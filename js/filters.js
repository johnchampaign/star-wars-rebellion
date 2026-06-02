/**
 * js/filters.js
 * Filter logic for log entries by player, action type, time marker, and text search
 * Production-grade module with no external dependencies
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} raw - The raw log line
 * @property {number} time - Time marker (t2, t3, etc.)
 * @property {string} player - Player identifier (Rebel, Empire, or neutral)
 * @property {string} action - Action type
 * @property {Object} [data] - Optional parsed JSON data
 */

/**
 * @typedef {Object} FilterState
 * @property {string[]} players - Selected players to show (empty = all)
 * @property {string[]} actions - Selected action types to show (empty = all)
 * @property {number|null} timeFrom - Minimum time marker (inclusive)
 * @property {number|null} timeTo - Maximum time marker (inclusive)
 * @property {string} searchText - Text to search for in log entries
 * @property {boolean} caseSensitive - Whether search is case-sensitive
 */

/**
 * Parse a raw log line into a structured LogEntry object
 * @param {string} line - Raw log line
 * @returns {LogEntry|null} Parsed entry or null if invalid
 */
export function parseLogEntry(line) {
  if (!line || typeof line !== 'string') return null;

  const trimmed = line.trim();
  if (!trimmed) return null;

  // Pattern: t<number> <player> <action> [<json_data>]
  const match = trimmed.match(/^t(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!match) return null;

  const time = parseInt(match[1], 10);
  const player = match[2];
  const action = match[3];
  const dataStr = match[4] || null;

  let data = null;
  if (dataStr) {
    try {
      data = JSON.parse(dataStr);
    } catch {
      // If JSON parsing fails, store as raw string
      data = { raw: dataStr };
    }
  }

  return {
    raw: trimmed,
    time,
    player,
    action,
    data
  };
}

/**
 * Parse multiple log lines into an array of LogEntry objects
 * @param {string[]} lines - Array of raw log lines
 * @returns {LogEntry[]} Array of parsed entries (invalid lines are skipped)
 */
export function parseLogEntries(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map(line => parseLogEntry(line))
    .filter(entry => entry !== null);
}

/**
 * Check if a log entry matches the given filter criteria
 * @param {LogEntry} entry - The log entry to check
 * @param {FilterState} filters - The filter criteria
 * @returns {boolean} True if the entry matches all filter criteria
 */
export function matchesFilter(entry, filters) {
  if (!entry || !filters) return false;

  // Player filter
  if (filters.players && filters.players.length > 0) {
    if (!filters.players.includes(entry.player)) return false;
  }

  // Action filter
  if (filters.actions && filters.actions.length > 0) {
    if (!filters.actions.includes(entry.action)) return false;
  }

  // Time range filter
  if (filters.timeFrom !== null && filters.timeFrom !== undefined) {
    if (entry.time < filters.timeFrom) return false;
  }
  if (filters.timeTo !== null && filters.timeTo !== undefined) {
    if (entry.time > filters.timeTo) return false;
  }

  // Text search filter
  if (filters.searchText && filters.searchText.length > 0) {
    const searchStr = filters.caseSensitive
      ? filters.searchText
      : filters.searchText.toLowerCase();
    const entryStr = filters.caseSensitive
      ? entry.raw
      : entry.raw.toLowerCase();
    if (!entryStr.includes(searchStr)) return false;
  }

  return true;
}

/**
 * Filter an array of log entries based on the provided filter state
 * @param {LogEntry[]} entries - Array of log entries
 * @param {FilterState} filters - The filter criteria
 * @returns {LogEntry[]} Filtered array of log entries
 */
export function filterLogEntries(entries, filters) {
  if (!Array.isArray(entries)) return [];
  if (!filters) return [...entries];

  return entries.filter(entry => matchesFilter(entry, filters));
}

/**
 * Get all unique player names from a set of log entries
 * @param {LogEntry[]} entries - Array of log entries
 * @returns {string[]} Sorted array of unique player names
 */
export function getUniquePlayers(entries) {
  if (!Array.isArray(entries)) return [];
  const players = new Set(entries.map(e => e.player).filter(Boolean));
  return Array.from(players).sort();
}

/**
 * Get all unique action types from a set of log entries
 * @param {LogEntry[]} entries - Array of log entries
 * @returns {string[]} Sorted array of unique action types
 */
export function getUniqueActions(entries) {
  if (!Array.isArray(entries)) return [];
  const actions = new Set(entries.map(e => e.action).filter(Boolean));
  return Array.from(actions).sort();
}

/**
 * Get the time range (min and max) from a set of log entries
 * @param {LogEntry[]} entries - Array of log entries
 * @returns {{ min: number|null, max: number|null }} Time range object
 */
export function getTimeRange(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { min: null, max: null };
  }

  let min = Infinity;
  let max = -Infinity;

  for (const entry of entries) {
    if (entry.time < min) min = entry.time;
    if (entry.time > max) max = entry.time;
  }

  return {
    min: min === Infinity ? null : min,
    max: max === -Infinity ? null : max
  };
}

