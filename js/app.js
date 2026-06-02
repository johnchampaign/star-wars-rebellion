javascript
/**
 * app.js - Main application logic for Star Wars Rebellion game state viewer
 * Handles parsing game state JSON, rendering log entries, and interactivity
 * for timeline and leader tracking.
 * @version 4.0.0
 * @license MIT
 */

(function() {
  'use strict';

  // ============================================================================
  // Type Definitions (JSDoc)
  // ============================================================================

  /**
   * @typedef {Object} GameState
   * @property {string} phase
   * @property {number} turn
   * @property {number} round
   * @property {string} humanSide
   * @property {string} aiSide
   * @property {System[]} systems
   * @property {Leader[]} leaders
   * @property {Unit[]} units
   * @property {Mission[]} missions
   * @property {Card[]} cards
   * @property {string} timestamp
   * @property {string} serverStamp
   */

  /**
   * @typedef {Object} System
   * @property {string} id
   * @property {string} name
   * @property {string} type
   * @property {string} owner
   * @property {string[]} units
   * @property {string[]} leaders
   * @property {boolean} isHomeworld
   * @property {boolean} isBlockaded
   * @property {string} loyalty
   * @property {number} resources
   * @property {{x: number, y: number}} position
   */

  /**
   * @typedef {Object} Leader
   * @property {string} id
   * @property {string} name
   * @property {string} side
   * @property {boolean} isActive
   * @property {boolean} isCaptured
   * @property {boolean} isMobilized
   * @property {string|null} currentSystem
   * @property {string|null} assignedMission
   * @property {{diplomacy: number, warfare: number, intrigue: number}} stats
   * @property {string|null} specialAbility
   */

  /**
   * @typedef {Object} Unit
   * @property {string} id
   * @property {string} typeId
   * @property {string} name
   * @property {string} side
   * @property {string|null} systemId
   * @property {boolean} isDamaged
   * @property {boolean} isDestroyed
   * @property {boolean} isMobilized
   * @property {{combat: number, health: number, speed: number}} stats
   */

  /**
   * @typedef {Object} Mission
   * @property {string} id
   * @property {string} name
   * @property {string} type
   * @property {string} side
   * @property {boolean} isCompleted
   * @property {boolean} isAvailable
   * @property {string[]} assignedLeaders
   * @property {number} requiredLeaders
   * @property {number} difficulty
   * @property {Object} rewards
   */

  /**
   * @typedef {Object} Card
   * @property {string} id
   * @property {string} name
   * @property {string} type
   * @property {string} side
   * @property {boolean} isInHand
   * @property {boolean} isPlayed
   * @property {boolean} isDiscarded
   * @property {string} effect
   */

  /**
   * @typedef {Object} LogEntry
   * @property {number} turn
   * @property {string} side
   * @property {string} action
   * @property {Object|string} data
   * @property {number} timestamp
   * @property {boolean} isValid
   */

  /**
   * @typedef {Object} AppState
   * @property {GameState|null} gameState
   * @property {LogEntry[]} logEntries
   * @property {LogEntry[]} filteredLogEntries
   * @property {string} currentFilter
   * @property {string|null} selectedLeader
   * @property {string|null} selectedSystem
   * @property {number} timelinePosition
   * @property {boolean} isAnimating
   * @property {Function[]} observers
   */

  // ============================================================================
  // Configuration & Constants
  // ============================================================================

  /** @enum {Object} */
  const CONFIG = Object.freeze({
    designSystem: Object.freeze({
      colors: Object.freeze({
        primary: '#1a1a2e',
        secondary: '#16213e',
        accent: '#0f3460',
        highlight: '#e94560',
        text: '#eaeaea',
        background: '#0a0a1a',
        success: '#2ecc71',
        warning: '#f39c12',
        error: '#e74c3c'
      }),
      typography: Object.freeze({
        headings: "'Orbitron', sans-serif",
        body: "'Roboto Mono', monospace",
        baseSize: '16px',
        scale: '1.25'
      }),
      spacing: Object.freeze({
        xs: '4px',
        sm: '8px',
        md: '16px',
        lg: '24px',
        xl: '48px'
      })
    }),
    stateKey: 'rebellion_game_state',
    logLimit: 30,
    animationDuration: 300,
    maxRetries: 3,
    retryDelay: 1000,
    maxLogEntries: 10000,
    maxObservers: 50,
    debounceDelay: 150
  });

  // ============================================================================
  // Custom Error Classes
  // ============================================================================

  /**
   * Application base error
   * @class
   * @extends Error
   */
  class AppError extends Error {
    /**
     * @param {string} message - Error message
     * @param {string} [code='UNKNOWN_ERROR'] - Error code
     * @param {Object} [context={}] - Additional context
     */
    constructor(message, code = 'UNKNOWN_ERROR', context = {}) {
      super(message);
      this.name = 'AppError';
      this.code = code;
      this.context = context;
      this.timestamp = new Date().toISOString();
      Error.captureStackTrace(this, this.constructor);
    }

    /**
     * Convert error to JSON-safe object
     * @returns {Object} Serializable error representation
     */
    toJSON() {
      return {
        name: this.name,
        message: this.message,
        code: this.code,
        context: this.context,
        timestamp: this.timestamp,
        stack: this.stack
      };
    }
  }

  /**
   * State validation error
   * @class
   * @extends AppError
   */
  class StateValidationError extends AppError {
    /**
     * @param {string} message - Error message
     * @param {Object} [context={}] - Additional context
     */
    constructor(message, context = {}) {
      super(message, 'STATE_VALIDATION_ERROR', context);
      this.name = 'StateValidationError';
    }
  }

  /**
   * Parse error
   * @class
   * @extends AppError
   */
  class ParseError extends AppError {
    /**
     * @param {string} message - Error message
     * @param {Object} [context={}] - Additional context
     */
    constructor(message, context = {}) {
      super(message, 'PARSE_ERROR', context);
      this.name = 'ParseError';
    }
  }

  /**
   * Network error
   * @class
   * @extends AppError
   */
  class NetworkError extends AppError {
    /**
     * @param {string} message - Error message
     * @param {number} [statusCode=0] - HTTP status code
     * @param {Object} [context={}] - Additional context
     */
    constructor(message, statusCode = 0, context = {}) {
      super(message, 'NETWORK_ERROR', { ...context, statusCode });
      this.name = 'NetworkError';
      this.statusCode = statusCode;
    }
  }

  /**
   * Validation error for input data
   * @class
   * @extends AppError
   */
  class ValidationError extends AppError {
    /**
     * @param {string} message - Error message
     * @param {string} field - Field that failed validation
     * @param {*} value - Invalid value
     * @param {Object} [context={}] - Additional context
     */
    constructor(message, field, value, context = {}) {
      super(message, 'VALIDATION_ERROR', { ...context, field, value });
      this.name = 'ValidationError';
      this.field = field;
      this.invalidValue = value;
    }
  }

  // ============================================================================
  // Logger
  // ============================================================================

  /**
   * Application logger with severity levels
   * @class
   */
  class Logger {
    /** @enum {number} */
    static LEVELS = Object.freeze({
      DEBUG: 0,
      INFO: 1,
      WARN: 2,
      ERROR: 3,
      FATAL: 4
    });

    /** @type {number} */
    static currentLevel = Logger.LEVELS.INFO;

    /** @type {LogEntry[]} */
    static history = [];

    /** @type {number} */
    static maxHistorySize = 1000;

    /**
     * Set the current logging level
     * @param {number} level - Logging level from Logger.LEVELS
     * @throws {ValidationError} If level is invalid
     */
    static setLevel(level) {
      if (!Object.values(Logger.LEVELS).includes(level)) {
        throw new ValidationError(
          `Invalid logging level: ${level}`,
          'level',
          level,
          { validLevels: Object.values(Logger.LEVELS) }
        );
      }
      Logger.currentLevel = level;
    }

    /**
     * Internal log method
     * @param {number} level - Severity level
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     * @param {Error} [error=null] - Associated error object
     * @private
     */
    static _log(level, message, data = {}, error = null) {
      if (level < Logger.currentLevel) return;

      const entry = {
        level,
        message,
        data,
        error: error ? error.toJSON() : null,
        timestamp: new Date().toISOString()
      };

      Logger.history.push(entry);
      if (Logger.history.length > Logger.maxHistorySize) {
        Logger.history.shift();
      }

      const prefix = `[${Object.keys(Logger.LEVELS).find(k => Logger.LEVELS[k] === level)}]`;
      const consoleMethod = level >= Logger.LEVELS.ERROR ? 'error' :
                           level >= Logger.LEVELS.WARN ? 'warn' : 'log';

      if (error) {
        console[consoleMethod](`${prefix} ${message}`, data, error);
      } else {
        console[consoleMethod](`${prefix} ${message}`, data);
      }
    }

    /**
     * Debug level log
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     */
    static debug(message, data = {}) {
      Logger._log(Logger.LEVELS.DEBUG, message, data);
    }

    /**
     * Info level log
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     */
    static info(message, data = {}) {
      Logger._log(Logger.LEVELS.INFO, message, data);
    }

    /**
     * Warning level log
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     * @param {Error} [error=null] - Associated error
     */
    static warn(message, data = {}, error = null) {
      Logger._log(Logger.LEVELS.WARN, message, data, error);
    }

    /**
     * Error level log
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     * @param {Error} [error=null] - Associated error
     */
    static error(message, data = {}, error = null) {
      Logger._log(Logger.LEVELS.ERROR, message, data, error);
    }

    /**
     * Fatal level log
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     * @param {Error} [error=null] - Associated error
     */
    static fatal(message, data = {}, error = null) {
      Logger._log(Logger.LEVELS.FATAL, message, data, error);
    }

    /**
     * Get log history
     * @param {number} [count=50] - Number of entries to return
     * @param {number} [level=Logger.LEVELS.DEBUG] - Minimum level filter
     * @returns {LogEntry[]} Filtered log entries
     */
    static getHistory(count = 50, level = Logger.LEVELS.DEBUG) {
      return Logger.history
        .filter(entry => entry.level >= level)
        .slice(-count);
    }

    /**
     * Clear log history
     */
    static clearHistory() {
      Logger.history = [];
    }
  }

  // ============================================================================
  // Utility Functions
  // ============================================================================

  /**
   * Deep clone an object
   * @template T
   * @param {T} obj - Object to clone
   * @returns {T} Cloned object
   * @throws {AppError} If cloning fails
   */
  function deepClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (error) {
      throw new AppError(
        'Failed to deep clone object',
        'CLONE_ERROR',
        { originalError: error.message }
      );
    }
  }

  /**
   * Debounce a function call
   * @param {Function} fn - Function to debounce
   * @param {number} delay - Delay in milliseconds
   * @returns {Function} Debounced function
   */
  function debounce(fn, delay) {
    let timeoutId = null;
    return function(...args) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        fn.apply(this, args);
        timeoutId = null;
      }, delay);
    };
  }

  /**
   * Throttle a function call
   * @param {Function} fn - Function to throttle
   * @param {number} limit - Limit in milliseconds
   * @returns {Function} Throttled function
   */
  function throttle(fn, limit) {
    let inThrottle = false;
    return function(...args) {
      if (!inThrottle) {
        fn.apply(this, args);
        inThrottle = true;
        setTimeout(() => {
          inThrottle = false;
        }, limit);
      }
    };
  }

  /**
   * Validate that a value is a non-empty string
   * @param {*} value - Value to validate
   * @param {string} fieldName - Field name for error message
   * @returns {boolean} True if valid
   * @throws {ValidationError} If validation fails
   */
  function validateNonEmptyString(value, fieldName) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ValidationError(
        `${fieldName} must be a non-empty string`,
        fieldName,
        value
      );
    }
    return true;
  }

  /**
   * Validate that a value is a positive integer
   * @param {*} value - Value to validate
   * @param {string} fieldName - Field name for error message
   * @returns {boolean} True if valid
   * @throws {ValidationError} If validation fails
   */
  function validatePositiveInteger(value, fieldName) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError(
        `${fieldName} must be a non-negative integer`,
        fieldName,
        value
      );
    }
    return true;
  }

  /**
   * Validate that a value is a valid side (Rebel or Empire)
   * @param {*} value - Value to validate
   * @param {string} fieldName - Field name for error message
   * @returns {boolean} True if valid
   * @throws {ValidationError} If validation fails
   */
  function validateSide(value, fieldName) {
    if (!['Rebel', 'Empire'].includes(value)) {
      throw new ValidationError(
        `${fieldName} must be 'Rebel' or 'Empire'`,
        fieldName,
        value
      );
    }
    return true;
  }

  /**
   * Sanitize a string for safe HTML display
   * @param {string} str - String to sanitize
   * @returns {string} Sanitized string
   */
  function sanitizeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /**
   * Format a timestamp to a readable date string
   * @param {number|string} timestamp - Unix timestamp or ISO string
   * @returns {string} Formatted date string
   */
  function formatTimestamp(timestamp) {
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        return 'Invalid date';
      }
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (error) {
      Logger.warn('Failed to format timestamp', { timestamp }, error);
      return 'Invalid date';
    }
  }

  // ============================================================================
  // State Manager
  // ============================================================================

  /**
   * Manages application state with observer pattern
   * @class
   */
  class StateManager {
    /** @type {AppState}