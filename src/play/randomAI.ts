// Heuristic AI. Plays strategically per the user's directives:
//
// REBEL: prefer missions over moves. Keep the base hidden — don't move
// units toward Empire-proximity areas. Use diplomacy. Prioritize
// objective-advancing missions.
//
// EMPIRE: reserve 1-2 leaders for opposition. Use probes aggressively to
// narrow the base location. Capture rebel leaders (cap at 1 to avoid
// the auto-release). Use diplomacy on high-value systems.
//
// "Look-ahead per phase" interpretation: when making the first Assignment-
// phase decision, the AI plans the full slate of leader-to-mission
// assignments and commits to the best one; subsequent calls re-plan
// against the updated state. For Command phase, each turn the AI scores
// all available actions (reveal, activate, pass) and picks the best.
//
// Contract: stepOnce(G, side) performs exactly one engine call when it's `side`'s
// turn. The caller is expected to call it in a loop (with refresh in between)
// until G.currentPlayer flips back to the human, the game ends, or we're in a
// state with no valid AI action.

import type { GameState, Side, LeaderId, SystemId } from '../engine/types';
import * as phases from '../engine/phases';
import * as combat from '../engine/combat';
import { missionTargets } from '../engine/missionTargets';

function pick<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================================
// Strategy primitives
// ============================================================================

/** How many leaders the Empire AI tries to keep in the pool for opposition.
 *  At least one when revealable missions exist. */
const EMPIRE_RESERVE_LEADERS = 1;

/** Static-ish strategic value of attempting a mission, before situational
 *  modifiers. Higher = AI cares more about this mission. */
function missionBaseValue(missionId: string, side: Side): number {
  const empireValues: Record<string, number> = {
    // Probe-card pulls — narrowing base. Bumped: human Empire wins
    // showed running probe-draw missions twice in T1 + T2 is critical
    // to set up subjugation-search later. These should beat almost
    // everything else early.
    'gather-intel': 15,
    'research-and-development': 13,
    // Captures — rob the Rebel of a leader
    'capture-rebel-operative': 11,
    'collect-bounty': 10,
    'detained': 8,
    'carbon-freezing': 6,
    'lure-of-the-dark-side': 9,
    'interrogation': 7,
    'interrogation-droid': 8,
    'retrieve-the-plans': 8,
    // Diplomacy / loyalty
    'rule-by-fear': 9,
    'trade-negotiations': 7,
    'fear-will-keep-them-in-line': 7,
    // Projects (build queue plumbing)
    'construct-death-star': 14,
    'construct-factory': 9,
    'construct-super-star-destroyer': 11,
    'oversee-project': 8,
    'superlaser-online': 10,
    // Subjugation / sabotage
    'sabotage': 6,
  };
  const rebelValues: Record<string, number> = {
    // Defensive / base protection
    'hit-and-run': 9,
    'hidden-fleet': 8,
    'demolition': 8,
    // Diplomacy / loyalty (user emphasized)
    'wookie-uprising': 12,
    'support-of-mon-calamari': 12,
    'establish-trade-relations': 10,
    'ignite-rebellion': 10,
    'public-uprising': 10,
    'for-the-greater-good': 11,
    // Recruit / rescue
    'daring-rescue': 12,
    'an-old-friend': 9,
    'seek-yoda': 11,
    // Sabotage / info
    'covert-operation': 8,
    'plant-false-lead': 9,
    'homing-beacon': 7,
    'intercept-transmissions': 7,
    'base-defenses': 8,
    'stolen-plans': 9,
    'misdirection': 7,
    // Critical-path
    'plan-the-assault': 10,
    'lead-the-strike-team': 11,
    'contingency-plan': 8,
    'rapid-mobilization': 9,
  };
  const table = side === 'Empire' ? empireValues : rebelValues;
  return table[missionId] ?? 5;
}

/** Skill-fit of a single leader for a single mission. Returns 0 if the
 *  leader contributes none of the mission's required skill, else weighted
 *  by skill icons. */
function leaderSkillFit(G: GameState, leaderId: LeaderId, missionId: string): number {
  const card = G.catalog.missions[missionId];
  const leader = G.catalog.leaders[leaderId];
  if (!card || !leader || !card.skill) return 0;
  // Mission counts-all-skills special-case (rare).
  const countsAll = card.id === 'interrogation-droid' || card.id === 'lure-of-the-dark-side';
  if (countsAll) {
    const sk = leader.skills;
    return (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0);
  }
  return leader.skills[card.skill as keyof typeof leader.skills] ?? 0;
}

/** Bonus for the leader matching the mission's preferred portrait (the
 *  illustrated leader on the card). Strong hint about intended-pairing. */
function leaderPortraitBonus(G: GameState, leaderId: LeaderId, missionId: string): number {
  const card = G.catalog.missions[missionId];
  if (!card || !card.leaderPortrait) return 0;
  return card.leaderPortrait === leaderId ? 4 : 0;
}

/** Hard-coded leader-mission pairings the engine especially values
 *  (e.g. mission-card text rewards specific leaders). */
function leaderMissionBespoke(leaderId: LeaderId, missionId: string): number {
  // An Old Friend: Han at Bespin/Kashyyyk to recruit Lando/Chewie.
  if (missionId === 'an-old-friend' && leaderId === 'han-solo') return 4;
  // Seek Yoda → Luke gets the Jedi swap.
  if (missionId === 'seek-yoda' && leaderId === 'luke-skywalker') return 5;
  // Contingency Plan: Lando gives +2 successes later.
  if (missionId === 'contingency-plan' && leaderId === 'lando-calrissian') return 3;
  // Construct Death Star / SSD prefer Jerjerrod or Tarkin.
  if (missionId === 'construct-death-star' && (leaderId === 'moff-jerjerrod' || leaderId === 'grand-moff-tarkin')) return 3;
  // Build/queue work prefers Tarkin.
  if ((missionId === 'oversee-project' || missionId === 'construct-factory')
    && leaderId === 'grand-moff-tarkin') return 3;
  return 0;
}

/** Combined "should this leader take this mission?" score. Returns -Infinity
 *  if it would be illegal (mission requires a different leader by name). */
function leaderMissionScore(G: GameState, leaderId: LeaderId, missionId: string, side: Side): number {
  const card = G.catalog.missions[missionId];
  if (!card) return -Infinity;
  const fit = leaderSkillFit(G, leaderId, missionId);
  // If the mission has a skill requirement and the leader contributes nothing,
  // they're a poor pick unless we're combining with another leader.
  // We still return a non-negative score (the planner can pair them).
  const value = missionBaseValue(missionId, side);
  const portrait = leaderPortraitBonus(G, leaderId, missionId);
  const bespoke = leaderMissionBespoke(leaderId, missionId);
  return value + fit * 2 + portrait + bespoke;
}

/** Does the Empire already hold a captured Rebel leader (cap at 1 — user's
 *  point that a second capture releases the first)? */
function empireHoldingCapture(G: GameState): boolean {
  return (G.empire.capturedLeaders ?? []).some((c) => c.ring === 'captured');
}

/** A mission's situational adjustment: amplify or suppress based on board
 *  state. E.g. capture missions are worthless if Empire already holds a
 *  captured leader; probe missions are worthless once base is revealed. */
function missionSituationalAdjust(G: GameState, missionId: string, side: Side): number {
  if (side === 'Empire') {
    const captureKinds = new Set(['capture-rebel-operative', 'collect-bounty', 'detained']);
    if (captureKinds.has(missionId) && empireHoldingCapture(G)) return -10;
    const probeKinds = new Set(['gather-intel', 'research-and-development']);
    if (probeKinds.has(missionId) && G.rebelBaseRevealed) return -8;
  }
  if (side === 'Rebel') {
    // Daring Rescue worthless unless there's a captured leader.
    if (missionId === 'daring-rescue'
      && (G.empire.capturedLeaders?.length ?? 0) === 0) return -8;
    if (missionId === 'for-the-greater-good'
      && (G.empire.capturedLeaders?.length ?? 0) === 0) return -8;
  }
  return 0;
}

