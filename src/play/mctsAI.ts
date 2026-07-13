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
import { bestCommandAction, tryCommandAction, stepOnce } from './randomAI';
import { evaluate } from './boardEval';

// ---------------------------------------------------------------------------
// Enablement flag (same resolution pattern as PLANNER_ENABLED).
// ---------------------------------------------------------------------------
export const MCTS_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_MCTS === '1') return true;
  } catch { /* browser: no process */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('mcts') : null;
    if (q === '1') g.localStorage?.setItem('swr-mcts', '1');
    if (q === '0') g.localStorage?.removeItem('swr-mcts');
    if (g.localStorage?.getItem('swr-mcts') === '1') return true;
  } catch { /* no localStorage */ }
  return false;
})();

// ---------------------------------------------------------------------------
// Tunables (env-overridable so benches can sweep without code edits).
// ---------------------------------------------------------------------------
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
export const mctsStats = { decisions: 0, pulls: 0, ms: 0, disagreements: 0 };
export function resetMctsStats(): void {
  mctsStats.decisions = 0; mctsStats.pulls = 0; mctsStats.ms = 0; mctsStats.disagreements = 0;
}

// ---------------------------------------------------------------------------
// State plumbing.
// ---------------------------------------------------------------------------

/** Clone the state cheaply (catalog reattached by reference — it's immutable). */
function cloneState(G: GameState): GameState {
  const { catalog, ...rest } = G;
  const c = structuredClone(rest) as GameState;
  c.catalog = catalog;
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
function leafValue(c: GameState, side: Side): number {
  if (c.winner === side) return 1;
  if (c.winner && c.winner !== side) return 0;
  let v = evaluate(c, side);
  if (!c.rebelBaseRevealed) {
    const nCand = baseCandidates(c).length;
    v += (side === 'Empire' ? -1 : 1) * 2 * nCand;
  }
  // Scale-free squash to (0,1): robust to evaluate()'s unbounded range.
  return 0.5 + 0.5 * (v / (Math.abs(v) + 60));
}

// ---------------------------------------------------------------------------
// The decision procedure.
// ---------------------------------------------------------------------------

let searching = false; // re-entrancy guard: rollouts use the plain heuristic

/** Determinized flat-MC Command decision for `side` (built for the Empire; the
 *  math is side-symmetric). Returns true if it committed an action on G; false
 *  to fall through to the heuristic (not a clean Command decision, or search
 *  found nothing legal). Safe as a setCommandPolicyOverride policy. */
export function mctsCommandStep(G: GameState, side: Side, cfg?: Partial<MctsConfig>): boolean {
  if (searching) return false;
  if (G.isGameOver || G.phase !== 'Command' || G.currentPlayer !== side) return false;
  if (G.pendingChoice || G.pendingMission || G.pendingCombat) return false;

  const conf = { ...defaultConfig(), ...cfg };
  const t0 = Date.now();

  const candidates = bestCommandAction(G, side).slice(0, conf.topK);
  if (candidates.length === 0) return false; // heuristic will pass
  // Nothing to search over — commit the only option without burning rollouts.
  if (candidates.length === 1) {
    const a = candidates[0];
    return a.kind === 'pass' ? phases.pass(G, side).ok : tryCommandAction(G, side, a);
  }

  // Determinization pool: sampled base worlds (pre-reveal) or reality (post).
  const pidBySystem = new Map<string, string>();
  for (const [pid, p] of Object.entries(G.catalog.probes)) {
    if (p?.systemId) pidBySystem.set(p.systemId, pid);
  }
  let worlds: SystemId[];
  if (G.rebelBaseRevealed) {
    worlds = [G.rebelBaseSystemId];
  } else {
    const pool = baseCandidates(G);
    if (pool.length === 0) worlds = [G.rebelBaseSystemId];
    else {
      // Fisher-Yates then take up to maxDets distinct worlds.
      for (let i = pool.length - 1; i > 0; i--) {
        const k = Math.floor(rand() * (i + 1));
        [pool[i], pool[k]] = [pool[k], pool[i]];
      }
      worlds = pool.slice(0, Math.max(1, conf.maxDets));
    }
  }

  // UCB1 across root actions; each pull rolls one world (cycled round-robin so
  // every action's mean averages over the same belief distribution).
  const arms = candidates.map((a) => ({ a, n: 0, sum: 0, dead: false }));
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
    arm.n++;
    arm.sum += leafValue(c, side);
    pulls++;
  }

  const alive = arms.filter((x) => !x.dead && x.n > 0);
  if (alive.length === 0) return false; // heuristic takes over
  alive.sort((x, y) => y.sum / y.n - x.sum / x.n);
  const chosen = alive[0].a;

  mctsStats.decisions++;
  mctsStats.pulls += pulls;
  mctsStats.ms += Date.now() - t0;
  if (chosen !== candidates[0]) mctsStats.disagreements++;

  if (chosen.kind === 'pass') return phases.pass(G, side).ok;
  if (tryCommandAction(G, side, chosen)) return true;
  return false; // executor rejected on the real state — heuristic fallback
}
