javascript
// js/state-parser.js
// Parses rebellion-state-v1 schema, extracts leader positions, mission assignments, and system activations

'use strict';

const { EventEmitter } = require('events');
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, errors, json } = format;

// Custom logger configuration
const logFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` | ${JSON.stringify(metadata)}`;
  }
  return msg;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    logFormat
  ),
  transports: [
    new transports.Console({
      handleExceptions: true,
      handleRejections: true
    }),
    new transports.File({ 
      filename: 'logs/state-parser-error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new transports.File({ 
      filename: 'logs/state-parser-combined.log',
      maxsize: 5242880,
      maxFiles: 5
    })
  ],
  exitOnError: false
});

// Constants for validation
const VALID_STATUSES = Object.freeze(['ready', 'assigned', 'used', 'captured', 'recruited']);
const VALID_SIDES = Object.freeze(['Rebel', 'Empire', 'neutral']);
const VALID_SCHEMA_VERSIONS = Object.freeze(['rebellion-state-v1', 'rebellion-state-v2']);
const MAX_LEADERS = 50;
const MAX_MISSIONS = 30;
const MAX_SYSTEMS = 100;
const MAX_UNITS_PER_SYSTEM = 100;
const MAX_RETRY_DELAY_MS = 1000;
const VALID_PHASES = Object.freeze(['setup', 'recruitment', 'assignment', 'activation', 'combat', 'resolution', 'cleanup']);

/**
 * @typedef {Object} LeaderPosition
 * @property {string} leaderId - Unique identifier for the leader
 * @property {string|null} systemId - Current system location
 * @property {string} status - Current status: 'ready' | 'assigned' | 'used' | 'captured' | 'recruited'
 * @property {string|null} missionId - Currently assigned mission
 * @property {string|null} side - Side affiliation: 'Rebel' | 'Empire' | null
 * @property {string|null} cardId - Associated card identifier
 * @property {boolean} exhausted - Whether leader is exhausted
 * @property {boolean} captured - Whether leader is captured
 */

/**
 * @typedef {Object} MissionAssignment
 * @property {string} missionId - Unique mission identifier
 * @property {string[]} leaderIds - Array of assigned leader IDs
 * @property {string|null} side - Side executing mission: 'Rebel' | 'Empire' | null
 * @property {boolean} resolved - Whether mission has been resolved
 * @property {string|null} type - Mission type classification
 * @property {string|null} targetSystem - Target system for the mission
 * @property {string|null} cardId - Associated card identifier
 * @property {string|null} outcome - Mission outcome result
 */

/**
 * @typedef {Object} SystemActivation
 * @property {string} systemId - Unique system identifier
 * @property {string} side - Controlling side: 'Rebel' | 'Empire' | 'neutral'
 * @property {string[]} units - Array of unit IDs in the system
 * @property {boolean} activated - Whether system is activated
 * @property {string|null} activatedBy - Leader ID who activated the system
 * @property {string|null} loyalty - System loyalty status
 * @property {boolean} hasBase - Whether system has a base
 * @property {boolean} hasFleet - Whether system has a fleet
 * @property {number|null} resources - Resource value of the system
 * @property {number|null} production - Production value of the system
 */

/**
 * @typedef {Object} ParsedState
 * @property {Map<string, LeaderPosition>} leaders - Map of leader IDs to leader positions
 * @property {Map<string, MissionAssignment>} missions - Map of mission IDs to mission assignments
 * @property {Map<string, SystemActivation>} systems - Map of system IDs to system activations
 * @property {Object} metadata - Additional state metadata
 * @property {string} phase - Current game phase
 * @property {number} turn - Current turn number
 * @property {string} schemaVersion - Schema version used
 */

/**
 * Custom error class for state parsing errors
 */
class StateParsingError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} section - Section where error occurred
   * @param {*} [details] - Additional error details
   */
  constructor(message, section, details = null) {
    super(message);
    this.name = 'StateParsingError';
    this.section = section;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Custom error class for validation errors
 */
class ValidationError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} field - Field that failed validation
   * @param {*} [value] - Invalid value
   */
  constructor(message, field, value = null) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * StateParser class for parsing rebellion-state-v1 schema
 * @extends EventEmitter
 */
class StateParser extends EventEmitter {
  /**
   * Initialize the StateParser
   * @param {Object} [options] - Configuration options
   * @param {string} [options.schemaVersion='rebellion-state-v1'] - Expected schema version
   * @param {boolean} [options.strictMode=false] - Enable strict validation
   * @param {number} [options.maxRetries=3] - Maximum retry attempts for parsing
   */
  constructor(options = {}) {
    super();
    
    this._schemaVersion = options.schemaVersion || 'rebellion-state-v1';
    this._strictMode = options.strictMode || false;
    this._maxRetries = options.maxRetries || 3;
    this._parsingStats = {
      totalParsed: 0,
      successfulParses: 0,
      failedParses: 0,
      lastParseTime: null
    };

    // Bind methods to maintain context
    this._parseLeaders = this._parseLeaders.bind(this);
    this._parseMissions = this._parseMissions.bind(this);
    this._parseSystems = this._parseSystems.bind(this);
    this._validateState = this._validateState.bind(this);
    this._sanitizeInput = this._sanitizeInput.bind(this);

    logger.info('StateParser initialized', { 
      schemaVersion: this._schemaVersion, 
      strictMode: this._strictMode 
    });
  }