/** Single-source shortest-paths over the adjacency graph from `origin`.
 *  Returns a Map of systemId → hop-count. Capped at maxHops to keep the
 *  search tight. */
function bfsDistances(G: GameState, origin: SystemId, maxHops = 10): Map<string, number> {
  const dist = new Map<string, number>([[origin, 0]]);
  let frontier: string[] = [origin];
  for (let d = 1; d <= maxHops; d++) {
    const next: string[] = [];
    for (const s of frontier) {
      for (const n of (G.catalog.adjacency[s] ?? [])) {
        if (!dist.has(n)) { dist.set(n, d); next.push(n); }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return dist;
}

/** Cached distance lookup. Caller passes the BFS map; absent entries are
 *  treated as Infinity. */
function distFrom(map: Map<string, number>, target: SystemId): number {
  return map.get(target) ?? Infinity;
}

/** Count Empire units within 2 hops of the Rebel base. Used by Rebel AI
 *  to detect base threat. */
function empireProximityToBase(G: GameState): number {
  if (!G.rebelBaseSystemId) return 0;
  const dist = bfsDistances(G, G.rebelBaseSystemId, 2);
  let count = 0;
  for (const [sysId, d] of dist) {
    if (d > 2) continue;
    count += (G.map.systems[sysId]?.units ?? []).filter((u) => u.side === 'Empire').length;
  }
  return count;
}

/** Score a target system for an Empire mission, with situational bias. */
function empireMissionTargetScore(G: GameState, missionId: string, targetSysId: SystemId): number {
  let s = 0;
  const sys = G.catalog.systems[targetSysId];
  if (!sys) return -Infinity;
  // Generally prefer high-resource systems for build/diplomacy missions.
  const resourceWeight = (sys.resources?.length ?? 0);
  if (missionId.startsWith('rule-by-fear') || missionId.startsWith('trade-negotiations')
    || missionId === 'fear-will-keep-them-in-line') {
    s += resourceWeight * 2;
  }
  // Captures / probes don't care about target system per se.
  if (missionId === 'gather-intel') s += 3;
  return s;
}

/** Score a target system for a Rebel mission. `baseDist` is a precomputed
 *  hop-count map from the Rebel base (or null when base is revealed/missing). */
function rebelMissionTargetScore(
  G: GameState, missionId: string, targetSysId: SystemId,
  baseDist: Map<string, number> | null,
): number {
  let s = 0;
  const sysDef = G.catalog.systems[targetSysId];
  const sysState = G.map.systems[targetSysId];
  if (!sysDef) return -Infinity;
  if (baseDist) {
    const d = distFrom(baseDist, targetSysId);
    if (d <= 1) s -= 6;
    else if (d === 2) s -= 2;
  }
  if (missionId === 'establish-trade-relations' || missionId === 'wookie-uprising'
    || missionId === 'support-of-mon-calamari') {
    s += (sysDef.resources?.length ?? 0) * 2;
    // Don't target a system that's already Rebel-loyal — wasted loyalty gain.
    if (sysState?.loyalty === 'rebel' && !sysState.subjugated) s -= 6;
  }
  // Sabotage (Rebel mission) should target ENEMY systems, never own.
  // Issues #10, #13: the AI was sabotaging Bespin / Alderaan when those
  // were Rebel-loyal, which is strategic self-harm.
  if (missionId === 'sabotage') {
    if (sysState?.loyalty === 'rebel' && !sysState.subjugated) {
      s -= 20; // huge penalty — never sabotage own system
    } else if (sysState?.loyalty === 'imperial' || sysState?.subjugated) {
      s += 6; // reward sabotaging Imperial-controlled systems
    }
    if (sysState?.sabotage) s -= 10; // already sabotaged
  }
  return s;
}

// ============================================================================
// Assignment planner
// ============================================================================

/** Plan the full Assignment phase: which leaders should go on which missions
 *  for this side.
 *
 *  Algorithm: for each mission in hand, compute the CHEAPEST leader-set
 *  that meets its skill cost (or null if no such set exists). Score by
 *  mission value - leader-cost-penalty. Greedy-commit top-scoring missions
 *  in order, marking leaders used. Skip infeasible missions entirely —
 *  previous bug had the planner committing top leaders to high-value
 *  missions they could never reveal (cost not met), starving the actually-
 *  attemptable missions of leaders. */
function planAssignment(G: GameState, side: Side): Array<{ missionId: string; leaderIds: LeaderId[] }> {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const hand = [...f.missionHand];
  if (f.leaderPool.length === 0 || hand.length === 0) return [];

  // Score every mission's best feasible leader-set.
  type Plan = { missionId: string; leaderIds: LeaderId[]; score: number; leaderSkillSum: number };
  const computePlanForMission = (missionId: string, availableLeaders: LeaderId[]): Plan | null => {
    const card = G.catalog.missions[missionId];
    if (!card || !card.skill) return null;
    const sit = missionSituationalAdjust(G, missionId, side);
    if (sit < -5) return null;
    const cost = card.skillCost;
    // Rank leaders by skill fit for this mission (best first).
    const ranked = availableLeaders
      .map((lid) => ({ lid, fit: leaderSkillFit(G, lid, missionId) }))
      .filter((x) => x.fit > 0 || cost === 0) // include zero-fit only when no cost
      .sort((a, b) => b.fit - a.fit);
    // Greedy: add leaders in fit-order until cost is met.
    const used: LeaderId[] = [];
    let sum = 0;
    for (const r of ranked) {
      if (sum >= cost) break;
      used.push(r.lid);
      sum += r.fit;
    }
    if (sum < cost) return null; // infeasible — skip
    // Base mission value + situational + leader bonuses minus the
    // opportunity cost of using N leaders (we'd rather a 1-leader plan
    // than a 2-leader one all else equal).
    const baseValue = missionBaseValue(missionId, side) + sit;
    const leaderBonus = used.reduce((s, l) => s + leaderPortraitBonus(G, l, missionId) + leaderMissionBespoke(l, missionId), 0);
    const score = baseValue + leaderBonus - used.length * 0.5;
    return { missionId, leaderIds: used, score, leaderSkillSum: sum };
  };

  // Greedy multi-round selection: each round, pick the highest-scoring
  // feasible plan with currently-free leaders, commit it, mark leaders used,
  // and recompute.
  const usedLeaders = new Set<string>();
  const planMap: Array<{ missionId: string; leaderIds: LeaderId[] }> = [];
  const usedMissions = new Set<string>();
  while (true) {
    const available = (f.leaderPool as LeaderId[]).filter((lid) => !usedLeaders.has(lid));
    if (available.length === 0) break;
    // Empire reserve: stop if we'd leave fewer than EMPIRE_RESERVE_LEADERS in pool.
    if (side === 'Empire' && f.leaderPool.length - usedLeaders.size <= EMPIRE_RESERVE_LEADERS) break;
    let best: Plan | null = null;
    for (const missionId of hand) {
      if (usedMissions.has(missionId)) continue;
      const p = computePlanForMission(missionId, available);
      if (!p) continue;
      if (!best || p.score > best.score) best = p;
    }
    if (!best || best.score <= 0) break;
    planMap.push({ missionId: best.missionId, leaderIds: best.leaderIds });
    usedMissions.add(best.missionId);
    for (const l of best.leaderIds) usedLeaders.add(l);
  }
  return planMap;
}

// ============================================================================
// Command-phase action scorer
// ============================================================================

type CommandAction =
  | { kind: 'reveal'; missionId: string; targetSystemId: SystemId; score: number }
  | { kind: 'activate'; leaderId: LeaderId; targetSystemId: SystemId; score: number }
  | { kind: 'pass'; score: number };

/** Enumerate command-phase actions and score them. Returns highest-scoring
 *  action. Precomputes one BFS distance map from the Rebel base (when
 *  hidden) for use across all per-system scoring. */
function bestCommandAction(G: GameState, side: Side): CommandAction {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const actions: CommandAction[] = [];
  const allSystemIds = Object.keys(G.map.systems);
  const baseDist = (side === 'Rebel' && G.rebelBaseSystemId && !G.rebelBaseRevealed)
    ? bfsDistances(G, G.rebelBaseSystemId, 3)
    : null;
  // Precompute the set of probe-eliminated systems for the Empire.
  const eliminatedByProbe = side === 'Empire'
    ? new Set((G.empire.probeHand ?? [])
        .map((pid) => G.catalog.probes[pid]?.systemId)
        .filter((s): s is string => !!s))
    : new Set<string>();

  // 1) Revealing assigned missions whose skill cost is met AND at least one
  //    legal target exists. Previously we'd score any system, pick the best
  //    one, and let the engine reject illegal targets — this resulted in
  //    missions like capture-rebel-operative scoring high every turn but
  //    failing to reveal (no Rebel-leader + Empire-unit shared system),
  //    causing the AI to pass instead.
  for (const am of f.leadersOnMissions) {
    const card = G.catalog.missions[am.missionId];
    if (!card || !card.skill) continue;
    let skillSum = 0;
    for (const lid of am.leaderIds) skillSum += leaderSkillFit(G, lid as LeaderId, am.missionId);
    if (skillSum < card.skillCost) continue;
    const targets = missionTargets(G, side, am.missionId);
    // If the encoder couldn't narrow targets (permissive), allow all systems;
    // otherwise restrict to the engine-legal list.
    const candidateSystems = targets.permissive ? allSystemIds : targets.systemIds;
    if (candidateSystems.length === 0) continue;
    const baseValue = missionBaseValue(am.missionId, side) + missionSituationalAdjust(G, am.missionId, side);
    let bestTarget: SystemId | null = null;
    let bestTargetScore = -Infinity;
    for (const sysId of candidateSystems) {
      const t = side === 'Empire'
        ? empireMissionTargetScore(G, am.missionId, sysId)
        : rebelMissionTargetScore(G, am.missionId, sysId, baseDist);
      if (t > bestTargetScore) { bestTargetScore = t; bestTarget = sysId; }
    }
    if (!bestTarget) continue;
    actions.push({
      kind: 'reveal',
      missionId: am.missionId,
      targetSystemId: bestTarget,
      score: baseValue + bestTargetScore + 6,
    });
  }

  // 2) Activating systems. Pre-score each system once (not per-leader) since
  //    the per-system signal doesn't change between leaders.
  // Pre-compute base candidates from the Empire perspective: systems the
  // Rebel base could still be at (not Coruscant, not remote, not probe-
  // eliminated). When this set shrinks, the Empire pivots to actively
  // visiting those systems to "stumble onto" the base.
  let baseCandidateSet: Set<string> | null = null;
  if (side === 'Empire' && !G.rebelBaseRevealed) {
    baseCandidateSet = new Set(
      allSystemIds.filter((sid) => {
        if (sid === 'coruscant') return false;
        const def = G.catalog.systems[sid];
        if (!def || def.isRemote) return false;
        if (eliminatedByProbe.has(sid)) return false;
        return true;
      }),
    );
  }
  const narrowingMode = baseCandidateSet ? baseCandidateSet.size <= 6 : false;
  const systemScore = new Map<string, number>();
  for (const sysId of allSystemIds) {
    let ts = 0;
    const sys = G.map.systems[sysId];
    if (!sys) continue;
    const def = G.catalog.systems[sysId];
    const hasEnemyUnits = sys.units.some((u) => u.side !== side);
    const hasOwnUnits = sys.units.some((u) => u.side === side);
    if (side === 'Empire') {
      // Existing baseline.
      if (hasEnemyUnits) ts += 4;
      if (eliminatedByProbe.has(sysId)) ts -= 4;
      // Spread heuristic — reward visiting untouched neutral/Rebel-loyalty
      // systems to extend Imperial control + drop a unit for subjugation.
      // Worth more when the system has build resources.
      if (!hasOwnUnits && !sys.subjugated) {
        const resourceWeight = def?.resources?.length ?? 0;
        ts += 2 + resourceWeight;
        // Already Empire-loyal (string compare — sys.loyalty is just a string).
        if (sys.loyalty === 'imperial') ts -= 2;
      }
      // Base-narrowing pivot: when probe info has narrowed candidates,
      // strongly reward visiting remaining candidate systems (looking
      // to bump into the base).
      if (baseCandidateSet?.has(sysId)) {
        if (narrowingMode) ts += 6;
        else ts += 2;
      }
      // Spread within the current Command turn: if an Empire leader is
      // already on this system, another leader going there is wasted
      // (they'd subjugate the same place). Penalize unless the base is
      // revealed there — in that case we WANT all leaders converging.
      const empireLeadersHere = (G.empire.leadersOnBoard[sysId] ?? []).length;
      if (G.rebelBaseRevealed && sysId === G.rebelBaseSystemId) {
        // CONVERGE on the revealed base: massively reward sending leaders
        // here, especially if a first attack already happened (Pattern 4:
        // two-wave attack same turn).
        ts += 25;
      } else if (empireLeadersHere > 0) {
        ts -= 5 * empireLeadersHere;
      }
      // Don't waste activations on Coruscant or systems already saturated.
      if (sysId === 'coruscant') ts -= 3;
    } else {
      if (baseDist) {
        const d = distFrom(baseDist, sysId);
        if (d <= 1) ts -= 5;
      }
      if (sys.loyalty?.side === 'Empire') ts += 3;
    }
    if (hasOwnUnits && side === 'Rebel') ts += 1;
    systemScore.set(sysId, ts);
  }
  // For each pool leader, pick their best target.
  for (const leaderId of f.leaderPool as LeaderId[]) {
    const l = G.catalog.leaders[leaderId];
    if (!l) continue;
    if (l.tacticValues.space + l.tacticValues.ground === 0) continue;
    let bestT: SystemId | null = null;
    let bestTS = -Infinity;
    for (const sysId of allSystemIds) {
      const ts = systemScore.get(sysId) ?? 0;
      if (ts > bestTS) { bestTS = ts; bestT = sysId; }
    }
    if (!bestT || bestTS <= 0) continue;
    actions.push({
      kind: 'activate',
      leaderId,
      targetSystemId: bestT,
      score: bestTS,
    });
  }

  actions.push({ kind: 'pass', score: 0.5 });
  actions.sort((a, b) => b.score - a.score);
  return actions[0]!;
}

/** Run one AI action for `side`. Returns true if something happened (caller
 *  should re-render and may call again), false if nothing left to do. */
export function stepOnce(G: GameState, side: Side): boolean {
  if (G.isGameOver) return false;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const did = stepOnceInner(G, side);
  const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  if (elapsed > 500) {
    // Per-step budget exceeded — log so the slow path can be diagnosed.
    console.warn(`[ai] slow stepOnce: ${elapsed.toFixed(0)}ms`, {
      side, phase: G.phase, pendingChoice: G.pendingChoice?.kind, currentPlayer: G.currentPlayer,
    });
  }
  return did;
}

function stepOnceInner(G: GameState, side: Side): boolean {
  if (G.isGameOver) return false;

  // Pending-choice handlers run REGARDLESS of whose turn it is: an opponent
  // can owe a choice (e.g. OpposeMission during the other side's turn,
  // CombatAttackerTactics/CombatDefenderTactics mid-combat).
  if (G.pendingChoice && G.pendingChoice.kind === 'OpposeMission' && G.pendingChoice.opposerSide === side) {
    return handleOpposeMission(G, side);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatAttackerTactics' && G.pendingChoice.side === side) {
    return handleCombatAttackerTactics(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatDefenderTactics' && G.pendingChoice.side === side) {
    return handleCombatDefenderTactics(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'BuildPick' && G.pendingChoice.side === side) {
    return handleBuildPick(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatAssignDamage' && G.pendingChoice.side === side) {
    return handleCombatAssignDamage(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'YodaReroll' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    if (c.context === 'mission') {
      // AI: always reroll the first blank (it's a free upgrade — same
      // policy as the auto-apply we replaced).
      const idx = c.blankIndices[0] ?? null;
      return phases.resolveYodaMissionReroll(G, idx).ok;
    }
    return handleYodaReroll(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'R2D2Flip' && G.pendingChoice.side === side) {
    // AI Rebel: flip the most valuable Empire die.
    const c = G.pendingChoice;
    const score = (face: string) =>
      face === 'direct-hit' ? 4 : face === 'hit' ? 3 : face === 'special' ? 2 : 0;
    let bestIdx = -1;
    let bestScore = -1;
    // Source the faces from the appropriate context.
    let faces: string[] = [];
    if (c.context === 'combat') {
      const dice = G.pendingCombat?.pendingAttack?.dice ?? [];
      faces = dice.map((d) => d.face);
    } else {
      faces = c.missionFaces ?? [];
    }
    for (const i of c.flippableDieIndices) {
      const s = score(faces[i] ?? 'blank');
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    // AI policy: only spend the once-per-game card if the target is at least
    // a hit (worth 3+). Otherwise save it.
    const flipIndex = bestScore >= 3 ? bestIdx : null;
    if (c.context === 'mission') return phases.resolveR2D2MissionFlip(G, flipIndex).ok;
    return combat.resolveR2D2Flip(G, flipIndex).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'SpecialDieSpend' && G.pendingChoice.side === side) {
    return handleSpecialDieSpend(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatStartActionCards' && G.pendingChoice.side === side) {
    return handleCombatStartActionCards(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RetreatDecision' && G.pendingChoice.side === side) {
    return handleRetreatDecision(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DeathStarPlansAttempt' && G.pendingChoice.side === side) {
    // AI: always attempt — it's a free shot at destroying the Death Star.
    return combat.resolveDeathStarPlansAttempt(G, true).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'MoreDangerousTheaterPick' && G.pendingChoice.side === side) {
    // AI: pick the deck with more remaining cards (avoid drawing 0 of 0).
    const theater: 'space' | 'ground' = G.groundTacticDeck.length >= G.spaceTacticDeck.length ? 'ground' : 'space';
    return combat.resolveMoreDangerousTheaterPick(G, theater).ok;
  }
  // Assignment-timed action card play: the AI never proactively opens this
  // modal (random Assignment branch just assigns or skips). But if for some
  // reason the choice is posted, cancel out / pick a random candidate-system
  // so we don't deadlock.
  if (G.pendingChoice && G.pendingChoice.kind === 'PlayAssignmentActionCard' && G.pendingChoice.side === side) {
    return phases.cancelAssignmentActionCardPlay(G).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ActionCardSystemPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const sysId = pick(c.candidates);
    if (!sysId) return false;
    return phases.resolveActionCardSystemPick(G, sysId).ok;
  }

  // RecruitActionCardPick fires during the Refresh phase where
  // G.currentPlayer doesn't match the side that owes the choice (refresh
  // is bilateral). Handle it before the "my turn only" gate so the AI
  // doesn't deadlock when its own recruit pick is queued during Rebel's
  // refresh turn (or vice versa).
  if (G.pendingChoice && G.pendingChoice.kind === 'RecruitActionCardPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const f = side === 'Rebel' ? G.rebel : G.empire;
    const canRecruit = (cid: string) => {
      const card = G.catalog.actions[cid];
      if (!card?.leaderRequirement?.length) return false;
      const lid = card.leaderRequirement[0];
      return !!G.catalog.leaders[lid] && !f.leaderPool.includes(lid) && !f.eliminatedLeaders.includes(lid);
    };
    const [a, b] = c.drawnIds;
    const keep = canRecruit(a) ? a : canRecruit(b) ? b : a;
    return phases.resolveRecruitActionCardPick(G, keep).ok;
  }
  // BuildPick is also bilateral during refresh — same fix.
  if (G.pendingChoice && G.pendingChoice.kind === 'BuildPick' && G.pendingChoice.side === side) {
    return handleBuildPick(G);
  }
  // DeployUnitPick is also a bilateral refresh-phase pause.
  if (G.pendingChoice && G.pendingChoice.kind === 'DeployUnitPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const sysId = c.candidates[0]; // first legal target — dumb but deterministic
    return phases.resolveDeployUnitPick(G, sysId).ok;
  }
  // Detained: Empire picks any Rebel leader at the target.
  if (G.pendingChoice && G.pendingChoice.kind === 'DetainedTargetPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveDetainedTargetPick(G, c.candidates[0]).ok;
  }
  // Retrieve The Plans: Empire bottoms the highest-rep Rebel objective.
  if (G.pendingChoice && G.pendingChoice.kind === 'RetrieveThePlansPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestRep = G.catalog.objectives[best]?.reputation ?? 0;
    for (const oid of c.candidates.slice(1)) {
      const r = G.catalog.objectives[oid]?.reputation ?? 0;
      if (r > bestRep) { best = oid; bestRep = r; }
    }
    return phases.resolveRetrieveThePlansPick(G, best).ok;
  }
  // One In A Million: set up to 2 worst dice to direct-hit (always good for Rebel).
  if (G.pendingChoice && G.pendingChoice.kind === 'OneInAMillionOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Rank: blanks worst (0), specials (1), hits (2), direct-hits (3).
    const rank = (f: string) => f === 'blank' ? 0 : f === 'special' ? 1 : f === 'hit' ? 2 : 3;
    const indexed = c.faces.map((f, i) => ({ i, r: rank(f) }))
      .sort((a, b) => a.r - b.r);
    const picks = indexed.slice(0, Math.min(2, indexed.length))
      .filter((x) => x.r < 3) // don't bother overriding direct-hits
      .map((x) => ({ index: x.i, face: 'direct-hit' }));
    if (c.context === 'combat') {
      return combat.resolveOneInAMillionCombat(G, picks).ok;
    }
    return phases.resolveOneInAMillionMission(G, picks).ok;
  }
  // Noble Sacrifice: always accept (+1 reputation, Obi out of capture).
  if (G.pendingChoice && G.pendingChoice.kind === 'NobleSacrificeOffer' && G.pendingChoice.side === side) {
    return phases.resolveNobleSacrificeOffer(G, true).ok;
  }
  // It Is Your Destiny: always capture highest-value rescuer.
  if (G.pendingChoice && G.pendingChoice.kind === 'ItIsYourDestinyOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestScore = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      if (!l) continue;
      const sk = l.skills;
      const score = (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0);
      if (score > bestScore) { best = lid; bestScore = score; }
    }
    return phases.resolveItIsYourDestinyOffer(G, best).ok;
  }
  // Undercover: always relocate the first available candidate.
  if (G.pendingChoice && G.pendingChoice.kind === 'UndercoverOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveUndercoverOffer(G, c.candidates[0] ?? null).ok;
  }
  // Son of Skywalker offer: always pull a mission (free card).
  if (G.pendingChoice && G.pendingChoice.kind === 'SonOfSkywalkerOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveSonOfSkywalkerOffer(G, c.candidates[0] ?? null).ok;
  }
  // Blindside: always accept (denies pool opposition; clear upside).
  if (G.pendingChoice && G.pendingChoice.kind === 'BlindsideOffer' && G.pendingChoice.side === side) {
    return phases.resolveBlindsideOffer(G, true).ok;
  }
  // Wookie Guardian: always accept (auto-fails Empire specOps).
  if (G.pendingChoice && G.pendingChoice.kind === 'WookieGuardianOffer' && G.pendingChoice.side === side) {
    return phases.resolveWookieGuardianOffer(G, true).ok;
  }
  // C-3PO offer: always accept (converts failure → success; no downside).
  if (G.pendingChoice && G.pendingChoice.kind === 'C3POOffer' && G.pendingChoice.side === side) {
    return phases.resolveC3POOffer(G, true).ok;
  }
  // Falcon offer: always rescue the highest-value captured leader.
  if (G.pendingChoice && G.pendingChoice.kind === 'FalconOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Pick whichever has the highest combined skill total — a rough proxy.
    let best = c.candidates[0];
    let bestScore = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      if (!l) continue;
      const sk = l.skills;
      const score = (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0);
      if (score > bestScore) { best = lid; bestScore = score; }
    }
    return phases.resolveFalconOffer(G, best).ok;
  }
  // Brilliant Administrator: default to highest-tier-legal per icon (mirror of TA AI).
  if (G.pendingChoice && G.pendingChoice.kind === 'BrilliantAdministratorBuildPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const pickDefault = (icon: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }): string | null => {
      const need = tierRank[icon.shape] ?? 2;
      const legal = Object.values(G.catalog.unitTypes)
        .filter((t) => t.side === 'Empire' && t.theater === icon.theater
          && (tierRank[t.tier ?? 'square'] ?? 2) <= need && t.class !== 'structure')
        .map((t) => t.id);
      return legal[legal.length - 1] ?? null;
    };
    return phases.resolveBrilliantAdministratorBuildPick(G, c.icons.map(pickDefault)).ok;
  }
  // Catch Them By Surprise: pick first source, move all Empire units there
  // that can travel (greedy-pack).
  if (G.pendingChoice && G.pendingChoice.kind === 'CatchThemBySurpriseMovePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const src = c.candidateSourceSystemIds[0];
    if (!src) return phases.resolveCatchThemBySurpriseMovePick(G, '', []).ok;
    const units = G.map.systems[src].units.filter((u) => u.side === 'Empire');
    // Use the same greedy-pack heuristic.
    const capShipIds: string[] = [];
    const fighterIds: string[] = [];
    const groundIds: string[] = [];
    for (const u of units) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t || t.transport.immobile) continue;
      if (t.transport.capacity > 0) capShipIds.push(u.instanceId);
      else if (t.transport.restriction) fighterIds.push(u.instanceId);
      else if (t.theater === 'ground' && t.class !== 'structure') groundIds.push(u.instanceId);
    }
    let cap = capShipIds.reduce((s, uid) => {
      const u = units.find((x) => x.instanceId === uid);
      return s + (u ? (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) : 0);
    }, 0);
    const picks = [...capShipIds];
    for (const uid of [...fighterIds, ...groundIds]) {
      if (cap <= 0) break;
      picks.push(uid); cap--;
    }
    return phases.resolveCatchThemBySurpriseMovePick(G, src, picks).ok;
  }
  // Scouting Mission: relocate up to 4 TIEs from candidates.
  if (G.pendingChoice && G.pendingChoice.kind === 'ScoutingMissionTIEPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveScoutingMissionTIEPick(G, c.candidateUnitIds.slice(0, c.maxPicks)).ok;
  }
  // Our Most Desperate Hour: pick a random mission from the deck.
  if (G.pendingChoice && G.pendingChoice.kind === 'OurMostDesperateHourPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveOurMostDesperateHourPick(G, c.candidates[0]).ok;
  }
  // Proceeding As Planned: pick a random project from the deck.
  if (G.pendingChoice && G.pendingChoice.kind === 'ProceedingAsPlannedPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveProceedingAsPlannedPick(G, c.candidates[0]).ok;
  }
  // Start The Evacuation: pick the first non-Imperial system, move all
  // mobile Rebel Base units that fit.
  if (G.pendingChoice && G.pendingChoice.kind === 'StartEvacuationPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const target = c.candidateSystemIds[0];
    if (!target) return phases.resolveStartEvacuationPick(G, '', []).ok;
    // Greedy pack like Hidden Fleet.
    const baseUnits = G.map.rebelBaseSpace.units.filter((u) => c.candidateUnitIds.includes(u.instanceId));
    const capShipIds: string[] = [];
    const fighterIds: string[] = [];
    const groundIds: string[] = [];
    for (const u of baseUnits) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      if (t.transport.capacity > 0) capShipIds.push(u.instanceId);
      else if (t.transport.restriction) fighterIds.push(u.instanceId);
      else if (t.theater === 'ground' && t.class !== 'structure') groundIds.push(u.instanceId);
    }
    let cap = capShipIds.reduce((s, uid) => {
      const u = baseUnits.find((x) => x.instanceId === uid);
      return s + (u ? (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) : 0);
    }, 0);
    const picks = [...capShipIds];
    for (const uid of [...fighterIds, ...groundIds]) {
      if (cap <= 0) break;
      picks.push(uid); cap--;
    }
    return phases.resolveStartEvacuationPick(G, target, picks).ok;
  }
  // Independent Operation: Empire picks first Imperial system to retreat to.
  if (G.pendingChoice && G.pendingChoice.kind === 'IndependentOperationEvacPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveIndependentOperationEvacPick(G, c.candidateSystemIds[0]).ok;
  }
  // Hidden Fleet: greedy-pack capital ships first, then fighters/ground
  // up to capacity. Mirrors the old engine auto-pick heuristic.
  if (G.pendingChoice && G.pendingChoice.kind === 'HiddenFleetUnitPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const baseUnits = G.map.rebelBaseSpace.units.filter((u) => c.candidateUnitIds.includes(u.instanceId));
    const capShipIds: string[] = [];
    const fighterIds: string[] = [];
    const groundIds: string[] = [];
    for (const u of baseUnits) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      if (t.transport.capacity > 0) capShipIds.push(u.instanceId);
      else if (t.transport.restriction) fighterIds.push(u.instanceId);
      else if (t.theater === 'ground' && t.class !== 'structure') groundIds.push(u.instanceId);
    }
    let capacity = capShipIds.reduce((s, uid) => {
      const u = baseUnits.find((x) => x.instanceId === uid);
      return s + (u ? (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) : 0);
    }, 0);
    const picks = [...capShipIds];
    for (const uid of [...fighterIds, ...groundIds]) {
      if (capacity <= 0) break;
      picks.push(uid); capacity--;
    }
    return phases.resolveHiddenFleetUnitPick(G, picks).ok;
  }
  // Temporary Alliance: default unit per icon (lowest-tier matching).
  if (G.pendingChoice && G.pendingChoice.kind === 'TemporaryAllianceBuildPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const pickDefault = (icon: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }): string | null => {
      if (icon.theater === 'space') {
        if (icon.shape === 'triangle') return 'x-wing';
        if (icon.shape === 'circle') return 'corellian-corvette';
        return 'mc-cruiser';
      }
      if (icon.shape === 'triangle') return 'rebel-trooper';
      // No square ground unit for Rebel — fall back to airspeeder.
      return 'airspeeder';
    };
    const picks = c.icons.map(pickDefault);
    return phases.resolveTemporaryAllianceBuildPick(G, picks).ok;
  }
  // Contingency Plan: pick a random starting mission from the candidates.
  if (G.pendingChoice && G.pendingChoice.kind === 'ContingencyPlanPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveContingencyPlanPick(G, c.candidates[0]).ok;
  }
  // Rapid Mobilization: prefer establish-base (always-available) over
  // move-units; AI doesn't have great unit-selection heuristics for the
  // move branch.
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationBranch' && G.pendingChoice.side === side) {
    return phases.resolveRapidMobilizationBranch(G, 'establish-base').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationMovePick' && G.pendingChoice.side === side) {
    // Find any Rebel-occupied system and move up to 5 units to base.
    let srcSys: string | null = null;
    let picks: string[] = [];
    for (const sysId of Object.keys(G.map.systems)) {
      const rebels = G.map.systems[sysId].units.filter((u) => u.side === 'Rebel');
      if (rebels.length > 0) { srcSys = sysId; picks = rebels.slice(0, 5).map((u) => u.instanceId); break; }
    }
    if (!srcSys) {
      // Nothing to move — bail without picks.
      return phases.resolveRapidMobilizationMove(G, Object.keys(G.map.systems)[0], []).ok;
    }
    return phases.resolveRapidMobilizationMove(G, srcSys, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationBasePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const candidates = c.baseRevealed
      ? Object.keys(G.map.systems)
      : (c.probeSystemIds ?? []);
    if (candidates.length === 0) {
      // No legal target — just clear the choice via no-op (pick current base
      // — engine will accept any valid system in revealed case).
      const fallback = Object.keys(G.map.systems)[0];
      return phases.resolveRapidMobilizationBasePick(G, fallback).ok;
    }
    return phases.resolveRapidMobilizationBasePick(G, candidates[0]).ok;
  }
  // Interrogation Droid: Rebel picks 2 decoy systems that AREN'T the base.
  if (G.pendingChoice && G.pendingChoice.kind === 'InterrogationDroidDecoyPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const decoys = c.candidates.filter((sid) => sid !== G.rebelBaseSystemId).slice(0, c.count);
    return phases.resolveInterrogationDroidDecoyPick(G, decoys).ok;
  }

  // From here on, only act on our own turn.
  if (G.currentPlayer !== side) return false;

  // If a player choice is pending and this side owns it, resolve it first.
  if (G.pendingChoice && G.pendingChoice.kind === 'StolenPlansReorder' && side === 'Rebel') {
    const c = G.pendingChoice;
    // Pick the highest-rep remaining card to place next on top.
    let best = c.remaining[0];
    let bestRep = G.catalog.objectives[best]?.reputation ?? 0;
    for (const cid of c.remaining.slice(1)) {
      const rep = G.catalog.objectives[cid]?.reputation ?? 0;
      if (rep > bestRep) { best = cid; bestRep = rep; }
    }
    const r = phases.resolveStolenPlansPick(G, best);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PlanTheAssaultShips' && side === 'Rebel') {
    // AI: send every available ship.
    const c = G.pendingChoice;
    const r = phases.resolvePlanTheAssaultShips(G, c.availableShipIds);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DestroyUpToHealth' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const sorted = c.candidates
      .map((uid) => {
        const u = ss?.units.find((x) => x.instanceId === uid);
        const t = u ? G.catalog.unitTypes[u.typeId] : null;
        return { uid, hp: t?.health.value ?? 0, tier: tierRank[t?.tier ?? 'triangle'] ?? 0 };
      })
      .sort((a, b) => b.tier - a.tier || b.hp - a.hp);
    let spent = 0;
    const picks: string[] = [];
    for (const x of sorted) {
      if (spent + x.hp > c.budget) continue;
      picks.push(x.uid); spent += x.hp;
    }
    return phases.resolveDestroyUpToHealth(G, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RogueSquadronRaidPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const sorted = [...c.candidates].sort((a, b) => b.health - a.health);
    let spent = 0;
    const picks: { slot: 1 | 2 | 3; queueIndex: number }[] = [];
    for (const x of sorted) {
      if (spent + x.health > c.budget) continue;
      picks.push({ slot: x.slot, queueIndex: x.queueIndex });
      spent += x.health;
    }
    return phases.resolveRogueSquadronRaidPick(G, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DoubleOurEffortsPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const sorted = [...c.candidates].sort((a, b) => {
      const tA = tierRank[G.catalog.unitTypes[a.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      const tB = tierRank[G.catalog.unitTypes[b.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      return tB - tA || a.slot - b.slot;
    });
    return phases.resolveDoubleOurEffortsPick(G, sorted.slice(0, c.picksAllowed).map((x) => ({ slot: x.slot, queueIndex: x.queueIndex }))).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PlanetaryConquestSourcePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const best = c.sources.reduce((a, b) => (b.picks.length > a.picks.length ? b : a));
    return phases.resolvePlanetaryConquestSourcePick(G, best.sourceSystemId).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'FearWillKeepThemInLinePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Prefer non-Imperial systems first.
    const ranked = [...c.candidates].sort((a, b) => {
      const aRebel = G.map.systems[a]?.loyalty !== 'imperial' ? 1 : 0;
      const bRebel = G.map.systems[b]?.loyalty !== 'imperial' ? 1 : 0;
      return bRebel - aRebel;
    });
    return phases.resolveFearWillKeepThemInLinePick(G, ranked.slice(0, c.count)).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PublicUprisingPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId];
    let empireSpace = 0, empireGround = 0;
    if (ss) for (const u of ss.units) {
      if (u.side !== 'Empire') continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (t?.theater === 'space') empireSpace++; else empireGround++;
    }
    const circle = empireGround > empireSpace ? 'airspeeder' : 'corellian-corvette';
    const triangle = (empireSpace > 0 && empireGround === 0) ? 'x-wing' : 'rebel-trooper';
    return phases.resolvePublicUprisingPick(G, { circle, triangles: [triangle, triangle] }).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'SupportOfMonCalamariPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const alreadyRebel = c.monCalaLoyalty === 'rebel' && !c.monCalaSubjugated;
    return phases.resolveSupportOfMonCalamariPick(G, alreadyRebel ? 'cruiser' : 'loyalty').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'MisdirectionPick' && G.pendingChoice.side === side) {
    // AI: protect the highest-value Rebel leader.
    const c = G.pendingChoice;
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics + l.tacticValues.space + l.tacticValues.ground) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveMisdirectionPick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ResearchAndDevelopmentOption' && side === 'Empire') {
    // AI: cleanse sabotage if available (B), else peek-and-keep (A).
    const c = G.pendingChoice;
    return phases.resolveResearchAndDevelopmentOption(G, c.hasSabotage ? 'B' : 'A').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ResearchAndDevelopmentProjectPick' && side === 'Empire') {
    // AI: keep the first card (heuristic — both project cards are valuable).
    const c = G.pendingChoice;
    return phases.resolveResearchAndDevelopmentProjectPick(G, c.drawnIds[0]).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'OverseeProjectPick' && side === 'Empire') {
    const c = G.pendingChoice;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    let best = c.candidates[0];
    for (const cand of c.candidates.slice(1)) {
      const r = tierRank[G.catalog.unitTypes[cand.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      const rBest = tierRank[G.catalog.unitTypes[best.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      if (r > rBest || (r === rBest && cand.slot < best.slot)) best = cand;
    }
    return phases.resolveOverseeProjectPick(G, best.queueIndex, best.slot).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CaptureOperativePick' && side === 'Empire') {
    const c = G.pendingChoice;
    // Pick highest-value Rebel leader (catalog skills sum).
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics + l.tacticValues.space + l.tacticValues.ground) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveCaptureOperativePick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CarbonFreezingPick' && side === 'Empire') {
    const c = G.pendingChoice;
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveCarbonFreezingPick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'LureOfTheDarkSidePick' && side === 'Empire') {
    const c = G.pendingChoice;
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveLureOfTheDarkSidePick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'HomingBeaconPlace' && side === 'Empire') {
    const c = G.pendingChoice;
    // AI: rescue highest-value leader; place at first system in region.
    let best = c.leaderCandidates[0]; let bestV = -1;
    for (const lid of c.leaderCandidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveHomingBeaconPlace(G, best, c.systemCandidates[0]).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CovertOperationPick' && side === 'Rebel') {
    // AI: keep the higher-rep card.
    const c = G.pendingChoice;
    const [a, b] = c.drawnIds;
    const repA = G.catalog.objectives[a]?.reputation ?? 0;
    const repB = G.catalog.objectives[b]?.reputation ?? 0;
    const keep = repA >= repB ? a : b;
    const r = phases.resolveCovertOperationPick(G, keep);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'InfiltrationPick' && side === 'Rebel') {
    const c = G.pendingChoice;
    const repTop = G.catalog.objectives[c.topId]?.reputation ?? 0;
    const repBottom = G.catalog.objectives[c.bottomId]?.reputation ?? 0;
    const keep = repTop >= repBottom ? c.topId : c.bottomId;
    const r = phases.resolveInfiltrationPick(G, keep);
    return r.ok;
  }
  switch (G.phase) {
    case 'Setup': {
      // If we're the Rebel and a base pick is pending, pick first.
      if (side === 'Rebel' && G.pendingRebelBasePick && G.pendingRebelBasePick.length > 0) {
        const picked = pick(G.pendingRebelBasePick)!;
        const r = phases.pickRebelBase(G, picked);
        if (r.ok) return true;
      }
      // Auto-fill all remaining units for this side.
      const r = phases.setupAutoFill(G, side);
      return r.ok;
    }
    case 'Assignment': {
      // Plan the full Assignment phase; execute one assignment per call.
      // Re-plans every call so the latest state (including action-card
      // recruits, leader captures, etc.) is reflected.
      const plan = planAssignment(G, side);
      const f = side === 'Rebel' ? G.rebel : G.empire;
      for (const entry of plan) {
        if (!f.missionHand.includes(entry.missionId)) continue;
        if (!entry.leaderIds.every((l) => f.leaderPool.includes(l))) continue;
        // Hard rule (both sides): never assign a leader to a mission they
        // can't perform. Drop any leader with zero skill fit for this
        // mission's required skill. The planner already filters these
        // out, but this is a defensive check so the rule holds even if
        // the planner is later refactored.
        const useful = entry.leaderIds.filter((lid) =>
          leaderSkillFit(G, lid as LeaderId, entry.missionId) > 0);
        if (useful.length === 0) continue;
        const r = phases.assignLeader(G, side, entry.missionId, useful);
        if (r.ok) return true;
      }
      return phases.skipAssignment(G, side).ok;
    }
    case 'Command': {
      const action = bestCommandAction(G, side);
      if (action.kind === 'reveal') {
        const r = phases.revealMission(G, side, action.missionId, action.targetSystemId);
        if (r.ok) return true;
        // If reveal failed (illegal target etc.) try a few fallback systems.
        const sysIds = Object.keys(G.map.systems);
        for (let attempt = 0; attempt < 5; attempt++) {
          const fallback = pick(sysIds)!;
          const r2 = phases.revealMission(G, side, action.missionId, fallback);
          if (r2.ok) return true;
        }
        return phases.pass(G, side).ok;
      }
      if (action.kind === 'activate') {
        // Bring along units from one adjacent friendly system if there's
        // value in massing forces. EMPIRE: leave a ground unit at the source
        // so the source system stays subjugated/garrisoned (user's strategy
        // of spreading out, keeping control of visited systems).
        const orders: phases.MoveOrder[] = [];
        const f = side === 'Rebel' ? G.rebel : G.empire;
        const adj = G.catalog.adjacency[action.targetSystemId] ?? [];
        const sources = adj.filter((sysId) => {
          if ((f.leadersOnBoard[sysId] ?? []).length > 0) return false;
          const ss = G.map.systems[sysId];
          return ss && ss.units.some((u) => u.side === side);
        });
        if (sources.length > 0) {
          const fromId = sources[0];
          const ss = G.map.systems[fromId];
          const mine = ss.units.filter((u) => u.side === side);
          let pickIds: string[];
          if (side === 'Empire') {
            // Sort: capital ships first (most valuable to bring), then
            // fighters, then ground last. Reserve one ground unit at source.
            const sortedNonGround = mine.filter((u) => {
              const t = G.catalog.unitTypes[u.typeId];
              return !t || t.theater !== 'ground' || t.class === 'structure';
            });
            const ground = mine.filter((u) => {
              const t = G.catalog.unitTypes[u.typeId];
              return t && t.theater === 'ground' && t.class !== 'structure';
            });
            // Keep one ground unit (the cheapest) at source if possible.
            const groundToBring = ground.length > 1 ? ground.slice(0, ground.length - 1) : [];
            pickIds = [...sortedNonGround.slice(0, 3), ...groundToBring.slice(0, Math.max(0, 3 - sortedNonGround.length))]
              .map((u) => u.instanceId);
          } else {
            // Rebel: same shape as before — bring up to 3 units, no
            // reservation (Rebel rarely wants to leave behind).
            pickIds = mine.slice(0, 3).map((u) => u.instanceId);
          }
          if (pickIds.length > 0) {
            orders.push({ fromSystemId: fromId, unitInstanceIds: pickIds });
          }
        }
        const r = phases.activateSystem(G, side, action.leaderId, action.targetSystemId, orders);
        if (r.ok) return true;
        return phases.pass(G, side).ok;
      }
      return phases.pass(G, side).ok;
    }
    default:
      return false;
  }
}

function handleOpposeMission(G: GameState, side: Side): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'OpposeMission' }>;
  const skill = c.skill;
  // Existing opposers' skill dice.
  const existingSkill = c.existingAtTarget.reduce((s, lid) => {
    const ld = G.catalog.leaders[lid];
    return s + ((ld?.skills as Record<string, number>)?.[skill] ?? 0);
  }, 0);
  // Find the best pool candidate.
  let best: { lid: LeaderId; m: number; v: number } | null = null;
  for (const lid of c.poolLeaders) {
    const ld = G.catalog.leaders[lid];
    if (!ld) continue;
    const m = (ld.skills as Record<string, number>)[skill] ?? 0;
    const v = ld.skills.diplomacy + ld.skills.intel + ld.skills.specOps + ld.skills.logistics
           + ld.tacticValues.space + ld.tacticValues.ground;
    if (!best || m > best.m || (m === best.m && v < best.v)) best = { lid, m, v };
  }
  // Dice math: ~0.5 successes per die. Mission attacker wins ties (no — they
  // need strictly more). With portrait bonuses unknown to us here, treat as
  // expected-equal contest.
  const attExpected = c.attackerDice * 0.5;
  const noOpposeExpected = existingSkill * 0.5;
  // Auto-decline if we already have enough to win without burning a card,
  // or if no pool candidate exists.
  let sentLeader: LeaderId | null = null;
  if (best) {
    const withBestExpected = (existingSkill + best.m) * 0.5;
    // Send a pool leader if it materially improves the math AND
    // (a) we currently lose without them, OR
    // (b) the mission is high-impact for the attacker (captures, key effects).
    const improves = withBestExpected > noOpposeExpected + 0.4;
    const losingWithout = noOpposeExpected < attExpected - 0.5;
    const highImpact = isHighImpactMissionForOpposer(c.missionId, side);
    if (improves && (losingWithout || highImpact)) sentLeader = best.lid;
    // Always send if there are NO existing opposers and the attacker has
    // any dice — a guaranteed loss otherwise.
    if (!sentLeader && existingSkill === 0 && c.attackerDice >= 1 && best.m >= 1) {
      sentLeader = best.lid;
    }
  }
  const r = phases.resolveOpposition(G, sentLeader);
  return r.ok;
}

/** Missions whose effect on the OPPOSING side is particularly bad; the
 *  opposer should commit harder to stopping these. */
function isHighImpactMissionForOpposer(missionId: string, opposerSide: Side): boolean {
  if (opposerSide === 'Rebel') {
    // Empire missions the Rebel REALLY wants to stop.
    return new Set([
      'capture-rebel-operative', 'collect-bounty', 'detained',
      'gather-intel', 'research-and-development',
      'lure-of-the-dark-side', 'carbon-freezing', 'interrogation-droid',
      'retrieve-the-plans',
    ]).has(missionId);
  }
  // Rebel missions the Empire REALLY wants to stop.
  return new Set([
    'daring-rescue', 'for-the-greater-good',
    'plant-false-lead', 'stolen-plans',
    'wookie-uprising', 'support-of-mon-calamari',
    'lead-the-strike-team',
  ]).has(missionId);
}

// ---------- Combat tactic-card heuristics --------------------------------
// Mirrors the prior auto-play behaviour now that those helpers are gone.

function handleCombatAttackerTactics(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAttackerTactics' }>;
  const hits = c.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
  const blanks = c.dice.filter((d) => d.face === 'blank').length;
  let concentrateFire: string | null = null;
  // Concentrate Fire if hit rate < 50% AND we have blanks to reroll.
  if (c.dice.length > 0 && blanks > 0 && hits < Math.ceil(c.dice.length / 2)) {
    concentrateFire = c.hand.find((cid) => cid.includes('concentrate-fire')) ?? null;
  }
  const damageBoosts: string[] = [];
  for (const sub of ['take-it-down', 'critical-hit', 'onslaught']) {
    const cid = c.hand.find((x) => x.includes(sub));
    if (cid) damageBoosts.push(cid);
  }
  const r = combat.resolveCombatAttackerTactics(G, {
    concentrateFireCardId: concentrateFire,
    damageBoostCardIds: damageBoosts,
  });
  return r.ok;
}

function handleCombatDefenderTactics(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatDefenderTactics' }>;
  const blockCards: string[] = [];
  const sacrifices: string[] = [];
  if (c.incomingHits > 0) {
    // Free block first.
    const free = c.hand.find((cid) => cid.includes('defensive-formation'));
    if (free) blockCards.push(free);
    // Then dig-in / outmaneuver if we have a sacrificial spare.
    const paid = c.hand.find((cid) =>
      (cid.includes('dig-in') && c.theater === 'ground') ||
      (cid.includes('outmaneuver') && c.theater === 'space')
    );
    if (paid && c.hand.length >= 2) {
      const sacrifice = c.hand.find((cid) =>
        cid !== paid && cid !== free && !cid.includes('concentrate-fire') // keep concentrate-fire if we have it for next time
      );
      if (sacrifice) { blockCards.push(paid); sacrifices.push(sacrifice); }
    }
  }
  const r = combat.resolveCombatDefenderTactics(G, { blockCardIds: blockCards, sacrificeCardIds: sacrifices });
  return r.ok;
}

// ---------- Build-pick heuristic --------------------------------
// Picks the first legal unit type for each entry (matches the prior
// auto-behavior). Real game would diversify, but this keeps AI-vs-AI
// games running without a UI prompt.
function handleBuildPick(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'BuildPick' }>;
  const choices = c.picks.map((p) => p.legalUnitTypes[0]);
  const r = phases.resolveBuildPicks(G, choices);
  return r.ok;
}

/** AI damage-assignment heuristic — for each incoming hit, pick the
 *  weakest legal target (lowest current effective HP, ties broken by
 *  smaller tier first). Tracks already-staged targets across hits so we
 *  don't waste damage on the same instance. */
function handleCombatAssignDamage(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAssignDamage' }>;
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  const assigned = new Map<string, number>(); // instanceId → damage already queued
  const assignments: (string | null)[] = [];
  // Track per-source-card targets to respect RAW constraints:
  //   take-it-down: subsequent hits MUST go to the same target as the first
  //   onslaught:    subsequent hits MUST go to a DIFFERENT target
  const sourceFirstTarget = new Map<string, string>();
  const sourceTargets = new Map<string, Set<string>>();

  // Find the live unit instance from catalog data + current map state.
  const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
  for (let i = 0; i < c.hits.length; i++) {
    const targets = c.targetsByHit[i];
    if (targets.length === 0) { assignments.push(null); continue; }
    const src = c.hits[i].source;
    const isTakeItDown = src && src.includes('take-it-down');
    const isOnslaught = src && src.includes('onslaught');
    let best: { id: string; remaining: number; tier: number } | null = null;
    for (const tid of targets) {
      // Per-source constraint filtering.
      if (isTakeItDown && sourceFirstTarget.has(src)) {
        if (tid !== sourceFirstTarget.get(src)) continue;
      }
      if (isOnslaught && sourceTargets.get(src)?.has(tid)) continue;
      const u = ss?.units.find((x) => x.instanceId === tid);
      if (!u) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      const queued = assigned.get(tid) ?? 0;
      const remaining = (t.health.value ?? 1) - (u.damage ?? 0) - queued;
      if (remaining <= 0) continue; // already dead under queued damage
      const tier = tierRank[t.tier ?? 'square'] ?? 9;
      if (!best || remaining < best.remaining || (remaining === best.remaining && tier < best.tier)) {
        best = { id: tid, remaining, tier };
      }
    }
    if (best) {
      assignments.push(best.id);
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1);
      if (src) {
        if (!sourceFirstTarget.has(src)) sourceFirstTarget.set(src, best.id);
        if (!sourceTargets.has(src)) sourceTargets.set(src, new Set());
        sourceTargets.get(src)!.add(best.id);
      }
    } else {
      assignments.push(null);
    }
  }
  const r = combat.resolveCombatAssignDamage(G, assignments);
  return r.ok;
}

/** AI: always take the Yoda reroll if available. Reroll the first blank. */
function handleYodaReroll(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'YodaReroll' }>;
  const idx = c.blankIndices.length > 0 ? c.blankIndices[0] : null;
  const r = combat.resolveYodaReroll(G, idx);
  return r.ok;
}

/** AI: spend every available special on drawing tactic cards. Doesn't play
 *  any special-required cards (we'd need card-by-card logic). */
function handleSpecialDieSpend(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'SpecialDieSpend' }>;
  const r = combat.resolveSpecialDieSpend(G, { draws: c.specialCount, playCardIds: [] });
  return r.ok;
}

/** AI: skip Start-of-Combat action cards (effects aren't wired anyway). */
function handleCombatStartActionCards(G: GameState): boolean {
  const r = combat.resolveCombatStartActionCards(G, []);
  return r.ok;
}

/** AI retreat heuristic: retreat only if outnumbered ≥2:1 in either theater.
 *  Take all units. */
function handleRetreatDecision(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'RetreatDecision' }>;
  const ss = G.map.systems[c.systemId];
  const my = ss?.units.filter((u) => u.side === c.side).length ?? 0;
  const opp = ss?.units.filter((u) => u.side !== c.side).length ?? 0;
  const shouldRetreat = my > 0 && opp >= my * 2 && c.legalDestinations.length > 0;
  if (!shouldRetreat) {
    const r = combat.resolveRetreatDecision(G, null, null);
    return r.ok;
  }
  // Pick the first legal destination.
  const r = combat.resolveRetreatDecision(G, c.legalDestinations[0], null);
  return r.ok;
}
