javascript
// app.ts - Client-side logic for Star Wars Rebellion game state viewer
// Production quality implementation with comprehensive error handling, type safety, and logging

'use strict';

// ============================================================================
// External Dependencies
// ============================================================================
// None - pure TypeScript implementation

// ============================================================================
// Configuration
// ============================================================================
interface AppConfig {
  readonly colors: {
    readonly primary: string;
    readonly secondary: string;
    readonly accent: string;
    readonly empire: string;
    readonly rebel: string;
    readonly neutral: string;
    readonly text: string;
    readonly background: string;
  };
  readonly typography: {
    readonly headings: string;
    readonly body: string;
    readonly baseSize: string;
    readonly scale: number;
  };
  readonly spacing: {
    readonly xs: string;
    readonly sm: string;
    readonly md: string;
    readonly lg: string;
    readonly xl: string;
  };
  readonly logLimit: number;
  readonly breakpoints: {
    readonly mobile: number;
    readonly tablet: number;
  };
  readonly github: {
    readonly apiBaseUrl: string;
    readonly token: string;
    readonly timeout: number;
    readonly retryAttempts: number;
    readonly retryDelay: number;
    readonly maxRetryDelay: number;
    readonly userAgent: string;
  };
}

const CONFIG: AppConfig = Object.freeze({
  colors: Object.freeze({
    primary: '#1a1a2e',
    secondary: '#16213e',
    accent: '#0f3460',
    empire: '#e94560',
    rebel: '#4ecca3',
    neutral: '#f5f5f5',
    text: '#e0e0e0',
    background: '#0a0a1a'
  }),
  typography: Object.freeze({
    headings: "'Orbitron', sans-serif",
    body: "'Roboto Mono', monospace",
    baseSize: '16px',
    scale: 1.25
  }),
  spacing: Object.freeze({
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '48px'
  }),
  logLimit: 30,
  breakpoints: Object.freeze({
    mobile: 768,
    tablet: 1024
  }),
  github: Object.freeze({
    apiBaseUrl: 'https://api.github.com',
    token: '',
    timeout: 10000,
    retryAttempts: 3,
    retryDelay: 1000,
    maxRetryDelay: 10000,
    userAgent: 'star-wars-rebellion-viewer/1.0'
  })
});

// ============================================================================
// Custom Error Types
// ============================================================================
class GameStateError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GameStateError';
    Object.setPrototypeOf(this, GameStateError.prototype);
  }
}

class ParseError extends GameStateError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PARSE_ERROR', details);
    this.name = 'ParseError';
    Object.setPrototypeOf(this, ParseError.prototype);
  }
}

class ValidationError extends GameStateError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

class SecurityError extends GameStateError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SECURITY_ERROR', details);
    this.name = 'SecurityError';
    Object.setPrototypeOf(this, SecurityError.prototype);
  }
}

class GitHubApiError extends GameStateError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string,
    details?: Record<string, unknown>
  ) {
    super(message, 'GITHUB_API_ERROR', { ...details, statusCode, responseBody });
    this.name = 'GitHubApiError';
    Object.setPrototypeOf(this, GitHubApiError.prototype);
  }
}

// ============================================================================
// Logger
// ============================================================================
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4
}

interface LogEntry {
  readonly timestamp: string;
  readonly level: string;
  readonly prefix: string;
  readonly message: string;
  readonly args: ReadonlyArray<unknown>;
}

class Logger {
  private static instance: Logger | null = null;
  private readonly level: LogLevel;
  private readonly prefix: string;
  private readonly buffer: LogEntry[] = [];
  private readonly maxBufferSize: number = 1000;

  private constructor(level: LogLevel = LogLevel.INFO, prefix: string = 'SWR') {
    this.level = level;
    this.prefix = prefix;
  }

