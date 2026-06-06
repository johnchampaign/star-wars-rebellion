// The framework Codec<GameState> for online play. The framework's
// Codec.decode(raw) takes no extra args, but the engine's decode needs the
// static catalog to rehydrate a snapshot — so we close over a catalog built
// once on the server from the asset DataBundle.
//
// encode uses encodeFull (NOT the single-player encode): online snapshots are
// taken at every action, including mid-choice and mid-combat, so the transient
// pendingChoice/pendingCombat/pendingMission state MUST survive a round-trip.

import type { Codec } from 'digital-boardgame-framework';
import type { GameState, GameCatalog } from '../engine/types';
import { encodeFull, decode } from '../engine/codec';

export function makeRebellionCodec(catalog: GameCatalog): Codec<GameState> {
  return {
    encode: (state) => encodeFull(state),
    decode: (raw) => decode(raw, catalog),
  };
}
