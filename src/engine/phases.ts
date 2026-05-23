// Phase machinery: Assignment / Command / Refresh.
// Combat (sub-machine, triggered mid-Command-turn) is implemented in combat.ts (next task).
// Effect handlers (mission/action/objective text) live in handlers/ (later task).
//
// See docs/engine.md §4–7.

import type {
  GameState, Side, SystemId, LeaderId, MissionResolution,
} from './types';
// (Phase advances from Setup → Assignment internally; no extra imports needed.)
import * as M from './mechanics';
import { beginCombat, runCombat } from './combat';
import { log } from './log';
import * as Handlers from './handlers/registry';
import { missionTargets } from './missionTargets';
import { rollDie } from './rng';
import { objectiveConditionMet, objectiveReputationGain, objectiveReturnsToDeck } from './objectives';

/** Roll N mission dice and count successes. Per Rules Reference "Reveal a
 *  Mission" panel: each player rolls dice of any color, hit = 1 success,
 *  direct-hit = 2 successes. Per RR p.6 "Component Limitations": each player
 *  can roll a maximum of 5 black + 5 red dice per mission (10 total).
 *  Red is statistically better for missions (4/6 expected vs black's 3/6),
 *  so we use red first up to the 5 cap, then black for the remainder. */
function missionDieScore(face: string): number {
  if (face === 'hit' || face === 'direct-hit') return 1;
  if (face === 'special') return 2;
  return 0;
}

/** Per RR p.7 Dice glossary:
 *    Hit during mission = 1 success.
 *    Direct-hit during mission = 1 success.
 *    Special during mission = 2 successes.
 *    Blank = 0.
 *  Per RR p.6 Component Limitations: 5 red + 5 black max per mission. */
function rollMissionDice(
  G: GameState, n: number, side: Side, systemId: SystemId,
): { successes: number; faces: string[]; colors: ('red' | 'black')[] } {
  const red = Math.min(n, 5);
  const black = Math.min(Math.max(0, n - 5), 5);
  const faces: string[] = [];
  const colors: ('red' | 'black')[] = [];
  for (let i = 0; i < red; i++) {
    const r = rollDie(G.rng, 'red');
    faces.push(r.face); colors.push('red');
  }
  for (let i = 0; i < black; i++) {
    const r = rollDie(G.rng, 'black');
    faces.push(r.face); colors.push('black');
  }
  // Yoda ring: if this side has the Yoda holder at the system and hasn't
  // used the reroll this round, reroll one blank die.
  tryYodaReroll(G, side, systemId, faces, colors);
  let successes = 0;
  for (const f of faces) successes += missionDieScore(f);
  return { successes, faces, colors };
}

/** Returns the leader id holding the Yoda ring, or null. (At most one per game.) */
function findYodaHolder(G: GameState): LeaderId | null {
  if (!G.leaderAttachments) return null;
  for (const lid of Object.keys(G.leaderAttachments)) {
    if (G.leaderAttachments[lid].includes('yoda')) return lid as LeaderId;
  }
  return null;
}

/** Apply Yoda's "1/round reroll a die" effect in-place to `faces`/`colors`
 *  if the Yoda holder is on `side` AND present at `systemId` AND hasn't yet
 *  used the reroll this round. Picks the first blank to reroll. */
function tryYodaReroll(
  G: GameState, side: Side, systemId: SystemId,
  faces: string[], colors: ('red' | 'black')[],
): void {
  if (side !== 'Rebel') return; // only Rebel can hold the Yoda ring
  if (G.yodaRerollUsedThisRound) return;
  const yoda = findYodaHolder(G);
  if (!yoda) return;
  const here = G.rebel.leadersOnBoard[systemId] ?? [];
  if (!here.includes(yoda)) return;
  const idx = faces.indexOf('blank');
  if (idx < 0) return; // nothing worth rerolling
  const color = colors[idx];
  const fresh = rollDie(G.rng, color);
  log(G, { kind: 'yoda-reroll', side: 'Rebel', payload: {
    holder: yoda, systemId, color, oldFace: 'blank', newFace: fresh.face,
  }});
  faces[idx] = fresh.face;
  G.yodaRerollUsedThisRound = true;
}

/** Per-mission portrait bonus: if the mission card has a leaderPortrait and one
 *  of the assigned leaders matches it, the resolver gains 2 successes. */
function portraitBonus(G: GameState, missionId: string, leaderIds: LeaderId[]): number {
  const card = G.catalog.missions[missionId];
  if (!card || !card.leaderPortrait) return 0;
  return leaderIds.includes(card.leaderPortrait) ? 2 : 0;
}

/** True if the mission is specifically attempted against a captured leader
 *  (Carbon Freezing, Interrogation, Lure of the Dark Side, etc.). Per RR p.9:
 *  "A captured leader does not participate in the mission, and it is treated
 *  as if it is not in the system. The only time that a captured leader
 *  contributes its skill icons is when a mission is attempted against it." */
function missionTargetsCapturedLeader(G: GameState, missionId: string): boolean {
  const card = G.catalog.missions[missionId];
  if (!card) return false;
  return card.rulesText.toLowerCase().includes('against a captured leader');
}

/** Opposing leaders at a system: normally just the side's leadersOnBoard
 *  there. If the mission targets a captured leader specifically, captured
 *  Rebel leaders at the system ALSO contribute their skill icons (RR p.9).
 *  For any other mission, captured leaders are ignored (treated as if not
 *  in the system). */
function opposerLeadersAt(G: GameState, opposerSide: Side, systemId: SystemId, missionId: string): LeaderId[] {
  const f = opposerSide === 'Rebel' ? G.rebel : G.empire;
  const here = [...(f.leadersOnBoard[systemId] ?? [])];
  if (opposerSide === 'Rebel' && missionTargetsCapturedLeader(G, missionId)) {
    for (const cap of G.empire.capturedLeaders ?? []) {
      if (cap.systemId === systemId && !here.includes(cap.leaderId)) here.push(cap.leaderId);
    }
  }
  return here as LeaderId[];
}

/** Sum of matching-skill icons across a leader set. */
function totalSkill(G: GameState, leaderIds: LeaderId[], skill: string): number {
  let total = 0;
  for (const lid of leaderIds) {
    const ld = G.catalog.leaders[lid];
    if (ld) total += ld.skills[skill as keyof typeof ld.skills] ?? 0;
  }
  return total;
}

/** Sum of ALL skill icons (any type) across a leader set. Used by missions
 *  that say "count all skill icons during this attempt" (e.g. Interrogation
 *  Droid, Lure of the Dark Side). RR p.9. */
function totalAllSkills(G: GameState, leaderIds: LeaderId[]): number {
  let total = 0;
  for (const lid of leaderIds) {
    const ld = G.catalog.leaders[lid];
    if (!ld) continue;
    total += (ld.skills.diplomacy ?? 0) + (ld.skills.intel ?? 0)
           + (ld.skills.specOps ?? 0) + (ld.skills.logistics ?? 0);
  }
  return total;
}

/** Does the mission's rulesText say "count all skill icons during this attempt"? */
function missionCountsAllSkills(G: GameState, missionId: string): boolean {
  const card = G.catalog.missions[missionId];
  if (!card) return false;
  return card.rulesText.toLowerCase().includes('count all skill icons during this attempt');
}

const STARTING_HAND_LIMIT = 10;

function other(side: Side): Side { return side === 'Rebel' ? 'Empire' : 'Rebel'; }
function faction(G: GameState, s: Side) { return s === 'Rebel' ? G.rebel : G.empire; }

