javascript
/**
 * renderer.js
 * Production-grade log visualization module with comprehensive error handling,
 * type safety, performance optimization, and accessibility support.
 * @version 2.0.0
 */

'use strict';

// ---------------------------------------------------------------------------
// Type Definitions (JSDoc for IDE support)
// ---------------------------------------------------------------------------

/**
 * @typedef {'empire' | 'rebel' | 'neutral'} Faction
 * @typedef {'log-entry' | 'log-entry--empire' | 'log-entry--rebel' | 'log-entry--neutral'} LogClass
 * @typedef {{ timestamp: string, faction: Faction, action: string, data: string, raw: string }} ParsedEntry
 * @typedef {{ clearContainer?: boolean, maxEntries?: number, filterFaction?: Faction | null, showTimestamps?: boolean, animate?: boolean, virtualScroll?: boolean }} RenderOptions
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @enum {string} */
const COLORS = Object.freeze({
  empire: '#e94560',
  rebel: '#4ecca3',
  neutral: '#f5f5f5',
  dark: '#0a0a1a',
  primary: '#1a1a2e',
  secondary: '#16213e',
  accent: '#0f3460'
});

/** @enum {string} */
const CLASSES = Object.freeze({
  logEntry: 'log-entry',
  logEntryEmpire: 'log-entry--empire',
  logEntryRebel: 'log-entry--rebel',
  logEntryNeutral: 'log-entry--neutral',
  logTimestamp: 'log-entry__timestamp',
  logFaction: 'log-entry__faction',
  logAction: 'log-entry__action',
  logData: 'log-entry__data',
  logContainer: 'log-container',
  logHeader: 'log-header',
  logBody: 'log-body'
});

/** @type {RegExp} */
const LOG_ENTRY_PATTERN = /^(t\d+)\s+(Empire|Rebel|Neutral)\s+([\w-]+)\s*(.*)?$/i;

/** @type {Object<Faction, RegExp>} */
const FACTION_PATTERNS = Object.freeze({
  empire: /^t\d+\s+Empire\s+/i,
  rebel: /^t\d+\s+Rebel\s+/i,
  neutral: /^t\d+\s+Neutral\s+/i
});

/** @type {number} */
const MAX_SAFE_ENTRIES = 10000;

/** @type {number} */
const ANIMATION_STAGGER_MS = 50;

/** @type {number} */
const ANIMATION_DURATION_MS = 300;

/** @type {number} */
const MAX_RENDER_BATCH = 500;

/** @type {number} */
const VIRTUAL_SCROLL_BUFFER = 100;

/** @type {string} */
const LOGGER_PREFIX = '[Renderer]';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger with levels and formatting.
 * @namespace
 */
const Logger = Object.freeze({
  /**
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {unknown} [data] - Additional data
   */
  log(level, message, data) {
    const timestamp = new Date().toISOString();
    const formatted = `${LOGGER_PREFIX} [${level}] ${message}`;
    
    switch (level) {
      case 'ERROR':
        console.error(formatted, data || '');
        break;
      case 'WARN':
        console.warn(formatted, data || '');
        break;
      case 'INFO':
        console.info(formatted, data || '');
        break;
      case 'DEBUG':
        if (process.env.NODE_ENV !== 'production') {
          console.debug(formatted, data || '');
        }
        break;
      default:
        console.log(formatted, data || '');
    }
  },

  /** @param {string} msg @param {unknown} [data] */
  error(msg, data) { this.log('ERROR', msg, data); },
  /** @param {string} msg @param {unknown} [data] */
  warn(msg, data) { this.log('WARN', msg, data); },
  /** @param {string} msg @param {unknown} [data] */
  info(msg, data) { this.log('INFO', msg, data); },
  /** @param {string} msg @param {unknown} [data] */
  debug(msg, data) { this.log('DEBUG', msg, data); }
});

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Sanitizes text to prevent XSS attacks.
 * @param {unknown} text - Input to sanitize
 * @returns {string} Sanitized text
 */
const sanitizeText = (text) => {
  try {
    if (typeof text !== 'string' && typeof text !== 'number' && typeof text !== 'boolean') {
      return '';
    }
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  } catch (error) {
    Logger.error('sanitizeText error:', error);
    return '';
  }
};

/**
 * Formats data for display with JSON pretty-printing.
 * @param {unknown} data - Data to format
 * @returns {string} Formatted string
 */
const formatData = (data) => {
  if (data === null || data === undefined) return '';
  
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return sanitizeText(String(data));
  }
};

/**
 * Validates that a value is a non-empty string.
 * @param {unknown} value - Value to validate
 * @returns {value is string} True if valid string
 */
const isValidString = (value) => {
  return typeof value === 'string' && value.trim().length > 0;
};

/**
 * Creates a throttled version of a function.
 * @param {Function} fn - Function to throttle
 * @param {number} limit - Throttle limit in ms
 * @returns {Function} Throttled function
 */
