typescript
// js/log-analyzer.ts
// Analyzes the last 30 log entries to detect anomalies like Palpatine activation without unit movement

import { Logger } from './logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Represents a parsed log entry with structured data
 */
interface ParsedLogEntry {
  readonly turn: number;
  readonly faction: string;
  readonly action: string;
  readonly data: Record<string, unknown>;
  readonly raw: string;
}

/**
 * Represents a detected anomaly with severity and context
 */
interface Anomaly {
  readonly id: string;
  readonly type: AnomalyType;
  readonly severity: SeverityLevel;
  readonly timestamp: string;
  readonly details: Record<string, unknown>;
  readonly suggestion: string;
  readonly detectedAt: string;
}

/**
 * Types of anomalies that can be detected
 */
type AnomalyType = 
  | 'palpatine_activation_no_movement'
  | 'missing_deploy_after_assignment'
  | 'incomplete_phase_transition'
  | 'invalid_leader_assignment'
  | 'duplicate_action';

/**
 * Severity levels for anomalies
 */
type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

/**
 * Represents a Palpatine activation event
 */
interface PalpatineActivation {
  readonly index: number;
  readonly entry: ParsedLogEntry;
  readonly leaderId: string;
  readonly timestamp: string;
}

/**
 * Represents a leader assignment event
 */
interface AssignmentEntry {
  readonly index: number;
  readonly entry: ParsedLogEntry;
  readonly faction: string;
  readonly leaderIds: string[];
}

/**
 * Represents a phase transition event
 */
interface PhaseEntry {
  readonly index: number;
  readonly phase: string;
  readonly entry: ParsedLogEntry;
}

/**
 * Configuration for the log analyzer
 */
interface AnalyzerConfig {
  readonly maxLogs: number;
  readonly searchWindow: number;
  readonly palpatineVariants: readonly string[];
  readonly movementActions: readonly string[];
  readonly movementFields: readonly string[];
  readonly maxAssignmentSearchDepth: number;
}

/**
 * Default configuration for the log analyzer
 */
const DEFAULT_CONFIG: AnalyzerConfig = {
  maxLogs: 30,
  searchWindow: 5,
  palpatineVariants: ['palpatine', 'emperor-palpatine', 'darth-sidious', 'emperor'],
  movementActions: [
    'deploy', 'move', 'attack', 'retreat', 'reinforce',
    'transport', 'invade', 'bombard', 'blockade'
  ],
  movementFields: ['systemId', 'targetSystemId', 'fromSystemId', 'toSystemId', 'destination'],
  maxAssignmentSearchDepth: 10
};

/**
 * LogAnalyzer - Detects anomalies in game log entries
 * 
 * Anomalies detected:
 * - Palpatine activation without unit movement
 * - Missing deploy actions after leader assignments
 * - Incomplete phase transitions
 * - Invalid leader assignments
 * - Duplicate actions
 * 
 * @class LogAnalyzer
 */
class LogAnalyzer {
  private anomalies: Anomaly[] = [];
  private lastLogs: string[] = [];
  private readonly config: AnalyzerConfig;
  private readonly logger: Logger;
  private analysisCount: number = 0;

