// Static board-evaluation experiment (John's proposal, 2026-07-01): quantify the
// value of board elements from one side's perspective, then pick the Command
// action that maximizes the resulting state value ("eval-greedy"), as an
// alternative decision policy to the hand-tuned per-action heuristic scores in
// randomAI. Compared head-to-head via scripts/eval-vs-heuristic.mjs.
//
// Terms (per the proposal):
//   - Systems: own-loyal > subjugated-neutral > subjugated-rebel > neutral >
//     enemy-loyal, scaled by resource icons (production is what loyalty buys).
//   - Units: + for own, - for enemy, valued by build cost + durability + dice.
//   - Leaders: valued by skills + tactic values; captured leaders swing double
//     (lost to you AND a mission target for the Empire).
//   - Reputation: the Rebel wins when reputationMarker <= timeMarker, so each
//     step of rep progress is worth a lot to the Rebel and against the Empire.
//   - Base (public info only): once revealed, Empire ground on the base system
//     is the win condition — weight it heavily. Pre-reveal search progress is
//     deliberately NOT modeled (it's not in the positional spec); expected to be
//     the eval-greedy Empire's main weakness vs the heuristic's hunt logic.
//
// This file deliberately owns no side effects; evalCommandStep clones the state
// per candidate (catalog reattached by reference) so the live game is untouched
// until the chosen action is applied for real.

import type { GameState, Side, SystemId } from '../engine/types';
import * as phases from '../engine/phases';
import { bestCommandAction, tryCommandAction } from './randomAI';
import { boardFeatures } from './evalFeatures';
import { LEAF_EVAL } from './leafEvalWeights';

// LEARNED leaf evaluator (#539 Phase 2). Logistic P(side wins) fit on the human
// corpus (scripts/train-leaf-eval.mjs), returned on the SAME signed scale as
// evaluate() — (P - 0.5) * 120 spans ~±60 — so it drops into leafValue's squash
// and the depth-2 beam unchanged. EXPERIMENTAL, default OFF: `?learnedeval=1`
// (sticky) / SWR_LEARNED_EVAL=1 for benches. The point is the corpus down-
// weights raw unit strength (the passivity culprit) and surfaces tempo/economy
// signals (build queue, sabotage, objectives) evaluate() lacks.
export const LEARNED_EVAL_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_LEARNED_EVAL === '1') return true;
    if (proc?.env?.SWR_LEARNED_EVAL === '0') return false;
  } catch { /* browser */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('learnedeval') : null;
    if (q === '1') g.localStorage?.setItem('swr-learned-eval-on', '1');
    if (q === '0') g.localStorage?.removeItem('swr-learned-eval-on');
    if (g.localStorage?.getItem('swr-learned-eval-on') === '1') return true;
  } catch { /* no localStorage */ }
  return false;
})();

export function evaluateLearned(G: GameState, side: Side): number {
  const x = boardFeatures(G, side);
  let t = 0;
  for (let d = 0; d < x.length; d++) {
    const z = d === 0 ? 1 : (x[d] - LEAF_EVAL.mean[d]) / (LEAF_EVAL.std[d] || 1);
    t += LEAF_EVAL.w[d] * z;
  }
  const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, t))));
  return (p - 0.5) * 120; // same signed scale as evaluate()
}

/** Blend weight in [0,1]: 0 = pure hand-tuned evaluate(), 1 = pure learned.
 *  A SMALL weight is the point — the pure learned leaf A/B'd negative because
 *  its dominant features barely move in one turn, flattening the search's
 *  per-move gradient. A convex blend keeps most of evaluate()'s gradient while
 *  adding the learned tempo/calibration signal. Both evals sit on ~the same
 *  ±60 scale (evaluateLearned by construction), so the mix needs no rescale.
 *  SWR_LEARNED_BLEND=0.3 (node) / ?learnedblend=0.3 (browser, sticky). The old
 *  SWR_LEARNED_EVAL / LEARNED_EVAL_ENABLED forces weight 1 (pure) for
 *  back-compat with the earlier bench runs. */