// ============================================================================
// Setup Phase — Rebel base pick (rr p.15 step 9) + interactive unit placement
// ============================================================================

/** Rebel chooses one of the 5 candidate systems as the secret base. Swaps in
 *  the new probe card and restores the previously-removed placeholder probe.
 *  Idempotent if the new pick equals the current base. */
export function pickRebelBase(G: GameState, systemId: SystemId): { ok: boolean; reason?: string } {
  if (G.phase !== 'Setup') return { ok: false, reason: 'wrong-phase' };
  if (!G.pendingRebelBasePick) return { ok: false, reason: 'no-pending-base-pick' };
  if (!G.pendingRebelBasePick.includes(systemId)) {
    return { ok: false, reason: 'not-a-candidate' };
  }

  const prevBaseSystemId = G.rebelBaseSystemId;
  if (prevBaseSystemId !== systemId) {
    // Return previous placeholder probe to the deck.
    const prevProbe = Object.values(G.catalog.probes).find((p) => p.systemId === prevBaseSystemId);
    if (prevProbe && !G.probeDeck.includes(prevProbe.id)) {
      G.probeDeck.push(prevProbe.id);
    }
    // Remove the new pick's probe from the deck.
    const newProbe = Object.values(G.catalog.probes).find((p) => p.systemId === systemId);
    if (newProbe) {
      const idx = G.probeDeck.indexOf(newProbe.id);
      if (idx >= 0) G.probeDeck.splice(idx, 1);
    }
    G.rebelBaseSystemId = systemId;
  }

  G.pendingRebelBasePick = undefined;
  log(G, { kind: 'pick-rebel-base', side: 'Rebel', payload: { systemId } });
  return { ok: true };
}

// ============================================================================
// Setup Phase — interactive unit placement (rr p.15 step 8)
// ============================================================================

let setupInstanceCounter = 100_000; // separate range from auto-setup
function mkSetupInstance(typeId: string, side: Side) {
  return { instanceId: `s${(++setupInstanceCounter).toString().padStart(6, '0')}`, typeId, side, damage: 0 };
}

/** Place the next unit of `typeId` from the side's pending deployment list into
 *  `systemId`. Returns ok=false with a reason if the placement is illegal. */
export function setupDeployUnit(G: GameState, side: Side, typeId: string, systemId: SystemId): { ok: boolean; reason?: string } {
  if (G.phase !== 'Setup') return { ok: false, reason: 'wrong-phase' };
  if (!G.pendingDeployment) return { ok: false, reason: 'no-pending-deployment' };
  const list = G.pendingDeployment[side];
  const idx = list.indexOf(typeId);
  if (idx < 0) return { ok: false, reason: `unit-not-pending:${typeId}` };

  // Validate legal targets
  if (side === 'Empire') {
    if (systemId === 'rebel-base-space') return { ok: false, reason: 'empire-cannot-use-rebel-base' };
    const ss = G.map.systems[systemId];
    if (!ss) return { ok: false, reason: 'unknown-system' };
    if (ss.loyalty !== 'imperial' && !ss.subjugated) {
      return { ok: false, reason: 'must-be-imperial-or-subjugated' };
    }
  } else {
    // Rebel: Rebel Base space OR one chosen Rebel/neutral system
    if (systemId === 'rebel-base-space') {
      // always allowed
    } else {
      const ss = G.map.systems[systemId];
      if (!ss) return { ok: false, reason: 'unknown-system' };
      if (G.rebelDeployTarget && G.rebelDeployTarget !== systemId) {
        return { ok: false, reason: `rebel-already-chose-${G.rebelDeployTarget}` };
      }
      if (ss.subjugated || ss.loyalty === 'imperial' || G.catalog.systems[systemId]?.isCoruscant) {
        return { ok: false, reason: 'must-be-rebel-or-neutral' };
      }
      G.rebelDeployTarget = systemId;
    }
  }

  // Place
  const dest = systemId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[systemId];
  dest.units.push(mkSetupInstance(typeId, side));
  list.splice(idx, 1);

  log(G, { kind: 'setup-deploy', side, payload: { typeId, systemId } });

  maybeAdvanceFromSetup(G);
  return { ok: true };
}

/** Auto-fill the remaining pending deployments for `side` using a random-but-
 *  rules-compliant placement. Imperial: place 1 ground unit per Imperial system
 *  first, then distribute remaining round-robin. Rebel: all to Rebel Base space. */
export function setupAutoFill(G: GameState, side: Side): { ok: boolean; reason?: string } {
  if (G.phase !== 'Setup') return { ok: false, reason: 'wrong-phase' };
  if (!G.pendingDeployment) return { ok: false, reason: 'no-pending-deployment' };
  const remaining = G.pendingDeployment[side];

  if (side === 'Empire') {
    const imperialSystems = Object.entries(G.map.systems)
      .filter(([, ss]) => ss.loyalty === 'imperial' || ss.subjugated)
      .map(([id]) => id);
    if (imperialSystems.length === 0) return { ok: false, reason: 'no-imperial-systems' };

    // First: ensure each Imperial system has ≥1 ground unit (rr p.15).
    // Find systems that currently lack ground; deploy a triangle ground unit there.
    const triangleGround = G.catalog.unitTypes['stormtrooper'] ? 'stormtrooper' : null;
    if (triangleGround) {
      for (const sys of imperialSystems) {
        const ss = G.map.systems[sys];
        const hasGround = ss.units.some((u) => {
          const t = G.catalog.unitTypes[u.typeId];
          return u.side === 'Empire' && t?.theater === 'ground';
        });
        if (!hasGround) {
          const i = remaining.indexOf(triangleGround);
          if (i >= 0) {
            ss.units.push(mkSetupInstance(triangleGround, 'Empire'));
            remaining.splice(i, 1);
          }
        }
      }
    }

    // Distribute remaining units round-robin.
    let idx = 0;
    while (remaining.length > 0) {
      const typeId = remaining.shift()!;
      const sys = imperialSystems[idx % imperialSystems.length];
      G.map.systems[sys].units.push(mkSetupInstance(typeId, 'Empire'));
      idx++;
    }
  } else {
    // Rebel: place all at Rebel Base space (a safe default).
    while (remaining.length > 0) {
      const typeId = remaining.shift()!;
      G.map.rebelBaseSpace.units.push(mkSetupInstance(typeId, 'Rebel'));
    }
  }

  log(G, { kind: 'setup-auto-fill', side });
  maybeAdvanceFromSetup(G);
  return { ok: true };
}

function maybeAdvanceFromSetup(G: GameState): void {
  if (G.phase !== 'Setup' || !G.pendingDeployment) return;
  const empireDone = G.pendingDeployment.Empire.length === 0;
  const rebelDone = G.pendingDeployment.Rebel.length === 0;

  if (empireDone && !rebelDone) {
    G.currentPlayer = 'Rebel';
  } else if (empireDone && rebelDone) {
    // Both done — Verify Imperial constraint (≥1 ground per Imperial system).
    // If violated, log a warning but proceed (rule's enforcement is at end of
    // placement; a real player would have ensured this).
    for (const [sysId, ss] of Object.entries(G.map.systems)) {
      if (ss.loyalty !== 'imperial' && !ss.subjugated) continue;
      const hasGround = ss.units.some((u) => {
        const t = G.catalog.unitTypes[u.typeId];
        return u.side === 'Empire' && t?.theater === 'ground';
      });
      if (!hasGround) {
        log(G, { kind: 'setup-warning', payload: { systemId: sysId, warning: 'no-ground-in-imperial-system' } });
      }
    }
    // Don't leave Setup until the Rebel has finalised the base pick.
    if (G.pendingRebelBasePick) {
      G.currentPlayer = 'Rebel';
      return;
    }
    G.pendingDeployment = undefined;
    G.phase = 'Assignment';
    G.currentPlayer = 'Rebel';
    log(G, { kind: 'phase', payload: { phase: 'Assignment', via: 'setup-complete' } });
  }
}

