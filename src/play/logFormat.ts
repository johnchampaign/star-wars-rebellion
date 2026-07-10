// Log-format v2 container builder (see docs/log-events.md).
//
// The engine keeps writing its flat turnLog (events + labeled 'state'
// snapshots) inside GameState — codec.encode() is deliberately untouched, so
// saves, undo, reports, and the online branch are unaffected. This module
// restructures that flat log into the v2 upload container at UPLOAD time:
//
//   { schemaVersion: 2, gameId, meta, timeline, keyframes, final }
//
// - timeline: one entry per turn — the board snapshot at the START of that turn
//   (plain object, not a nested JSON string) plus the turn's events.
// - keyframes: the strategic-moment snapshots (base-reveal, base-assault).
// - final: the end-of-game board, with the turnLog stripped (history lives in
//   the timeline; nothing is stored twice).
//
// v1 files (the 558 pre-existing logs) are NOT migrated; readers dual-parse
// via scripts/lib/log-reader.mjs.

import type { LogEntry } from '../engine/types';

type Json = Record<string, unknown>;

export type V2GameLog = {
  schemaVersion: 2;
  /** Client-minted per-game id — the join key between play logs, problem
   *  reports, and saves. Absent for games archived before it shipped. */
  gameId?: string;
  meta: {
    seed?: number;
    expansion?: unknown;
    players?: { Rebel: 'human' | 'ai'; Empire: 'human' | 'ai' };
    /** Which policy drove the AI side(s), and the planner flag state. */
    ai?: Json;
    /** git short SHA of the build that played the game (__DBF_BUILD_ID__). */
    build?: string;
    encodedAt?: string;
    source?: string;
    inProgress?: boolean;
    outcome?: { winner?: string; reason?: string; rounds?: number };
    /** Kept for v1-reader compatibility (analyzers key off this). */
    humanSide?: string;
  };
  timeline: Array<{ turn: number; snapshot: Json | null; events: LogEntry[] }>;
  keyframes: Array<{ at: string; turn: number; state: Json }>;
  final: Json;
};

/** Parse a snapshot event's embedded codec string; null if malformed. */
function parseSnapshot(e: LogEntry): Json | null {
  try {
    const codec = (e.payload as { codec?: string } | undefined)?.codec;
    if (typeof codec !== 'string') return null;
    const parsed = JSON.parse(codec) as { state?: Json };
    return parsed.state ?? null;
  } catch { return null; }
}

export function buildV2GameLog(codecStr: string, opts: {
  gameId?: string;
  humanSide?: string;
  source: string;
  encodedAt?: string;
  build?: string;
  ai?: Json;
  inProgress?: boolean;
}): V2GameLog {
  const payload = JSON.parse(codecStr) as { state: Json & { turnLog?: LogEntry[] } };
  const { turnLog = [], ...finalState } = payload.state;

  const events: LogEntry[] = [];
  const snaps: Array<{ turn: number; at: string; state: Json }> = [];
  for (const e of turnLog) {
    if (e.kind === 'state') {
      const state = parseSnapshot(e);
      if (state) {
        // Unlabeled = written by the first deployed logState (pre-labels);
        // those were all turn-start/reveal — treat as turn-start.
        const at = ((e.payload as { at?: string } | undefined)?.at) ?? 'turn-start';
        snaps.push({ turn: e.turn, at, state });
      }
      continue;
    }
    events.push(e);
  }

  const maxTurn = Math.max(1, ...events.map((e) => e.turn), ...snaps.map((s) => s.turn));
  const timeline: V2GameLog['timeline'] = [];
  for (let t = 1; t <= maxTurn; t++) {
    // Turn 1's board is the setup-complete keyframe (turn-start snapshots only
    // begin when advanceTime fires into turn 2).
    const snap = t === 1
      ? snaps.find((s) => s.at === 'setup-complete')
      : snaps.find((s) => s.at === 'turn-start' && s.turn === t);
    timeline.push({ turn: t, snapshot: snap?.state ?? null, events: events.filter((e) => e.turn === t) });
  }
  const keyframes = snaps
    .filter((s) => s.at === 'base-reveal' || s.at === 'base-assault')
    .map((s) => ({ at: s.at, turn: s.turn, state: s.state }));

  const seed = (() => {
    const setup = events.find((e) => e.kind === 'setup');
    const s = (setup?.payload as { seed?: unknown } | undefined)?.seed;
    return typeof s === 'number' ? s : undefined;
  })();
  const players = opts.humanSide === 'Rebel' ? { Rebel: 'human' as const, Empire: 'ai' as const }
    : opts.humanSide === 'Empire' ? { Rebel: 'ai' as const, Empire: 'human' as const }
    : undefined;

  return {
    schemaVersion: 2,
    gameId: opts.gameId,
    meta: {
      seed,
      expansion: finalState.expansion,
      players,
      ai: opts.ai,
      build: opts.build,
      encodedAt: opts.encodedAt ?? new Date().toISOString(),
      source: opts.source,
      inProgress: opts.inProgress || undefined,
      outcome: {
        winner: finalState.winner as string | undefined,
        reason: finalState.winReason as string | undefined,
        rounds: finalState.timeMarker as number | undefined,
      },
      humanSide: opts.humanSide,
    },
    timeline,
    keyframes,
    final: finalState,
  };
}

/** The live build's git short SHA (injected by versionStamp; absent in dev). */
export function buildId(): string | undefined {
  try {
    return typeof __DBF_BUILD_ID__ !== 'undefined' ? __DBF_BUILD_ID__ : undefined;
  } catch { return undefined; }
}
