javascript
/**
 * @fileoverview High-performance log parser for Star Wars Rebellion game logs.
 * Parses structured log entries with comprehensive error handling, type safety,
 * and production-ready features.
 * @version 3.0.0
 */

// Type definitions for JSDoc
/**
 * @typedef {Object} LogEntry
 * @property {number} turn - Game turn number
 * @property {string} player - Player identifier (Rebel/Empire)
 * @property {string} actionType - Type of action performed
 * @property {Object|string|null} payload - Parsed JSON payload or raw string
 * @property {string} raw - Original raw log line
 * @property {number} timestamp - Processing timestamp
 * @property {number} lineNumber - Line number in source
 * @property {string} [error] - Any parsing error for this entry
 */

/**
 * @typedef {Object} ContextMetadata
 * @property {string|null} humanSide - Human player side
 * @property {string|null} aiSide - AI player side
 * @property {string|null} userAgent - User agent string
 * @property {boolean|null} canEncodeState - Whether state encoding is supported
 * @property {string|null} timestamp - Log timestamp
 * @property {string|null} serverStamp - Server stamp
 * @property {string|null} reporter - Reporter player
 */

/**
 * @typedef {Object} ParseResult
 * @property {LogEntry[]} entries - Parsed log entries
 * @property {ContextMetadata} context - Extracted context
 * @property {string|null} error - Error message if any
 * @property {Object} metadata - Parsing metadata
 * @property {number} metadata.totalLines - Total lines processed
 * @property {number} metadata.validEntries - Number of valid entries
 * @property {number} metadata.invalidLines - Number of invalid lines
 * @property {number} metadata.processingTimeMs - Processing time in milliseconds
 */

// Constants
const LOG_ENTRY_REGEX = /^t(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/;
const CONTEXT_PATTERNS = {
  humanSide: /^humanSide:\s*`(.+?)`/,
  aiSide: /^AI:\s*`(.+?)`/,
  userAgent: /^userAgent:\s*`(.+?)`/,
  canEncodeState: /^canEncodeState:\s*`(.+?)`/,
  timestamp: /^timestamp:\s*`(.+?)`/,
  serverStamp: /^server-stamp:\s*`(.+?)`/
};
const REPORTER_PATTERN = /^Reporter played:\s*(\S+)/;
const AI_PATTERN = /AI:\s*(\S+)/;
const MAX_LINE_LENGTH = 10000;
const MAX_ENTRIES = 1000;
const MAX_PAYLOAD_DEPTH = 10;
const VALID_PLAYER_REGEX = /^[A-Za-z0-9_-]+$/;
const VALID_ACTION_REGEX = /^[A-Za-z0-9_-]+$/;
const MALICIOUS_CHARS_REGEX = /[<>]/;
const MAX_RECURSION_DEPTH = 50;
const MAX_PAYLOAD_SIZE = 100000; // 100KB max payload size

/**
 * Custom error class for log parsing errors
 * @extends Error
 */
class LogParserError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} [line=''] - The problematic log line
   * @param {number} [lineNumber=-1] - Line number in source
   */
  constructor(message, line = '', lineNumber = -1) {
    super(message);
    this.name = 'LogParserError';
    this.line = line;
    this.lineNumber = lineNumber;
    this.timestamp = Date.now();
    this.code = 'LOG_PARSE_ERROR';
    
    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LogParserError);
    }
  }

  /**
   * Get error details for logging
   * @returns {Object} Error details
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      line: this.line,
      lineNumber: this.lineNumber,
      timestamp: this.timestamp,
      code: this.code,
      stack: this.stack
    };
  }
}

/**
 * Logger utility for consistent logging
 * @namespace
 */