const BLEND_WEIGHT: number = (() => {
  if (LEARNED_EVAL_ENABLED) return 1;
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = proc?.env?.SWR_LEARNED_BLEND;
    if (v !== undefined) { const n = parseFloat(v); if (Number.isFinite(n)) return Math.max(0, Math.min(1, n)); }
  } catch { /* browser */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('learnedblend') : null;
    if (q !== null) { const n = parseFloat(q); if (Number.isFinite(n)) { g.localStorage?.setItem('swr-learned-blend', String(n)); } }
    const stored = g.localStorage?.getItem('swr-learned-blend');
    if (stored != null) { const n = parseFloat(stored); if (Number.isFinite(n)) return Math.max(0, Math.min(1, n)); }
  } catch { /* no localStorage */ }
  return 0;
})();

/** Weight on the FORFEITED-ROUND charge (SWR_PASS_FORFEIT, default 0.5; 0
 *  restores the old blindness).
 *
 *  RR: a player who passes cannot use his leaders to activate systems or reveal
 *  missions for the rest of the Command phase. The evaluator did not know that
 *  — `passedThisCommand` appeared NOWHERE in either eval — so a leader sitting
 *  in the pool scored exactly the same whether or not its owner had just given
 *  up the ability to use it. Passing was free.
 *
 *  That is the leaf-side half of the pass-with-plays cluster. On #600's board
 *  (the one Rebel-side report) the depth-2 trace was:
 *      reveal:sabotage@naboo   heur 37    v1 -233     deep -257
 *      pass                    heur 0.5   v1 -234.5   deep -240.5
 *  The reveal LEADS at depth 1 and only loses after the extension — not the
 *  sampling-noise shape SWR_MCTS_PASS_Z was built for, but a confident
 *  mispricing.
 *
 *  Charged on leaders that the pass STRANDS — still in the pool, or committed
 *  to a face-down mission that can no longer be revealed. Leaders already on
 *  the board are not charged: they have acted. It is a TEMPO cost, not a loss —
 *  the leaders return at Refresh — so the weight is a fraction of their worth,
 *  not the whole thing. Symmetric: the opponent forfeiting is worth the same
 *  to you. */
const PASS_FORFEIT_WEIGHT: number = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = proc?.env?.SWR_PASS_FORFEIT;
    if (v !== undefined) { const n = parseFloat(v); if (Number.isFinite(n)) return Math.max(0, n); }
  } catch { /* browser */ }
  return 0.5;
})();

/** The leaf evaluator the search policies use. One switch so MCTS and depth-2
 *  stay consistent. Blends the learned and hand-tuned evals per BLEND_WEIGHT. */
export function leafEvaluate(G: GameState, side: Side): number {
  if (BLEND_WEIGHT <= 0) return evaluate(G, side);
  if (BLEND_WEIGHT >= 1) return evaluateLearned(G, side);
  return BLEND_WEIGHT * evaluateLearned(G, side) + (1 - BLEND_WEIGHT) * evaluate(G, side);
}

const other = (s: Side): Side => (s === 'Rebel' ? 'Empire' : 'Rebel');

function leaderWorth(G: GameState, lid: string): number {
  const l = G.catalog.leaders[lid];
  if (!l) return 0;
  const sk = l.skills as Record<string, number>;
  return (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0)
    + l.tacticValues.space + l.tacticValues.ground;
}

function unitWorth(G: GameState, typeId: string): number {
  const t = G.catalog.unitTypes[typeId];
  if (!t) return 0;
  const dice = (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0);
  return t.buildResource + (t.health?.value ?? 0) / 2 + dice / 2;
}

