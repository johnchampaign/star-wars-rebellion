// Shared dual-format play-log reader (log-format v2, docs/log-events.md).
//
// Normalizes BOTH log file formats into one shape so analyzers never parse the
// container themselves:
//   - v1 (the 558 pre-2026-07-10 logs): { schemaVersion: 1, hash, game } with a
//     quadruply-nested codec string; snapshots (if any) are 'state' events
//     inside state.turnLog with their own embedded codec strings.
//   - v2 (current uploads): { schemaVersion: 2, gameId, meta, timeline,
//     keyframes, final } — plain objects all the way down.
//
// Returned shape:
//   {
//     schemaVersion: 1 | 2,
//     gameId?: string,
//     meta?: object,               // v2 only
//     humanSide?: 'Rebel'|'Empire',
//     winner?: string, winReason?: string,
//     events:   LogEntry[],        // flat, ordered; 'state' snapshot events excluded
//     snapshots: [{ turn, at, state }],  // at: setup-complete|turn-start|base-reveal|base-assault
//     final:    object,            // end-of-game board (no turnLog)
//   }
//
// Throws on unreadable/malformed files — callers that scan a directory should
// try/catch per file (same discipline the analyzers already use).

import { readFileSync } from 'node:fs';

export function readGameLog(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw.schemaVersion === 2) return readV2(raw);
  return readV1(raw);
}

function readV2(raw) {
  const timeline = Array.isArray(raw.timeline) ? raw.timeline : [];
  const keyframes = Array.isArray(raw.keyframes) ? raw.keyframes : [];
  const events = timeline.flatMap((t) => t.events ?? []);
  const snapshots = [
    ...timeline.filter((t) => t.snapshot).map((t) => ({
      turn: t.turn,
      at: t.turn === 1 ? 'setup-complete' : 'turn-start',
      state: t.snapshot,
    })),
    ...keyframes.map((k) => ({ turn: k.turn, at: k.at, state: k.state })),
  ];
  return {
    schemaVersion: 2,
    gameId: raw.gameId,
    meta: raw.meta,
    humanSide: raw.meta?.humanSide,
    winner: raw.meta?.outcome?.winner,
    winReason: raw.meta?.outcome?.reason,
    events,
    snapshots,
    final: raw.final ?? {},
  };
}

function readV1(raw) {
  // Accept both the upload wrapper ({ game: {...} }) and a bare game record.
  const game = raw.game ?? raw;
  const state = JSON.parse(game.codec).state;
  const { turnLog = [], ...final } = state;
  const events = [];
  const snapshots = [];
  for (const e of turnLog) {
    if (e.kind === 'state') {
      try {
        snapshots.push({
          turn: e.turn,
          // Pre-label snapshots (first deployed logState) default to turn-start.
          at: e.payload?.at ?? 'turn-start',
          state: JSON.parse(e.payload.codec).state,
        });
      } catch { /* malformed snapshot — skip it, keep the rest */ }
      continue;
    }
    events.push(e);
  }
  return {
    schemaVersion: 1,
    gameId: game.gameId,
    meta: undefined,
    humanSide: game.humanSide,
    winner: game.winner ?? final.winner,
    winReason: game.winReason ?? final.winReason,
    events,
    snapshots,
    final,
  };
}

/** Wrap a normalized snapshot's state object back into a codec string that
 *  src/engine/codec.ts decode() accepts (schema + state envelope). */
export function snapshotToCodec(state) {
  return JSON.stringify({ schema: 'rebellion-state-v1', encodedAt: '', state });
}
