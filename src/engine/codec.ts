// GameState codec — encode/decode for persistence and report payloads.
// Per docs/engine.md §11: round-trip safe only at turn boundaries.
// Excludes `catalog` (re-attached on decode from the same data bundle) and
// the mid-resolution fields (`pendingMission`, `pendingCombat`,
// `pendingChoice`, `refreshPaused`).

import type { GameState, GameCatalog } from './types';

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

export function decode(s: string, catalog: GameCatalog): GameState {
  const payload = JSON.parse(s) as CodecPayload;
  if (payload.schema !== SCHEMA) {
    throw new Error(`codec schema mismatch: ${payload.schema} (expected ${SCHEMA})`);
  }
  return {
    ...payload.state,
    catalog,
    isGameOver: payload.state.isGameOver,
  } as GameState;
}

/** Validate that G is at a turn boundary (safe to encode). */
export function canEncode(G: GameState): boolean {
  return !G.pendingMission && !G.pendingCombat && !G.pendingChoice;
}