/** Aggression term weight (#539 passivity). The search rated 'keep the fleet
 *  home' as safe-and-equal to pressing forward because evaluate() only counted
 *  unit preservation — so it passed with a strong fleet (#516/#538/#580) and
 *  the learned-eval corpus independently down-weighted raw unit strength. This
 *  adds value for PRESSING A LOCAL ADVANTAGE — my surplus strength in a system
 *  where I've made contact (both sides present) — which rewards aggression
 *  that PAYS without rewarding doomed pushes (no bonus when I'm the weaker side
 *  there; the unit-loss term still bites). Tunable to A/B; default 0 until a
 *  win. SWR_AGGRO=0.4 (node) / ?aggro=0.4 (browser, sticky). */
const AGGRO_WEIGHT: number = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = proc?.env?.SWR_AGGRO;
    if (v !== undefined) { const n = parseFloat(v); if (Number.isFinite(n)) return n; }
  } catch { /* browser */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('aggro') : null;
    if (q !== null) { const n = parseFloat(q); if (Number.isFinite(n)) g.localStorage?.setItem('swr-aggro', String(n)); }
    const stored = g.localStorage?.getItem('swr-aggro');
    if (stored != null) { const n = parseFloat(stored); if (Number.isFinite(n)) return n; }
  } catch { /* no localStorage */ }
  return 0;
})();

