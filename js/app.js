typescript
// js/app.ts - Core application logic for log parsing, game state rendering, filtering/searching

import { Logger } from './logger';
import { Validator } from './validator';
import { MetricsCollector } from './metrics';

// Type definitions
interface LogEntry {
  readonly id: string;
  readonly raw: string;
  readonly time: number;
  readonly side: 'Rebel' | 'Empire' | 'unknown';
  readonly action: string;
  readonly data: Record<string, unknown> | null;
  readonly timestamp: number;
  readonly metadata: LogEntryMetadata;
}

interface LogEntryMetadata {
  readonly type: ActionCategory;
  readonly hasLeaders: boolean;
  readonly hasMissions: boolean;
  readonly hasObjectives: boolean;
  readonly isChoice: boolean;
  readonly isRecruit: boolean;
  readonly isDraw: boolean;
  readonly isAdvance: boolean;
}

interface GameState {
  currentTime: number;
  rebel: FactionState;
  empire: FactionState;
  timeline: TimelineEntry[];
}

interface FactionState {
  leaders: string[];
  missions: string[];
  objectives: string[];
  probes: string[];
  hand: string[];
  resources: Record<string, number>;
}

interface TimelineEntry {
  time: number;
  side: string;
  action: string;
  summary: string;
}

interface FilterState {
  side: 'all' | 'rebel' | 'empire';
  type: ActionCategory | 'all';
  search: string;
  timeRange: { min: number; max: number };
}

type ActionCategory = 'recruit' | 'draw' | 'choice' | 'advance' | 'objective' | 'refresh' | 'mission' | 'probe' | 'other';

type SubscriberEvent = 'logs-parsed' | 'state-updated' | 'filter-changed' | 'error';

interface SubscriberCallback {
  (event: SubscriberEvent, data: unknown): void;
}

// Constants
const VALID_SIDES: ReadonlyArray<string> = ['rebel', 'empire'] as const;
const MAX_LOG_ENTRIES: number = 10000;
const PERFORMANCE_THRESHOLD_MS: number = 50;
const MAX_INPUT_LENGTH: number = 1000000;
const CHUNK_SIZE: number = 100;
const MAX_RETRY_ATTEMPTS: number = 3;
const CACHE_TTL_MS: number = 5000;

class GameLogParser {
  private logEntries: LogEntry[] = [];
  private gameState: GameState;
  private filters: FilterState;
  private subscribers: Map<SubscriberEvent, Set<SubscriberCallback>>;
  private logger: Logger;
  private validator: Validator;
  private metrics: MetricsCollector;
  private isProcessing: boolean = false;
  private processingQueue: string[] = [];
  private cache: Map<string, { data: unknown; timestamp: number }> = new Map();

  constructor() {
    this.logger = new Logger('GameLogParser');
    this.validator = new Validator();
    this.metrics = new MetricsCollector();
    this.subscribers = new Map();
    
    this.gameState = this.initializeGameState();
    this.filters = this.initializeFilters();
    
    this.initializeSubscriberMap();
  }

  private initializeGameState(): GameState {
    return {
      currentTime: 0,
      rebel: this.createEmptyFactionState(),
      empire: this.createEmptyFactionState(),
      timeline: []
    };
  }

  private createEmptyFactionState(): FactionState {
    return {
      leaders: [],
      missions: [],
      objectives: [],
      probes: [],
      hand: [],
      resources: {}
    };
  }

  private initializeFilters(): FilterState {
    return {
      side: 'all',
      type: 'all',
      search: '',
      timeRange: { min: 0, max: Infinity }
    };
  }

  private initializeSubscriberMap(): void {
    const events: SubscriberEvent[] = ['logs-parsed', 'state-updated', 'filter-changed', 'error'];
    events.forEach(event => this.subscribers.set(event, new Set()));
  }

