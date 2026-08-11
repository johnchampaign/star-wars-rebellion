// Determinized Monte-Carlo Command policy (#Phase-1 prototype) — the search
// alternative to the greedy per-action scorer.
//
// WHY THIS EXISTS
// The heuristic AI is a memoryless one-ply scorer: it cannot value a move by
// where it LEADS (mass → ferry → strike, occupy-to-clear hunting), which is
// exactly the documented failure class (#538 delivery, 0/17 hunt replays in
// docs/ai-health.md). Depth-2 eval-beam tied the heuristic — the gap is
// multi-turn, so this policy plays each candidate action out with FULL-GAME
// heuristic rollouts and picks the action whose futures score best.
//
// HIDDEN INFORMATION (the base) is handled by DETERMINIZATION, the standard
// technique for hidden-target games (Cowling/Powley/Whitehouse 2012, ISMCTS):
// each rollout samples a base location uniformly from the systems the Empire
// has not ruled out (probe cards + searched rule-outs + reveal-implied), plays
// the rollout in that world, and the action's value is averaged across worlds.
// Occupy-to-clear then emerges by expectation: marching onto a candidate wins
// the worlds where the base IS there and shrinks the candidate set in the
// rest — no hand-coded hunt weights. The search NEVER reads the true base
// location pre-reveal (the one determinization-consistency exception: the
// sampled world's probe deck swaps the sampled system's card for the real
// base's card, so rollout probe draws stay consistent with the sampled world).
//
// SHAPE: flat determinized Monte-Carlo over the heuristic's own top-K root
// candidates (UCB1 allocation), heuristic playout policy for BOTH sides,
// horizon-capped rollouts, leaf = boardEval.evaluate + a candidate-count
// information term. This is a policy-improvement step over the heuristic
// rollout policy rather than a full ISMCTS tree — deliberate prototype scope.
//
// INTEGRATION: registered via setCommandPolicyOverride('Empire', ...), same
// hook as the depth-2 Rebel policy; a re-entrancy guard makes rollouts fall
// through to the plain heuristic. Off unless SWR_MCTS=1 (node) or ?mcts=1
// (browser, sticky via localStorage like ?planner= / ?hunt=).

import type { GameState, Side, SystemId } from '../engine/types';
import * as phases from '../engine/phases';
import { log as logEvent } from '../engine/log';
import { bestCommandAction, tryCommandAction, stepOnce } from './randomAI';
import { evaluate, leafEvaluate } from './boardEval';

// ---------------------------------------------------------------------------
// Enablement flag. SHIPPED DEFAULT-ON in the browser (John's call after the
// 2026-07-13 live playtest: "certainly not worse than the old AI — ship it and
// start getting MCTS games from real players"). `?mcts=0` opts out (sticky via
// localStorage, `?mcts=1` clears the opt-out). In node the default stays OFF
// so benches/tournaments A/B explicitly via SWR_MCTS=1.
// ---------------------------------------------------------------------------
export const MCTS_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_MCTS === '1') return true;
    if (proc?.env?.SWR_MCTS === '0') return false;
  } catch { /* browser: no process */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('mcts') : null;
    if (q === '0') g.localStorage?.setItem('swr-mcts-off', '1');
    if (q === '1') g.localStorage?.removeItem('swr-mcts-off');
    if (g.localStorage?.getItem('swr-mcts-off') === '1') return false;
    if (typeof g.location !== 'undefined') return true; // browser: default ON
  } catch { /* no localStorage */ }
  return false; // node without SWR_MCTS: benches opt in explicitly
})();

// ---------------------------------------------------------------------------
// MCTS-Rebel flag. EXPERIMENTAL, default OFF everywhere: `?mctsrebel=1` opts
// in for a browser playtest (sticky; `?mctsrebel=0` clears), SWR_MCTS_REBEL=1
// in node for benches. The Rebel search is the same searchMctsCommand with no
// determinization (the Rebel knows its own base — worlds = reality). Flip
// default only after the self-play bench AND a live playtest, same protocol
// as the Empire policy above.
// ---------------------------------------------------------------------------
export const MCTS_REBEL_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_MCTS_REBEL === '1') return true;
    if (proc?.env?.SWR_MCTS_REBEL === '0') return false;
  } catch { /* browser */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('mctsrebel') : null;
    if (q === '1') g.localStorage?.setItem('swr-mcts-rebel-on', '1');
    if (q === '0') g.localStorage?.removeItem('swr-mcts-rebel-on');
    if (g.localStorage?.getItem('swr-mcts-rebel-on') === '1') return true;
  } catch { /* no localStorage */ }
  return false; // default OFF: experimental
})();