/** Static value of the position from `side`'s perspective (positive = good). */
export function evaluate(G: GameState, side: Side): number {
  const enemy = other(side);
  const myLoyalty = side === 'Rebel' ? 'rebel' : 'imperial';
  const enemyLoyalty = side === 'Rebel' ? 'imperial' : 'rebel';
  let v = 0;

  // --- Systems (loyalty ladder, resource-scaled) ---
  for (const [sid, ss] of Object.entries(G.map.systems)) {
    if (ss.destroyed) continue;
    const res = G.catalog.systems[sid]?.resources?.length ?? 0;
    if (ss.subjugated) {
      // Subjugation is the Empire holding the system by force. Per the spec:
      // subjugated-neutral is worth more (to the Empire) than subjugated-rebel
      // (an underlying rebel population is a liberation waiting to happen).
      const empireVal = (ss.loyalty === 'rebel' ? 2.5 : 3.5) + res * 0.5;
      v += side === 'Empire' ? empireVal : -empireVal;
    } else if (ss.loyalty === myLoyalty) {
      v += 5 + res;
    } else if (ss.loyalty === enemyLoyalty) {
      v -= 5 + res;
    }
    // A sabotage marker denies production; it only ever hurts the Empire's
    // build (the Rebel places it), so it reads as Rebel-positive on any
    // Empire-producing system.
    if (ss.sabotage && res > 0) v += side === 'Rebel' ? 1.5 : -1.5;
  }

  // --- Units (yours minus theirs) ---
  const scan = (container: { units: { side: Side; typeId: string }[] }) => {
    for (const u of container.units) {
      const w = unitWorth(G, u.typeId);
      v += u.side === side ? w : -w;
    }
  };
  for (const ss of Object.values(G.map.systems)) scan(ss);
  if (G.map.rebelBaseSpace) scan(G.map.rebelBaseSpace);

  // --- Aggression: reward FORWARD PROJECTION that persists at a leaf. Combats
  // resolve within a turn, so "contact" is gone by the round-boundary leaf; the
  // signal that survives is my attack-capable units sitting in territory that
  // isn't mine — the Empire pressing ground toward the base (neutral/rebel
  // systems it's hunting/subjugating), the Rebel striking into Imperial space.
  // This lifts "advance the fleet" above "idle at home" (the #516/#538/#582
  // passivity), and a unit still forward at a leaf survived its combats, so it
  // isn't rewarding a doomed push. Capped per system; modest weight.
  // Gated to PRE-REVEAL: the self-play A/B showed an ungated term left the hunt
  // intact (13/14 revealed either way) but cut conversion (92%→85%) — rewarding
  // forward projection everywhere dilutes the force CONCENTRATION the base
  // assault needs. So it applies only while the base is hidden (press the hunt),
  // and lets concentration dominate once it's found.
  if (AGGRO_WEIGHT !== 0 && !G.rebelBaseRevealed) {
    for (const [sid, ss] of Object.entries(G.map.systems)) {
      if (ss.destroyed) continue;
      if (ss.loyalty === myLoyalty && !ss.subjugated) continue; // home turf: not "forward"
      let myAtk = 0;
      for (const u of ss.units) {
        if (u.side !== side) continue;
        const t = G.catalog.unitTypes[u.typeId];
        myAtk += t ? (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) : 0;
      }
      if (myAtk > 0) v += AGGRO_WEIGHT * Math.min(myAtk, 6);
    }
  }

  // --- Leaders (alive = yours; captured swing double) ---
  const countLeaders = (s: Side): number => {
    const f = s === 'Rebel' ? G.rebel : G.empire;
    let sum = 0;
    for (const lid of f.leaderPool) sum += leaderWorth(G, lid);
    for (const list of Object.values(f.leadersOnBoard)) for (const lid of list) sum += leaderWorth(G, lid);
    for (const m of f.leadersOnMissions) for (const lid of m.leaderIds) sum += leaderWorth(G, lid);
    return sum;
  };
  v += countLeaders(side) - countLeaders(enemy);
  // --- Forfeited round (RR: passing costs you the use of your leaders) ---
  // See PASS_FORFEIT_WEIGHT. Only leaders the pass STRANDS: pooled, or on a
  // face-down mission that can no longer be revealed this phase.
  if (PASS_FORFEIT_WEIGHT > 0) {
    const strandedByPass = (s: Side): number => {
      if (!(G.passedThisCommand ?? []).includes(s)) return 0;
      const f = s === 'Rebel' ? G.rebel : G.empire;
      let sum = 0;
      for (const lid of f.leaderPool) sum += leaderWorth(G, lid);
      for (const m of f.leadersOnMissions) for (const lid of m.leaderIds) sum += leaderWorth(G, lid);
      return sum;
    };
    v -= PASS_FORFEIT_WEIGHT * strandedByPass(side);
    v += PASS_FORFEIT_WEIGHT * strandedByPass(enemy);
  }
  for (const cl of G.empire.capturedLeaders ?? []) {
    const lid = typeof cl === 'string' ? cl : (cl as { leaderId?: string }).leaderId ?? '';
    const w = leaderWorth(G, lid) * 2;
    v += side === 'Empire' ? w : -w;
  }

  // --- Reputation clock (Rebel wins when reputationMarker <= timeMarker) ---
  const repProgress = G.trackLength - G.reputationMarker; // grows as Rebel scores
  v += (side === 'Rebel' ? 1 : -1) * repProgress * 6;

  // --- Revealed base (public info): Empire ground there is the Empire win ---
  if (G.rebelBaseRevealed && G.rebelBaseSystemId) {
    const baseSys = G.map.systems[G.rebelBaseSystemId as SystemId];
    let empGround = 0;
    for (const u of baseSys?.units ?? []) {
      if (u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground') empGround++;
    }
    const term = 10 + empGround * 3;
    v += side === 'Empire' ? term : -term;
  }

  return v;
}

/** Clone the state cheaply (catalog reattached by reference — it's immutable).
 *  Strips 'state' snapshot entries (~1MB/turn) from the cloned turnLog and
 *  marks the clone ephemeral (logState no-op) — same fix as mctsAI (#569):
 *  depth-2 clones candidates × replies, so full-log clones went quadratic. */
function cloneState(G: GameState): GameState {
  const { catalog, turnLog, ...rest } = G;
  const c = structuredClone(rest) as GameState;
  c.catalog = catalog;
  c.turnLog = structuredClone(turnLog.filter((e) => e.kind !== 'state'));
  c.ephemeralSearchClone = true;
  return c;
}

const CANDIDATE_CAP = 60;

// ---------------------------------------------------------------------------
// Depth-2 search (the follow-up experiment): the depth-1 eval-greedy tied the
// heuristic exactly, and every prior probe says the gap is MULTI-TURN — so try
// looking one opponent reply ahead. For each root candidate: apply on a clone,
// settle sub-choices (heuristic resolves both sides' pending prompts, same as
// live play), then give the OPPONENT their best eval-greedy reply (their eval,
// their perspective), settle again, and score the result from the root side.
// Beam-limited: all root candidates get the depth-1 eval; only the top
// ROOT_BEAM expand the opponent reply (candidates pre-sorted by the heuristic
// score, capped at OPP_CAP — the heuristic order is a good prefilter).
// ---------------------------------------------------------------------------

const ROOT_BEAM = 6;
const OPP_CAP = 20;

import { stepOnce } from './randomAI';

/** Resolve pending sub-choices/mission/combat on a scratch state until it's at
 *  a clean decision point again (mirrors the tournament driver). Mutates c. */
function settle(c: GameState): void {
  let guard = 0;
  while (!c.isGameOver && (c.pendingChoice || c.pendingMission || c.pendingCombat) && guard++ < 500) {
    if (stepOnce(c, c.currentPlayer)) continue;
    const o = c.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
    if (stepOnce(c, o as Side)) continue;
    break; // nobody can act — leave as-is, evaluate what we have
  }
}

/** Apply `side`'s best eval-greedy Command action on scratch state c (used as
 *  the opponent model inside the depth-2 search). No-op if it isn't a clean
 *  Command decision for that side. */
function applyGreedyReply(c: GameState, side: Side): void {
  if (c.isGameOver || c.phase !== 'Command' || c.currentPlayer !== side) return;
  if (c.pendingChoice || c.pendingMission || c.pendingCombat) return;
  const candidates = bestCommandAction(c, side).slice(0, OPP_CAP);
  let best: GameState | null = null;
  let bestVal = -Infinity;
  for (const a of candidates) {
    const cc = cloneState(c);
    const ok = a.kind === 'pass' ? phases.pass(cc, side).ok : tryCommandAction(cc, side, a);
    if (!ok) continue;
    settle(cc);
    const val = evaluate(cc, side);
    if (val > bestVal) { bestVal = val; best = cc; }
  }
  if (best) {
    // Copy the chosen continuation back onto c (cheaper than re-applying).
    const { catalog, ...rest } = best;
    void catalog;
    Object.assign(c, rest);
  }
}

/** Depth-N eval-greedy Command decision: rank all candidates by settled
 *  depth-1 value, then expand the top ROOT_BEAM by playing out `depth - 1`
 *  further moves — each made greedily by WHOEVER holds the turn (usually
 *  alternating opponent/self, but Rebellion's Command turn order can hand the
 *  same side consecutive actions; following currentPlayer keeps the line
 *  turn-order-correct). Commit the root action with the best end-of-line value
 *  from the root side's perspective.
 *  depth=2 reproduces the original depth-2 design (one opponent reply);
 *  depth=3 adds the root side's own follow-up, valuing initiative/tempo. */
export function evalCommandStepDeep(G: GameState, side: Side, depth = 2): boolean {
  if (G.phase !== 'Command' || G.currentPlayer !== side) return false;
  if (G.pendingChoice || G.pendingMission || G.pendingCombat) return false;
  const candidates = bestCommandAction(G, side).slice(0, CANDIDATE_CAP);
  if (candidates.length === 0) return phases.pass(G, side).ok;

  // Depth-1 pass: settled value of each candidate.
  const scored: { a: (typeof candidates)[number]; c: GameState; v1: number }[] = [];
  for (const a of candidates) {
    const c = cloneState(G);
    const ok = a.kind === 'pass' ? phases.pass(c, side).ok : tryCommandAction(c, side, a);
    if (!ok) continue;
    settle(c);
    scored.push({ a, c, v1: leafEvaluate(c, side) });
  }
  if (scored.length === 0) return phases.pass(G, side).ok;
  scored.sort((x, y) => y.v1 - x.v1);

  // Deep pass: extend the beam lines with greedy moves by whoever is to act.
  const dbg = (() => {
    try {
      const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
      return proc?.env?.SWR_EVAL_DEBUG === '1';
    } catch { return false; }
  })();
  let bestAction = scored[0].a;
  let bestVal = -Infinity;
  const deepVals: { a: (typeof candidates)[number]; v: number }[] = [];
  for (const s of scored.slice(0, ROOT_BEAM)) {
    const c = s.c; // already settled post-root state
    for (let d = 1; d < depth && !c.isGameOver; d++) {
      applyGreedyReply(c, c.currentPlayer);
      settle(c);
    }
    const v = c.isGameOver
      ? (c.winner === side ? 1e6 : c.winner ? -1e6 : leafEvaluate(c, side))
      : leafEvaluate(c, side);
    deepVals.push({ a: s.a, v });
    if (dbg) {
      const a = s.a as { kind: string; missionId?: string; targetSystemId?: string; score?: number };
      // eslint-disable-next-line no-console
      console.log('[eval-debug]', side, a.kind + (a.missionId ? ':' + a.missionId : '') + (a.targetSystemId ? '@' + a.targetSystemId : ''),
        'heur', Math.round((a.score ?? 0) * 10) / 10, 'v1', Math.round(s.v1 * 100) / 100, 'deep', Math.round(v * 100) / 100);
    }
    if (v > bestVal) { bestVal = v; bestAction = s.a; }
  }

  // PASS-MARGIN (the depth-2 analog of mctsAI's rule; reporters watched the
  // Rebel pass with 1-3 leaders still on missions): settle() samples ONE
  // stochastic resolution of each reveal, so a single bad sampled roll drops
  // a reveal a point or two below pass — and passing forfeits every assigned
  // mission for the round. A near-tie must not go to pass: it wins only by
  // beating the best actionable line by a real margin on the eval scale
  // (SWR_EVAL_PASS_MARGIN in eval points, default 3; =0 restores old
  // behavior). When every actionable line is genuinely much worse, pass
  // still goes through.
  if (bestAction.kind === 'pass') {
    const bestAct = deepVals.filter((x) => x.a.kind !== 'pass').sort((p, q) => q.v - p.v)[0];
    if (bestAct) {
      const margin = (() => {
        try {
          const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
          const v = proc?.env?.SWR_EVAL_PASS_MARGIN;
          if (v !== undefined) { const n = parseInt(v, 10); if (Number.isFinite(n)) return n; }
        } catch { /* browser */ }
        return 3;
      })();
      if (bestVal - bestAct.v < margin) bestAction = bestAct.a;
    }
  }
  if (bestAction.kind === 'pass') return phases.pass(G, side).ok;
  if (tryCommandAction(G, side, bestAction)) return true;
  return phases.pass(G, side).ok;
}

/** Eval-greedy Command decision: enumerate the heuristic's candidate actions
 *  (reusing its legality/enumeration work, IGNORING its scores), apply each on
 *  a clone, and commit the action whose resulting state evaluates best. Returns
 *  true if it acted; false when this isn't a plain Command decision (caller
 *  falls back to the heuristic stepper for choices/combat/other phases). */
export function evalCommandStep(G: GameState, side: Side): boolean {
  if (G.phase !== 'Command' || G.currentPlayer !== side) return false;
  if (G.pendingChoice || G.pendingMission || G.pendingCombat) return false;
  const candidates = bestCommandAction(G, side).slice(0, CANDIDATE_CAP);
  if (candidates.length === 0) return phases.pass(G, side).ok;
  let bestAction = null as (typeof candidates)[number] | null;
  let bestVal = -Infinity;
  for (const a of candidates) {
    const c = cloneState(G);
    const ok = a.kind === 'pass' ? phases.pass(c, side).ok : tryCommandAction(c, side, a);
    if (!ok) continue;
    const val = leafEvaluate(c, side);
    if (val > bestVal) { bestVal = val; bestAction = a; }
  }
  if (!bestAction) return phases.pass(G, side).ok;
  if (bestAction.kind === 'pass') return phases.pass(G, side).ok;
  if (tryCommandAction(G, side, bestAction)) return true;
  return phases.pass(G, side).ok;
}