  /**
   * Get singleton instance of Logger
   * @param level - Minimum log level to output
   * @param prefix - Prefix for log messages
   * @returns Logger instance
   */
  public static getInstance(level?: LogLevel, prefix?: string): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(level, prefix);
    }
    return Logger.instance;
  }

  /**
   * Reset logger instance (useful for testing)
   */
  public static resetInstance(): void {
    Logger.instance = null;
  }

  /**
   * Format log message with timestamp and metadata
   */
  private formatMessage(level: string, message: string, ...args: unknown[]): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      prefix: this.prefix,
      message,
      args: Object.freeze([...args])
    };
    return entry;
  }

  /**
   * Add entry to internal buffer for later retrieval
   */
  private addToBuffer(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
  }

  /**
   * Get buffered log entries
   */
  public getBuffer(): ReadonlyArray<LogEntry> {
    return Object.freeze([...this.buffer]);
  }

  /**
   * Clear log buffer
   */
  public clearBuffer(): void {
    this.buffer.length = 0;
  }

  public debug(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      const entry = this.formatMessage('DEBUG', message, ...args);
      this.addToBuffer(entry);
      console.debug(`[${entry.timestamp}] [${this.prefix}] [DEBUG] ${message}`, ...args);
    }
  }

  public info(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      const entry = this.formatMessage('INFO', message, ...args);
      this.addToBuffer(entry);
      console.info(`[${entry.timestamp}] [${this.prefix}] [INFO] ${message}`, ...args);
    }
  }

  public warn(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      const entry = this.formatMessage('WARN', message, ...args);
      this.addToBuffer(entry);
      console.warn(`[${entry.timestamp}] [${this.prefix}] [WARN] ${message}`, ...args);
    }
  }

  public error(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.ERROR) {
      const entry = this.formatMessage('ERROR', message, ...args);
      this.addToBuffer(entry);
      console.error(`[${entry.timestamp}] [${this.prefix}] [ERROR] ${message}`, ...args);
    }
  }

  public fatal(message: string, ...args: unknown[]): void {
    const entry = this.formatMessage('FATAL', message, ...args);
    this.addToBuffer(entry);
    console.error(`[${entry.timestamp}] [${this.prefix}] [FATAL] ${message}`, ...args);
  }
}

// ============================================================================
// Interfaces and Types
// ============================================================================
interface LogEntryData {
  timestamp?: string;
  side?: string;
  action?: string;
  details?: string;
  raw: string;
}

interface GameData {
  [key: string]: unknown;
}

interface GameStateData {
  logs: LogEntryData[];
  humanSide: string;
  [key: string]: unknown;
}

// ============================================================================
// GitHub API Client
// ============================================================================
class GitHubClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeout: number;
  private readonly retryAttempts: number;
  private readonly retryDelay: number;
  private readonly maxRetryDelay: number;
  private readonly userAgent: string;
  private readonly logger: Logger;

  constructor(config: AppConfig['github'], logger: Logger) {
    this.baseUrl = config.apiBaseUrl;
    this.token = config.token;
    this.timeout = config.timeout;
    this.retryAttempts = config.retryAttempts;
    this.retryDelay = config.retryDelay;
    this.maxRetryDelay = config.maxRetryDelay;
    this.userAgent = config.userAgent;
    this.logger = logger;
  }

  /**
   * Check if token is configured
   */
  public hasToken(): boolean {
    return this.token.length > 0;
  }

  /**
   * Make authenticated request to GitHub API
   */
  public async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': this.userAgent,
      'Content-Type': 'application/json'
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const responseBody = await response.text();
        throw new GitHubApiError(
          `GitHub API request failed: ${response.status} ${response.statusText}`,
          response.status,
          responseBody,
          { url, method }
        );
      }

      return await response.json() as T;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof GitHubApiError) {
        throw error;
      }
      
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new GitHubApiError(
          `Request timed out after ${this.timeout}ms`,
          408,
          undefined,
          { url, method }
        );
      }

      throw new GitHubApiError(
        `Network error: ${(error as Error).message}`,
        0,
        undefined,
        { url, method, originalError: (error as Error).message }
      );
    }
  }

  /**
   * Retry a request with exponential backoff
   */
  public async requestWithRetry<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    let lastError: Error | null = null;
    let delay = this.retryDelay;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        this.logger.debug(`GitHub API request attempt ${attempt}/${this.retryAttempts}`, { method, path });
        return await this.request<T>(method, path, body);
      } catch (error) {
        lastError = error as Error;
        
        if (error instanceof GitHubApiError) {
          // Don't retry 403 errors - they indicate authentication/permission issues
          if (error.statusCode === 403) {
            this.logger.error('GitHub API 403 Forbidden - check authentication and permissions', {
              path,
              method,
              statusCode: error.statusCode
            });
            throw error;
          }
          
          // Don't retry 401 errors
          if (error.statusCode === 401) {
            this.logger.error('GitHub API 401 Unauthorized - check token', {
              path,
              method,
              statusCode: error.statusCode
            });
            throw error;
          }
          
          // Don't retry 404 errors
          if (error.statusCode === 404) {
            this.logger.error('GitHub API 404 Not Found', {
              path,
              method,
              statusCode: error.statusCode
            });
            throw error;
          }
        }

        if (attempt < this.retryAttempts) {
          this.logger.warn(`Retrying request in ${delay}ms`, {
            attempt,
            error: lastError.message
          });
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, this.maxRetryDelay);
        }
      }
    }

    throw lastError || new Error('Request failed after all retry attempts');
  }

  /**
   * Fork a repository
   */
  public async forkRepository(owner: string, repo: string): Promise<unknown> {
    return this.requestWithRetry('POST', `/repos/${owner}/${repo}/forks`);
  }

  /**
   * Get repository contents
   */
  public async getContents(owner: string, repo: string, path: string): Promise<unknown> {
    return this.requestWithRetry('GET', `/repos/${owner}/${repo}/contents/${path}`);
  }
}

