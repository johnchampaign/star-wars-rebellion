// GameState codec — encode/decode for persistence and report payloads.
// Per docs/engine.md §11: round-trip safe only at turn boundaries.
// Excludes `catalog` (re-attached on decode from the same data bundle) and
// the mid-resolution fields (`pendingMission`, `pendingCombat`,
// `pendingChoice`, `refreshPaused`).

import type { GameState, GameCatalog } from './types';
import { reseedInstanceCounters, repairProbeState } from './mechanics';
import { reseedSetupInstanceCounter } from './phases';

const SCHEMA = 'rebellion-state-v1';

type CodecPayload = {
  schema: string;
  encodedAt: string;
  state: Omit<GameState, 'catalog' | 'pendingMission' | 'pendingCombat' | 'pendingChoice' | 'refreshPaused'>;
};

export function encode(G: GameState): string {
  const { catalog, pendingMission, pendingCombat, pendingChoice, refreshPaused, ...rest } = G;
  void catalog; void pendingMission; void pendingCombat; void pendingChoice; void refreshPaused;
  const payload: CodecPayload = {
    schema: SCHEMA,
    encodedAt: new Date().toISOString(),
    state: rest as CodecPayload['state'],
  };
  return JSON.stringify(payload);
}

/** Lightweight encode for the frequent localStorage RESUME save. Identical to
 *  encode() but drops the per-turn full-board snapshot entries (turnLog
 *  kind:'state') — those exist only for the uploaded v2 log / AI analysis and
 *  aren't needed to reload and continue a game. They dominate the codec: a
 *  late-game state is ~1.3 MB, ~92% of it snapshots, and persist() re-encodes
 *  and writes the whole thing on EVERY action + AI batch — which is what made
 *  the UI pause for seconds after confirming a modal. Stripping them cuts the
 *  save to ~100 KB. archiveCompletedGame() still uses the FULL encode() so the
 *  end-of-game upload keeps its snapshots. */
export function encodeForResume(G: GameState): string {
  const { catalog, pendingMission, pendingCombat, pendingChoice, refreshPaused, turnLog, ...rest } = G;
  void catalog; void pendingMission; void pendingCombat; void pendingChoice; void refreshPaused;
  const slimLog = Array.isArray(turnLog)
    ? turnLog.filter((e) => (e as { kind?: string }).kind !== 'state')
    : turnLog;
  const payload: CodecPayload = {
    schema: SCHEMA,
    encodedAt: new Date().toISOString(),
    state: { ...rest, turnLog: slimLog } as CodecPayload['state'],
  };
  return JSON.stringify(payload);
}

/** Full-fidelity encode for ONLINE/MULTIPLAYER snapshots. Unlike encode(),
 *  which strips the transient pendingMission/pendingCombat/pendingChoice/
 *  refreshPaused fields (single-player only ever saves at turn boundaries —
 *  see canEncode), this preserves them so an async game can be stored and
 *  reloaded mid-choice/mid-combat days later without losing in-progress state.
 *  Only the catalog (static reference data, re-attached on decode) is dropped.
 *  Reads back via the same decode(). */
export function encodeFull(G: GameState): string {
  const { catalog: _catalog, ...rest } = G;
  void _catalog;
  return JSON.stringify({
    schema: SCHEMA,
    encodedAt: new Date().toISOString(),
    state: rest,
  });
}

export function decode(s: string, catalog: GameCatalog): GameState {
  const payload = JSON.parse(s) as CodecPayload;
  if (payload.schema !== SCHEMA) {
    throw new Error(`codec schema mismatch: ${payload.schema} (expected ${SCHEMA})`);
  }
  const G = {
    ...payload.state,
    catalog,
    isGameOver: payload.state.isGameOver,
  } as GameState;
  // Critical: rehydrate the unit-instance counters from the loaded state.
  // Module-level counters in mechanics/phases reset to their initial values
  // on every page reload, but persisted units retain their original IDs.
  // Without reseeding, the next deployUnit/setup-place produces a colliding
  // instanceId — two units share the same ID, and unit-find lookups return
  // the wrong one. This is what issue #29 surfaced (AC and a stormtrooper
  // at Sullust both had instanceId u1000003; the transport check found the
  // stormtrooper first and never saw the AC's capacity).
  reseedInstanceCounters(G);
  reseedSetupInstanceCounter(G);
  // Repair probe-card conservation in saves corrupted by the RM leak (#451):
  // cards duplicated into both the Empire hand and the deck, in-hand dupes,
  // and the hidden base's own card wrongly held in hand.
  repairProbeState(G);
  return G;
}

/** Validate that G is at a turn boundary (safe to encode). */
export function canEncode(G: GameState): boolean {
  return !G.pendingMission && !G.pendingCombat && !G.pendingChoice;
}
