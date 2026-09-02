// Imitation ranker (docs/imitation-plan.md, step 2): re-orders the heuristic's
// Command candidates by a model trained on the recorded human decisions, so
// the MCTS root explores what a winning player would consider first.
//
// Model: pairwise logistic over candidateFeatures (scripts/train-ranker.mjs).
// Weights ship in rankerWeights.json with the feature names they were trained
// on; a catalog change that alters featureNames() disables the ranker rather
// than silently misaligning columns.
//
// Measured on held-out games (positions where the human's move was generated
// at K=4): heuristic order top-1 4-6% / top-3 10-13%; ranker top-1 20-32% /
// top-3 38-47% across four split seeds. Lever: SWR_RANKER=1 (node) or
// ?ranker=1 (browser, sticky; ?ranker=0 clears). Default OFF until the paired
// harness has measured it end-to-end.
import type { GameState, Side } from '../engine/types';
import type { CommandAction } from './randomAI';
import { candidateFeatures, featureNames, positionContext } from './candidateFeatures';
import weightsJson from './rankerWeights.json';

interface Weights { names: string[]; mean: number[]; std: number[]; w: number[] }
const W = weightsJson as unknown as Weights;

export const RANKER_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_RANKER === '1') return true;
    if (proc?.env?.SWR_RANKER === '0') return false;
  } catch { /* browser */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('ranker') : null;
    if (q === '1') g.localStorage?.setItem('swr-ranker-on', '1');
    if (q === '0') g.localStorage?.removeItem('swr-ranker-on');
    if (g.localStorage?.getItem('swr-ranker-on') === '1') return true;
  } catch { /* no localStorage */ }
  return false;
})();

let checkedNames: boolean | null = null;
/** True when the shipped weights match this catalog's feature layout. */
export function rankerUsable(G: GameState): boolean {
  if (checkedNames === null) {
    const names = featureNames(G);
    checkedNames = names.length === W.names.length && names.every((n, i) => n === W.names[i]);
  }
  return checkedNames;
}

/** Model score for one candidate (higher = more human-like). */
export function rankerScore(G: GameState, ctx: ReturnType<typeof positionContext>, c: CommandAction, rank: number): number {
  const x = candidateFeatures(G, ctx, c, rank);
  let s = 0;
  for (let d = 0; d < W.w.length; d++) s += W.w[d] * ((x[d] - W.mean[d]) / W.std[d]);
  return s;
}

/** Re-order candidates by the ranker. Stable on ties (keeps heuristic order).
 *  Returns the input untouched when the ranker is off or unusable. */
export function rankCandidates(G: GameState, side: Side, cands: CommandAction[]): CommandAction[] {
  if (!RANKER_ENABLED || cands.length < 2 || !rankerUsable(G)) return cands;
  const ctx = positionContext(G, side, cands.length);
  const scored = cands.map((c, i) => ({ c, i, s: rankerScore(G, ctx, c, i) }));
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  return scored.map((x) => x.c);
}