// ---------------------------------------------------------------------------
// Tunables (env-overridable so benches can sweep without code edits).
// ---------------------------------------------------------------------------
/** SWR_MCTS_DEBUG=1 (node only): per-arm rollout outcome dump after each
 *  decision — how many rollouts ended in a terminal win/loss vs. horizon cut,
 *  and each arm's mean. Built to diagnose the pass-over-attack reports
 *  (#580/#581: pass mc=1.0 beating score-43 reveals). */
function envDebug(): boolean {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return proc?.env?.SWR_MCTS_DEBUG === '1';
  } catch { return false; }
}

function envInt(name: string, dflt: number): number {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = proc?.env?.[name];
    if (v !== undefined) { const n = parseInt(v, 10); if (Number.isFinite(n)) return n; }
  } catch { /* browser */ }
  return dflt;
}

export interface MctsConfig {
  /** Total rollouts per Command decision. */
  budget: number;
  /** Root candidates taken from the heuristic's scored enumeration. */
  topK: number;
  /** Rollout horizon in time-marker advances (refresh boundaries). */
  horizonRounds: number;
  /** Max distinct sampled base worlds per decision (pre-reveal). */
  maxDets: number;
  /** UCB1 exploration constant (values live in [0,1]). */
  ucbC: number;
  /** Wall-clock safety cap per decision, ms. */
  msCap: number;
}

export function defaultConfig(): MctsConfig {
  // Defaults = the validated sweep winner (2026-07-13 mcts-bench): horizon 4 /
  // budget 64 / dets 8 beat both the heuristic and the horizon-2 config —
  // replays 5/23 captures vs heuristic 2/23 (every found base converted), and
  // hold-defender self-play Empire win 56.3% → 87.5% (16 games/arm). Costs
  // ~1.4s per Empire Command decision (same order as the depth-2 Rebel).
  return {
    budget: envInt('SWR_MCTS_BUDGET', 64),
    topK: envInt('SWR_MCTS_TOPK', 12),
    horizonRounds: envInt('SWR_MCTS_HORIZON', 4),
    maxDets: envInt('SWR_MCTS_DETS', 8),
    ucbC: 0.7,
    msCap: envInt('SWR_MCTS_MS', 8000),
  };
}

