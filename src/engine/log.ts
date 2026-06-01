// Structured event log. Appended to G.turnLog by Mechanics methods.

import type { GameState, LogEntry, Side } from './types';

export function log(G: GameState, entry: Omit<LogEntry, 'turn'>): void {
  G.turnLog.push({ turn: G.timeMarker, ...entry });
}

export function logState(G: GameState, codec: string): void {
  G.turnLog.push({ turn: G.timeMarker, kind: 'state', payload: { codec } });
}

export function logForSide(G: GameState, side: Side, kind: string, payload?: Record<string, unknown>): void {
  G.turnLog.push({ turn: G.timeMarker, side, kind, payload });
}

/** Queue a player-facing modal notice (deduped by id). For real game info the
 *  player must see — e.g. a Long Range Probe result. (notImplemented() is for
 *  unfinished code paths and logs differently; don't use it for this.) */
export function pushNotice(G: GameState, id: string, title: string, details?: string): void {
  if (!G.pendingNotices) G.pendingNotices = [];
  if (G.pendingNotices.some((n) => n.id === id)) return;
  G.pendingNotices.push({ id, title, details });
  log(G, { kind: 'notice', payload: { id, title } });
}

/** Surface a "not yet implemented" notice to the player. Adds it to a
 *  per-game queue (deduped by id) and emits a log entry. The play tab pops a
 *  modal and clears the queue on acknowledgement.
 *
 *  Use sparingly: for code paths that *should* do something but don't yet,
 *  not for ordinary "no legal target" failures. */
export function notImplemented(G: GameState, id: string, title: string, details?: string): void {
  if (!G.pendingNotices) G.pendingNotices = [];
  if (G.pendingNotices.some((n) => n.id === id)) {
    log(G, { kind: 'not-implemented', payload: { id, title, deduped: true } });
    return;
  }
  G.pendingNotices.push({ id, title, details });
  log(G, { kind: 'not-implemented', payload: { id, title } });
}