  /**
   * Parse raw log text into structured entries with validation and error handling
   * @param {string} rawLogs - Raw log text from the game
   * @returns {Promise<LogEntry[]>} Parsed log entries
   * @throws {Error} If input validation fails
   */
  public async parseLogs(rawLogs: string): Promise<LogEntry[]> {
    const startTime = performance.now();
    const cacheKey = `parse-${rawLogs.length}-${rawLogs.slice(0, 100)}`;
    
    // Check cache
    const cached = this.getFromCache<LogEntry[]>(cacheKey);
    if (cached) {
      this.logger.debug('Returning cached parse result');
      return cached;
    }
    
    try {
      // Input validation
      this.validateInput(rawLogs);

      // Sanitize input
      const sanitizedLogs = this.sanitizeInput(rawLogs);
      
      // Parse lines
      const lines = sanitizedLogs.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

      if (lines.length > MAX_LOG_ENTRIES) {
        this.logger.warn(`Truncating log entries from ${lines.length} to ${MAX_LOG_ENTRIES}`);
        lines.length = MAX_LOG_ENTRIES;
      }

      // Process in chunks for performance
      this.logEntries = [];
      
      for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
        const chunk = lines.slice(i, i + CHUNK_SIZE);
        const parsedChunk = await this.processChunk(chunk, i);
        this.logEntries.push(...parsedChunk);
      }

      // Update game state
      this.updateGameState(this.logEntries);

      // Cache the result
      this.setCache(cacheKey, this.logEntries);

      // Notify subscribers
      this.notifySubscribers('logs-parsed', this.logEntries);

      // Track metrics
      const duration = performance.now() - startTime;
      this.metrics.recordParseDuration(duration);
      
      if (duration > PERFORMANCE_THRESHOLD_MS) {
        this.logger.warn(`Parse operation took ${duration}ms, exceeding threshold`);
      }

      return this.logEntries;

    } catch (error) {
      this.logger.error('Failed to parse logs', error as Error);
      this.notifySubscribers('error', { 
        message: 'Failed to parse logs', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  /**
   * Validate input parameters
   * @param {string} rawLogs - Input to validate
   * @throws {Error} If validation fails
   */
  private validateInput(rawLogs: string): void {
    if (!this.validator.isValidString(rawLogs)) {
      throw new Error('Invalid input: rawLogs must be a non-empty string');
    }

    if (rawLogs.length > MAX_INPUT_LENGTH) {
      throw new Error(`Input too large: maximum ${MAX_INPUT_LENGTH / 1000000}MB of log data allowed`);
    }

    // Security check for potential injection
    if (this.containsMaliciousContent(rawLogs)) {
      throw new Error('Input contains potentially malicious content');
    }
  }

  /**
   * Check for malicious content in input
   * @param {string} input - Input to check
   * @returns {boolean} Whether malicious content was found
   */
  private containsMaliciousContent(input: string): boolean {
    const maliciousPatterns = [
      /<script[\s>]/i,
      /javascript:/i,
      /on\w+=/i,
      /data:\s*text\/html/i
    ];
    
    return maliciousPatterns.some(pattern => pattern.test(input));
  }

  /**
   * Process a chunk of lines with retry logic
   * @param {string[]} chunk - Array of log lines
   * @param {number} startIndex - Starting index for the chunk
   * @returns {Promise<LogEntry[]>} Parsed log entries
   */
  private async processChunk(chunk: string[], startIndex: number): Promise<LogEntry[]> {
    let attempts = 0;
    
    while (attempts < MAX_RETRY_ATTEMPTS) {
      try {
        return chunk.map((line, index) => this.parseLine(line, startIndex + index));
      } catch (error) {
        attempts++;
        if (attempts >= MAX_RETRY_ATTEMPTS) {
          throw error;
        }
        this.logger.warn(`Retry attempt ${attempts} for chunk starting at ${startIndex}`);
        await this.delay(100 * attempts);
      }
    }
    
    return [];
  }

  /**
   * Parse a single log line with comprehensive error handling
   * @param {string} line - Single log line
   * @param {number} index - Line index for identification
   * @returns {LogEntry} Parsed log entry
   */
  private parseLine(line: string, index: number): LogEntry {
    try {
      const parts = line.split(' ');
      const timeStr = parts[0];
      const side = parts[1] as 'Rebel' | 'Empire' | 'unknown';
      const action = parts[2];
      
      // Validate time format
      if (!timeStr || isNaN(Number(timeStr.replace('t', '')))) {
        throw new Error(`Invalid time format at line ${index}: ${timeStr}`);
      }
      
      // Validate side
      if (!['Rebel', 'Empire', 'unknown'].includes(side)) {
        throw new Error(`Invalid side at line ${index}: ${side}`);
      }
      
      // Parse JSON data if present
      let data: Record<string, unknown> | null = null;
      const dataStr = parts.slice(3).join(' ');
      if (dataStr) {
        try {
          data = JSON.parse(dataStr) as Record<string, unknown>;
        } catch {
          // If JSON parsing fails, store as raw string
          data = { raw: dataStr };
        }
      }
      
      const entry: LogEntry = {
        id: `${index}-${Date.now()}`,
        raw: line,
        time: parseInt(timeStr.replace('t', ''), 10),
        side: side as 'Rebel' | 'Empire' | 'unknown',
        action: action || 'unknown',
        data,
        timestamp: Date.now(),
        metadata: this.extractMetadata(action, data)
      };
      
      return entry;
    } catch (error) {
      this.logger.error(`Failed to parse line ${index}: ${line}`, error as Error);
      // Return a fallback entry for malformed lines
      return {
        id: `error-${index}-${Date.now()}`,
        raw: line,
        time: 0,
        side: 'unknown',
        action: 'parse-error',
        data: { error: error instanceof Error ? error.message : 'Unknown error' },
        timestamp: Date.now(),
        metadata: {
          type: 'other',
          hasLeaders: false,
          hasMissions: false,
          hasObjectives: false,
          isChoice: false,
          isRecruit: false,
          isDraw: false,
          isAdvance: false
        }
      };
    }
  }

  /**
   * Extract metadata from log entry
   * @param {string} action - Action type
   * @param {Record<string, unknown> | null} data - Parsed data
   * @returns {LogEntryMetadata} Extracted metadata
   */
  private extractMetadata(action: string, data: Record<string, unknown> | null): LogEntryMetadata {
    const type = this.categorizeAction(action);
    const hasLeaders = data?.leaderIds !== undefined || data?.leaderId !== undefined;
    const hasMissions = data?.missionIds !== undefined || data?.missionId !== undefined;
    const hasObjectives = data?.objectiveIds !== undefined || data?.objectiveId !== undefined;
    
    return {
      type,
      hasLeaders,
      hasMissions,
      hasObjectives,
      isChoice: action.includes('choice'),
      isRecruit: action.includes('recruit'),
      isDraw: action.includes('draw'),
      isAdvance: action.includes('advance')
    };
  }

  /**
   * Categorize action type
   * @param {string} action - Action string
   * @returns {ActionCategory} Categorized action type
   */
  private categorizeAction(action: string): ActionCategory {
    if (action.includes('recruit')) return 'recruit';
    if (action.includes('draw')) return 'draw';
    if (action.includes('choice')) return 'choice';
    if (action.includes('advance')) return 'advance';
    if (action.includes('objective')) return 'objective';
    if (action.includes('refresh')) return 'refresh';
    if (action.includes('mission')) return 'mission';
    if (action.includes('probe')) return 'probe';
    return 'other';
  }

  /**
   * Update game state based on parsed log entries
   * @param {LogEntry[]} entries - Parsed log entries
   */
  private updateGameState(entries: LogEntry[]): void {
    try {
      for (const entry of entries) {
        if (entry.side === 'unknown') continue;
        
        const faction = entry.side.toLowerCase() as 'rebel' | 'empire';
        const state = this.gameState[faction];
        
        // Update time
        if (entry.time > this.gameState.currentTime) {
          this.gameState.currentTime = entry.time;
        }
        
        // Update faction state based on action
        if (entry.metadata.hasLeaders && entry.data?.leaderIds) {
          const leaderIds = entry.data.leaderIds as string[];
          state.leaders = [...new Set([...state.leaders, ...leaderIds])];
        }
        
        if (entry.metadata.hasMissions && entry.data?.missionIds) {
          const missionIds = entry.data.missionIds as string[];
          state.missions = [...new Set([...state.missions, ...missionIds])];
        }
        
        if (entry.metadata.hasObjectives && entry.data?.objectiveIds) {
          const objectiveIds = entry.data.objectiveIds as string[];
          state.objectives = [...new Set([...state.objectives, ...objectiveIds])];
        }
        
        // Add to timeline
        this.gameState.timeline.push({
          time: entry.time,
          side: entry.side,
          action: entry.action,
          summary: this.generateSummary(entry)
        });
      }
      
      this.notifySubscribers('state-updated', this.gameState);
    } catch (error) {
      this.logger.error('Failed to update game state', error as Error);
      throw error;
    }
  }

  /**
   * Generate human-readable summary for log entry
   * @param {LogEntry} entry - Log entry
   * @returns {string} Summary string
   */
  private generateSummary(entry: LogEntry): string {
    const summaries: Record<string, (entry: LogEntry) => string> = {
      'recruit': (e) => {
        if (e.data?.leaderId) return `${e.side} recruited ${e.data.leaderId}`;
        if (e.data?.cardId) return `${e.side} recruited card ${e.data.cardId}`;
        return `${e.side} performed recruit action`;
      },
      'draw': (e) => {
        if (e.data?.missionIds) return `${e.side} drew ${(e.data.missionIds as string[]).length} missions`;
        if (e.data?.probeIds) return `${e.side} drew ${(e.data.probeIds as string[]).length} probes`;
        if (e.data?.objectiveIds) return `${e.side} drew ${(e.data.objectiveIds as string[]).length} objectives`;
        return `${e.side} performed draw action`;
      },
      'choice': (e) => `${e.side} made a choice: ${e.data?.kind || 'unknown'}`,
      'advance': (e) => `Time advanced to ${e.data?.newValue || 'unknown'}`,
      'default': (e) => `${e.side} performed ${e.action}`
    };
    
    const summaryFn = summaries[entry.metadata.type] || summaries['default'];
    return summaryFn(entry);
  }

  /**
   * Sanitize input string
   * @param {string} input - Input to sanitize
   * @returns {string} Sanitized input
   */
  private sanitizeInput(input: string): string {
    // Remove null bytes
    let sanitized = input.replace(/\0/g, '');
    
    // Remove control characters except newlines and tabs
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    
    // Normalize line endings
    sanitized = sanitized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    return sanitized;
  }

  /**
   * Get cached data if not expired
   * @param {string} key - Cache key
   * @returns {T | null} Cached data or null
   */
  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data as T;
    }
    return null;
  }

  /**
   * Set cache entry
   * @param {string} key - Cache key
   * @param {unknown} data - Data to cache
   */
  private setCache(key: string, data: unknown): void {
    this.cache.set(key, { data, timestamp: Date.now() });
    
    // Clean old cache entries
    if (this.cache.size > 100) {
      const now = Date.now();
      for (const [cacheKey, value] of this.cache) {
        if (now - value.timestamp > CACHE_TTL_MS * 2) {
          this.cache.delete(cacheKey);
        }
      }
    }
  }

  /**
   * Delay execution
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Not