// Structured event log. Appended to G.turnLog by Mechanics methods.

import type { GameState, LogEntry, Side } from './types';

export function log(G: GameState, entry: Omit<LogEntry, 'turn'>): void {
  G.turnLog.push({ turn: G.timeMarker, ...entry });
}

/** Append a full-board snapshot to the turn log (`kind: 'state'`), so a saved
 *  game carries the exact board at key moments (round start, base reveal) and an
 *  analyzer can decode any past position — not just the final one. (#539: enables
 *  replaying the AI Empire forward from a real, human-defended reveal position.)
 *
 *  The snapshot is encoded INLINE here (rather than importing codec.encode) for
 *  two reasons: (1) it keeps log.ts free of a codec↔mechanics import cycle, and
 *  (2) it strips `turnLog` from the snapshot — a snapshot lives INSIDE the turn
 *  log, so embedding the log-so-far would nest logs and blow up quadratically.
 *  The shape mirrors codec.encode()'s CodecPayload exactly (schema + same omitted
 *  transient fields) so codec.decode() reads these snapshots back unchanged. */
const SNAPSHOT_SCHEMA = 'rebellion-state-v1';
export function logState(G: GameState): void {
  const { catalog, pendingMission, pendingCombat, pendingChoice, refreshPaused, turnLog, ...rest } =
    G as GameState & Record<string, unknown>;
  void catalog; void pendingMission; void pendingCombat; void pendingChoice; void refreshPaused; void turnLog;
  const codec = JSON.stringify({
    schema: SNAPSHOT_SCHEMA,
    encodedAt: new Date().toISOString(),
    state: { ...rest, turnLog: [] },
  });
  G.turnLog.push({ turn: G.timeMarker, kind: 'state', payload: { codec } });
}

export function logForSide(G: GameState, side: Side, kind: string, payload?: Record<string, unknown>): void {
  G.turnLog.push({ turn: G.timeMarker, side, kind, payload });
}

/** Queue a player-facing modal notice (deduped by id). For real game info the
 *  player must see — e.g. a Long Range Probe result. (notImplemented() is for
 *  unfinished code paths and logs differently; don't use it for this.) */
export function pushNotice(G: GameState, id: string, title: string, details?: string, side?: Side): void {
  if (!G.pendingNotices) G.pendingNotices = [];
  if (G.pendingNotices.some((n) => n.id === id)) return;
  G.pendingNotices.push({ id, title, details, kind: 'info', side });
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
  G.pendingNotices.push({ id, title, details, kind: 'notImplemented' });
  log(G, { kind: 'not-implemented', payload: { id, title } });
}