const Logger = {
  /**
   * @param {string} message - Log message
   * @param {Object} [context] - Additional context
   */
  info(message, context = {}) {
    if (typeof console !== 'undefined' && console.info) {
      console.info(`[LogParser] ${message}`, context);
    }
  },

  /**
   * @param {string} message - Warning message
   * @param {Object} [context] - Additional context
   */
  warn(message, context = {}) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[LogParser] ${message}`, context);
    }
  },

  /**
   * @param {string} message - Error message
   * @param {Object} [context] - Additional context
   */
  error(message, context = {}) {
    if (typeof console !== 'undefined' && console.error) {
      console.error(`[LogParser] ${message}`, context);
    }
  },

  /**
   * @param {string} message - Debug message
   * @param {Object} [context] - Additional context
   */
  debug(message, context = {}) {
    if (process && process.env && process.env.NODE_ENV === 'development') {
      if (typeof console !== 'undefined' && console.debug) {
        console.debug(`[LogParser] ${message}`, context);
      }
    }
  }
};

/**
 * Validates and sanitizes a log line
 * @param {string} line - Raw log line to validate
 * @returns {string} Sanitized line
 * @throws {LogParserError} If line is invalid
 */
function validateLogLine(line) {
  if (typeof line !== 'string') {
    throw new LogParserError('Log line must be a string', String(line));
  }

  const trimmed = line.trim();
  
  if (!trimmed) {
    throw new LogParserError('Empty log line');
  }

  if (trimmed.length > MAX_LINE_LENGTH) {
    throw new LogParserError(
      `Log line exceeds maximum length of ${MAX_LINE_LENGTH} characters`,
      trimmed.substring(0, 100)
    );
  }

  // Check for potentially malicious content
  if (MALICIOUS_CHARS_REGEX.test(trimmed)) {
    throw new LogParserError('Log line contains potentially malicious characters', trimmed);
  }

  return trimmed;
}

/**
 * Safely parses JSON payload with fallback
 * @param {string} payloadStr - JSON string to parse
 * @returns {Object|string|null} Parsed payload or raw string
 */
function safeParseJSON(payloadStr) {
  if (!payloadStr || typeof payloadStr !== 'string') {
    return null;
  }

  // Quick check for JSON structure
  const trimmed = payloadStr.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return trimmed;
  }

  // Check payload size
  if (trimmed.length > MAX_PAYLOAD_SIZE) {
    Logger.warn('Payload exceeds maximum size', { 
      size: trimmed.length, 
      maxSize: MAX_PAYLOAD_SIZE 
    });
    return trimmed.substring(0, 1000) + '... [TRUNCATED]';
  }

  try {
    const parsed = JSON.parse(trimmed);
    
    // Validate parsed result is an object or array
    if (typeof parsed !== 'object' || parsed === null) {
      return trimmed;
    }
    
    // Check for excessive nesting
    const depth = getObjectDepth(parsed);
    if (depth > MAX_PAYLOAD_DEPTH) {
      Logger.warn('Payload exceeds maximum nesting depth', { depth, maxDepth: MAX_PAYLOAD_DEPTH });
      return trimmed;
    }
    
    return parsed;
  } catch (parseError) {
    // Attempt to fix common JSON issues
    try {
      // Try to fix truncated JSON by adding closing brackets
      let fixed = trimmed;
      const openBraces = (fixed.match(/\{/g) || []).length;
      const closeBraces = (fixed.match(/\}/g) || []).length;
      const openBrackets = (fixed.match(/\[/g) || []).length;
      const closeBrackets = (fixed.match(/\]/g) || []).length;
      
      while (openBraces > closeBraces) {
        fixed += '}';
      }
      while (openBrackets > closeBrackets) {
        fixed += ']';
      }
      
      if (fixed !== trimmed) {
        return JSON.parse(fixed);
      }
    } catch (fixError) {
      Logger.debug('Failed to fix malformed JSON', { 
        original: trimmed.substring(0, 100),
        error: fixError.message 
      });
    }
    
    return trimmed;
  }
}

/**
 * Calculate the maximum depth of an object
 * @param {Object} obj - Object to check
 * @param {number} [currentDepth=0] - Current recursion depth
 * @returns {number} Maximum depth
 */
function getObjectDepth(obj, currentDepth = 0) {
  if (currentDepth > MAX_RECURSION_DEPTH) {
    return currentDepth;
  }
  
  if (typeof obj !== 'object' || obj === null) {
    return currentDepth;
  }
  
  let maxDepth = currentDepth;
  
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const depth = getObjectDepth(obj[key], currentDepth + 1);
      if (depth > maxDepth) {
        maxDepth = depth;
      }
    }
  }
  
  return maxDepth;
}

/**
 * Parses a single log line into a LogEntry
 * @param {string} line - Raw log line
 * @param {number} lineNumber - Line number in source
 * @returns {LogEntry|null} Parsed log entry or null if invalid
 */
function parseLogLine(line, lineNumber) {
  try {
    const validatedLine = validateLogLine(line);
    const match = validatedLine.match(LOG_ENTRY_REGEX);
    
    if (!match) {
      Logger.debug('Line does not match log entry pattern', { lineNumber, line: validatedLine.substring(0, 100) });
      return null;
    }

    const [, turnStr, player, actionType, payloadStr] = match;
    const turn = parseInt(turnStr, 10);

    // Validate turn number
    if (isNaN(turn) || turn < 0) {
      Logger.warn('Invalid turn number', { turn: turnStr, lineNumber });
      return null;
    }

    // Validate player identifier
    if (!VALID_PLAYER_REGEX.test(player)) {
      Logger.warn('Invalid player identifier', { player, lineNumber });
      return null;
    }

    // Validate action type
    if (!VALID_ACTION_REGEX.test(actionType)) {
      Logger.warn('Invalid action type', { actionType, lineNumber });
      return null;
    }

    // Parse payload
    const payload = safeParseJSON(payloadStr);

    return {
      turn,
      player,
      actionType,
      payload,
      raw: validatedLine,
      timestamp: Date.now(),
      lineNumber,
      error: undefined
    };
  } catch (error) {
    if (error instanceof LogParserError) {
      Logger.warn('Failed to parse log line', { 
        lineNumber, 
        error: error.message,
        line: line.substring(0, 100)
      });
    } else {
      Logger.error('Unexpected error parsing log line', {
        lineNumber,
        error: error.message,
        stack: error.stack
      });
    }
    return null;
  }
}

/**
 * Extracts context metadata from log lines
 * @param {string[]} lines - Array of log lines
 * @returns {ContextMetadata} Extracted context
 */
function extractContext(lines) {
  const context = {
    humanSide: null,
    aiSide: null,
    userAgent: null,
    canEncodeState: null,
    timestamp: null,
    serverStamp: null,
    reporter: null
  };

  try {
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Extract reporter
      const reporterMatch = trimmed.match(REPORTER_PATTERN);
      if (reporterMatch) {
        context.reporter = reporterMatch[1];
        continue;
      }

      // Extract AI side
      const aiMatch = trimmed.match(AI_PATTERN);
      if (aiMatch) {
        context.aiSide = aiMatch[1];
        continue;
      }

      // Extract other context fields
      for (const [key, pattern] of Object.entries(CONTEXT_PATTERNS)) {
        const match = trimmed.match(pattern);
        if (match) {
          if (key === 'canEncodeState') {
            context[key] = match[1] === 'true';
          } else {
            context[key] = match[1];
          }
          break;
        }
      }
    }
  } catch (error) {
    Logger.error('Failed to extract context', { error: error.message });
  }

  return context;
}

/**
 * Main log parser function
 * @param {string} logText - Raw log text to parse
 * @returns {ParseResult} Parsed result with entries and context
 */
function parseLog(logText) {
  const startTime = Date.now();
  const result = {
    entries: [],
    context: {
      humanSide: null,
      aiSide: null,
      userAgent: null,
      canEncodeState: null,
      timestamp: null,
      serverStamp: null,
      reporter: null
    },
    error: null,
    metadata: {
      totalLines: 0,
      validEntries: 0,
      invalidLines: 0,
      processingTimeMs: 0
    }
  };

  try {
    // Input validation
    if (typeof logText !== 'string') {
      throw new LogParserError('Log text must be a string', String(logText));
    }

    if (!logText.trim()) {
      throw new LogParserError('Log text is empty');
    }

    // Split into lines
    const lines = logText.split('\n');
    result.metadata.totalLines = lines.length;

    // Limit number of lines to process
    const linesToProcess = lines.slice(0, MAX_ENTRIES + 50); // Allow extra lines for context

    // Extract context first
    result.context = extractContext(linesToProcess);

    // Parse each line
    for (let i = 0; i < linesToProcess.length; i++) {
      const entry = parseLogLine(linesToProcess[i], i);
      
      if (entry) {
        result.entries.push(entry);
        result.metadata.validEntries++;
      } else {
        result.metadata.invalidLines++;
      }

      // Limit number of entries
      if (result.entries.length >= MAX_ENTRIES) {
        Logger.info('Reached maximum number of entries', { maxEntries: MAX_ENTRIES });
        break;
      }
    }

    // Calculate processing time
    result.metadata.processingTimeMs = Date.now() - startTime;

    Logger.info('Log parsing completed', {
      totalLines: result.metadata.totalLines,
      validEntries: result.metadata.validEntries,
      invalidLines: result.metadata.invalidLines,
      processingTimeMs: result.metadata.processingTimeMs
    });

  } catch (error) {
    const errorMessage = error instanceof LogParserError ? error.message : 'Unexpected error during log parsing';
    result.error = errorMessage;
    
    Logger.error('Log parsing failed', {
      error: errorMessage,
      stack: error.stack,
      processingTimeMs: Date.now() - startTime
    });
    
    result.metadata.processingTimeMs = Date.now() - startTime;
  }

  return result;
}

/**
 * Formats parsed log entries for display
 * @param {ParseResult} parseResult - Result from parseLog
 * @returns {string} Formatted log output
 */
function formatLogOutput(parseResult) {
  if (parseResult.error) {
    return `Error parsing log: ${parseResult.error}`;
  }

  const { entries, context, metadata } = parseResult;
  
  let output = '';
  
  // Add context information
  if (context.reporter) {
    output += `Reporter: ${context.reporter}\n`;
  }
  if (context.humanSide) {
    output += `Human Side: ${context.humanSide}\n`;
  }
  if (context.aiSide) {
    output += `AI Side: ${context.aiSide}\n`;
  }
  
  output += '\n--- Log Entries ---\n\n';
  
  // Format each entry
  for (const entry of entries) {
    const payloadStr = typeof entry.payload === 'object' 
      ? JSON.stringify(entry.payload, null, 2)
      : String(entry.payload || '');
    
    output += `[Turn ${entry.turn}] ${entry.player} - ${entry.actionType}\n`;
    if (payloadStr && payloadStr !== 'null') {
      output += `  Payload: ${payloadStr}\n`;
    }
    output += '\n';
  }
  
  // Add metadata summary
  output += '--- Summary ---\n';
  output += `Total lines: ${metadata.totalLines}\n`;
  output += `Valid entries: ${metadata.validEntries}\n`;
  output += `Invalid lines: ${metadata.invalidLines}\n`;
  output += `Processing time: ${metadata.processingTimeMs}ms\n`;
  
  return output;
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseLog,
    formatLogOutput,
    LogParserError,
    Logger
  };
}