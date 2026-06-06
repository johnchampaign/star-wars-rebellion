// GameState codec — encode/decode for persistence and report payloads.
// Per docs/engine.md §11: round-trip safe only at turn boundaries.
// Excludes `catalog` (re-attached on decode from the same data bundle) and
// the mid-resolution fields (`pendingMission`, `pendingCombat`,
// `pendingChoice`, `refreshPaused`).

import type { GameState, GameCatalog } from './types';
import { reseedInstanceCounters } from './mechanics';
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
  return G;
}

/** Validate that G is at a turn boundary (safe to encode). */
export function canEncode(G: GameState): boolean {
  return !G.pendingMission && !G.pendingCombat && !G.pendingChoice;
}
