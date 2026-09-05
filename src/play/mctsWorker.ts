/// <reference lib="webworker" />
// MCTS search worker (#539 roadmap item 4): runs searchMctsCommand on a
// DECODED COPY of the game state so the 1-2s Empire think doesn't freeze the
// UI thread. The main thread (PlayTab's worker bridge) posts {id, codec, side};
// we post back {id, ok, result} where result is a postMessage-safe
// MctsSearchResult (plain JSON) that the bridge commits on the real state via
// commitMctsCommand. The worker never mutates anything the main thread sees.
//
// The catalog is rebuilt here from the same runtime assets the app loads
// (workers share the origin, so loadAllForEngine's fetches hit the same
// dev-assets); loaded once, lazily, on the first request.
import { loadAllForEngine } from '../data/loadAssets';
import { buildCatalog } from '../engine/setup';
import { decode } from '../engine/codec';
import { searchMctsCommand, setPostRevealHeuristic } from './mctsAI';
import { setRankerEnabled, setRankerFinal } from './candidateRanker';
import type { GameCatalog, Side } from '../engine/types';

let catalogPromise: Promise<GameCatalog> | null = null;
const getCatalog = (): Promise<GameCatalog> =>
  (catalogPromise ??= loadAllForEngine().then((d) => buildCatalog(d)));

interface SearchRequest { id: number; codec: string; side: Side; flags?: { ranker?: boolean; rankerFinal?: number | 'visits'; postReveal?: boolean } }

self.onmessage = async (ev: MessageEvent<SearchRequest>) => {
  const { id, codec, side, flags } = ev.data;
  try {
    setRankerEnabled(!!flags?.ranker); // main-thread flags the worker cannot read itself
    setRankerFinal(flags?.rankerFinal ?? 0);
    setPostRevealHeuristic(!!flags?.postReveal);
    const catalog = await getCatalog();
    const G = decode(codec, catalog);
    const result = searchMctsCommand(G, side);
    (self as unknown as Worker).postMessage({ id, ok: true, result });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(e) });
  }
};