// ============================================================================
// Assignment Phase
// ============================================================================

/** Rebel assigns first, finishes. Empire assigns after. Each side calls
 *  `skipAssignment(G, side)` when done. Phase ends when both have skipped. */

const ASSIGNMENT_DONE_KEY = '_assignmentDone' as const;

function assignmentDone(G: GameState): Set<Side> {
  const meta = (G as unknown as Record<string, unknown>)[ASSIGNMENT_DONE_KEY] as Side[] | undefined;
  return new Set(meta ?? []);
}

function markAssignmentDone(G: GameState, side: Side): void {
  const meta = (G as unknown as Record<string, unknown>);
  const list = (meta[ASSIGNMENT_DONE_KEY] as Side[]) ?? [];
  if (!list.includes(side)) list.push(side);
  meta[ASSIGNMENT_DONE_KEY] = list;
}

function clearAssignmentDone(G: GameState): void {
  delete (G as unknown as Record<string, unknown>)[ASSIGNMENT_DONE_KEY];
}

/** Assign 1 or 2 leaders to a mission card in hand. Skill icons are NOT
 *  checked here — only at reveal (rr p.8). */
export function assignLeader(G: GameState, side: Side, missionId: string, leaderIds: LeaderId[]): { ok: boolean; reason?: string } {
  if (G.phase !== 'Assignment') return { ok: false, reason: 'wrong-phase' };
  if (G.currentPlayer !== side) return { ok: false, reason: 'not-your-turn' };
  if (leaderIds.length < 1 || leaderIds.length > 2) return { ok: false, reason: 'must-assign-1-or-2-leaders' };

  const f = faction(G, side);

  // Mission must be in hand.
  if (!f.missionHand.includes(missionId)) return { ok: false, reason: 'mission-not-in-hand' };

  // Each leader must be in pool.
  for (const lid of leaderIds) {
    if (!f.leaderPool.includes(lid)) return { ok: false, reason: `leader-not-in-pool:${lid}` };
  }

  // Remove leaders from pool, remove mission from hand, add to leadersOnMissions.
  for (const lid of leaderIds) {
    const i = f.leaderPool.indexOf(lid);
    f.leaderPool.splice(i, 1);
  }
  const mi = f.missionHand.indexOf(missionId);
  f.missionHand.splice(mi, 1);
  f.leadersOnMissions.push({ missionId, leaderIds: [...leaderIds] });
  log(G, { kind: 'assign-leader', side, payload: { missionId, leaderIds } });
  return { ok: true };
}

/** Signal "I'm done assigning". Rebel goes first; once Rebel signals, current
 *  player switches to Empire. Once both have signaled, advance to Command. */
export function skipAssignment(G: GameState, side: Side): { ok: boolean; reason?: string } {
  if (G.phase !== 'Assignment') return { ok: false, reason: 'wrong-phase' };
  if (G.currentPlayer !== side) return { ok: false, reason: 'not-your-turn' };

  markAssignmentDone(G, side);
  log(G, { kind: 'skip-assignment', side });

  const done = assignmentDone(G);
  if (done.has('Rebel') && done.has('Empire')) {
    // Both done — advance to Command.
    enterCommandPhase(G);
  } else if (done.has('Rebel') && !done.has('Empire')) {
    G.currentPlayer = 'Empire';
  } else if (done.has('Empire') && !done.has('Rebel')) {
    // Empire signaled first somehow (shouldn't happen — Rebel goes first). Tolerate it.
    G.currentPlayer = 'Rebel';
  }
  return { ok: true };
}

// ============================================================================
// Command Phase
// ============================================================================

function enterCommandPhase(G: GameState): void {
  clearAssignmentDone(G);
  G.phase = 'Command';
  G.currentPlayer = 'Rebel'; // rr p.6
  G.passedThisCommand = [];
  log(G, { kind: 'phase', payload: { phase: 'Command' } });
}

/** Pass. Passed sides stay passed for the rest of this Command phase but can
 *  still oppose missions and add leaders to combat (rr p.6). */
export function pass(G: GameState, side: Side): { ok: boolean; reason?: string } {
  if (G.phase !== 'Command') return { ok: false, reason: 'wrong-phase' };
  if (G.currentPlayer !== side) return { ok: false, reason: 'not-your-turn' };

  if (!G.passedThisCommand.includes(side)) G.passedThisCommand.push(side);
  log(G, { kind: 'pass', side });
  advanceCommandTurn(G);
  return { ok: true };
}

/** Advance to the next side's turn, or to Refresh if both have passed. */
function advanceCommandTurn(G: GameState): void {
  if (G.passedThisCommand.length >= 2) {
    enterRefreshPhase(G);
    return;
  }
  // Pass to the other side, but skip them if they have already passed.
  const next = other(G.currentPlayer);
  if (G.passedThisCommand.includes(next)) {
    // The other side is passed; current player keeps going.
    return;
  }
  G.currentPlayer = next;
}

// ----- Activate System (basic; no combat yet) -----

export type MoveOrder = { fromSystemId: SystemId; unitInstanceIds: string[] };

/** Activate a system. SKELETAL: does NOT yet validate transport capacity,
 *  restriction icons, or immobile units; full validation comes in the combat
 *  task. For now it accepts the moveOrders and applies them. */
export function activateSystem(
  G: GameState, side: Side, leaderId: LeaderId, targetSystemId: SystemId, moveOrders: MoveOrder[] = []
): { ok: boolean; reason?: string } {
  if (G.phase !== 'Command') return { ok: false, reason: 'wrong-phase' };
  if (G.currentPlayer !== side) return { ok: false, reason: 'not-your-turn' };
  if (G.passedThisCommand.includes(side)) return { ok: false, reason: 'already-passed' };

  const f = faction(G, side);
  if (!f.leaderPool.includes(leaderId)) return { ok: false, reason: 'leader-not-in-pool' };
  const leader = G.catalog.leaders[leaderId];
  if (!leader) return { ok: false, reason: 'unknown-leader' };
  if (leader.tacticValues.space + leader.tacticValues.ground === 0) {
    return { ok: false, reason: 'leader-has-no-tactic-values' };
  }
  if (!G.map.systems[targetSystemId]) return { ok: false, reason: 'unknown-target-system' };

  // Cannot move units out of a system that already contains your own leader (rr p.2).
  for (const order of moveOrders) {
    const youHaveLeaderHere = (f.leadersOnBoard[order.fromSystemId] ?? []).length > 0;
    if (youHaveLeaderHere) {
      return { ok: false, reason: `friendly-leader-blocks-source:${order.fromSystemId}` };
    }
    // Adjacency check (rr p.9 — units can pass region borders but not impassable).
    if (order.fromSystemId !== 'rebel-base-space') {
      const adj = G.catalog.adjacency[targetSystemId] ?? [];
      if (!adj.includes(order.fromSystemId)) {
        return { ok: false, reason: `not-adjacent:${order.fromSystemId}` };
      }
    }
  }

  // Place the leader.
  M.placeLeader(G, side, leaderId, targetSystemId);

  // Execute moves.
  for (const order of moveOrders) {
    for (const uid of order.unitInstanceIds) {
      M.moveUnit(G, uid, order.fromSystemId, targetSystemId);
    }
  }

  log(G, { kind: 'activate-system', side, payload: { leaderId, targetSystemId, orders: moveOrders.length } });

  // Combat check: if both sides have units in the target system, run combat.
  const opp: Side = side === 'Rebel' ? 'Empire' : 'Rebel';
  const ss = G.map.systems[targetSystemId];
  const oppHere = ss?.units.some((u) => u.side === opp) ?? false;
  const myHere = ss?.units.some((u) => u.side === side) ?? false;
  if (oppHere && myHere) {
    // Source system: use the first move order's from, or the target itself if no moves.
    const src = moveOrders[0]?.fromSystemId ?? targetSystemId;
    beginCombat(G, side, src, targetSystemId);
    runCombat(G);
  }
  if (G.isGameOver) return { ok: true };

  advanceCommandTurn(G);
  return { ok: true };
}

