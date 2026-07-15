// Structured event log. Appended to G.turnLog by Mechanics methods.
//
// EVENT ENVELOPE (log-format v2, see docs/log-events.md): every entry carries
//   seq   — monotonic index (turnLog position at append time); lets analyzers
//           order and cross-reference events without array positions.
//   turn  — G.timeMarker at append time.
//   phase — G.phase at append time (Setup/Assignment/Command/Refresh/GameOver).
//   side? — the acting side, when the event has one.
//   kind + payload — the event itself; payload shapes are documented in the
//           registry and guarded by scripts/test-log-registry.mjs.

import type { GameState, LogEntry, Side } from './types';

export function log(G: GameState, entry: Omit<LogEntry, 'turn' | 'seq' | 'phase'>): void {
  G.turnLog.push({ seq: G.turnLog.length, turn: G.timeMarker, phase: G.phase, ...entry });
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
/** `at` labels WHY the snapshot was taken — 'turn-start' | 'base-reveal' |
 *  'base-assault' — so the v2 log builder can route it to the timeline or the
 *  keyframes list. Snapshots without a label (written by the first deployed
 *  version of this code) are treated as 'turn-start' by readers. */
export function logState(G: GameState, at: string = 'turn-start'): void {
  // AI-search clones are simulated forward and discarded; serializing a full
  // snapshot per simulated turn × dozens of rollouts per decision was a large
  // share of late-game AI think time (#569). Real games are never marked.
  if (G.ephemeralSearchClone) return;
  const { catalog, pendingMission, pendingCombat, pendingChoice, refreshPaused, turnLog, ...rest } =
    G as GameState & Record<string, unknown>;
  void catalog; void pendingMission; void pendingCombat; void pendingChoice; void refreshPaused; void turnLog;
  const codec = JSON.stringify({
    schema: SNAPSHOT_SCHEMA,
    encodedAt: new Date().toISOString(),
    state: { ...rest, turnLog: [] },
  });
  G.turnLog.push({ seq: G.turnLog.length, turn: G.timeMarker, phase: G.phase, kind: 'state', payload: { codec, at } });
}

export function logForSide(G: GameState, side: Side, kind: string, payload?: Record<string, unknown>): void {
  G.turnLog.push({ seq: G.turnLog.length, turn: G.timeMarker, phase: G.phase, side, kind, payload });
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