  /**
   * Creates an instance of LogAnalyzer
   * @param logger - Logger instance for logging
   * @param config - Optional configuration overrides
   * @throws {Error} If logger is not provided
   */
  constructor(logger: Logger, config?: Partial<AnalyzerConfig>) {
    if (!logger) {
      throw new Error('Logger instance is required');
    }

    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.anomalies = [];
    this.lastLogs = [];
    
    this.logger.info('LogAnalyzer initialized', {
      config: this.config,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Feed log entries into the analyzer
   * @param logEntries - Array of log entry strings
   * @throws {Error} If logEntries is not an array or contains invalid entries
   */
  public feedLogs(logEntries: string[]): void {
    if (!Array.isArray(logEntries)) {
      throw new Error('logEntries must be an array');
    }

    if (logEntries.length === 0) {
      this.logger.warn('Empty log entries array provided');
      return;
    }

    const validEntries = logEntries.filter((entry): entry is string => {
      if (typeof entry !== 'string') {
        this.logger.warn('Invalid log entry type', { type: typeof entry });
        return false;
      }
      return entry.trim().length > 0;
    });

    if (validEntries.length === 0) {
      this.logger.warn('No valid log entries found');
      return;
    }

    this.lastLogs = validEntries.slice(-this.config.maxLogs);
    this.logger.debug('Logs fed to analyzer', {
      totalEntries: validEntries.length,
      storedEntries: this.lastLogs.length
    });

    this.analyze();
  }

  /**
   * Add a single log entry
   * @param logEntry - Single log entry string
   * @throws {Error} If logEntry is not a string or is empty
   */
  public addLog(logEntry: string): void {
    if (typeof logEntry !== 'string') {
      throw new Error('logEntry must be a string');
    }

    const trimmedEntry = logEntry.trim();
    if (trimmedEntry.length === 0) {
      throw new Error('logEntry cannot be empty');
    }

    this.lastLogs.push(trimmedEntry);
    
    if (this.lastLogs.length > this.config.maxLogs) {
      this.lastLogs.shift();
    }

    this.logger.debug('Single log entry added', {
      entryLength: trimmedEntry.length,
      totalEntries: this.lastLogs.length
    });

    this.analyze();
  }

  /**
   * Get all detected anomalies
   * @returns Readonly array of anomalies
   */
  public getAnomalies(): ReadonlyArray<Anomaly> {
    return Object.freeze([...this.anomalies]);
  }

  /**
   * Clear all detected anomalies
   */
  public clearAnomalies(): void {
    this.anomalies = [];
    this.logger.debug('Anomalies cleared');
  }

  /**
   * Get the current log entries
   * @returns Readonly array of log entries
   */
  public getLogs(): ReadonlyArray<string> {
    return Object.freeze([...this.lastLogs]);
  }

  /**
   * Parse a log entry into structured data
   * @param entry - Raw log entry
   * @returns Parsed log entry or null if invalid
   */
  private parseLogEntry(entry: string): ParsedLogEntry | null {
    if (!entry || typeof entry !== 'string') {
      return null;
    }

    try {
      const parts = entry.trim().split(/\s+/);
      
      if (parts.length < 3) {
        this.logger.debug('Log entry has insufficient parts', { entry });
        return null;
      }

      const [turnStr, faction, action, ...rest] = parts;
      
      // Validate turn format
      const turnMatch = turnStr.match(/^t(\d+)$/);
      if (!turnMatch) {
        this.logger.debug('Invalid turn format', { turn: turnStr });
        return null;
      }

      const turn = parseInt(turnMatch[1], 10);
      if (isNaN(turn) || turn < 0) {
        this.logger.debug('Invalid turn number', { turn: turnStr });
        return null;
      }

      // Validate faction
      if (!faction || faction.length === 0) {
        this.logger.debug('Empty faction', { entry });
        return null;
      }

      const dataStr = rest.join(' ');
      let data: Record<string, unknown> = {};

      if (dataStr) {
        try {
          data = JSON.parse(dataStr) as Record<string, unknown>;
          
          // Validate parsed data is an object
          if (typeof data !== 'object' || data === null || Array.isArray(data)) {
            data = { raw: dataStr };
          }
        } catch {
          data = { raw: dataStr };
        }
      }

      return {
        turn,
        faction: faction.toLowerCase(),
        action: action.toLowerCase(),
        data,
        raw: entry
      };
    } catch (error) {
      this.logger.error('Failed to parse log entry', {
        entry,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * Check if a leader is Palpatine
   * @param leaderId - Leader identifier
   * @returns True if the leader is Palpatine
   */
  private isPalpatine(leaderId: string): boolean {
    if (!leaderId || typeof leaderId !== 'string') {
      return false;
    }

    const normalizedId = leaderId.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return this.config.palpatineVariants.some(variant => 
      normalizedId.includes(variant.toLowerCase().replace(/[^a-z0-9-]/g, ''))
    );
  }

  /**
   * Check if an action involves unit movement
   * @param action - Action string
   * @param data - Action data
   * @returns True if the action involves movement
   */
  private isMovementAction(action: string, data: Record<string, unknown>): boolean {
    if (!action || typeof action !== 'string') {
      return false;
    }

    const normalizedAction = action.toLowerCase();
    
    // Check if action type is a movement action
    if (this.config.movementActions.includes(normalizedAction)) {
      return true;
    }

    // Check if data contains movement fields
    return this.config.movementFields.some(field => 
      field in data && data[field] !== null && data[field] !== undefined
    );
  }

  /**
   * Search for movement actions after a Palpatine activation
   * @param activationIndex - Index of the activation entry
   * @param parsedLogs - Array of parsed log entries
   * @returns True if movement was found
   */
  private searchForMovementAfterActivation(
    activationIndex: number,
    parsedLogs: ParsedLogEntry[]
  ): boolean {
    if (activationIndex < 0 || activationIndex >= parsedLogs.length) {
      return false;
    }

    const searchEnd = Math.min(
      activationIndex + this.config.searchWindow,
      parsedLogs.length
    );

    for (let i = activationIndex + 1; i < searchEnd; i++) {
      const entry = parsedLogs[i];
      if (entry && this.isMovementAction(entry.action, entry.data)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detect Palpatine activation without unit movement
   * @param parsedLogs - Array of parsed log entries
   */
  private detectPalpatineActivationNoMovement(parsedLogs: ParsedLogEntry[]): void {
    if (!parsedLogs || parsedLogs.length === 0) {
      return;
    }

    try {
      const palpatineActivations: PalpatineActivation[] = [];

      // Find all Palpatine activations
      for (let i = 0; i < parsedLogs.length; i++) {
        const entry = parsedLogs[i];
        if (!entry) continue;

        if (entry.action === 'recruit-leader' || entry.action === 'activate-leader') {
          const leaderId = entry.data?.leaderId as string;
          
          if (leaderId && this.isPalpatine(leaderId)) {
            palpatineActivations.push({
              index: i,
              entry,
              leaderId,
              timestamp: new Date().toISOString()
            });
          }
        }
      }

      // Check each activation for subsequent movement
      for (const activation of palpatineActivations) {
        const hasMovement = this.searchForMovementAfterActivation(
          activation.index,
          parsedLogs
        );

        if (!hasMovement) {
          const anomaly: Anomaly = {
            id: uuidv4(),
            type: 'palpatine_activation_no_movement',
            severity: 'high',
            timestamp: activation.timestamp,
            details: {
              leaderId: activation.leaderId,
              activationEntry: activation.entry.raw,
              turn: activation.entry.turn,
              faction: activation.entry.faction,
              searchWindow: this.config.searchWindow
            },
            suggestion: 'Palpatine was activated but no unit movement was detected. Consider deploying or moving units to utilize Palpatine\'s abilities.',
            detectedAt: new Date().toISOString()
          };

          this.anomalies.push(anomaly);
          this.logger.warn('Detected Palpatine activation without movement', anomaly.details);
        }
      }
    } catch (error) {
      this.logger.error('Error detecting Palpatine activation anomalies', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Detect missing deploy actions after leader assignments
   * @param parsedLogs - Array of parsed log entries
   */
  private detectMissingDeployAfterAssignment(parsedLogs: ParsedLogEntry[]): void {
    if (!parsedLogs || parsedLogs.length === 0) {
      return;
    }

    try {
      const assignments: AssignmentEntry[] = [];

      // Find all leader assignments
      for (let i = 0; i < parsedLogs.length; i++) {
        const entry = parsedLogs[i];
        if (!entry) continue;

        if (entry.action === 'assign-leader') {
          const leaderIds = entry.data?.leaderIds as string[];
          
          if (leaderIds && Array.isArray(leaderIds) && leaderIds.length > 0) {
            assignments.push({
              index: i,
              entry,
              faction: entry.faction,
              leaderIds
            });
          }
        }
      }

      // Check each assignment for subsequent deploy actions
      for (const assignment of assignments) {
        const searchEnd = Math.min(
          assignment.index + this.config.maxAssignmentSearchDepth,
          parsedLogs.length
        );

        let hasDeploy = false;
        for (let i = assignment.index + 1; i < searchEnd; i++) {
          const entry = parsedLogs[i];
          if (entry && entry.action === 'deploy') {
            hasDeploy = true;
            break;
          }
        }

        if (!hasDeploy) {
          const anomaly: Anomaly = {
            id: uuidv4(),
            type: 'missing_deploy_after_assignment',
            severity: 'medium',
            timestamp: new Date().toISOString(),
            details: {
              faction: assignment.faction,
              leaderIds: assignment.leaderIds,
              assignmentEntry: assignment.entry.raw,
              turn: assignment.entry.turn
            },
            suggestion: 'Leaders were assigned but no deploy actions followed. Consider deploying units to utilize assigned leaders.',
            detectedAt: new Date().toISOString()
          };

          this.anomalies.push(anomaly);
          this.logger.warn('Detected missing deploy after assignment', anomaly.details);
        }
      }
    } catch (error) {
      this.logger.error('Error detecting missing deploy anomalies', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Detect incomplete phase transitions
   * @param parsedLogs - Array of parsed log entries
   */
  private detectIncompletePhaseTransition(parsedLogs: ParsedLogEntry[]): void {
    if (!parsedLogs || parsedLogs.length < 2) {
      return;
    }

    try {
      const phases: PhaseEntry[] = [];

      // Find all phase transitions
      for (let i = 0; i < parsedLogs.length; i++) {
        const entry = parsedLogs[i];
        if (!entry) continue;

        if (entry.action === 'phase') {
          const phase = entry.data?.phase as string;
          
          if (phase && typeof phase === 'string') {
            phases.push({
              index: i,
              phase,
              entry
            });
          }
        }
      }

      // Check for incomplete transitions
      for (let i = 0; i < phases.length - 1; i++) {
        const currentPhase = phases[i];
        const nextPhase = phases[i + 1];
        
        // Check if there are actions between phases
        const actionsBetween = parsedLogs.slice(
          currentPhase.index + 1,
          nextPhase.index
        );

        if (actionsBetween.length === 0) {
          const anomaly: Anomaly = {
            id: uuidv4(),
            type: 'incomplete_phase_transition',
            severity: 'low',
            timestamp: new Date().toISOString(),
            details: {
              fromPhase: currentPhase.phase,
              toPhase: nextPhase.phase,
              fromEntry: currentPhase.entry.raw,
              toEntry: nextPhase.entry.raw,
              turn: currentPhase.entry.turn
            },
            suggestion: 'Phase transition occurred without any actions between phases. This may indicate a skipped turn or missing actions.',
            detectedAt: new Date().toISOString()
          };

          this.anomalies.push(anomaly);
          this.logger.info('Detected incomplete phase transition', anomaly.details);
        }
      }
    } catch (error) {
      this.logger.error('Error detecting phase transition anomalies', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Detect invalid leader assignments
   * @param parsedLogs - Array of parsed log entries
   */
  private detectInvalidLeaderAssignment(parsedLogs: ParsedLogEntry[]): void {
    if (!parsedLogs || parsedLogs.length === 0) {
      return;
    }

    try {
      const assignedLeaders = new Map<string, Set<string>>();

      for (const entry of parsedLogs) {
        if (!entry) continue;

        if (entry.action === 'assign-leader') {
          const leaderIds = entry.data?.leaderIds as string[];
          const missionId = entry.data?.missionId as string;

          if (leaderIds && Array.isArray(leaderIds) && missionId) {
            // Check for duplicate assignments
            for (const leaderId of leaderIds) {
              if (ass