  /**
   * Parse raw state object into structured data
   * @param {Object} rawState - Raw rebellion-state-v1 object
   * @returns {Promise<ParsedState>} Parsed state object
   * @throws {StateParsingError} If state parsing fails
   * @throws {ValidationError} If state validation fails
   */
  async parse(rawState) {
    const startTime = Date.now();
    this._parsingStats.totalParsed++;

    try {
      // Input validation
      if (!rawState || typeof rawState !== 'object') {
        throw new ValidationError('Invalid state: must be a non-null object', 'rawState', rawState);
      }

      if (Array.isArray(rawState)) {
        throw new ValidationError('Invalid state: must be an object, not an array', 'rawState', rawState);
      }

      // Sanitize input
      const sanitizedState = this._sanitizeInput(rawState);

      // Schema version validation
      if (sanitizedState.schemaVersion && 
          !VALID_SCHEMA_VERSIONS.includes(sanitizedState.schemaVersion)) {
        logger.warn('Unexpected schema version', {
          actual: sanitizedState.schemaVersion,
          expected: this._schemaVersion
        });
      }

      // Initialize state object
      const state = {
        leaders: new Map(),
        missions: new Map(),
        systems: new Map(),
        metadata: {},
        phase: 'unknown',
        turn: 0,
        schemaVersion: sanitizedState.schemaVersion || this._schemaVersion
      };

      // Parse phase and turn with validation
      state.phase = this._validatePhase(sanitizedState.phase);
      state.turn = this._validateTurn(sanitizedState.turn);

      // Parse each section with error handling
      try {
        state.leaders = await this._parseLeaders(sanitizedState.leaders);
      } catch (error) {
        logger.error('Failed to parse leaders section', { error: error.message });
        if (this._strictMode) {
          throw new StateParsingError('Leaders parsing failed', 'leaders', error);
        }
      }

      try {
        state.missions = await this._parseMissions(sanitizedState.missions);
      } catch (error) {
        logger.error('Failed to parse missions section', { error: error.message });
        if (this._strictMode) {
          throw new StateParsingError('Missions parsing failed', 'missions', error);
        }
      }

      try {
        state.systems = await this._parseSystems(sanitizedState.systems);
      } catch (error) {
        logger.error('Failed to parse systems section', { error: error.message });
        if (this._strictMode) {
          throw new StateParsingError('Systems parsing failed', 'systems', error);
        }
      }

      // Extract metadata
      state.metadata = this._extractMetadata(sanitizedState);

      // Validate complete state
      const validationErrors = this._validateState(state);
      if (validationErrors.length > 0) {
        logger.warn('State validation warnings', { errors: validationErrors });
        if (this._strictMode) {
          throw new ValidationError('State validation failed', 'state', validationErrors);
        }
      }

      // Update stats
      this._parsingStats.successfulParses++;
      this._parsingStats.lastParseTime = Date.now() - startTime;

      logger.info('State parsed successfully', {
        leadersCount: state.leaders.size,
        missionsCount: state.missions.size,
        systemsCount: state.systems.size,
        phase: state.phase,
        turn: state.turn,
        parseTime: this._parsingStats.lastParseTime
      });

      this.emit('stateParsed', state);
      return state;

    } catch (error) {
      this._parsingStats.failedParses++;
      logger.error('State parsing failed', {
        error: error.message,
        stack: error.stack,
        parseTime: Date.now() - startTime
      });
      
      this.emit('parseError', error);
      throw error;
    }
  }

  /**
   * Sanitize input object to prevent prototype pollution
   * @param {Object} input - Raw input object
   * @returns {Object} Sanitized object
   * @private
   */
  _sanitizeInput(input) {
    if (!input || typeof input !== 'object') {
      return {};
    }

    try {
      return JSON.parse(JSON.stringify(input));
    } catch (error) {
      logger.error('Input sanitization failed', { error: error.message });
      return {};
    }
  }

  /**
   * Validate and normalize phase value
   * @param {string} phase - Phase value to validate
   * @returns {string} Validated phase
   * @private
   */
  _validatePhase(phase) {
    if (!phase || typeof phase !== 'string') {
      logger.warn('Invalid phase value, defaulting to unknown', { phase });
      return 'unknown';
    }

    const normalizedPhase = phase.toLowerCase().trim();
    
    if (!VALID_PHASES.includes(normalizedPhase)) {
      logger.warn('Unknown phase value', { phase: normalizedPhase });
      return normalizedPhase;
    }

    return normalizedPhase;
  }