/**
 * Create a default filter state
 * @param {Object} [overrides] - Optional overrides for default values
 * @returns {FilterState} Default filter state
 */
export function createDefaultFilterState(overrides = {}) {
  return {
    players: [],
    actions: [],
    timeFrom: null,
    timeTo: null,
    searchText: '',
    caseSensitive: false,
    ...overrides
  };
}

/**
 * Check if a filter state is active (has any filters applied)
 * @param {FilterState} filters - The filter state to check
 * @returns {boolean} True if any filter is active
 */
export function isFilterActive(filters) {
  if (!filters) return false;

  return (
    (filters.players && filters.players.length > 0) ||
    (filters.actions && filters.actions.length > 0) ||
    filters.timeFrom !== null ||
    filters.timeTo !== null ||
    (filters.searchText && filters.searchText.length > 0)
  );
}

/**
 * Reset a filter state to default values
 * @param {FilterState} filters - The filter state to reset (mutated in place)
 * @returns {FilterState} The reset filter state
 */
export function resetFilters(filters) {
  if (!filters) return createDefaultFilterState();

  filters.players = [];
  filters.actions = [];
  filters.timeFrom = null;
  filters.timeTo = null;
  filters.searchText = '';
  filters.caseSensitive = false;

  return filters;
}

/**
 * Count how many entries match the current filter
 * @param {LogEntry[]} entries - Array of log entries
 * @param {FilterState} filters - The filter criteria
 * @returns {number} Count of matching entries
 */
export function countFilteredEntries(entries, filters) {
  return filterLogEntries(entries, filters).length;
}

/**
 * Group log entries by time marker
 * @param {LogEntry[]} entries - Array of log entries
 * @returns {Map<number, LogEntry[]>} Map of time markers to entries
 */
export function groupEntriesByTime(entries) {
  if (!Array.isArray(entries)) return new Map();

  const groups = new Map();
  for (const entry of entries) {
    const time = entry.time;
    if (!groups.has(time)) {
      groups.set(time, []);
    }
    groups.get(time).push(entry);
  }

  // Sort entries within each time group by their original order
  for (const [time, timeEntries] of groups) {
    timeEntries.sort((a, b) => {
      return entries.indexOf(a) - entries.indexOf(b);
    });
  }

  return groups;
}

/**
 * Group log entries by player
 * @param {LogEntry[]} entries - Array of log entries
 * @returns {Map<string, LogEntry[]>} Map of player names to entries
 */
export function groupEntriesByPlayer(entries) {
  if (!Array.isArray(entries)) return new Map();

  const groups = new Map();
  for (const entry of entries) {
    const player = entry.player || 'unknown';
    if (!groups.has(player)) {
      groups.set(player, []);
    }
    groups.get(player).push(entry);
  }

  return groups;
}

/**
 * Group log entries by action type
 * @param {LogEntry[]} entries - Array of log entries
 * @returns {Map<string, LogEntry[]>} Map of action types to entries
 */
export function groupEntriesByAction(entries) {
  if (!Array.isArray(entries)) return new Map();

  const groups = new Map();
  for (const entry of entries) {
    const action = entry.action || 'unknown';
    if (!groups.has(action)) {
      groups.set(action, []);
    }
    groups.get(action).push(entry);
  }

  return groups;
}

/**
 * Extract all unique action types that contain a specific keyword
 * @param {LogEntry[]} entries - Array of log entries
 * @param {string} keyword - Keyword to search for in action names
 * @returns {string[]} Sorted array of matching action types
 */
export function findActionsByKeyword(entries, keyword) {
  if (!Array.isArray(entries) || !keyword) return [];

  const actions = new Set();
  const lowerKeyword = keyword.toLowerCase();

  for (const entry of entries) {
    if (entry.action && entry.action.toLowerCase().includes(lowerKeyword)) {
      actions.add(entry.action);
    }
  }

  return Array.from(actions).sort();
}

/**
 * Get a summary of the log data for display purposes
 * @param {LogEntry[]} entries - Array of log entries
 * @returns {Object} Summary object with counts and metadata
 */
export function getLogSummary(entries) {
  if (!Array.isArray(entries)) {
    return {
      totalEntries: 0,
      uniquePlayers: [],
      uniqueActions: [],
      timeRange: { min: null, max: null },
      entriesByPlayer: new Map(),
      entriesByAction: new Map()
    };
  }

  return {
    totalEntries: entries.length,
    uniquePlayers: getUniquePlayers(entries),
    uniqueActions: getUniqueActions(entries),
    timeRange: getTimeRange(entries),
    entriesByPlayer: groupEntriesByPlayer(entries),
    entriesByAction: groupEntriesByAction(entries)
  };
}

export default {
  parseLogEntry,
  parseLogEntries,
  matchesFilter,
  filterLogEntries,
  getUniquePlayers,
  getUniqueActions,
  getTimeRange,
  createDefaultFilterState,
  isFilterActive,
  resetFilters,
  countFilteredEntries,
  groupEntriesByTime,
  groupEntriesByPlayer,
  groupEntriesByAction,
  findActionsByKeyword,
  getLogSummary
};