// Own RNG (separate from seedAI's) so benches can reproduce search decisions
// without coupling to how many aiRand() calls the heuristic makes.
let _rng: (() => number) | null = null;
export function seedMCTS(seed: number): void {
  let s = seed >>> 0;
  _rng = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rand(): number { return _rng ? _rng() : Math.random(); }

// Decision telemetry for benches (reset per run if desired).
// `passRescues` counts pass-margin overrides; `keepPlaying` counts the
// lost-position fallback (#630). Both are narrow guards, so a high firing rate
// is itself a signal that something is wrong — watch them in benches.
// `noiseRescues` counts the subset the measured noise floor caught that the
// fixed constants would have let pass through.
export const mctsStats = { decisions: 0, pulls: 0, ms: 0, disagreements: 0, passRescues: 0, keepPlaying: 0, revealRescues: 0, noiseRescues: 0 };
export function resetMctsStats(): void {
  mctsStats.decisions = 0; mctsStats.pulls = 0; mctsStats.ms = 0; mctsStats.disagreements = 0;
  mctsStats.passRescues = 0; mctsStats.keepPlaying = 0; mctsStats.revealRescues = 0;
  mctsStats.noiseRescues = 0;
}

// ---------------------------------------------------------------------------
// State plumbing.
// ---------------------------------------------------------------------------

/** Clone the state cheaply (catalog reattached by reference — it's immutable).
 *  The turnLog is cloned WITHOUT its 'state' snapshot entries (~1MB each, one
 *  per game turn): cloning them 64×/decision made late-game decisions take
 *  tens of seconds (#569). The AI only reads reveal-mission history from the
 *  log, so decisions are unchanged. The clone is also marked ephemeral so
 *  logState() skips snapshot writes during rollouts. */
function cloneState(G: GameState): GameState {
  const { catalog, turnLog, ...rest } = G;
  const c = structuredClone(rest) as GameState;
  c.catalog = catalog;
  c.turnLog = structuredClone(turnLog.filter((e) => e.kind !== 'state'));
  c.ephemeralSearchClone = true;
  return c;
}

/** Systems the hidden base could be in, from the EMPIRE's public knowledge:
 *  every system with a probe card, minus probe-card rule-outs in hand, minus
 *  searched rule-outs, minus worlds where the base would already have revealed
 *  itself (imperial loyalty or Empire ground — mechanics.checkBaseReveal),
 *  minus destroyed systems. Never reads the true base location. */
export function baseCandidates(G: GameState): SystemId[] {
  const ruledOut = new Set<string>();
  for (const pid of G.empire.probeHand ?? []) {
    const sys = G.catalog.probes[pid]?.systemId;
    if (sys) ruledOut.add(sys);
  }
  for (const sid of G.empireSearchedRuledOut ?? []) ruledOut.add(sid);
  const universe = new Set<string>();
  for (const p of Object.values(G.catalog.probes)) if (p?.systemId) universe.add(p.systemId);
  const out: SystemId[] = [];
  for (const sid of universe) {
    if (ruledOut.has(sid)) continue;
    const ss = G.map.systems[sid as SystemId];
    if (!ss || ss.destroyed) continue;
    if (ss.loyalty === 'imperial' && !ss.subjugated) continue; // would have revealed
    const empireGround = ss.units.some((u) => u.side === 'Empire'
      && G.catalog.unitTypes[u.typeId]?.theater === 'ground');
    if (empireGround) continue; // would have revealed
    out.push(sid as SystemId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base-location belief (the post-RM re-hunt lever). Uniform sampling wastes
// rollouts on worlds no human would pick. Empirical grounding from the
// human-Rebel corpus (scripts/analyze-base-choices.mjs, 24 placements + 4
// relocations): humans are NOT remote-biased (29% vs 31% pool — the "hides at
// Dagobah" intuition is false), ARE loyalty-biased (rebel-loyal at ~2x pool
// rate), and ARE distance-biased (~1 hop farther from Empire ground than the
// average candidate). Weights use FEATURES only — no system identities — so
// the model generalizes beyond the one recorded player.
//
// STATUS: SHIPPED DEFAULT-ON in the browser (2026-07-16) after the RM
// conditioning fixed the parked version's failure. History:
// - UNCONDITIONED (2026-07-14): 3-seed replay A/B measured NO gain — the
//   setup-fitted peaked weights over-committed after the base relocated,
//   because an RM destination is the best of 4 RANDOM probe draws (near-flat
//   posterior), not a free feature-biased choice.
// - CONDITIONED (2026-07-16): peaked pre-RM / uniform post-RM (see
//   beliefWeights). 3-seed replay A/B vs uniform: finds 6/9/8 vs 5/5/5,
//   captures 8/11/10 vs 7/7/9 — better on every seed, both metrics.
// `?belief=0` opts out (sticky), `?belief=1` clears the opt-out. In node the
// default stays OFF so benches A/B explicitly via SWR_MCTS_BELIEF=1/0.
// Side lesson baked into the bench: single-run replay counts swing 5-13 on
// seed alone — always compare multi-seed (--ai-seed).
// ---------------------------------------------------------------------------
const BELIEF_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_MCTS_BELIEF === '1') return true;
    if (proc?.env?.SWR_MCTS_BELIEF === '0') return false;
  } catch { /* browser */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('belief') : null;
    if (q === '0') g.localStorage?.setItem('swr-belief-off', '1');
    if (q === '1') g.localStorage?.removeItem('swr-belief-off');
    if (g.localStorage?.getItem('swr-belief-off') === '1') return false;
    if (typeof g.location !== 'undefined') return true; // browser: default ON
  } catch { /* no localStorage */ }
  return false; // node without SWR_MCTS_BELIEF: benches opt in explicitly
})();

/** Has the base publicly relocated? Rapid Mobilization resolves in the open —
 *  the Empire watches the mission and the "new base established" moment even
 *  though the destination stays hidden — so conditioning the belief on this
 *  uses only public knowledge. Scanned from the tail (relocations are recent
 *  events; the tail hit exits fast). */
function baseHasRelocated(G: GameState): boolean {
  for (let i = G.turnLog.length - 1; i >= 0; i--) {
    if (G.turnLog[i].kind === 'rapid-mobilization-base-established') return true;
  }
  return false;
}

/** Per-candidate belief weights (unnormalized). One BFS from the Empire's
 *  ground presence, shared across all candidates.
 *
 *  CONDITIONED ON RELOCATION (the parked A/B's post-mortem, now confirmed by
 *  the grown corpus — 30 initial placements vs 6 relocations):
 *  - PRE-RM the base sits where the human freely placed it at setup, and setup
 *    choices are strongly feature-biased (rebel-loyal 37% vs 13% pool, dist
 *    2.2 vs 1.3) → the peaked feature weights fit.
 *  - POST-RM the destination was the best of 4 UNIFORM probe draws, and the
 *    corpus shows the choices sitting AT the pool average on our features
 *    (dist 1.5 vs 1.4, remote below pool, loyal only mildly up) — i.e. the
 *    human's in-draw pick criterion is not predictable by our feature score.
 *    A draw-pick posterior ranked by our features was tried here and came out
 *    MORE peaked than setup (rank-1 wins 33% of draws under a perfect proxy)
 *    — the opposite of what the data supports — so post-RM is simply UNIFORM.
 *    Revisit the draw-pick model only when the relocation corpus is big
 *    enough to fit the human's actual pick criterion (>6 events). */