const throttle = (fn, limit) => {
  let inThrottle = false;
  let lastFn = null;
  let lastTime = 0;

  return function throttled(...args) {
    const context = this;
    const now = Date.now();

    if (!inThrottle) {
      fn.apply(context, args);
      lastTime = now;
      inThrottle = true;
    } else {
      clearTimeout(lastFn);
      lastFn = setTimeout(() => {
        if (Date.now() - lastTime >= limit) {
          fn.apply(context, args);
          lastTime = Date.now();
        }
      }, Math.max(0, limit - (now - lastTime)));
    }
  };
};

/**
 * Creates a debounced version of a function.
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Debounce delay in ms
 * @returns {Function} Debounced function
 */
const debounce = (fn, delay) => {
  let timeoutId = null;
  
  return function debounced(...args) {
    const context = this;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(context, args), delay);
  };
};

/**
 * Validates render options with defaults.
 * @param {RenderOptions} options - Options to validate
 * @returns {RenderOptions} Validated options with defaults
 */
const validateRenderOptions = (options) => {
  try {
    const validated = { ...options };
    
    if (typeof validated.clearContainer !== 'boolean') {
      validated.clearContainer = true;
    }
    
    if (typeof validated.maxEntries !== 'number' || validated.maxEntries < 1) {
      validated.maxEntries = MAX_SAFE_ENTRIES;
    } else {
      validated.maxEntries = Math.min(validated.maxEntries, MAX_SAFE_ENTRIES);
    }
    
    if (validated.filterFaction && !['empire', 'rebel', 'neutral'].includes(validated.filterFaction)) {
      validated.filterFaction = null;
    }
    
    if (typeof validated.showTimestamps !== 'boolean') {
      validated.showTimestamps = true;
    }
    
    if (typeof validated.animate !== 'boolean') {
      validated.animate = true;
    }
    
    if (typeof validated.virtualScroll !== 'boolean') {
      validated.virtualScroll = false;
    }
    
    return validated;
  } catch (error) {
    Logger.error('validateRenderOptions error:', error);
    return {
      clearContainer: true,
      maxEntries: MAX_SAFE_ENTRIES,
      filterFaction: null,
      showTimestamps: true,
      animate: true,
      virtualScroll: false
    };
  }
};

// ---------------------------------------------------------------------------
// Custom Error Classes
// ---------------------------------------------------------------------------

/**
 * Renderer-specific error class.
 * @extends Error
 */
