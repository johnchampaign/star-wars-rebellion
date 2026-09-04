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

interface Weights { names: string[]; mean: number[]; std: number[]; w: number[]; sides?: Side[] }
const W = weightsJson as unknown as Weights;

export const RANKER_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_RANKER === '1') return true;
    if (proc?.env?.SWR_RANKER === '0') return false;
  } catch { /* browser */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    // DEFAULT ON since 2026-09-03 (John's call): at the browser's real search
    // budget, ranker + final-by-visits measured Rebel 33% -> 53% pooled over
    // n=60/arm (CI [+3,+37], McNemar p=0.036, replicated on fresh seeds).
    // ?ranker=0 opts out (sticky); ?ranker=1 clears the opt-out.
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('ranker') : null;
    if (q === '0') g.localStorage?.setItem('swr-ranker-off', '1');
    if (q === '1') g.localStorage?.removeItem('swr-ranker-off');
    if (q === '0') return false;
    if (g.localStorage?.getItem('swr-ranker-off') === '1') return false;
  } catch { /* no localStorage */ }
  return true;
})();

function envNum(name: string, d: number): number {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = Number(proc?.env?.[name]); return Number.isFinite(v) ? v : d;
  } catch { return d; }
}
/** Softmax temperature for rankerPriors (SWR_RANKER_T). */
export const RANKER_T: number = envNum('SWR_RANKER_T', 1.0);
/** PUCT weight of the ranker prior in the MCTS selection rule
 *  (SWR_RANKER_PRIOR, default 1.0 — only matters when the ranker is on). */
export const RANKER_PRIOR_W: number = envNum('SWR_RANKER_PRIOR', 1.0);
/** Use the ranker INSIDE rollouts too (SWR_RANKER_ROLLOUT=1, only with the
 *  ranker on): the heuristic that plays out each rollout for the covered side
 *  tries candidates in ranker order instead of heuristic-score order. This
 *  changes the leaf VALUES every arm is judged by, not just which arm is
 *  explored — the more powerful use of an imitation model when the root's
 *  arm means tie. Cost ~0.15 ms per rollout decision. */
export const RANKER_ROLLOUT: boolean = envNum('SWR_RANKER_ROLLOUT', 0) === 1;
/** Cut the root to the ranker's top-N arms (SWR_RANKER_TOPK, default 0 = no
 *  cut). With a 24-pull budget and ~6 arms, cutting to 3-4 doubles the pulls
 *  each surviving arm gets. */
export const RANKER_TOPK: number = envNum('SWR_RANKER_TOPK', 0);

/** How the ranker prior enters the FINAL pick (SWR_RANKER_FINAL):
 *   - a number λ: choose argmax(mean + λ·P). Arm means tie at the median
 *     (gap 0.000, p75 0.01 at ~4 pulls/arm), so even λ≈0.05 breaks ties by
 *     the prior while a real rollout win (+0.2) still dominates;
 *   - 'visits': choose the most-pulled arm (standard PUCT; the prior steers
 *     visits, so this is the prior's information laundered through pulls).
 *  Default 0 = unchanged (argmax mean). */
export type RankerFinal = number | 'visits';
function parseFinal(v: string | null | undefined): RankerFinal | null {
  if (v === 'visits') return 'visits';
  const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null;
}
export const RANKER_FINAL: RankerFinal = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const f = parseFinal(proc?.env?.SWR_RANKER_FINAL); if (f !== null) return f;
  } catch { /* browser */ }
  try {
    // Browser: ?rankerfinal=visits | 0.05 | 0 (sticky; only matters with ?ranker=1).
    // The strongest measured configuration (2026-09-02, full budget) is visits.
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('rankerfinal') : null;
    if (q !== null) { if (q === '') g.localStorage?.removeItem('swr-ranker-final'); else g.localStorage?.setItem('swr-ranker-final', q); }
    const f = parseFinal(q ?? g.localStorage?.getItem('swr-ranker-final')); if (f !== null) return f;
  } catch { /* no localStorage */ }
  // DEFAULT 'visits' since 2026-09-03 — the measured configuration (see
  // RANKER_ENABLED). ?rankerfinal=0 restores argmax-mean (sticky).
  return 'visits';
})();
// Runtime-settable for the worker (which cannot read the page's flags itself).
let rankerFinal: RankerFinal = RANKER_FINAL;
export function setRankerFinal(v: RankerFinal): void { rankerFinal = v; }
export function getRankerFinal(): RankerFinal { return rankerFinal; }

// The MCTS runs in a web worker, which has neither the page's query string
// nor localStorage, so the module-load flag above evaluates to OFF there.
// PlayTab forwards the main-thread decision with every search request and the
// worker applies it here before searching. (A first attempt appended ?ranker=1
// to the worker URL — that broke Vite's worker bundling, which only recognises
// the literal `new Worker(new URL(...))` form, and shipped a build with NO
// worker chunk. Never construct the worker from a variable URL.)
let rankerOn: boolean = RANKER_ENABLED;
export function setRankerEnabled(v: boolean): void { rankerOn = v; }
export function isRankerEnabled(): boolean { return rankerOn; }
/** Does the shipped model cover this side? Width (K=4 generation) and the
 *  ranker itself apply only where the model ranks — the Empire keeps the
 *  legacy generator until it has its own validated weights. */
export function rankerCoversSide(side: Side): boolean {
  return rankerOn && (!W.sides || W.sides.includes(side));
}

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

/** Softmax prior over candidates from the ranker's scores, aligned with the
 *  input order. null when the ranker is off, unusable on this catalog, or the
 *  side is not covered by the trained weights. Temperature T (SWR_RANKER_T,
 *  default 1.0) in standardised-score units: the held-out score gaps between
 *  the human's pick and the runner-up are O(1), so T=1 gives priors that are
 *  sharp but not degenerate. */
export function rankerPriors(G: GameState, side: Side, cands: CommandAction[]): number[] | null {
  if (!isRankerEnabled() || cands.length < 2 || !rankerUsable(G)) return null;
  if (W.sides && !W.sides.includes(side)) return null;
  const ctx = positionContext(G, side, cands.length);
  const T = RANKER_T;
  const sc = cands.map((c, i) => rankerScore(G, ctx, c, i) / T);
  const m = Math.max(...sc);
  const ex = sc.map((v) => Math.exp(v - m));
  const z = ex.reduce((a, b) => a + b, 0);
  return ex.map((v) => v / z);
}

/** Re-order candidates by the ranker. Stable on ties (keeps heuristic order).
 *  Returns the input untouched when the ranker is off or unusable. */
export function rankCandidates(G: GameState, side: Side, cands: CommandAction[]): CommandAction[] {
  if (!isRankerEnabled() || cands.length < 2 || !rankerUsable(G)) return cands;
  // Only the side(s) the model was trained on. The archive's exact positions
  // are all human-Rebel so far (the Empire acts second in Command; the v2
  // replayer will add it) — applying Rebel-learned preferences to the Empire
  // would be a guess dressed as a prior.
  if (W.sides && !W.sides.includes(side)) return cands;
  const ctx = positionContext(G, side, cands.length);
  const scored = cands.map((c, i) => ({ c, i, s: rankerScore(G, ctx, c, i) }));
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  return scored.map((x) => x.c);
}