  /**
   * Validate and normalize turn value
   * @param {*} turn - Turn value to validate
   * @returns {number} Validated turn number
   * @private
   */
  _validateTurn(turn) {
    if (turn === undefined || turn === null) {
      logger.warn('Turn value missing, defaulting to 0');
      return 0;
    }

    const parsedTurn = Number(turn);
    
    if (isNaN(parsedTurn) || !Number.isInteger(parsedTurn)) {
      logger.warn('Invalid turn value, defaulting to 0', { turn });
      return 0;
    }

    if (parsedTurn < 0) {
      logger.warn('Negative turn value, defaulting to 0', { turn: parsedTurn });
      return 0;
    }

    return parsedTurn;
  }

  /**
   * Parse leaders section from raw state
   * @param {Object[]} leadersData - Raw leaders data
   * @returns {Promise<Map<string, LeaderPosition>>} Map of leader IDs to leader positions
   * @private
   */
  async _parseLeaders(leadersData) {
    const leaders = new Map();

    if (!leadersData || !Array.isArray(leadersData)) {
      logger.warn('Leaders data is missing or invalid');
      return leaders;
    }

    if (leadersData.length > MAX_LEADERS) {
      logger.warn('Leaders count exceeds maximum', {
        count: leadersData.length,
        max: MAX_LEADERS
      });
    }

    for (const leader of leadersData) {
      try {
        if (!leader || typeof leader !== 'object') {
          logger.warn('Invalid leader entry skipped', { leader });
          continue;
        }

        if (!leader.leaderId || typeof leader.leaderId !== 'string') {
          logger.warn('Leader missing or invalid leaderId', { leader });
          continue;
        }

        const leaderPosition = {
          leaderId: leader.leaderId,
          systemId: leader.systemId || null,
          status: this._validateStatus(leader.status),
          missionId: leader.missionId || null,
          side: this._validateSide(leader.side),
          cardId: leader.cardId || null,
          exhausted: Boolean(leader.exhausted),
          captured: Boolean(leader.captured)
        };

        leaders.set(leader.leaderId, leaderPosition);
      } catch (error) {
        logger.error('Error parsing leader entry', {
          error: error.message,
          leader: leader?.leaderId
        });
      }
    }

    return leaders;
  }

  /**
   * Parse missions section from raw state
   * @param {Object[]} missionsData - Raw missions data
   * @returns {Promise<Map<string, MissionAssignment>>} Map of mission IDs to mission assignments
   * @private
   */
  async _parseMissions(missionsData) {
    const missions = new Map();

    if (!missionsData || !Array.isArray(missionsData)) {
      logger.warn('Missions data is missing or invalid');
      return missions;
    }

    if (missionsData.length > MAX_MISSIONS) {
      logger.warn('Missions count exceeds maximum', {
        count: missionsData.length,
        max: MAX_MISSIONS
      });
    }

    for (const mission of missionsData) {
      try {
        if (!mission || typeof mission !== 'object') {
          logger.warn('Invalid mission entry skipped', { mission });
          continue;
        }

        if (!mission.missionId || typeof mission.missionId !== 'string') {
          logger.warn('Mission missing or invalid missionId', { mission });
          continue;
        }

        const missionAssignment = {
          missionId: mission.missionId,
          leaderIds: Array.isArray(mission.leaderIds) ? 
            mission.leaderIds.filter(id => typeof id === 'string') : [],
          side: this._validateSide(mission.side),
          resolved: Boolean(mission.resolved),
          type: mission.type || null,
          targetSystem: mission.targetSystem || null,
          cardId: mission.cardId || null,
          outcome: mission.outcome || null
        };

        missions.set(mission.missionId, missionAssignment);
      } catch (error) {
        logger.error('Error parsing mission entry', {
          error: error.message,
          mission: mission?.missionId
        });
      }
    }

    return missions;
  }

  /**
   * Parse systems section from raw state
   * @param {Object[]} systemsData - Raw systems data
   * @returns {Promise<Map<string, SystemActivation>>} Map of system IDs to system activations
   * @private
   */
  async _parseSystems(systemsData) {
    const systems = new Map();

    if (!systemsData || !Array.isArray(systemsData)) {
      logger.warn('Systems data is missing or invalid');
      return systems;
    }

    if (systemsData.length > MAX_SYSTEMS) {
      logger.warn('Systems count exceeds maximum', {
        count: systemsData.length,
        max: MAX_SYSTEMS
      });
    }

    for (const system of systemsData) {
      try {
        if (!system || typeof system !== 'object') {
          logger.warn('Invalid system entry skipped', { system });
          continue;
        }

        if (!system.systemId || typeof system.systemId !== 'string') {
          logger.warn('System missing or invalid systemId', { system });
          continue;
        }

        const units = Array.isArray(system.units) ? 
          system.units.slice(0, MAX_UNITS_PER_SYSTEM).filter(u => typeof u === 'string') : [];

        const systemActivation = {
          systemId: system.systemId,
          side: this._validateSide(system.side),
          units: units,
          activated: Boolean(system.activated),
          activatedBy: system.activatedBy || null,
          loyalty: system.loyalty || null,
          hasBase: Boolean(s