// ============================================================================
// Game State Manager
// ============================================================================
class GameStateManager {
  private readonly logger: Logger;
  private state: GameStateData | null = null;
  private readonly githubClient: GitHubClient;

  constructor(logger: Logger, githubClient: GitHubClient) {
    this.logger = logger;
    this.githubClient = githubClient;
  }

  /**
   * Load game state from GitHub
   */
  public async loadFromGitHub(owner: string, repo: string, path: string): Promise<void> {
    try {
      this.logger.info('Loading game state from GitHub', { owner, repo, path });
      
      if (!this.githubClient.hasToken()) {
        throw new SecurityError('GitHub token not configured');
      }

      const contents = await this.githubClient.getContents(owner, repo, path) as { content?: string };
      
      if (!contents.content) {
        throw new ParseError('No content found in repository file');
      }

      const decoded = atob(contents.content);
      const parsed = JSON.parse(decoded) as GameStateData;
      
      this.validateGameState(parsed);
      this.state = parsed;
      
      this.logger.info('Game state loaded successfully');
    } catch (error) {
      this.logger.error('Failed to load game state', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Validate game state data
   */
  private validateGameState(data: GameStateData): void {
    if (!data.logs || !Array.isArray(data.logs)) {
      throw new ValidationError('Invalid game state: logs must be an array');
    }

    if (typeof data.humanSide !== 'string') {
      throw new ValidationError('Invalid game state: humanSide must be a string');
    }

    if (data.humanSide !== 'Empire' && data.humanSide !== 'Rebel') {
      throw new ValidationError(`Invalid game state: humanSide must be 'Empire' or 'Rebel', got '${data.humanSide}'`);
    }

    this.logger.debug('Game state validation passed');
  }

  /**
   * Get current game state
   */
  public getState(): GameStateData | null {
    return this.state;
  }

  /**
   * Get logs from game state
   */
  public getLogs(): LogEntryData[] {
    return this.state?.logs || [];
  }

  /**
   * Get human side
   */
  public getHumanSide(): string {
    return this.state?.humanSide || '';
  }
}

// ============================================================================
// Main Application
// ============================================================================
class App {
  private readonly logger: Logger;
  private readonly githubClient: GitHubClient;
  private readonly gameStateManager: GameStateManager;

  constructor() {
    this.logger = Logger.getInstance(LogLevel.DEBUG, 'SWR');
    this.githubClient = new GitHubClient(CONFIG.github, this.logger);
    this.gameStateManager = new GameStateManager(this.logger, this.githubClient);
  }

  /**
   * Initialize application
   */
  public async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing application');
      
      // Check if GitHub token is configured
      if (!CONFIG.github.token) {
        this.logger.warn('GitHub token not configured - API calls will be unauthenticated');
      }

      this.logger.info('Application initialized successfully');
    } catch (error) {
      this.logger.fatal('Failed to initialize application', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Load game state from GitHub
   */
  public async loadGameState(owner: string, repo: string, path: string): Promise<void> {
    try {
      await this.gameStateManager.loadFromGitHub(owner, repo, path);
      this.logger.info('Game state loaded successfully');
    } catch (error) {
      if (error instanceof GitHubApiError && error.statusCode === 403) {
        this.logger.error('GitHub API returned 403 Forbidden. This may be due to:', {
          suggestions: [
            'Invalid or expired GitHub token',
            'Repository does not exist or is private',
            'Rate limiting - too many requests',
            'Insufficient permissions to access the repository'
          ]
        });
      }
      throw error;
    }
  }

  /**
   * Fork a repository
   */
  public async forkRepository(owner: string, repo: string): Promise<void> {
    try {
      this.logger.info('Forking repository', { owner, repo });
      await this.githubClient.forkRepository(owner, repo);
      this.logger.info('