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

/** Clone the state cheaply (catalog reattached by reference — it's immutable). */
function cloneState(G: GameState): GameState {
  const { catalog, ...rest } = G;
  const c = structuredClone(rest) as GameState;
  c.catalog = catalog;
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

/** Depth-2 eval-greedy Command decision: rank all candidates by settled
 *  depth-1 value, then expand the top ROOT_BEAM through the opponent's best
 *  reply and commit the root action with the best post-reply value. */
export function evalCommandStepDeep(G: GameState, side: Side): boolean {
  if (G.phase !== 'Command' || G.currentPlayer !== side) return false;
  if (G.pendingChoice || G.pendingMission || G.pendingCombat) return false;
  const candidates = bestCommandAction(G, side).slice(0, CANDIDATE_CAP);
  if (candidates.length === 0) return phases.pass(G, side).ok;
  const opp: Side = side === 'Rebel' ? 'Empire' : 'Rebel';

  // Depth-1 pass: settled value of each candidate.
  const scored: { a: (typeof candidates)[number]; c: GameState; v1: number }[] = [];
  for (const a of candidates) {
    const c = cloneState(G);
    const ok = a.kind === 'pass' ? phases.pass(c, side).ok : tryCommandAction(c, side, a);
    if (!ok) continue;
    settle(c);
    scored.push({ a, c, v1: evaluate(c, side) });
  }
  if (scored.length === 0) return phases.pass(G, side).ok;
  scored.sort((x, y) => y.v1 - x.v1);

  // Depth-2 pass: expand the beam through the opponent's greedy reply.
  let bestAction = scored[0].a;
  let bestVal = -Infinity;
  for (const s of scored.slice(0, ROOT_BEAM)) {
    const c = s.c; // already settled post-root state
    if (!c.isGameOver) { applyGreedyReply(c, opp); settle(c); }
    const v2 = c.isGameOver
      ? (c.winner === side ? 1e6 : c.winner ? -1e6 : evaluate(c, side))
      : evaluate(c, side);
    if (v2 > bestVal) { bestVal = v2; bestAction = s.a; }
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
    const val = evaluate(c, side);
    if (val > bestVal) { bestVal = val; bestAction = a; }
  }
  if (!bestAction) return phases.pass(G, side).ok;
  if (bestAction.kind === 'pass') return phases.pass(G, side).ok;
  if (tryCommandAction(G, side, bestAction)) return true;
  return phases.pass(G, side).ok;
}