export function beliefWeights(G: GameState, candidates: SystemId[]): Map<SystemId, number> {
  const out = new Map<SystemId, number>();
  if (!BELIEF_ENABLED) { for (const sid of candidates) out.set(sid, 1); return out; }
  // BFS distances from every system with Empire ground.
  const dist: Record<string, number> = {};
  let frontier: string[] = [];
  for (const [sid, ss] of Object.entries(G.map.systems)) {
    if (ss.units.some((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')) {
      dist[sid] = 0; frontier.push(sid);
    }
  }
  let d = 0;
  while (frontier.length) {
    d++; const next: string[] = [];
    for (const s of frontier) for (const a of (G.catalog.adjacency[s] ?? [])) {
      if (dist[a] === undefined) { dist[a] = d; next.push(a); }
    }
    frontier = next;
  }
  const feature = (sid: SystemId): number => {
    const far = Math.min(dist[sid] ?? 6, 6); // unreachable/no-Empire-ground = max
    const loyal = G.map.systems[sid]?.loyalty === 'rebel' ? 2 : 1;
    // (1+far)^1.5: corpus shows chosen bases ~1 hop beyond the candidate mean;
    // a superlinear ramp reproduces that shift without zeroing near systems.
    return Math.pow(1 + far, 1.5) * loyal;
  };
  const relocated = baseHasRelocated(G);
  for (const sid of candidates) out.set(sid, relocated ? 1 : feature(sid));
  return out;
}

/** Weighted sample WITHOUT replacement of up to n candidates. */
function sampleWorlds(candidates: SystemId[], weights: Map<SystemId, number>, n: number): SystemId[] {
  const pool = candidates.map((sid) => ({ sid, w: weights.get(sid) ?? 1 }));
  const out: SystemId[] = [];
  while (out.length < n && pool.length > 0) {
    let total = 0; for (const p of pool) total += p.w;
    let r = rand() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
    out.push(pool[idx].sid);
    pool.splice(idx, 1);
  }
  return out;
}

/** Rewrite a CLONE into the world where the base is at `sampled`. Keeps the
 *  probe deck consistent: the sampled system's card leaves the deck (its base
 *  card would have been pulled at placement) and the real base's card returns
 *  in its place, so rollout probe draws can rule out the real system but never
 *  the sampled base. Units/leaders in rebelBaseSpace ride along untouched —
 *  they live wherever "the base" is. */
function determinize(c: GameState, sampled: SystemId, pidBySystem: Map<string, string>): void {
  const real = c.rebelBaseSystemId;
  if (sampled === real) return;
  c.rebelBaseSystemId = sampled;
  const sPid = pidBySystem.get(sampled);
  const rPid = pidBySystem.get(real);
  if (sPid) {
    const i = c.probeDeck.indexOf(sPid);
    if (i >= 0) {
      const inHand = (c.empire.probeHand ?? []).includes(rPid ?? '');
      if (rPid && !inHand && !c.probeDeck.includes(rPid)) c.probeDeck[i] = rPid;
      else c.probeDeck.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Rollout + leaf evaluation.
// ---------------------------------------------------------------------------

/** Play the clone forward with the heuristic (both sides) until game end or
 *  the horizon. Mirrors the tournament driver's step loop. */
function rollout(c: GameState, horizonRounds: number): void {
  const endTM = c.timeMarker + horizonRounds;
  const stepCap = 220 * Math.max(1, horizonRounds); // ~50 steps/round observed; generous
  let steps = 0;
  while (!c.isGameOver && c.timeMarker < endTM && steps < stepCap) {
    const sd = c.currentPlayer;
    if (stepOnce(c, sd)) { steps++; continue; }
    const o: Side = sd === 'Rebel' ? 'Empire' : 'Rebel';
    if (stepOnce(c, o)) { steps++; continue; }
    break; // nobody can act — evaluate what we have
  }
}

/** Leaf value in [0,1] from `side`'s perspective. Terminal results dominate;
 *  otherwise boardEval.evaluate plus an INFORMATION term — each still-alive
 *  base candidate is bad for the Empire (the hunt's whole currency), which is
 *  what makes rule-out progress visible inside a bounded horizon. */
function leafValue(c: GameState, side: Side, refWeight = 1): number {
  if (c.winner === side) return 1;
  if (c.winner && c.winner !== side) return 0;
  let v = leafEvaluate(c, side);
  if (!c.rebelBaseRevealed) {
    // Information term as BELIEF MASS, not raw count: ruling out a system a
    // human would actually pick (far, rebel-loyal) is worth more than ruling
    // out one they wouldn't. refWeight is the ROOT decision's mean candidate
    // weight — a fixed scale across all leaves of one search, so the term
    // equals the old per-candidate count under a flat belief and drops by
    // w/refWeight (>1 for likely systems) per cleared candidate otherwise.
    // Normalizing by the LEAF's own mean would cancel the weights entirely.
    const cand = baseCandidates(c);
    const w = beliefWeights(c, cand);
    let sum = 0; for (const sid of cand) sum += w.get(sid) ?? 1;
    v += (side === 'Empire' ? -1 : 1) * 2 * (sum / Math.max(1e-6, refWeight));
  }
  // Scale-free squash to (0,1): robust to evaluate()'s unbounded range.
  return 0.5 + 0.5 * (v / (Math.abs(v) + 60));
}

// ---------------------------------------------------------------------------
// The decision procedure.
// ---------------------------------------------------------------------------

let searching = false; // re-entrancy guard: rollouts use the plain heuristic

/** A completed search, decoupled from the commit so the search can run on a
 *  DECODED COPY in a web worker while the real G stays on the main thread.
 *  Everything here is plain JSON (postMessage-safe). */
export interface MctsSearchResult {
  chosen: ReturnType<typeof bestCommandAction>[number];
  /** Ready-to-log 'ai-decision' payload; null for the single-candidate
   *  shortcut (which never logged a trace). */
  trace: Record<string, unknown> | null;
}

/** Determinized flat-MC Command decision for `side` (built for the Empire; the
 *  math is side-symmetric). Returns true if it committed an action on G; false
 *  to fall through to the heuristic (not a clean Command decision, or search
 *  found nothing legal). Safe as a setCommandPolicyOverride policy. */
export function mctsCommandStep(G: GameState, side: Side, cfg?: Partial<MctsConfig>): boolean {
  const res = searchMctsCommand(G, side, cfg);
  if (!res) return false;
  return commitMctsCommand(G, side, res);
}

/** Commit a search result on the REAL state. Kept separate so the worker
 *  bridge can post a result across threads and apply it here. Returns false
 *  if the executor rejects it (caller falls back to the heuristic). */
export function commitMctsCommand(G: GameState, side: Side, res: MctsSearchResult): boolean {
  const committed = res.chosen.kind === 'pass'
    ? phases.pass(G, side).ok
    : tryCommandAction(G, side, res.chosen);
  if (committed && res.trace) {
    // Same 'ai-decision' trace the heuristic writes (no new registry kind) —
    // logged after commit, like the heuristic's (we only know the choice
    // stuck once the engine accepts it).
    logEvent(G, { kind: 'ai-decision', side, payload: res.trace });
  }
  return committed;
}

/** SEARCH ONLY — no mutation of G beyond none (rollouts run on clones).
 *  Returns null when this isn't a searchable spot / nothing legal. */
export function searchMctsCommand(G: GameState, side: Side, cfg?: Partial<MctsConfig>): MctsSearchResult | null {
  if (searching) return null;
  if (G.isGameOver || G.phase !== 'Command' || G.currentPlayer !== side) return null;
  if (G.pendingChoice || G.pendingMission || G.pendingCombat) return null;

  const conf = { ...defaultConfig(), ...cfg };
  const t0 = Date.now();

  const candidates = bestCommandAction(G, side).slice(0, conf.topK);
  if (candidates.length === 0) return null; // heuristic will pass
  // Nothing to search over — return the only option without burning rollouts.
  if (candidates.length === 1) {
    return { chosen: candidates[0], trace: null };
  }

  // Determinization pool: sampled base worlds (pre-reveal) or reality (post).
  const pidBySystem = new Map<string, string>();
  for (const [pid, p] of Object.entries(G.catalog.probes)) {
    if (p?.systemId) pidBySystem.set(p.systemId, pid);
  }
  let worlds: SystemId[];
  let refWeight = 1; // root mean belief weight — the leaf info term's scale
  if (G.rebelBaseRevealed || side === 'Rebel') {
    // Post-reveal everyone knows the base; the REBEL always does — its search
    // needs no determinization at all (MCTS-Rebel), just reality.
    worlds = [G.rebelBaseSystemId];
    if (side === 'Rebel' && !G.rebelBaseRevealed) {
      // Still normalize the leaf info term (surviving candidates are GOOD for
      // the Rebel) by the same root-mean scale the Empire search uses, so the
      // term's magnitude matches the belief weights computed at each leaf.
      const pool = baseCandidates(G);
      if (pool.length > 0) {
        const rootW = beliefWeights(G, pool);
        let wSum = 0; for (const sid of pool) wSum += rootW.get(sid) ?? 1;
        refWeight = wSum / pool.length;
      }
    }
  } else {
    const pool = baseCandidates(G);
    if (pool.length === 0) worlds = [G.rebelBaseSystemId];
    else {
      // Belief-weighted sample (without replacement): spend rollouts on the
      // worlds a human would actually pick, not uniformly across the map.
      const rootW = beliefWeights(G, pool);
      worlds = sampleWorlds(pool, rootW, Math.max(1, conf.maxDets));
      let wSum = 0; for (const sid of pool) wSum += rootW.get(sid) ?? 1;
      refWeight = pool.length ? wSum / pool.length : 1;
    }
  }

  // UCB1 across root actions; each pull rolls one world (cycled round-robin so
  // every action's mean averages over the same belief distribution).
  // `sumsq` exists only so an arm can report its own measurement error to the
  // pass guard below — a mean with no spread attached cannot say whether it
  // beat the field or beat the dice.
  const arms = candidates.map((a) => ({ a, n: 0, sum: 0, sumsq: 0, dead: false }));
  const dbg = envDebug();
  const dbgOutcomes = new Map<(typeof arms)[number], { win: number; loss: number; cut: number; endTM: number }>();
  const totalBudget = Math.max(arms.length, conf.budget);
  let pulls = 0;
  for (let t = 0; t < totalBudget; t++) {
    if (Date.now() - t0 > conf.msCap) break;
    let arm = null as (typeof arms)[number] | null;
    let bestU = -Infinity;
    for (const x of arms) {
      if (x.dead) continue;
      const u = x.n === 0
        ? Infinity
        : x.sum / x.n + conf.ucbC * Math.sqrt(Math.log(Math.max(2, pulls)) / x.n);
      if (u > bestU) { bestU = u; arm = x; }
    }
    if (!arm) break;

    const c = cloneState(G);
    // Pair worlds by the ARM's own pull count (common random numbers): every
    // arm's k-th rollout plays the same sampled base, so arm means differ by
    // action quality, not by which worlds the global pull order dealt them.
    determinize(c, worlds[arm.n % worlds.length], pidBySystem);
    let ok = false;
    searching = true;
    try {
      ok = arm.a.kind === 'pass' ? phases.pass(c, side).ok : tryCommandAction(c, side, arm.a);
      if (ok) rollout(c, conf.horizonRounds);
    } catch {
      ok = false; // a rollout crash kills the arm, never the game
    } finally {
      searching = false;
    }
    if (!ok) { arm.dead = true; continue; }
    const lv = leafValue(c, side, refWeight);
    arm.n++;
    arm.sum += lv;
    arm.sumsq += lv * lv;
    pulls++;
    if (dbg) {
      const d = (dbgOutcomes.get(arm) ?? { win: 0, loss: 0, cut: 0, endTM: 0 });
      if (c.winner === side) d.win++; else if (c.winner) d.loss++; else d.cut++;
      d.endTM += c.timeMarker;
      dbgOutcomes.set(arm, d);
    }
  }

  if (dbg) {
    const rows = arms.filter((x) => x.n > 0).map((x) => {
      const d = dbgOutcomes.get(x) ?? { win: 0, loss: 0, cut: 0, endTM: 0 };
      const a = x.a as { kind: string; missionId?: string; leaderId?: string; targetSystemId?: string; score: number };
      return {
        action: a.kind + (a.missionId ? `:${a.missionId}` : '') + (a.leaderId ? `:${a.leaderId}` : '') + (a.targetSystemId ? `@${a.targetSystemId}` : ''),
        score: Math.round(a.score * 10) / 10,
        n: x.n, mean: Math.round((x.sum / x.n) * 1000) / 1000,
        win: d.win, loss: d.loss, cut: d.cut,
        avgEndTM: Math.round((d.endTM / Math.max(1, x.n)) * 10) / 10,
      };
    }).sort((p, q) => q.mean - p.mean);
    // eslint-disable-next-line no-console
    console.log('[mcts-debug] tm=%d decision arms:', G.timeMarker);
    // eslint-disable-next-line no-console
    for (const r of rows) console.log('  ', JSON.stringify(r));
  }

  const alive = arms.filter((x) => !x.dead && x.n > 0);
  if (alive.length === 0) return null; // heuristic takes over
  alive.sort((x, y) => y.sum / y.n - x.sum / x.n);
  let chosen = alive[0].a;
  // PASS-MARGIN (#580/#581/#516): with ~5-15 pulls per arm and near-binary
  // rollout outcomes (terminal win 1.0 vs horizon-cut ~0.7-0.8), one lucky
  // rollout swings an arm's mean by more than the whole field's spread —
  // which is how 'pass' kept topping the list against score-40 attacks
  // (reporters watched the Empire pass with fleets next to targets; traces
  // showed pass mc=1.0 over tiny n). Passing forfeits the rest of the
  // Empire's round, so a statistical tie must NOT go to pass: it wins only
  // by beating the best actionable arm by a real margin. When the
  // alternatives are genuinely bad their means sit clearly lower and pass
  // still goes through.
  // Recorded for the trace so a future "why did it pass?" report can be read
  // off the log instead of re-derived by replaying the board.
  let passGuard: { gap: number; se: number; eff: number } | null = null;
  if (chosen.kind === 'pass' && alive.length > 1) {
    const acts = alive.filter((x) => x.a.kind !== 'pass');
    const bestAct = acts[0];
    if (bestAct) {
      const margin = envInt('SWR_MCTS_PASS_MARGIN', 5) / 100;
      const passMean = alive[0].sum / alive[0].n;
      const actMean = bestAct.sum / bestAct.n;
      // REVEAL-MARGIN (#649). Forfeiting a REVEAL is not symmetric with
      // forfeiting an activation: the leaders are ALREADY committed to that
      // mission, so passing spends them for the round and buys nothing — the
      // card just returns to hand. And after the assignment gate (ddaa0af) a
      // reveal candidate only exists because assignment judged the mission
      // worth playing and its targets aren't pointless.
      //
      // Meanwhile the search cannot actually tell these apart. On #649's board
      // the two arms sat at ~0.52-0.58 with almost every rollout horizon-cut,
      // and the pass-vs-reveal gap wandered from -0.025 to +0.063 across seeds
      // on RNG alone. With ~30 pulls per arm near p=0.5 the sampling error on
      // the difference is roughly +/-0.09 — WIDER than the 0.05 base margin, so
      // the guard was calibrated tighter than the measurement it guards, and
      // ~28% of seeds forfeited Vader's whole round to noise.
      //
      // So require a gap that actually clears the noise before throwing a
      // committed mission away. Set SWR_MCTS_REVEAL_MARGIN=5 to collapse this
      // back onto the base margin (the A/B control).
      const revealMargin = envInt('SWR_MCTS_REVEAL_MARGIN', 15) / 100;
      // SOLE REVEAL. A tuned margin only works while it stays wider than the
      // noise it filters, and this one did not: 140 commits of engine changes
      // after the fix above, #649's board no longer wanders around zero — the
      // search now prefers pass by more than the base margin on EVERY seed, and
      // by more than 0.15 on a quarter of them. Chasing that with a bigger
      // constant just buys time until the next drift.
      //
      // When the reveal is the ONLY actionable arm there is nothing to defer
      // to, so no gap justifies passing: the leaders are already committed, so
      // pass spends their round and hands the card back for nothing. That is a
      // structural fact about the position, not a quantity to measure, so it
      // does not belong behind a threshold.
      //
      // Deliberately narrow — it requires a SINGLE actionable arm, so boards
      // with a real choice (#630 has 5, #639 has 6) are untouched and still go
      // through the margin path below. SWR_MCTS_REVEAL_SOLE=0 to A/B it off.
      const soleReveal = acts.length === 1 && bestAct.a.kind === 'reveal'
        && envInt('SWR_MCTS_REVEAL_SOLE', 1) === 1;
      // MEASURED NOISE (#705 and the wider pass-with-plays cluster: #706 #702
      // #695 #629 #617 #600 #581 #580). Both margins above are CONSTANTS
      // standing in for how big the search's sampling error is, and #649's note
      // recorded the hazard in that: "the guard was calibrated tighter than the
      // measurement it guards." Nothing in the code could check that, because
      // an arm carried a mean with no spread attached.
      //
      // Now it can. `stderr` is the standard error of an arm's own mean and
      // `noiseSE` the SE of the pass-vs-best-action difference, recorded on
      // every guarded decision via the trace's `passGuard`. Read them before
      // touching either constant.
      //
      // First reading, on #705's board over 20 seeds: SE ~0.03-0.04 against a
      // pass-vs-action gap of 0.02-0.09. So the 0.05 activation margin is NOT
      // swamped by noise the way the reveal margin was, and the 30% of seeds
      // that pass there are passing on a ~2-SE preference — the search really
      // does rate pass above the alternatives on that board. That makes the
      // remaining reports a question about the LEAF EVALUATION (does it value
      // a forfeited round correctly?) rather than about this guard, which is
      // why no threshold here was changed.
      //
      // SWR_MCTS_PASS_Z scales the SE into an additional floor under the
      // margins. Default 0 = off, constants unchanged: it exists so the
      // hypothesis can be A/B'd without a rebuild, NOT as tuning already
      // believed in.
      const stderr = (x: { n: number; sum: number; sumsq: number }): number => {
        if (x.n < 1) return 0;
        const m = x.sum / x.n;
        // n<2 has no sample variance; fall back to the Bernoulli bound, an
        // over-estimate for the horizon-cut values that cluster tightly.
        if (x.n < 2) return Math.sqrt(Math.max(0, m * (1 - m)));
        const v = Math.max(0, (x.sumsq - x.n * m * m) / (x.n - 1));
        return Math.sqrt(v / x.n);
      };
      // SE of the difference of two means. Common random numbers pair the arms'
      // rollouts, so treating them as independent OVER-states this slightly.
      const noiseSE = Math.hypot(stderr(alive[0]), stderr(bestAct));
      const z = envInt('SWR_MCTS_PASS_Z', 0) / 100;
      const baseMargin = bestAct.a.kind === 'reveal' ? Math.max(margin, revealMargin) : margin;
      const effMargin = soleReveal ? Infinity : Math.max(baseMargin, z * noiseSE);
      passGuard = { gap: passMean - actMean, se: noiseSE, eff: effMargin };
      if (passMean - actMean < effMargin) {
        chosen = bestAct.a;
        mctsStats.passRescues++;
        if (passMean - actMean >= margin) mctsStats.revealRescues++;
        if (passMean - actMean >= baseMargin) mctsStats.noiseRescues++;
      } else if (
        envInt('SWR_MCTS_KEEP_PLAYING', 1) === 1
        && acts.every((x) => x.sum / x.n <= envInt('SWR_MCTS_LOST_FLOOR', 1) / 100)
      ) {
        // KEEP-PLAYING (#630). The margin rule above assumes the means carry
        // information. In a position the search rates as LOST they carry none:
        // every action arm rolls out at exactly 0 while pass picks up a couple
        // of stray wins purely because ending the round early lands the rollout
        // in a different part of the tree. #630's own trace is pass 2/17 = 0.118
        // against five action arms at 0/9..0/10 = 0.000 — a gap of 0.118 that
        // sails past the 0.05 margin on no evidence at all.
        //
        // With no gradient there is nothing to defer TO, and passing makes the
        // AI visibly down tools with legal moves on the table (the reporter:
        // "the empire gave up on turn 6 and passed after one action despite
        // having several leaders and missions"). So when NO action arm ever won
        // a rollout, fall back to the heuristic's own ranking, which is the only
        // signal left. Deliberately narrow: one action arm above the floor and
        // the search has a real preference again, so this stops firing.
        //
        // Picked by heuristic SCORE rather than by arm order: with every mean
        // tied at 0 the sort above is arbitrary among them.
        chosen = acts.reduce((best, x) => (x.a.score > best.a.score ? x : best), bestAct).a;
        mctsStats.keepPlaying++;
      }
    }
  }

  mctsStats.decisions++;
  mctsStats.pulls += pulls;
  mctsStats.ms += Date.now() - t0;
  if (chosen !== candidates[0]) mctsStats.disagreements++;

  // Trace payload with policy:'mcts' + search stats — John's first ?mcts=1
  // playtest could only be attributed by the ABSENCE of traces, which is
  // exactly the forensics the trace exists to avoid.
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const r3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
  const brief = (a: (typeof candidates)[number]): Record<string, unknown> => {
    const arm = arms.find((x) => x.a === a);
    const mean = arm && arm.n > 0 ? r2(arm.sum / arm.n) : null;
    return a.kind === 'reveal'
      ? { kind: a.kind, missionId: a.missionId, target: a.targetSystemId, score: r2(a.score), mc: mean }
      : a.kind === 'activate'
        ? { kind: a.kind, leaderId: a.leaderId, target: a.targetSystemId, score: r2(a.score), mc: mean }
        : { kind: a.kind, score: r2(a.score), mc: mean };
  };
  return {
    chosen,
    trace: {
      policy: 'mcts',
      chose: brief(chosen),
      alts: alive.filter((x) => x.a !== chosen).slice(0, 5).map((x) => brief(x.a)),
      search: {
        pulls, worlds: worlds.length, ms: Date.now() - t0, heuristicRank: candidates.indexOf(chosen),
        ...(passGuard ? { passGuard: { gap: r3(passGuard.gap), se: r3(passGuard.se), eff: r3(passGuard.eff) } } : {}),
      },
    },
  };
}