class RendererError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} [code='RENDERER_ERROR'] - Error code
   */
  constructor(message, code = 'RENDERER_ERROR') {
    super(message);
    this.name = 'RendererError';
    this.code = code;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Parse error for log entries.
 * @extends RendererError
 */
class ParseError extends RendererError {
  /**
   * @param {string} message - Error message
   * @param {string} [rawInput] - Raw input that failed to parse
   */
  constructor(message, rawInput = '') {
    super(message, 'PARSE_ERROR');
    this.name = 'ParseError';
    this.rawInput = rawInput;
  }
}

/**
 * Validation error for invalid inputs.
 * @extends RendererError
 */
class ValidationError extends RendererError {
  /**
   * @param {string} message - Error message
   * @param {string} [field] - Field that failed validation
   */
  constructor(message, field = '') {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Log Parser
// ---------------------------------------------------------------------------

/**
 * Parses raw log text into structured entries.
 * @class
 */
class LogParser {
  /**
   * Parse a single log line into a structured entry.
   * @param {string} line - Raw log line
   * @returns {ParsedEntry} Parsed log entry
   * @throws {ParseError} If line cannot be parsed
   */
  static parseLine(line) {
    if (!isValidString(line)) {
      throw new ParseError('Empty or invalid log line', line);
    }

    const trimmed = line.trim();
    const match = trimmed.match(LOG_ENTRY_PATTERN);

    if (!match) {
      throw new ParseError(`Log line does not match expected pattern: ${trimmed.substring(0, 50)}...`, trimmed);
    }

    const [, timestamp, factionRaw, action, dataRaw] = match;
    const faction = factionRaw.toLowerCase();

    if (!['empire', 'rebel', 'neutral'].includes(faction)) {
      throw new ParseError(`Invalid faction: ${factionRaw}`, trimmed);
    }

    return {
      timestamp,
      faction: /** @type {Faction} */ (faction),
      action: action.toLowerCase(),
      data: dataRaw ? dataRaw.trim() : '',
      raw: trimmed
    };
  }

  /**
   * Parse multiple log lines into structured entries.
   * @param {string} logText - Raw log text
   * @returns {ParsedEntry[]} Array of parsed entries
   * @throws {ParseError} If log text is invalid
   */
  static parseLog(logText) {
    if (!isValidString(logText)) {
      throw new ParseError('Log text is empty or invalid');
    }

    const lines = logText.split('\n');
    const entries = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const line = lines[i].trim();
        if (line) {
          entries.push(this.parseLine(line));
        }
      } catch (error) {
        Logger.warn(`Skipping line ${i + 1}: ${error.message}`);
        // Continue parsing remaining lines
      }
    }

    return entries;
  }
}

// ---------------------------------------------------------------------------
// DOM Renderer
// ---------------------------------------------------------------------------

/**
 * Handles DOM rendering of log entries with performance optimizations.
 * @class
 */
class LogRenderer {
  /** @type {HTMLDivElement | null} */
  #container = null;
  
  /** @type {RenderOptions} */
  #options = {};
  
  /** @type {ParsedEntry[]} */
  #entries = [];
  
  /** @type {number} */
  #renderedCount = 0;
  
  /** @type {boolean} */
  #isRendering = false;
  
  /** @type {number | null} */
  #animationFrameId = null;

  /**
   * Create a new LogRenderer instance.
   * @param {string | HTMLDivElement} container - Container element or selector
   * @param {RenderOptions} [options] - Rendering options
   * @throws {ValidationError} If container is invalid
   */
  constructor(container, options = {}) {
    this.#initializeContainer(container);
    this.#options = validateRenderOptions(options);
    this.#setupAccessibility();
  }

  /**
   * Initialize the container element.
   * @param {string | HTMLDivElement} container - Container element or selector
   * @throws {ValidationError} If container is invalid
   */
  #initializeContainer(container) {
    try {
      if (typeof container === 'string') {
        const element = document.querySelector(container);
        if (!element) {
          throw new ValidationError(`Container not found: ${container}`, 'container');
        }
        this.#container = /** @type {HTMLDivElement} */ (element);
      } else if (container instanceof HTMLDivElement) {
        this.#container = container;
      } else {
        throw new ValidationError('Container must be a CSS selector string or HTMLDivElement', 'container');
      }

      if (!this.#container) {
        throw new ValidationError('Failed to initialize container', 'container');
      }
    } catch (error) {
      Logger.error('Container initialization failed:', error);
      throw error;
    }
  }

  /**
   * Setup accessibility attributes on the container.
   */
  #setupAccessibility() {
    if (!this.#container) return;

    try {
      this.#container.setAttribute('role', 'log');
      this.#container.setAttribute('aria-live', 'polite');
      this.#container.setAttribute('aria-relevant', 'additions');
      this.#container.setAttribute('aria-label', 'Game log entries');
      this.#container.classList.add(CLASSES.logContainer);
    } catch (error) {
      Logger.warn('Failed to set accessibility attributes:', error);
    }
  }

  /**
   * Get the CSS class for a faction.
   * @param {Faction} faction - Faction name
   * @returns {LogClass} CSS class name
   */
  #getFactionClass(faction) {
    switch (faction) {
      case 'empire':
        return CLASSES.logEntryEmpire;
      case 'rebel':
        return CLASSES.logEntryRebel;
      case 'neutral':
        return CLASSES.logEntryNeutral;
      default:
        return CLASSES.logEntry;
    }
  }

  /**
   * Create a DOM element for a log entry.
   * @param {ParsedEntry} entry - Parsed log entry
   * @param {number} index - Entry index for animation
   * @returns {HTMLDivElement} Created DOM element
   */
  #createEntryElement(entry, index) {
    const element = document.createElement('div');
    element.className = `${CLASSES.logEntry} ${this.#getFactionClass(entry.faction)}`;
    element.setAttribute('data-timestamp', entry.timestamp);
    element.setAttribute('data-faction', entry.faction);
    element.setAttribute('data-action', entry.action);

    // Timestamp
    if (this.#options.showTimestamps) {
      const timestampEl = document.createElement('span');
      timestampEl.className = CLASSES.logTimestamp;
      timestampEl.textContent = entry.timestamp;
      element.appendChild(timestampEl);
    }

    // Faction badge
    const factionEl = document.createElement('span');
    factionEl.className = CLASSES.logFaction;
    factionEl.textContent = entry.faction.charAt(0).toUpperCase() + entry.faction.slice(1);
    element.appendChild(factionEl);

    // Action name
    const actionEl = document.createElement('span');
    actionEl.className = CLASSES.logAction;
    actionEl.textContent = entry.action.replace(/-/g, ' ');
    element.appendChild(actionEl);

    // Data (if present)
    if (entry.data) {
      const dataEl = document.createElement('pre');
      dataEl.className = CLASSES.logData;
      dataEl.textContent = formatData(entry.data);
      element.appendChild(dataEl);
    }

    // Animation
    if (this.#options.animate) {
      element.style.opacity = '0';
      element.style.transform = 'translateY(-10px)';
      element.style.transition = `opacity ${ANIMATION_DURATION_MS}ms ease, transform ${ANIMATION_DURATION_MS}ms ease`;
      
      requestAnimationFrame(() => {
        element.style.opacity = '1';
        element.style.transform = 'translateY(0)';
      });
    }

    return element;
  }

  /**
   * Render entries to the container.
   * @param {ParsedEntry[]} entries - Entries to render
   * @returns {number} Number of entries rendered
   */
  render(entries) {
    if (!this.#container) {
      Logger.error('Cannot render: container not initialized');
      return 0;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      return 0;
    }

    try {
      // Filter entries if faction filter is active
      const filteredEntries = this.#options.filterFaction
        ? entries.filter(e => e.faction === this.#options.filterFaction)
        : entries;

      if (filteredEntries.length === 0) {
        return 0;
      }

      // Apply max entries limit
      const limitedEntries = filteredEntries.slice(-this.#options.maxEntries);

      // Clear