// ----- Reveal Mission (basic; no effect handlers yet) -----

/** Reveal a face-down mission. SKELETAL: validates skill icons and sets
 *  `pendingMission` to walk through opposition. Effect handler invocation
 *  comes in a later task. */
export function revealMission(
  G: GameState, side: Side, missionId: string, targetSystemId: SystemId
): { ok: boolean; reason?: string } {
  if (G.phase !== 'Command') return { ok: false, reason: 'wrong-phase' };
  if (G.currentPlayer !== side) return { ok: false, reason: 'not-your-turn' };
  if (G.passedThisCommand.includes(side)) return { ok: false, reason: 'already-passed' };

  const f = faction(G, side);
  const assigned = f.leadersOnMissions.find((m) => m.missionId === missionId);
  if (!assigned) return { ok: false, reason: 'mission-not-assigned' };

  const card = G.catalog.missions[missionId];
  if (!card) return { ok: false, reason: 'unknown-mission' };

  // Skill check: sum of matching skill icons across assigned leaders must meet card.skillCost.
  const need = card.skill;
  if (!need) return { ok: false, reason: 'mission-has-no-skill' };
  let total = 0;
  for (const lid of assigned.leaderIds) {
    const ldr = G.catalog.leaders[lid];
    if (!ldr) continue;
    total += ldr.skills[need as keyof typeof ldr.skills] ?? 0;
  }
  if (total < card.skillCost) return { ok: false, reason: `insufficient-skill:${total}/${card.skillCost}` };

  // Target-legality check (heuristic — see missionTargets.ts). For permissive
  // results (mission's target rule not yet encoded), accept any system.
  const targets = missionTargets(G, side, missionId);
  if (!targets.permissive && !targets.systemIds.includes(targetSystemId)) {
    return { ok: false, reason: `illegal-target:${targets.note ?? 'mismatch'}` };
  }

  // Remove the mission card from leadersOnMissions; place leaders in target system.
  const i = f.leadersOnMissions.indexOf(assigned);
  f.leadersOnMissions.splice(i, 1);
  for (const lid of assigned.leaderIds) {
    M.placeLeader(G, side, lid, targetSystemId);
  }

  const pending: MissionResolution = {
    missionId,
    resolverSide: side,
    targetSystemId,
    leaderIds: [...assigned.leaderIds],
    stage: card.isAttempt ? 'oppose' : 'effect',
  };
  G.pendingMission = pending;

  log(G, { kind: 'reveal-mission', side, payload: { missionId, targetSystemId, isAttempt: card.isAttempt } });

  // Attempt missions: pause for the OPPOSING player to choose whether to
  // oppose (and which leader to send from pool). If they decline AND no
  // existing leaders are at the target → mission auto-succeeds (no roll).
  if (pending.stage === 'oppose') {
    const oppSide: Side = side === 'Rebel' ? 'Empire' : 'Rebel';
    const oppFaction = oppSide === 'Rebel' ? G.rebel : G.empire;
    // Existing opposer leaders include any captured Rebel leaders at the
    // target system (per RR — captured leaders oppose missions at them).
    const existing = opposerLeadersAt(G, oppSide, targetSystemId, missionId);
    const pool = oppFaction.leaderPool.slice();
    const skill = card.skill as string;
    const countsAll = missionCountsAllSkills(G, missionId);
    const attackerDice = countsAll
      ? totalAllSkills(G, pending.leaderIds as LeaderId[])
      : totalSkill(G, pending.leaderIds as LeaderId[], skill);

    G.pendingChoice = {
      kind: 'OpposeMission',
      missionId, targetSystemId, opposerSide: oppSide,
      skill, attackerDice,
      poolLeaders: pool,
      existingAtTarget: existing,
    };
    log(G, { kind: 'choice-request', side: oppSide, payload: {
      kind: 'OpposeMission', missionId, attackerDice, existing, poolSize: pool.length,
    }});
    return { ok: true }; // pause; resolveOpposition will continue
  }

  // (stage was already 'effect' for non-attempt missions — fall through.)
  if (pending.stage === 'effect') {
    runMissionEffect(G, side, missionId, targetSystemId, assigned.leaderIds);
    if (G.pendingChoice) return { ok: true };
    discardOrReturnMission(G, side, missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
  } else if (pending.stage === 'failed') {
    discardOrReturnMission(G, side, missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
  }
  return { ok: true };
}

/** Continue mission resolution after the player resolves a mid-effect choice.
 *  Called by resolveInfiltrationPick (and analogous resolvers). */
function resumeMissionAfterChoice(G: GameState): void {
  const pm = G.pendingMission;
  if (!pm) return;
  if (G.pendingChoice) return; // still waiting
  discardOrReturnMission(G, pm.resolverSide, pm.missionId);
  G.pendingMission = undefined;
  if (!G.isGameOver) advanceCommandTurn(G);
}

/** Resolve a pending OpposeMission choice. `opposerLeaderId = null` declines
 *  opposition (auto-succeed if no existing leaders at the target); a leader id
 *  sends that leader from pool to the target system and rolls. */
export function resolveOpposition(G: GameState, opposerLeaderId: LeaderId | null): { ok: boolean; reason?: string } {
  const c = G.pendingChoice;
  if (!c || c.kind !== 'OpposeMission') return { ok: false, reason: 'no-pending-opposition' };
  const pm = G.pendingMission;
  if (!pm) return { ok: false, reason: 'no-pending-mission' };
  const card = G.catalog.missions[pm.missionId];
  if (!card) return { ok: false, reason: 'unknown-mission' };

  // Validate sent leader is in pool.
  if (opposerLeaderId !== null && !c.poolLeaders.includes(opposerLeaderId)) {
    return { ok: false, reason: 'leader-not-in-pool' };
  }

  // Send the chosen leader to the target system (if any).
  if (opposerLeaderId !== null) {
    M.placeLeader(G, c.opposerSide, opposerLeaderId, pm.targetSystemId);
  }

  // Determine if opposition actually happens: any opposer leader at target.
  // Captured leaders only contribute when the mission targets them (RR p.9).
  const oppLeaderIds = opposerLeadersAt(G, c.opposerSide, pm.targetSystemId, pm.missionId);

  G.pendingChoice = undefined;

  // RAW from Rules Reference "Reveal a Mission" panel:
  //   - "The mission will automatically succeed unless it is opposed by an
  //     opponent's leader." → if no opposer leader at target (after their
  //     send-from-pool choice), mission auto-succeeds, no roll.
  //   - Otherwise both players roll: matching-skill dice (max 10 each); each
  //     hit = 1 success, each direct-hit = 2 successes; portrait bonus +2.
  //     Resolver wins iff successes > opposer successes (ties fail).
  if (!G.missionReports) G.missionReports = [];
  if (oppLeaderIds.length === 0) {
    log(G, { kind: 'mission-unopposed', side: pm.resolverSide, payload: {
      missionId: pm.missionId,
      result: 'auto-success',
    }});
    G.missionReports.push({
      missionId: pm.missionId,
      resolverSide: pm.resolverSide,
      targetSystemId: pm.targetSystemId,
      attackerLeaders: [...pm.leaderIds] as LeaderId[],
      opposerSide: c.opposerSide,
      opposerLeaders: [],
      skill: c.skill,
      result: 'auto-success',
    });
    pm.stage = 'effect';
  } else {
    const skill = c.skill;
    const countsAll = missionCountsAllSkills(G, pm.missionId);
    const attackerDice = countsAll
      ? totalAllSkills(G, pm.leaderIds as LeaderId[])
      : totalSkill(G, pm.leaderIds as LeaderId[], skill);
    const opposerDice = countsAll
      ? totalAllSkills(G, oppLeaderIds as LeaderId[])
      : totalSkill(G, oppLeaderIds as LeaderId[], skill);
    const att = rollMissionDice(G, attackerDice, pm.resolverSide, pm.targetSystemId);
    const opp = rollMissionDice(G, opposerDice, c.opposerSide, pm.targetSystemId);
    const portrait = portraitBonus(G, pm.missionId, pm.leaderIds as LeaderId[]);
    const attackerSuccesses = att.successes + portrait;
    const succeeded = attackerSuccesses > opp.successes;
    log(G, { kind: 'mission-roll', side: pm.resolverSide, payload: {
      missionId: pm.missionId, skill,
      attacker: { dice: attackerDice, successes: att.successes, portrait, total: attackerSuccesses, faces: att.faces },
      opposer: { side: c.opposerSide, leaderIds: oppLeaderIds, dice: opposerDice, successes: opp.successes, faces: opp.faces },
      result: succeeded ? 'success' : 'failure',
    }});
    G.missionReports.push({
      missionId: pm.missionId,
      resolverSide: pm.resolverSide,
      targetSystemId: pm.targetSystemId,
      attackerLeaders: [...pm.leaderIds] as LeaderId[],
      opposerSide: c.opposerSide,
      opposerLeaders: [...oppLeaderIds] as LeaderId[],
      skill,
      attackerDice: { count: Math.min(attackerDice, 10), faces: att.faces, successes: att.successes },
      opposerDice: { count: Math.min(opposerDice, 10), faces: opp.faces, successes: opp.successes },
      portraitBonus: portrait,
      attackerTotal: attackerSuccesses,
      result: succeeded ? 'success' : 'failure',
    });
    pm.stage = succeeded ? 'effect' : 'failed';
  }

  // Continue mission resolution.
  if (pm.stage === 'effect') {
    runMissionEffect(G, pm.resolverSide, pm.missionId, pm.targetSystemId, pm.leaderIds as LeaderId[]);
    if (G.pendingChoice) return { ok: true }; // sub-choice triggered (e.g. Infiltration)
    discardOrReturnMission(G, pm.resolverSide, pm.missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
  } else if (pm.stage === 'failed') {
    discardOrReturnMission(G, pm.resolverSide, pm.missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
  }
  return { ok: true };
}

/** Apply one step of the Stolen Plans reorder. `cardId` is the card the
 *  Rebel chooses to place next on top. Each call moves one card from
 *  `remaining` into `orderedTop`. When all are placed, the deck is updated
 *  and mission resolution resumes. */
export function resolveStolenPlansPick(G: GameState, cardId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'StolenPlansReorder') {
    return { ok: false, reason: 'no-pending-stolen-plans' };
  }
  const idx = choice.remaining.indexOf(cardId);
  if (idx < 0) return { ok: false, reason: 'card-not-in-pool' };
  const [card] = choice.remaining.splice(idx, 1);
  choice.orderedTop.push(card);
  if (choice.remaining.length === 0) {
    // Place orderedTop back on the deck. orderedTop[0] should be the topmost.
    // unshift in reverse so [0] ends up at index 0.
    if (!G.rebel.objectiveDeck) G.rebel.objectiveDeck = [];
    for (let i = choice.orderedTop.length - 1; i >= 0; i--) {
      G.rebel.objectiveDeck.unshift(choice.orderedTop[i]);
    }
    log(G, { kind: 'stolen-plans-reorder', side: 'Rebel', payload: { order: [...choice.orderedTop] } });
    G.pendingChoice = undefined;
    resumeMissionAfterChoice(G);
  }
  return { ok: true };
}

/** Apply the Rebel's Infiltration pick. `keepOnTopId` is one of the two
 *  cards revealed; the other goes to the bottom of the objective deck. */
/** Resolve Plan The Assault's ship-selection. `shipIds` are unit instance
 *  IDs from the rebel-base-space that the Rebel sends to the target system.
 *  After moving, kicks off combat at the target. */
export function resolvePlanTheAssaultShips(G: GameState, shipIds: string[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'PlanTheAssaultShips') {
    return { ok: false, reason: 'no-pending-plan-the-assault' };
  }
  // Validate every pick is in the available list.
  for (const sid of shipIds) {
    if (!choice.availableShipIds.includes(sid)) {
      return { ok: false, reason: `illegal-ship:${sid}` };
    }
  }
  const targetSystemId = choice.targetSystemId;
  // Move each picked ship from rebel-base-space to the target system.
  // (M.moveUnit handles invariants like reveal-base checks.)
  for (const sid of shipIds) {
    M.moveUnit(G, sid, 'rebel-base-space', targetSystemId);
  }
  log(G, { kind: 'plan-the-assault-move', side: 'Rebel', payload: {
    targetSystemId, shipsSent: shipIds.length,
  }});
  G.pendingChoice = undefined;

  // Kick off combat at the target if both sides now have units there.
  // Source system for retreat purposes = rebel-base-space.
  beginCombat(G, 'Rebel', 'rebel-base-space', targetSystemId);
  runCombat(G);

  // If combat is paused for a choice, leave it. Otherwise resume mission
  // resolution machinery (mission discard + advance command turn).
  if (G.pendingChoice || G.pendingCombat) return { ok: true };
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Resolve Covert Operation's keep-vs-bottom pick. Distinct from
 *  Infiltration: the kept card lands in HAND, not back on top of the deck. */
export function resolveCovertOperationPick(G: GameState, keepInHandId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'CovertOperationPick') {
    return { ok: false, reason: 'no-pending-covert-operation' };
  }
  const [a, b] = choice.drawnIds;
  if (keepInHandId !== a && keepInHandId !== b) {
    return { ok: false, reason: 'invalid-pick' };
  }
  const kept = keepInHandId;
  const bottomed = keepInHandId === a ? b : a;
  if (!G.rebel.objectiveHand) G.rebel.objectiveHand = [];
  if (!G.rebel.objectiveDeck) G.rebel.objectiveDeck = [];
  G.rebel.objectiveHand.push(kept);
  G.rebel.objectiveDeck.push(bottomed);
  log(G, { kind: 'covert-operation-pick', side: 'Rebel', payload: {
    drawn: [a, b], kept, bottomed,
  }});
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

export function resolveInfiltrationPick(G: GameState, keepOnTopId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'InfiltrationPick') {
    return { ok: false, reason: 'no-pending-infiltration-pick' };
  }
  if (keepOnTopId !== choice.topId && keepOnTopId !== choice.bottomId) {
    return { ok: false, reason: 'invalid-pick' };
  }
  const onTop = keepOnTopId;
  const onBottom = keepOnTopId === choice.topId ? choice.bottomId : choice.topId;
  if (!G.rebel.objectiveDeck) G.rebel.objectiveDeck = [];
  G.rebel.objectiveDeck.unshift(onTop);
  G.rebel.objectiveDeck.push(onBottom);
  const keptRep = G.catalog.objectives[onTop]?.reputation ?? 0;
  const bottomedRep = G.catalog.objectives[onBottom]?.reputation ?? 0;
  log(G, { kind: 'objective-peek', side: 'Rebel', payload: {
    looked: [choice.topId, choice.bottomId], kept: onTop, keptRep, bottomed: onBottom, bottomedRep,
  }});
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

function runMissionEffect(G: GameState, side: Side, missionId: string, targetSystemId: SystemId, leaderIds: LeaderId[]): void {
  const card = G.catalog.missions[missionId];
  if (!card) return;
  // Prefer explicit effectKey if set and registered; otherwise fall back to
  // the missionId itself (most mission handlers are registered under the id).
  let key = '';
  if (card.effectKey && Handlers.has(card.effectKey)) key = card.effectKey;
  else if (Handlers.has(missionId)) key = missionId;
  if (!key) {
    log(G, { kind: 'note', payload: { msg: `no handler for mission ${missionId}` } });
    return;
  }
  const ctx = Handlers.makeContext(side, { kind: 'mission', id: missionId }, { targetSystemId, leaderIds });
  Handlers.invokeByKey(G, key, ctx);
}

function discardOrReturnMission(G: GameState, side: Side, missionId: string): void {
  const f = faction(G, side);
  const card = G.catalog.missions[missionId];
  if (card?.isStarting) {
    f.missionHand.push(missionId);
    log(G, { kind: 'mission-return-to-hand', side, payload: { missionId } });
  } else {
    f.missionDiscard.push(missionId);
    log(G, { kind: 'mission-discard', side, payload: { missionId } });
  }
}

// ============================================================================
// Refresh Phase
// ============================================================================

/** Run the refresh phase end-to-end per rr p.12. No player choices yet —
 *  Start-of-Refresh objective play, hand-limit discards, and recruit picks
 *  use auto-defaults (drop the right number from the bottom of hand,
 *  pick the leader on the first action card drawn). Wire to ChoiceRequests later. */
function enterRefreshPhase(G: GameState): void {
  G.phase = 'Refresh';
  log(G, { kind: 'phase', payload: { phase: 'Refresh' } });
  const logStart = G.turnLog.length;

  // Misdirection protection is a per-round flag — clear here.
  if (G.misdirectionProtected && G.misdirectionProtected.length > 0) {
    G.misdirectionProtected = [];
  }
  // Yoda ring's "1/round reroll" resets at the round boundary.
  G.yodaRerollUsedThisRound = false;

  // Pre-step: resolve eligible StartOfRefresh objectives (rr p.10 — Rebel may
  // play one objective at start of Refresh phase, just before step 1).
  refreshPlayStartOfRefreshObjectives(G);
  if (G.isGameOver) return;

  // Step 1: Retrieve leaders
  refreshRetrieveLeaders(G);
  if (G.isGameOver) return;

  // Step 2: Draw missions (down to limit)
  refreshDrawMissions(G);

  // Step 3: Launch probe droids
  M.drawProbe(G, 2);

  // Step 4: Draw objective
  M.drawObjective(G, 1);
  if (G.isGameOver) return;

  // Step 5: Advance time marker (may trigger recruit / build)
  M.advanceTime(G);
  if (G.isGameOver) return;
  refreshRecruitIfApplicable(G);

  // Build may pause for BuildPick choices. If it does, refresh resumes via
  // resolveBuildPicks() → finishRefreshAfterBuild().
  if (refreshBuildIfApplicable(G, logStart)) return;

  finishRefreshAfterBuild(G, logStart);
}

/** Continues the refresh phase after the build step (which may have paused
 *  for BuildPick choices). Runs deploy, builds the report, advances to
 *  Assignment. */
function finishRefreshAfterBuild(G: GameState, logStart: number): void {
  // Step 6: Deploy units (slide queue)
  refreshDeployUnits(G);
  if (G.isGameOver) return;

  // Build the refresh report by scanning the log slice we just emitted.
  buildRefreshReport(G, logStart);

  // Round complete — back to Assignment for the next round.
  enterAssignmentPhase(G);
}

/** Walk the log entries appended during this refresh and roll them up into
 *  two RefreshReports (one per side), shown sequentially in the UI.
 *  Cheaper than threading a builder through every sub-step. */
function buildRefreshReport(G: GameState, logStart: number): void {
  const slice = G.turnLog.slice(logStart);
  const mk = (side: Side): import('./types').RefreshReport => ({
    side,
    newTurn: G.timeMarker,
    retrievedLeaders: [],
    missionsDrawn: { count: 0, missionIds: [] },
    probesDrawn: { count: 0, probeIds: [] },
    objectivesDrawn: { count: 0, objectiveIds: [] },
    objectivesPlayed: [],
    recruits: [],
    builds: [],
    deployed: [],
  });
  const reb = mk('Rebel');
  const emp = mk('Empire');
  const pick = (side: Side) => side === 'Rebel' ? reb : emp;

  for (const entry of slice) {
    const k = entry.kind;
    const p = (entry as { payload?: Record<string, unknown> }).payload ?? {};
    const sideOf = (entry as { side?: Side }).side;
    if (k === 'draw-mission' && sideOf) {
      const r = pick(sideOf);
      r.missionsDrawn.count += (p.count as number) ?? 0;
      r.missionsDrawn.missionIds.push(...((p.missionIds as string[] | undefined) ?? []));
    } else if (k === 'draw-probe') {
      emp.probesDrawn.count += (p.count as number) ?? 0;
      emp.probesDrawn.probeIds.push(...((p.probeIds as string[] | undefined) ?? []));
    } else if (k === 'draw-objective') {
      reb.objectivesDrawn.count += (p.count as number) ?? 0;
      reb.objectivesDrawn.objectiveIds.push(...((p.objectiveIds as string[] | undefined) ?? []));
    } else if (k === 'objective-played') {
      reb.objectivesPlayed.push({
        objectiveId: (p.objectiveId as string) ?? '',
        reputation: (p.reputation as number) ?? 0,
      });
    } else if (k === 'recruit-leader' && sideOf) {
      pick(sideOf).recruits.push({
        cardId: (p.cardId as string) ?? '',
        leaderId: (p.leaderId as string) ?? null,
      });
    } else if (k === 'recruit-action-only' && sideOf) {
      // Player drew an action card but no leader (either by choice or by
      // all candidates being already-recruited).
      pick(sideOf).recruits.push({
        cardId: (p.cardId as string) ?? '',
        leaderId: null,
      });
    } else if (k === 'refresh-retrieve' && sideOf) {
      const ids = (p.leaderIds as string[] | undefined) ?? [];
      const f = pick(sideOf);
      f.retrievedLeaders = [...f.retrievedLeaders, ...ids];
    } else if (k === 'build-queue' && sideOf) {
      pick(sideOf).builds.push({
        systemId: ((p.sourceSystemId as string) ?? 'rebel-base') as SystemId | 'rebel-base',
        unitTypeId: (p.typeId as string) ?? '',
        slot: ((p.slot as 1 | 2 | 3) ?? 1),
      });
    } else if (k === 'deploy' && sideOf) {
      pick(sideOf).deployed.push({
        unitTypeId: (p.typeId as string) ?? '',
        systemId: (p.systemId as SystemId),
      });
    }
  }
  // Push Rebel first, then Empire — the UI shows them in this order.
  (G.refreshReports ??= []).push(reb, emp);
}

/** RR p.10: "Only one objective can be played during each Refresh Phase."
 *  Pick the highest-rep eligible StartOfRefresh objective the Rebel holds
 *  whose condition is met, gain that reputation, discard/return the card. */
function refreshPlayStartOfRefreshObjectives(G: GameState): void {
  const hand = G.rebel.objectiveHand;
  if (!hand || hand.length === 0) return;
  type Eligible = { id: string; rep: number };
  const eligible: Eligible[] = [];
  for (const id of hand) {
    const card = G.catalog.objectives[id];
    if (!card || card.timing !== 'StartOfRefresh') continue;
    if (!objectiveConditionMet(G, id)) continue;
    eligible.push({ id, rep: objectiveReputationGain(G, id) });
  }
  if (eligible.length === 0) return;
  // RR p.10: only one objective per refresh. Auto-pick highest rep.
  eligible.sort((a, b) => b.rep - a.rep);
  const winner = eligible[0];
  const handIdx = hand.indexOf(winner.id);
  if (handIdx < 0) return;
  hand.splice(handIdx, 1);
  if (objectiveReturnsToDeck(G, winner.id)) {
    if (!G.rebel.objectiveDeck) G.rebel.objectiveDeck = [];
    G.rebel.objectiveDeck.push(winner.id);
  }
  // Otherwise the card is returned to the game box (just removed from play).
  log(G, { kind: 'play-objective', side: 'Rebel', payload: {
    objectiveId: winner.id, reputation: winner.rep,
  }});
  M.gainReputation(G, winner.rep);
}

function refreshRetrieveLeaders(G: GameState): void {
  for (const side of ['Rebel', 'Empire'] as const) {
    const f = faction(G, side);
    const retrieved: string[] = [];
    // Leaders on missions return without revealing (rr p.9).
    for (const a of f.leadersOnMissions) {
      for (const lid of a.leaderIds) {
        if (!f.leaderPool.includes(lid)) f.leaderPool.push(lid);
        retrieved.push(lid);
      }
      f.missionHand.push(a.missionId);
    }
    f.leadersOnMissions = [];
    // Leaders on the board return to the pool.
    for (const list of Object.values(f.leadersOnBoard)) {
      for (const lid of list) {
        if (!f.leaderPool.includes(lid)) f.leaderPool.push(lid);
        retrieved.push(lid);
      }
    }
    f.leadersOnBoard = {};
    if (retrieved.length > 0) {
      log(G, { kind: 'refresh-retrieve', side, payload: { leaderIds: retrieved } });
    }
  }
}

function refreshDrawMissions(G: GameState): void {
  for (const side of ['Rebel', 'Empire'] as const) {
    M.drawMission(G, side, 2);
    const f = faction(G, side);
    // Per RR p.12: only non-project mission cards count toward the 10-card
    // limit. Starting missions also cannot be discarded.
    const countingHand = () => f.missionHand.filter((id) => {
      const c = G.catalog.missions[id];
      return c && !c.isProject;
    }).length;
    while (countingHand() > STARTING_HAND_LIMIT) {
      // Find a non-starting, non-project card to discard (auto: from the end).
      let i = -1;
      for (let j = f.missionHand.length - 1; j >= 0; j--) {
        const c = G.catalog.missions[f.missionHand[j]];
        if (c && !c.isStarting && !c.isProject) { i = j; break; }
      }
      if (i < 0) break;
      const card = f.missionHand.splice(i, 1)[0];
      f.missionDiscard.push(card);
      log(G, { kind: 'mission-hand-trim', side, payload: { missionId: card } });
    }
  }
}

function refreshRecruitIfApplicable(G: GameState): void {
  // For now: hard-code time-track icons. In a real game the time track has
  // recruit/build icons on specific spaces. The user-published version lists:
  //   Time 1: nothing (setup)
  //   Time 2: Recruit + Build
  //   Time 3: Build
  //   Time 4: Recruit + Build
  //   Time 5: Build
  //   Time 6: Recruit + Build
  //   Time 7: Build
  //   Time 8: end (Rebel can win at any earlier point if reputation meets time)
  // [VERIFY against the printed time track.]
  const recruitOn: Record<number, boolean> = { 2: true, 4: true, 6: true };
  if (!recruitOn[G.timeMarker]) return;

  // Each side draws 2 action cards and auto-keeps the first (no choice yet).
  for (const side of ['Rebel', 'Empire'] as const) {
    const f = faction(G, side);
    const drawn = f.actionDeck.splice(0, 2);
    if (drawn.length === 0) continue;
    // Pick the leader on the first card — recruit them.
    const cardId = drawn[0];
    const card = G.catalog.actions[cardId];
    let recruited = false;
    if (card?.leaderRequirement && card.leaderRequirement.length > 0) {
      const pick = card.leaderRequirement[0];
      if (G.catalog.leaders[pick] && !f.leaderPool.includes(pick) && !f.eliminatedLeaders.includes(pick)) {
        f.leaderPool.push(pick);
        log(G, { kind: 'recruit-leader', side, payload: { leaderId: pick, cardId } });
        recruited = true;
      }
    }
    if (!recruited) {
      // Drew a card but couldn't recruit (no leader requirement, or
      // already recruited / eliminated). Note for the report modal.
      log(G, { kind: 'recruit-action-only', side, payload: { cardId } });
    }
    f.actionHand.push(cardId);
    // The other card goes to the bottom of the deck unrevealed.
    if (drawn[1]) f.actionDeck.push(drawn[1]);
  }
}

/** Return the legal unit type IDs a side may build for one (type, shape)
 *  resource icon. Base-game scope; expansion units would extend this. */
export function legalUnitsForIcon(
  side: Side, type: 'space' | 'ground', shape: 'triangle' | 'circle' | 'square'
): string[] {
  if (side === 'Rebel') {
    if (type === 'space') {
      if (shape === 'triangle') return ['x-wing', 'y-wing'];
      if (shape === 'circle')   return ['corellian-corvette', 'rebel-transport'];
      if (shape === 'square')   return ['mon-cala-cruiser'];
    } else {
      if (shape === 'triangle') return ['rebel-trooper'];
      if (shape === 'circle')   return ['airspeeder'];
      if (shape === 'square')   return []; // no base-game Rebel square ground
    }
  } else {
    if (type === 'space') {
      if (shape === 'triangle') return ['tie-fighter'];
      if (shape === 'circle')   return ['assault-carrier'];
      if (shape === 'square')   return ['star-destroyer']; // SSD is a project, not an icon-build
    } else {
      if (shape === 'triangle') return ['stormtrooper'];
      if (shape === 'circle')   return ['at-st'];
      if (shape === 'square')   return ['at-at'];
    }
  }
  return [];
}

type BuildPickEntry = {
  sourceSystemId: SystemId | 'rebel-base';
  slot: 1 | 2 | 3;
  iconType: 'space' | 'ground';
  iconShape: 'triangle' | 'circle' | 'square';
  legalUnitTypes: string[];
};

/** Collect all this turn's build entries. Icons with only one legal unit
 *  type auto-apply immediately; icons with multiple legal types are queued
 *  for player choice. Returns true if a BuildPick is now pending (the
 *  refresh phase is paused). */
function refreshBuildIfApplicable(G: GameState, logStart: number): boolean {
  // Build happens on every EVEN turn (verified against the printed board).
  if (G.timeMarker % 2 !== 0) return false;

  type AutoApplied = {
    sourceSystemId: SystemId | 'rebel-base';
    slot: 1 | 2 | 3;
    unitTypeId: string;
  };
  const pendingBySide: { side: Side; picks: BuildPickEntry[]; autoApplied: AutoApplied[] }[] = [];

  for (const side of ['Rebel', 'Empire'] as const) {
    const sidePicks: BuildPickEntry[] = [];
    const sideAutoApplied: AutoApplied[] = [];
    const otherSide = side === 'Rebel' ? 'Empire' : 'Rebel';

    for (const [sysId, ss] of Object.entries(G.map.systems)) {
      const sysDef = G.catalog.systems[sysId];
      if (!sysDef || sysDef.isRemote || ss.destroyed || ss.sabotage) continue;
      // Opponent unit in system blocks build (rr p.3).
      if (ss.units.some((u) => u.side === otherSide)) continue;

      let icons = ss.resources ?? sysDef.resources;
      if (side === 'Rebel') {
        if (ss.loyalty !== 'rebel' || ss.subjugated) continue;
      } else {
        if (ss.loyalty !== 'imperial' && !ss.subjugated) continue;
        // Subjugated (still has Rebel loyalty underneath) → leftmost icon only.
        if (ss.subjugated && ss.loyalty !== 'imperial') icons = icons.slice(0, 1);
      }

      const slot = (sysDef.buildSlot ?? 1) as 1 | 2 | 3;
      for (const icon of icons) {
        const legal = legalUnitsForIcon(side, icon.type, icon.shape);
        if (legal.length === 0) continue;
        if (legal.length === 1) {
          M.buildToQueue(G, side, legal[0], slot, sysId);
          sideAutoApplied.push({ sourceSystemId: sysId, slot, unitTypeId: legal[0] });
        } else {
          sidePicks.push({
            sourceSystemId: sysId, slot,
            iconType: icon.type, iconShape: icon.shape,
            legalUnitTypes: legal,
          });
        }
      }
    }

    // Rebel Base card adds 1 ground triangle + 1 space triangle, unless
    // revealed AND Empire occupies the base system.
    if (side === 'Rebel') {
      let baseProduces = true;
      if (G.rebelBaseRevealed) {
        const baseSys = G.map.systems[G.rebelBaseSystemId];
        const empireUnit = baseSys?.units.some((u) => u.side === 'Empire') ?? false;
        const empireLoyal = baseSys?.loyalty === 'imperial' || !!baseSys?.subjugated;
        if (empireUnit || empireLoyal) baseProduces = false;
      }
      if (baseProduces) {
        // Ground triangle has only one legal type — auto-apply.
        M.buildToQueue(G, 'Rebel', 'rebel-trooper', 1, 'rebel-base');
        sideAutoApplied.push({ sourceSystemId: 'rebel-base', slot: 1, unitTypeId: 'rebel-trooper' });
        // Space triangle is the X-Wing / Y-Wing choice.
        sidePicks.push({
          sourceSystemId: 'rebel-base', slot: 1,
          iconType: 'space', iconShape: 'triangle',
          legalUnitTypes: ['x-wing', 'y-wing'],
        });
      }
    }

    if (sidePicks.length > 0) pendingBySide.push({ side, picks: sidePicks, autoApplied: sideAutoApplied });
  }

  if (pendingBySide.length === 0) return false; // no choices needed

  G.refreshPaused = { logStart, pendingBuildPicks: pendingBySide };
  promoteNextBuildPick(G);
  return true;
}

function promoteNextBuildPick(G: GameState): void {
  const r = G.refreshPaused;
  if (!r || r.pendingBuildPicks.length === 0) return;
  const next = r.pendingBuildPicks[0];
  G.pendingChoice = {
    kind: 'BuildPick',
    side: next.side,
    picks: next.picks,
    autoApplied: next.autoApplied,
  };
  log(G, { kind: 'choice-request', side: next.side, payload: {
    kind: 'BuildPick', count: next.picks.length, autoApplied: next.autoApplied.length,
  }});
}

/** Apply the player's chosen unit type for each entry in the current
 *  BuildPick. Advances to the next side's BuildPick, or finishes refresh
 *  if no more pending. */
export function resolveBuildPicks(G: GameState, choices: string[]): { ok: boolean; reason?: string } {
  const r = G.refreshPaused;
  if (!r || r.pendingBuildPicks.length === 0) return { ok: false, reason: 'no-pending-build' };
  if (!G.pendingChoice || G.pendingChoice.kind !== 'BuildPick') return { ok: false, reason: 'no-choice' };
  const cur = r.pendingBuildPicks[0];
  if (choices.length !== cur.picks.length) return { ok: false, reason: 'choice-count-mismatch' };

  for (let i = 0; i < cur.picks.length; i++) {
    const p = cur.picks[i];
    const c = choices[i];
    if (!p.legalUnitTypes.includes(c)) {
      return { ok: false, reason: `illegal-pick:${c}` };
    }
    M.buildToQueue(G, cur.side, c, p.slot, p.sourceSystemId);
  }

  r.pendingBuildPicks.shift();
  G.pendingChoice = undefined;

  if (r.pendingBuildPicks.length > 0) {
    promoteNextBuildPick(G);
    return { ok: true };
  }

  // All build picks resolved — continue the refresh phase.
  const logStart = r.logStart;
  G.refreshPaused = undefined;
  finishRefreshAfterBuild(G, logStart);
  return { ok: true };
}

function refreshDeployUnits(G: GameState): void {
  // Slide queues 3 -> 2 -> 1 -> deploy. (rr p.7)
  for (const side of ['Rebel', 'Empire'] as const) {
    const f = faction(G, side);
    const deploying = f.buildQueue[1];
    f.buildQueue[1] = f.buildQueue[2];
    f.buildQueue[2] = f.buildQueue[3];
    f.buildQueue[3] = [];

    // Auto-deploy: place each unit in the first eligible system. Real game
    // lets the player pick. [TODO]
    for (const typeId of deploying) {
      const sys = pickDefaultDeployTarget(G, side, typeId);
      if (sys) {
        M.deployUnit(G, side, typeId, sys);
      } else {
        // No legal target: returns to slot 1 (rr p.7).
        f.buildQueue[1].push(typeId);
      }
    }
  }
}

function pickDefaultDeployTarget(G: GameState, side: Side, _typeId: string): string | null {
  // Find any system where this side has loyalty (or subjugation for Empire)
  // and the opponent has no units, no sabotage, room for one more unit.
  for (const [sysId, ss] of Object.entries(G.map.systems)) {
    const sysDef = G.catalog.systems[sysId];
    if (!sysDef || sysDef.isRemote || ss.destroyed || ss.sabotage) continue;
    if (side === 'Rebel' && ss.loyalty !== 'rebel') continue;
    if (side === 'Empire' && ss.loyalty !== 'imperial' && !ss.subjugated) continue;
    const opp: Side = side === 'Rebel' ? 'Empire' : 'Rebel';
    if (ss.units.some((u) => u.side === opp)) continue;
    return sysId;
  }
  if (side === 'Rebel' && !G.rebelBaseRevealed) {
    return 'rebel-base-space';
  }
  return null;
}

// ============================================================================
// Round transitions
// ============================================================================

function enterAssignmentPhase(G: GameState): void {
  G.phase = 'Assignment';
  G.currentPlayer = 'Rebel';
  clearAssignmentDone(G);
  log(G, { kind: 'phase', payload: { phase: 'Assignment' } });
}
