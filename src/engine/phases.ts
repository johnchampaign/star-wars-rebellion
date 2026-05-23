// Phase machinery: Assignment / Command / Refresh.
// Combat (sub-machine, triggered mid-Command-turn) is implemented in combat.ts (next task).
// Effect handlers (mission/action/objective text) live in handlers/ (later task).
//
// See docs/engine.md §4–7.

import type {
  GameState, Side, SystemId, LeaderId, MissionResolution, UnitTypeId,
} from './types';
// (Phase advances from Setup → Assignment internally; no extra imports needed.)
import * as M from './mechanics';
import { beginCombat, runCombat } from './combat';
import { log } from './log';
import * as Handlers from './handlers/registry';
import { missionTargets } from './missionTargets';
import { rollDie, shuffle } from './rng';
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
  G: GameState, n: number, _side: Side, _systemId: SystemId,
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
  // Yoda ring is no longer auto-applied here. Mission-side Yoda is offered
  // as a player choice in resolveOpposition (mirrors the combat-side
  // YodaReroll pause). Combat-side Yoda is handled in combat.ts.
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
  const holderName = G.catalog.leaders[yoda]?.name ?? yoda;
  // Loud, prose-friendly log entry so the player understands what happened.
  // The UI surfaces this in the mission report and the turn log.
  log(G, { kind: 'yoda-reroll', side: 'Rebel', payload: {
    holder: yoda,
    holderName,
    systemId,
    color,
    oldFace: 'blank',
    newFace: fresh.face,
    rule: "Yoda's training: once per round, reroll one blank die on a mission " +
          "or combat attack rolled by the leader bearing the Yoda ring.",
    explanation: `Yoda (carried by ${holderName} at ${G.catalog.systems[systemId]?.name ?? systemId}) ` +
                 `rerolled a blank ${color} die → ${fresh.face === 'blank' ? 'still blank' : fresh.face}.`,
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

/** Advance to the next side's turn, or to Refresh if both have passed.
 *  Before transitioning to Refresh, drain any pending Rapid Mobilization
 *  end-of-phase choices (RAW: those resolve after both players pass). */
function advanceCommandTurn(G: GameState): void {
  if (G.passedThisCommand.length >= 2) {
    processPendingRapidMobilizations(G);
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

/** Per-source transport-capacity validator. RR p.9:
 *   - Immobile units cannot move
 *   - Each restriction-icon unit (TIE Fighter, X-Wing, Y-Wing) consumes 1
 *     transport capacity AND requires at least one capacity-providing ship
 *     also moving out of the same source system
 *   - Each ground unit consumes 1 transport capacity
 *   - Transport-capacity ships consume nothing themselves
 *   - Total capacity available (from moving capacity-ships) ≥ total required
 *   "Ignore transport restrictions" abilities (Hidden Fleet, Plan The Assault,
 *   Planetary Conquest, Scouting Mission) bypass this; those handlers move
 *   units via M.moveUnit directly and don't go through activateSystem. */
export function validateMoveOrderTransport(
  G: GameState, side: Side, order: MoveOrder
): { ok: true } | { ok: false; reason: string } {
  const src = order.fromSystemId === 'rebel-base-space'
    ? G.map.rebelBaseSpace
    : G.map.systems[order.fromSystemId];
  if (!src) return { ok: false, reason: `unknown-source:${order.fromSystemId}` };

  let capacityAvailable = 0;
  let capacityProvidingShips = 0;
  let restrictionUnits = 0;
  let groundUnits = 0;
  const ownership: string[] = [];
  for (const uid of order.unitInstanceIds) {
    const u = src.units.find((x) => x.instanceId === uid);
    if (!u) return { ok: false, reason: `unit-not-at-source:${uid}` };
    if (u.side !== side) return { ok: false, reason: `not-your-unit:${uid}` };
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) return { ok: false, reason: `unknown-unit-type:${u.typeId}` };
    if (t.transport.immobile) {
      return { ok: false, reason: `immobile-unit:${u.typeId}` };
    }
    if (t.transport.capacity > 0) {
      capacityAvailable += t.transport.capacity;
      capacityProvidingShips++;
    }
    // Restriction-icon: needs to ride along.
    if (t.transport.restriction) restrictionUnits++;
    // Ground units (theater === 'ground') need transport too.
    if (t.theater === 'ground' && t.class !== 'structure') groundUnits++;
    ownership.push(u.typeId);
  }
  const required = restrictionUnits + groundUnits;
  if (required > 0 && capacityProvidingShips === 0) {
    return { ok: false, reason: `no-transport-capacity-ship-from-${order.fromSystemId}` };
  }
  if (required > capacityAvailable) {
    return {
      ok: false,
      reason: `transport-capacity-short:${capacityAvailable}-need-${required}-from-${order.fromSystemId}`,
    };
  }
  return { ok: true };
}

/** Activate a system per RR p.6 + RR p.9 movement rules. Validates:
 *   - Leader is in pool and has tactic values
 *   - Target system exists
 *   - For each move-source: friendly leader doesn't block, adjacent to target
 *   - For each move-source: per-source transport capacity ≥ per-source
 *     transport requirement (ground units + restriction-icon fighters that
 *     are moving); restriction-icon units require at least one capacity-
 *     providing ship also moving from the same source
 *   - No moving unit has the immobile icon */
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

  // Transport-capacity validation (RR p.9). Validate per source system.
  for (const order of moveOrders) {
    const cap = validateMoveOrderTransport(G, side, order);
    if (!cap.ok) return { ok: false, reason: cap.reason };
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
  G: GameState, side: Side, missionId: string, targetSystemId: SystemId,
  targetLeaderId?: LeaderId,
): { ok: boolean; reason?: string } {
  if (G.phase !== 'Command') return { ok: false, reason: 'wrong-phase' };
  if (G.currentPlayer !== side) return { ok: false, reason: 'not-your-turn' };
  if (G.passedThisCommand.includes(side)) return { ok: false, reason: 'already-passed' };

  // "Boba Fett, Where?" (Empire action card): "Rebels cannot attempt missions
  // or use action cards here." We check Boba Fett's live position rather than
  // a flag so the block ends naturally when he leaves the system (e.g.
  // refresh retrieve, captured, eliminated). Empire-only blocker.
  if (side === 'Rebel') {
    const bobaHere = (G.empire.leadersOnBoard[targetSystemId] ?? []).includes('boba-fett')
      && G.actionCardFlags?.bobaBlockSystemIds?.includes(targetSystemId);
    if (bobaHere) {
      return { ok: false, reason: `boba-fett-blocks-system:${targetSystemId}` };
    }
  }

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
    targetLeaderId,
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
    runMissionEffect(G, side, missionId, targetSystemId, assigned.leaderIds, targetLeaderId);
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

    // R2-D2 mission-flip pause point. If Empire rolled (resolver OR opposer)
    // AND the Rebel holds R2-D2 AND that Empire roll has a non-blank die,
    // stash the partial state and post the choice. The resolver applies
    // the flip and re-enters this function to finalise.
    // Build the partial-resolution stash that BOTH Yoda and R2-D2 mission
    // pauses share. Either pause point uses the same fields; resolvers
    // apply their effect to the appropriate side's faces and continue.
    const empireSideOfRoll: 'attacker' | 'opposer' | null =
      pm.resolverSide === 'Empire' ? 'attacker' :
      c.opposerSide === 'Empire' ? 'opposer' : null;
    pm.r2d2Pending = {
      attDice: attackerDice,
      opposerDice,
      attFaces: [...att.faces],
      attColors: [...att.colors],
      attSuccesses: att.successes,
      oppFaces: [...opp.faces],
      oppColors: [...opp.colors],
      oppSuccesses: opp.successes,
      portrait,
      oppLeaderIds: [...oppLeaderIds] as LeaderId[],
      empireSide: empireSideOfRoll ?? 'attacker', // unused if no Empire roll
    };

    // Yoda mission pause: Rebel may discard the once-per-round reroll on
    // a blank die in their OWN roll. Mirrors the combat-side YodaReroll
    // pause point in advanceAttackToTactics.
    const yodaPosted = maybePostMissionYodaReroll(G, pm);
    if (yodaPosted) return { ok: true };

    // R2-D2 mission pause: Rebel may discard the ring to flip 1 Empire
    // die to blank.
    const r2d2Posted = maybePostMissionR2D2(G, pm);
    if (r2d2Posted) return { ok: true };

    finalizeMissionRoll(G, pm, c, skill, attackerDice, opposerDice,
      pm.r2d2Pending.attFaces, pm.r2d2Pending.oppFaces,
      pm.r2d2Pending.attSuccesses, pm.r2d2Pending.oppSuccesses,
      portrait, oppLeaderIds as LeaderId[]);
    pm.r2d2Pending = undefined;
  }

  // Continue mission resolution.
  if (pm.stage === 'effect') {
    runMissionEffect(G, pm.resolverSide, pm.missionId, pm.targetSystemId, pm.leaderIds as LeaderId[], pm.targetLeaderId);
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
/** Compute successes from a face array (re-used after R2-D2 flips). */
function successesFromFaces(faces: string[]): number {
  let s = 0;
  for (const f of faces) s += missionDieScore(f);
  return s;
}

/** Push the mission report + advance pm.stage from a finalized roll. Shared
 *  by both the inline path (no R2-D2) and the post-R2D2 resume path. */
function finalizeMissionRoll(
  G: GameState,
  pm: MissionResolution,
  c: { skill: string; opposerSide: Side },
  skill: string,
  attackerDice: number,
  opposerDice: number,
  attFaces: string[],
  oppFaces: string[],
  attSuccesses: number,
  oppSuccesses: number,
  portrait: number,
  oppLeaderIds: LeaderId[],
): void {
  // Contingency Plan bonus: +2 successes on Lando's next mission attempt this
  // round. Consumed when applied. Only when Lando is among the resolvers and
  // Rebel is the attacker.
  let landoBonus = 0;
  if (pm.resolverSide === 'Rebel'
    && G.actionCardFlags?.landoContingencyBonus
    && (pm.leaderIds as LeaderId[]).includes('lando-calrissian')) {
    landoBonus = 2;
    G.actionCardFlags.landoContingencyBonus = false;
    log(G, { kind: 'lando-contingency-bonus-consumed', side: 'Rebel', payload: {
      missionId: pm.missionId,
    }});
  }
  const attackerTotal = attSuccesses + portrait + landoBonus;
  const succeeded = attackerTotal > oppSuccesses;
  log(G, { kind: 'mission-roll', side: pm.resolverSide, payload: {
    missionId: pm.missionId, skill,
    attacker: { dice: attackerDice, successes: attSuccesses, portrait, landoBonus, total: attackerTotal, faces: attFaces },
    opposer: { side: c.opposerSide, leaderIds: oppLeaderIds, dice: opposerDice, successes: oppSuccesses, faces: oppFaces },
    result: succeeded ? 'success' : 'failure',
  }});
  (G.missionReports ??= []).push({
    missionId: pm.missionId,
    resolverSide: pm.resolverSide,
    targetSystemId: pm.targetSystemId,
    attackerLeaders: [...pm.leaderIds] as LeaderId[],
    opposerSide: c.opposerSide,
    opposerLeaders: [...oppLeaderIds] as LeaderId[],
    skill,
    attackerDice: { count: Math.min(attackerDice, 10), faces: attFaces, successes: attSuccesses },
    opposerDice: { count: Math.min(opposerDice, 10), faces: oppFaces, successes: oppSuccesses },
    portraitBonus: portrait,
    attackerTotal,
    result: succeeded ? 'success' : 'failure',
  });
  pm.stage = succeeded ? 'effect' : 'failed';
}

/** Post the mission-context Yoda reroll choice if eligible. Returns true
 *  if a choice was posted (caller pauses). Eligibility: Yoda ring holder
 *  is on the Rebel side at the mission's target system, the reroll hasn't
 *  been used this round, AND the Rebel-side roll (attacker if Rebel is
 *  resolver, else opposer) has at least one blank die. */
function maybePostMissionYodaReroll(G: GameState, pm: MissionResolution): boolean {
  if (G.yodaRerollUsedThisRound) return false;
  const yoda = findYodaHolder(G);
  if (!yoda) return false;
  const here = G.rebel.leadersOnBoard[pm.targetSystemId] ?? [];
  if (!here.includes(yoda)) return false;
  const stash = pm.r2d2Pending;
  if (!stash) return false;
  // Pick the Rebel-side roll's faces.
  const rebelFaces = pm.resolverSide === 'Rebel' ? stash.attFaces : stash.oppFaces;
  const blanks = rebelFaces.map((f, i) => f === 'blank' ? i : -1).filter((i) => i >= 0);
  if (blanks.length === 0) return false;
  G.pendingChoice = {
    kind: 'YodaReroll',
    side: 'Rebel',
    context: 'mission',
    systemId: pm.targetSystemId,
    blankIndices: blanks,
    holderLeaderId: yoda,
    missionFaces: [...rebelFaces],
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'YodaReroll', context: 'mission', blanks: blanks.length,
  }});
  return true;
}

/** Post the mission-context R2-D2 flip choice if eligible. Returns true
 *  if posted. Eligibility: Rebel holds the Resourceful Astromech card AND
 *  an Empire side (attacker or opposer) rolled a non-blank face. */
function maybePostMissionR2D2(G: GameState, pm: MissionResolution): boolean {
  if (!G.rebel.actionHand.includes('resourceful-astromech')) return false;
  const stash = pm.r2d2Pending;
  if (!stash) return false;
  // Determine which side is Empire-rolled.
  const c = G.catalog.missions[pm.missionId];
  if (!c) return false;
  const opposerSide = pm.resolverSide === 'Rebel' ? 'Empire' as Side : 'Rebel' as Side;
  const empireIsAttacker = pm.resolverSide === 'Empire';
  const empireIsOpposer = opposerSide === 'Empire';
  if (!empireIsAttacker && !empireIsOpposer) return false;
  const empireSide = empireIsAttacker ? 'attacker' : 'opposer';
  const empireFaces = empireSide === 'attacker' ? stash.attFaces : stash.oppFaces;
  const flippable = empireFaces.map((f, i) => f !== 'blank' ? i : -1).filter((i) => i >= 0);
  if (flippable.length === 0) return false;
  // Stash already has empireSide stored; rewrite in case the field was
  // defaulted to 'attacker' when no Empire roll existed at stash-build
  // time. (Currently maybePostMissionYodaReroll runs first and doesn't
  // touch this — but be defensive in case order changes later.)
  stash.empireSide = empireSide;
  G.pendingChoice = {
    kind: 'R2D2Flip',
    side: 'Rebel',
    context: 'mission',
    systemId: pm.targetSystemId,
    flippableDieIndices: flippable,
    missionFaces: [...empireFaces],
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'R2D2Flip', context: 'mission', flippable: flippable.length,
  }});
  return true;
}

/** Continue mission resolution from the stash. Called by both Yoda and
 *  R2-D2 mission resolvers after they've applied their effect. */
function continueMissionFromStash(G: GameState, pm: MissionResolution): void {
  const stash = pm.r2d2Pending;
  if (!stash) return;
  // Check the OTHER potential pause point. Yoda runs first, then R2-D2.
  // If R2-D2 was already resolved (or skipped), we finalize.
  if (!pm.r2d2Pending) return;
  // Try R2-D2 (won't post if Yoda already used; the R2-D2 path checks
  // its own conditions).
  if (maybePostMissionR2D2(G, pm)) return;
  // Both pause points cleared. Finalize the roll.
  const c = { skill: G.catalog.missions[pm.missionId]?.skill ?? '', opposerSide: pm.resolverSide === 'Rebel' ? 'Empire' as Side : 'Rebel' as Side };
  finalizeMissionRoll(
    G, pm, c, c.skill,
    stash.attDice, stash.opposerDice,
    stash.attFaces, stash.oppFaces,
    stash.attSuccesses, stash.oppSuccesses,
    stash.portrait, stash.oppLeaderIds,
  );
  pm.r2d2Pending = undefined;
  if (pm.stage === 'effect') {
    runMissionEffect(G, pm.resolverSide, pm.missionId, pm.targetSystemId, pm.leaderIds as LeaderId[], pm.targetLeaderId);
    if (G.pendingChoice) return;
    discardOrReturnMission(G, pm.resolverSide, pm.missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
  } else if (pm.stage === 'failed') {
    discardOrReturnMission(G, pm.resolverSide, pm.missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
  }
}

/** Resolve a mission-context Yoda reroll. rerollIndex === null → skip
 *  (preserve the reroll for a later roll this round). Otherwise reroll
 *  the chosen blank die, recompute the side's successes, then continue. */
export function resolveYodaMissionReroll(G: GameState, rerollIndex: number | null): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'YodaReroll' || pc.context !== 'mission') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm || !pm.r2d2Pending) return { ok: false, reason: 'no-stash' };
  const stash = pm.r2d2Pending;
  if (rerollIndex !== null) {
    // Rebel-side faces array (attacker if Rebel resolved, else opposer).
    const facesArr = pm.resolverSide === 'Rebel' ? stash.attFaces : stash.oppFaces;
    const colorsArr = pm.resolverSide === 'Rebel' ? stash.attColors : stash.oppColors;
    if (rerollIndex < 0 || rerollIndex >= facesArr.length) return { ok: false, reason: 'bad-index' };
    if (facesArr[rerollIndex] !== 'blank') return { ok: false, reason: 'not-blank' };
    const color = colorsArr[rerollIndex];
    const fresh = rollDie(G.rng, color);
    facesArr[rerollIndex] = fresh.face;
    // Recompute successes on the Rebel side.
    if (pm.resolverSide === 'Rebel') {
      stash.attSuccesses = successesFromFaces(stash.attFaces);
    } else {
      stash.oppSuccesses = successesFromFaces(stash.oppFaces);
    }
    G.yodaRerollUsedThisRound = true;
    const holderName = G.catalog.leaders[pc.holderLeaderId]?.name ?? pc.holderLeaderId;
    log(G, { kind: 'yoda-reroll', side: 'Rebel', payload: {
      context: 'mission', holder: pc.holderLeaderId, holderName,
      systemId: pm.targetSystemId, color, oldFace: 'blank', newFace: fresh.face,
      rule: "Yoda's training: once per round, reroll one blank die on a mission or combat attack rolled by the leader bearing the Yoda ring.",
      explanation: `Yoda (carried by ${holderName} at ${G.catalog.systems[pm.targetSystemId]?.name ?? pm.targetSystemId}) ` +
                   `rerolled a blank ${color} die → ${fresh.face === 'blank' ? 'still blank' : fresh.face}.`,
    }});
  } else {
    log(G, { kind: 'yoda-skipped', side: 'Rebel', payload: { context: 'mission', systemId: pm.targetSystemId } });
  }
  G.pendingChoice = undefined;
  continueMissionFromStash(G, pm);
  return { ok: true };
}

/** Resolve a mission-context R2-D2 flip. flipIndex === null → skip (card
 *  stays in hand). Otherwise flip the chosen face in the stashed Empire-
 *  roll faces to blank, discard the card, then finalise the mission. */
export function resolveR2D2MissionFlip(G: GameState, flipIndex: number | null): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'R2D2Flip' || pc.context !== 'mission') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm || !pm.r2d2Pending) return { ok: false, reason: 'no-r2d2-stash' };
  const stash = pm.r2d2Pending;
  if (flipIndex !== null) {
    const facesArr = stash.empireSide === 'attacker' ? stash.attFaces : stash.oppFaces;
    if (flipIndex < 0 || flipIndex >= facesArr.length) return { ok: false, reason: 'bad-index' };
    if (facesArr[flipIndex] === 'blank') return { ok: false, reason: 'already-blank' };
    const before = facesArr[flipIndex];
    facesArr[flipIndex] = 'blank';
    // Discard the R2-D2 card.
    const i = G.rebel.actionHand.indexOf('resourceful-astromech');
    if (i >= 0) {
      G.rebel.actionHand.splice(i, 1);
      G.rebel.actionDiscard.push('resourceful-astromech');
    }
    // Recompute successes on the side that was flipped.
    if (stash.empireSide === 'attacker') {
      stash.attSuccesses = successesFromFaces(stash.attFaces);
    } else {
      stash.oppSuccesses = successesFromFaces(stash.oppFaces);
    }
    log(G, { kind: 'r2d2-flip', side: 'Rebel', payload: {
      context: 'mission', systemId: pm.targetSystemId,
      dieIndex: flipIndex, flippedFrom: before, empireSide: stash.empireSide,
      explanation: `R2-D2 ring discarded — turned an Empire ${stash.empireSide}'s "${before}" mission die to blank.`,
    }});
  } else {
    log(G, { kind: 'r2d2-skipped', side: 'Rebel', payload: { context: 'mission', systemId: pm.targetSystemId } });
  }
  G.pendingChoice = undefined;
  // R2-D2 is the LAST mission pause point — Yoda already ran (or wasn't
  // eligible). Finalize directly without re-checking pause points.
  const c = { skill: G.catalog.missions[pm.missionId]?.skill ?? '', opposerSide: pm.resolverSide === 'Rebel' ? 'Empire' as Side : 'Rebel' as Side };
  finalizeMissionRoll(
    G, pm, c, c.skill,
    stash.attDice, stash.opposerDice,
    stash.attFaces, stash.oppFaces,
    stash.attSuccesses, stash.oppSuccesses,
    stash.portrait, stash.oppLeaderIds,
  );
  pm.r2d2Pending = undefined;
  if (pm.stage === 'effect') {
    runMissionEffect(G, pm.resolverSide, pm.missionId, pm.targetSystemId, pm.leaderIds as LeaderId[], pm.targetLeaderId);
    if (G.pendingChoice) return { ok: true };
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
  // RAW: "Move ships (but not ground units) from the Rebel Base space to
  // this system as if they were adjacent." Adjacency is bypassed but the
  // card does NOT say "ignoring transport restrictions" — fighters with
  // the restriction icon (X-Wing, Y-Wing) still need a transport-capacity
  // ship in the move group.
  const cap = validateMoveOrderTransport(G, 'Rebel', {
    fromSystemId: 'rebel-base-space', unitInstanceIds: shipIds,
  });
  if (!cap.ok) return { ok: false, reason: `plan-the-assault-transport:${cap.reason}` };
  // Move each picked ship from rebel-base-space to the target system.
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

/** Oversee Project: Empire picks which queued unit to deploy. */
export function resolveOverseeProjectPick(G: GameState, queueIndex: number, slot: 1 | 2): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'OverseeProjectPick') return { ok: false, reason: 'no-pending' };
  const q = G.empire.buildQueue;
  if (!q[slot] || queueIndex < 0 || queueIndex >= q[slot].length) return { ok: false, reason: 'bad-index' };
  const typeId = q[slot].splice(queueIndex, 1)[0];
  M.deployUnit(G, 'Empire', typeId, choice.targetSystemId);
  log(G, { kind: 'oversee-project-pick', side: 'Empire', payload: { typeId, slot, targetSystemId: choice.targetSystemId } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Capture Rebel Operative: Empire picks which Rebel leader to capture. */
export function resolveCaptureOperativePick(G: GameState, leaderId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'CaptureOperativePick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
  M.captureLeader(G, leaderId, 'captured');
  log(G, { kind: 'capture-operative-pick', side: 'Empire', payload: { leaderId } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Carbon Freezing: Empire picks which captured leader gets the carbonite ring. */
export function resolveCarbonFreezingPick(G: GameState, leaderId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'CarbonFreezingPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
  const entry = G.empire.capturedLeaders?.find((c) => c.leaderId === leaderId);
  if (entry) {
    entry.ring = 'carbonite';
    log(G, { kind: 'carbonite-applied', payload: { leaderId, systemId: entry.systemId } });
  }
  M.loseReputation(G, 1);
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Lure Of The Dark Side: Empire picks which captured leader to flip. */
export function resolveLureOfTheDarkSidePick(G: GameState, leaderId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'LureOfTheDarkSidePick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
  const ok = M.flipLeaderToImperial(G, leaderId);
  if (ok && leaderId === 'luke-skywalker') M.loseReputation(G, 1);
  log(G, { kind: 'lure-dark-side-pick', side: 'Empire', payload: { leaderId, flipped: ok } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Homing Beacon: Empire picks a captured leader to rescue AND a system in
 *  the Rebel base's region to place them in. */
export function resolveHomingBeaconPlace(G: GameState, leaderId: string, systemId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'HomingBeaconPlace') return { ok: false, reason: 'no-pending' };
  if (!choice.leaderCandidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
  if (!choice.systemCandidates.includes(systemId)) return { ok: false, reason: 'bad-system' };
  M.rescueLeader(G, leaderId, 'homing-beacon');
  M.placeLeader(G, 'Rebel', leaderId, systemId);
  const baseDef = G.catalog.systems[G.rebelBaseSystemId];
  log(G, { kind: 'homing-beacon-place', side: 'Empire', payload: {
    leaderId, systemId, regionRevealed: baseDef?.region,
  }});
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** R&D Stage 1: Empire picks Option A (peek-and-keep) or B (cleanse + draw 1). */
export function resolveResearchAndDevelopmentOption(G: GameState, option: 'A' | 'B'): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'ResearchAndDevelopmentOption') return { ok: false, reason: 'no-pending' };
  if (option === 'B' && !choice.hasSabotage) {
    // B is technically still legal RAW — the sabotage clause is just a
    // no-op — but warn the caller and proceed.
  }
  G.pendingChoice = undefined;
  if (option === 'B') {
    const ss = G.map.systems[choice.targetSystemId];
    if (ss?.sabotage) {
      ss.sabotage = false;
      log(G, { kind: 'sabotage-removed', side: 'Empire', payload: { systemId: choice.targetSystemId } });
    }
    const drawn = G.empire.projectDeck?.shift();
    if (drawn) {
      G.empire.missionHand.push(drawn);
      log(G, { kind: 'project-draw', side: 'Empire', payload: { count: 1, drawn: [drawn] } });
    }
    resumeMissionAfterChoice(G);
    return { ok: true };
  }
  // Option A — draw 2, queue the keep-vs-bottom pick.
  const a = G.empire.projectDeck?.shift();
  const b = G.empire.projectDeck?.shift();
  if (!a && !b) {
    resumeMissionAfterChoice(G);
    return { ok: true };
  }
  if (a && !b) {
    G.empire.missionHand.push(a);
    log(G, { kind: 'project-draw', side: 'Empire', payload: { count: 1, drawn: [a] } });
    resumeMissionAfterChoice(G);
    return { ok: true };
  }
  G.pendingChoice = {
    kind: 'ResearchAndDevelopmentProjectPick',
    side: 'Empire',
    drawnIds: [a!, b!],
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'ResearchAndDevelopmentProjectPick', candidates: [a, b],
  }});
  return { ok: true };
}

/** R&D Stage 2: Empire picks which drawn project to keep; other goes to bottom. */
export function resolveResearchAndDevelopmentProjectPick(G: GameState, keepInHandId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'ResearchAndDevelopmentProjectPick') return { ok: false, reason: 'no-pending' };
  const [a, b] = choice.drawnIds;
  if (keepInHandId !== a && keepInHandId !== b) return { ok: false, reason: 'invalid-pick' };
  const kept = keepInHandId;
  const bottomed = keepInHandId === a ? b : a;
  G.empire.missionHand.push(kept);
  if (G.empire.projectDeck) G.empire.projectDeck.push(bottomed);
  log(G, { kind: 'project-peek', side: 'Empire', payload: { drawn: [a, b], kept, bottomed } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Destroy up to N health worth of units. Used by Hunt Them Down,
 *  Hit And Run, Wookie Uprising. Caller passes the selected instance
 *  IDs; engine validates total health <= budget then destroys each. */
export function resolveDestroyUpToHealth(G: GameState, instanceIds: string[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'DestroyUpToHealth') return { ok: false, reason: 'no-pending' };
  const ss = G.map.systems[choice.systemId] ?? G.map.rebelBaseSpace;
  if (!ss) return { ok: false, reason: 'no-system' };
  // Validate each pick is in candidates and not double-counted.
  const seen = new Set<string>();
  let totalH = 0;
  for (const uid of instanceIds) {
    if (!choice.candidates.includes(uid)) return { ok: false, reason: `bad-target:${uid}` };
    if (seen.has(uid)) return { ok: false, reason: `duplicate:${uid}` };
    seen.add(uid);
    const u = ss.units.find((x) => x.instanceId === uid);
    if (!u) return { ok: false, reason: `unit-missing:${uid}` };
    totalH += G.catalog.unitTypes[u.typeId]?.health.value ?? 0;
  }
  if (totalH > choice.budget) return { ok: false, reason: `over-budget:${totalH}/${choice.budget}` };
  for (const uid of instanceIds) M.destroyUnit(G, uid, 'mission-effect');
  log(G, { kind: 'destroy-up-to-health', side: choice.side, payload: { card: choice.cardName, killed: instanceIds.length, totalHealth: totalH } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Rogue Squadron Raid: Rebel picks queue items to destroy. */
export function resolveRogueSquadronRaidPick(G: GameState, picks: { slot: 1 | 2 | 3; queueIndex: number }[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'RogueSquadronRaidPick') return { ok: false, reason: 'no-pending' };
  // Validate + sum health.
  let totalH = 0;
  for (const p of picks) {
    const c = choice.candidates.find((x) => x.slot === p.slot && x.queueIndex === p.queueIndex);
    if (!c) return { ok: false, reason: `bad-pick:${p.slot}/${p.queueIndex}` };
    totalH += c.health;
  }
  if (totalH > choice.budget) return { ok: false, reason: `over-budget:${totalH}/${choice.budget}` };
  // Splice in reverse-index order per slot to keep earlier indices stable.
  const sorted = [...picks].sort((a, b) => a.slot - b.slot || b.queueIndex - a.queueIndex);
  for (const p of sorted) {
    const removed = G.empire.buildQueue[p.slot].splice(p.queueIndex, 1)[0];
    log(G, { kind: 'build-queue-destroy', side: 'Rebel', payload: { slot: p.slot, typeId: removed, via: 'rogue-squadron-raid' } });
  }
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Double Our Efforts: Empire moves picked unit(s) down one slot each. */
export function resolveDoubleOurEffortsPick(G: GameState, picks: { slot: 2 | 3; queueIndex: number }[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'DoubleOurEffortsPick') return { ok: false, reason: 'no-pending' };
  if (picks.length > choice.picksAllowed) return { ok: false, reason: `too-many:${picks.length}/${choice.picksAllowed}` };
  // Apply each in reverse-index order per slot.
  const sorted = [...picks].sort((a, b) => a.slot - b.slot || b.queueIndex - a.queueIndex);
  for (const p of sorted) {
    if (p.queueIndex < 0 || p.queueIndex >= G.empire.buildQueue[p.slot].length) {
      return { ok: false, reason: `bad-index:${p.slot}/${p.queueIndex}` };
    }
    const typeId = G.empire.buildQueue[p.slot].splice(p.queueIndex, 1)[0];
    const toSlot = (p.slot - 1) as 1 | 2;
    G.empire.buildQueue[toSlot].push(typeId);
    log(G, { kind: 'build-queue-advance', side: 'Empire', payload: { typeId, fromSlot: p.slot, toSlot, via: 'double-our-efforts' } });
  }
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Planetary Conquest: Empire picks source system; engine moves the
 *  pre-computed unit set; combat triggers at target. */
export function resolvePlanetaryConquestSourcePick(G: GameState, sourceSystemId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'PlanetaryConquestSourcePick') return { ok: false, reason: 'no-pending' };
  const src = choice.sources.find((s) => s.sourceSystemId === sourceSystemId);
  if (!src) return { ok: false, reason: `bad-source:${sourceSystemId}` };
  for (const uid of src.picks) M.moveUnit(G, uid, sourceSystemId, choice.targetSystemId);
  log(G, { kind: 'planetary-conquest-source', side: 'Empire', payload: { sourceSystemId, targetSystemId: choice.targetSystemId, units: src.picks.length } });
  G.pendingChoice = undefined;
  // Trigger combat at target (lazy import to avoid cycle).
  beginCombat(G, 'Empire', sourceSystemId, choice.targetSystemId);
  runCombat(G);
  if (G.pendingChoice || G.pendingCombat) return { ok: true };
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Fear Will Keep Them In Line: Empire picks 2 systems in the region. */
export function resolveFearWillKeepThemInLinePick(G: GameState, systemIds: string[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'FearWillKeepThemInLinePick') return { ok: false, reason: 'no-pending' };
  if (systemIds.length !== choice.count) return { ok: false, reason: `expected-${choice.count}-systems` };
  for (const sid of systemIds) {
    if (!choice.candidates.includes(sid)) return { ok: false, reason: `bad-system:${sid}` };
  }
  for (const sid of systemIds) M.gainLoyalty(G, 'Empire', sid, 1);
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Public Uprising: Rebel picks unit composition for 1 circle + 2 triangles. */
export function resolvePublicUprisingPick(G: GameState, picks: {
  circle: 'corellian-corvette' | 'airspeeder';
  triangles: ('x-wing' | 'rebel-trooper')[];
}): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'PublicUprisingPick') return { ok: false, reason: 'no-pending' };
  if (picks.triangles.length !== 2) return { ok: false, reason: 'expected-2-triangles' };
  const sysId = choice.systemId;
  M.gainUnit(G, 'Rebel', picks.circle, sysId);
  for (const t of picks.triangles) M.gainUnit(G, 'Rebel', t, sysId);
  log(G, { kind: 'public-uprising-pick', side: 'Rebel', payload: { systemId: sysId, circle: picks.circle, triangles: picks.triangles } });
  G.pendingChoice = undefined;
  // Trigger combat at the system.
  beginCombat(G, 'Rebel', sysId, sysId);
  runCombat(G);
  if (G.pendingChoice || G.pendingCombat) return { ok: true };
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Support Of Mon Calamari: Rebel picks loyalty vs cruiser. */
export function resolveSupportOfMonCalamariPick(G: GameState, option: 'loyalty' | 'cruiser'): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'SupportOfMonCalamariPick') return { ok: false, reason: 'no-pending' };
  if (option === 'loyalty') M.gainLoyalty(G, 'Rebel', 'mon-calamari', 2);
  else M.buildToQueue(G, 'Rebel', 'mon-cala-cruiser', 3);
  log(G, { kind: 'support-mon-cala-pick', side: 'Rebel', payload: { option } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Misdirection: Rebel picks any of their leaders to protect. */
export function resolveMisdirectionPick(G: GameState, leaderId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'MisdirectionPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(leaderId)) return { ok: false, reason: `bad-leader:${leaderId}` };
  if (!G.misdirectionProtected) G.misdirectionProtected = [];
  if (!G.misdirectionProtected.includes(leaderId)) G.misdirectionProtected.push(leaderId);
  log(G, { kind: 'misdirection-set', side: 'Rebel', payload: { leaderId } });
  G.pendingChoice = undefined;
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

/** Detained: Empire picks which Rebel leader at the target system gets the
 *  "skip next refresh retrieve" mark. */
export function resolveDetainedTargetPick(G: GameState, leaderId: LeaderId): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'DetainedTargetPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
  G.detainedLeadersNextRefresh = G.detainedLeadersNextRefresh ?? [];
  if (!G.detainedLeadersNextRefresh.some((d) => d.leaderId === leaderId)) {
    G.detainedLeadersNextRefresh.push({ side: 'Rebel', leaderId });
  }
  log(G, { kind: 'detained-applied', side: 'Empire', payload: { leaderId } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** End-of-Command-phase hook: drain Rapid Mobilization deferred entries
 *  one at a time, posting the Branch choice for the next pending mission.
 *  Once the queue is empty, advance to Refresh. */
function processPendingRapidMobilizations(G: GameState): void {
  const queue = G.pendingRapidMobilizations;
  if (!queue || queue.length === 0) {
    enterRefreshPhase(G);
    return;
  }
  const next = queue[0];
  const baseRevealed = !!G.rebelBaseRevealed;
  G.pendingChoice = {
    kind: 'RapidMobilizationBranch',
    side: 'Rebel',
    twoLeaders: next.twoLeaders,
    baseRevealed,
    moveUnitsAvailable: !baseRevealed,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'RapidMobilizationBranch', twoLeaders: next.twoLeaders, baseRevealed,
    endOfPhase: true, remaining: queue.length,
  }});
}

/** Called by RapidMobilization sub-resolvers when they finish their chain.
 *  Pops the head of the queue (the one just resolved) and either posts the
 *  next or advances to Refresh. */
function finishRapidMobilization(G: GameState): void {
  if (G.pendingRapidMobilizations && G.pendingRapidMobilizations.length > 0) {
    G.pendingRapidMobilizations.shift();
  }
  processPendingRapidMobilizations(G);
}

/** Rapid Mobilization branch: Rebel picks 'move-units' or 'establish-base'.
 *  - 'move-units' (only legal if base unrevealed): posts a follow-up
 *    RapidMobilizationMovePick.
 *  - 'establish-base': either picks a system directly (revealed case) or
 *    draws probes and posts RapidMobilizationBasePick (unrevealed case). */
export function resolveRapidMobilizationBranch(
  G: GameState, branch: 'move-units' | 'establish-base'
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'RapidMobilizationBranch') return { ok: false, reason: 'no-pending' };
  if (branch === 'move-units' && !choice.moveUnitsAvailable) return { ok: false, reason: 'move-units-unavailable' };
  const twoLeaders = choice.twoLeaders;
  const baseRevealed = choice.baseRevealed;
  if (branch === 'move-units') {
    G.pendingChoice = { kind: 'RapidMobilizationMovePick', side: 'Rebel' };
    log(G, { kind: 'choice-request', side: 'Rebel', payload: {
      kind: 'RapidMobilizationMovePick',
    }});
    return { ok: true };
  }
  // Establish a new Rebel Base.
  if (baseRevealed) {
    // Any system on the map is a candidate.
    G.pendingChoice = { kind: 'RapidMobilizationBasePick', side: 'Rebel', baseRevealed: true };
    log(G, { kind: 'choice-request', side: 'Rebel', payload: {
      kind: 'RapidMobilizationBasePick', baseRevealed: true,
    }});
    return { ok: true };
  }
  // Unrevealed: draw N probes (4 or 8) → those systems are the candidates.
  const n = twoLeaders ? 8 : 4;
  const drawn = M.drawProbe(G, n);
  log(G, { kind: 'rapid-mobilization-probe-draw', side: 'Rebel', payload: {
    count: n, twoLeaders, drawnProbeIds: drawn,
  }});
  const probeSystemIds = drawn
    .map((pid) => G.catalog.probes[pid]?.systemId)
    .filter((s): s is SystemId => !!s);
  G.pendingChoice = {
    kind: 'RapidMobilizationBasePick', side: 'Rebel',
    baseRevealed: false, probeSystemIds,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'RapidMobilizationBasePick', baseRevealed: false, candidates: probeSystemIds.length,
  }});
  return { ok: true };
}

/** Rapid Mobilization move-units sub-pick: move up to 5 units from a source
 *  system to the Rebel Base space, ignoring adjacency. The picks are unit
 *  instance IDs; engine validates they're Rebel-side units at the source. */
export function resolveRapidMobilizationMove(
  G: GameState, sourceSystemId: SystemId, unitInstanceIds: string[]
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'RapidMobilizationMovePick') return { ok: false, reason: 'no-pending' };
  if (unitInstanceIds.length > 5) return { ok: false, reason: 'too-many-units' };
  const src = G.map.systems[sourceSystemId];
  if (!src) return { ok: false, reason: 'unknown-source' };
  const picks = unitInstanceIds.filter((uid) => {
    const u = src.units.find((x) => x.instanceId === uid);
    return u && u.side === 'Rebel';
  });
  for (const uid of picks) M.moveUnit(G, uid, sourceSystemId, 'rebel-base-space');
  log(G, { kind: 'rapid-mobilization-move-applied', side: 'Rebel', payload: {
    sourceSystemId, movedCount: picks.length, movedIds: picks,
  }});
  G.pendingChoice = undefined;
  finishRapidMobilization(G);
  return { ok: true };
}

/** Rapid Mobilization establish-base sub-pick: relocate the Rebel Base to
 *  the chosen system. Revealed base stays revealed; unrevealed stays hidden. */
export function resolveRapidMobilizationBasePick(
  G: GameState, systemId: SystemId
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'RapidMobilizationBasePick') return { ok: false, reason: 'no-pending' };
  if (!choice.baseRevealed) {
    if (!choice.probeSystemIds || !choice.probeSystemIds.includes(systemId)) {
      return { ok: false, reason: 'not-a-drawn-probe-candidate' };
    }
  }
  if (!G.map.systems[systemId]) return { ok: false, reason: 'unknown-system' };
  const old = G.rebelBaseSystemId;
  G.rebelBaseSystemId = systemId;
  log(G, { kind: 'rapid-mobilization-base-established', side: 'Rebel', payload: {
    fromSystemId: old, toSystemId: systemId, baseRevealed: choice.baseRevealed,
  }});
  G.pendingChoice = undefined;
  finishRapidMobilization(G);
  return { ok: true };
}

/** Hidden Fleet: Rebel picks which units at Rebel Base space to move to the
 *  mission's target system. Validates transport (no immobile, fighters and
 *  ground require capacity-ship coverage) and rejects illegal picks. */
export function resolveHiddenFleetUnitPick(
  G: GameState, unitInstanceIds: string[]
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'HiddenFleetUnitPick') return { ok: false, reason: 'no-pending' };
  // Allow an empty pick (Rebel chooses to move nothing).
  for (const uid of unitInstanceIds) {
    if (!choice.candidateUnitIds.includes(uid)) return { ok: false, reason: `not-a-candidate:${uid}` };
  }
  if (unitInstanceIds.length > 0) {
    const v = validateMoveOrderTransport(G, 'Rebel', {
      fromSystemId: 'rebel-base-space',
      unitInstanceIds,
    });
    if (!v.ok) return { ok: false, reason: v.reason };
  }
  for (const uid of unitInstanceIds) M.moveUnit(G, uid, 'rebel-base-space', choice.targetSystemId);
  log(G, { kind: 'hidden-fleet-move', side: 'Rebel', payload: {
    targetSystemId: choice.targetSystemId, moved: unitInstanceIds.length,
    movedIds: unitInstanceIds,
  }});
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Temporary Alliance: Rebel picks the unit type to queue for each of the
 *  chosen system's resource icons. typeIds[i] must be a legal unit for
 *  icons[i] (tier ≤ icon tier, theater match). null entries are 'skip this
 *  icon' (legal — RAW lets you decline). */
export function resolveTemporaryAllianceBuildPick(
  G: GameState, typeIds: (string | null)[]
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'TemporaryAllianceBuildPick') return { ok: false, reason: 'no-pending' };
  if (typeIds.length !== choice.icons.length) return { ok: false, reason: 'length-mismatch' };
  const sysDef = G.catalog.systems[choice.systemId];
  if (!sysDef || !sysDef.buildSlot) return { ok: false, reason: 'no-build-slot' };
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  // Validate each pick.
  for (let i = 0; i < typeIds.length; i++) {
    const tid = typeIds[i];
    if (tid === null) continue;
    const icon = choice.icons[i];
    const t = G.catalog.unitTypes[tid];
    if (!t || t.side !== 'Rebel') return { ok: false, reason: `bad-type:${tid}` };
    if (t.theater !== icon.theater) return { ok: false, reason: `theater-mismatch:${tid}` };
    const need = tierRank[icon.shape] ?? 2;
    const have = tierRank[t.tier ?? 'square'] ?? 2;
    if (have > need) return { ok: false, reason: `tier-too-high:${tid}` };
  }
  let added = 0;
  for (let i = 0; i < typeIds.length; i++) {
    const tid = typeIds[i];
    if (!tid) continue;
    M.buildToQueue(G, 'Rebel', tid, sysDef.buildSlot, choice.systemId);
    added++;
  }
  log(G, { kind: 'temporary-alliance-built', side: 'Rebel', payload: {
    systemId: choice.systemId, added, picks: typeIds,
  }});
  G.pendingChoice = undefined;
  // Action cards don't have a pendingMission to resume — clear and let the
  // play UI continue naturally.
  return { ok: true };
}

/** Contingency Plan: Rebel picks a starting mission from their hand to
 *  re-assign the resolver leader to. The leader goes onto leadersOnMissions,
 *  available to be revealed later this Command phase (or a future one). */
export function resolveContingencyPlanPick(G: GameState, missionId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'ContingencyPlanPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(missionId)) return { ok: false, reason: 'bad-mission' };
  const leaderId = choice.leaderId;
  // Move mission from hand to leadersOnMissions. If the mission's already
  // there (e.g. someone else assigned to it earlier and it hasn't been
  // resolved), append our leader to the existing entry; else create new.
  const hand = G.rebel.missionHand;
  const i = hand.indexOf(missionId);
  if (i >= 0) hand.splice(i, 1);
  // Make sure the leader isn't sitting on a different mission already.
  const otherAssign = G.rebel.leadersOnMissions.find((m) => m.leaderIds.includes(leaderId));
  if (otherAssign) {
    otherAssign.leaderIds = otherAssign.leaderIds.filter((l) => l !== leaderId);
    if (otherAssign.leaderIds.length === 0) {
      G.rebel.leadersOnMissions = G.rebel.leadersOnMissions.filter((m) => m !== otherAssign);
    }
  }
  const existing = G.rebel.leadersOnMissions.find((m) => m.missionId === missionId);
  if (existing) {
    if (!existing.leaderIds.includes(leaderId)) existing.leaderIds.push(leaderId);
  } else {
    G.rebel.leadersOnMissions.push({ missionId, leaderIds: [leaderId] });
  }
  // Also remove the leader from any board placement (they were on Contingency
  // Plan's target system; the reassignment pulls them back into the mission).
  for (const list of Object.values(G.rebel.leadersOnBoard)) {
    const j = list.indexOf(leaderId);
    if (j >= 0) list.splice(j, 1);
  }
  log(G, { kind: 'contingency-plan-applied', side: 'Rebel', payload: { leaderId, missionId } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Retrieve The Plans: Empire picks 1 card from the Rebel's revealed
 *  objective hand to send to the bottom of the objective deck. */
export function resolveRetrieveThePlansPick(G: GameState, objectiveId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'RetrieveThePlansPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(objectiveId)) return { ok: false, reason: 'bad-card' };
  const hand = G.rebel.objectiveHand ?? [];
  const i = hand.indexOf(objectiveId);
  if (i < 0) return { ok: false, reason: 'card-not-in-hand-anymore' };
  hand.splice(i, 1);
  (G.rebel.objectiveDeck ??= []).push(objectiveId);
  log(G, { kind: 'retrieve-plans-applied', side: 'Empire', payload: {
    bottomed: objectiveId, revealedHand: choice.candidates,
  }});
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Interrogation Droid: Rebel picks 2 decoy systems; engine adds the actual
 *  base and logs the trio so Empire learns the same info they'd see at
 *  a physical table (the base is among these 3). */
export function resolveInterrogationDroidDecoyPick(G: GameState, systemIds: SystemId[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'InterrogationDroidDecoyPick') return { ok: false, reason: 'no-pending' };
  if (systemIds.length !== choice.count) return { ok: false, reason: `expected-${choice.count}-systems` };
  if (new Set(systemIds).size !== systemIds.length) return { ok: false, reason: 'duplicates-not-allowed' };
  for (const sid of systemIds) {
    if (!choice.candidates.includes(sid)) return { ok: false, reason: `bad-system:${sid}` };
    if (sid === G.rebelBaseSystemId) return { ok: false, reason: 'cannot-name-base-as-decoy' };
  }
  // Combine 2 decoys + base, then shuffle (deterministically via the seeded
  // RNG) so the log doesn't betray the base's position.
  const shuffled = shuffle(G.rng, [...systemIds, G.rebelBaseSystemId]);
  log(G, { kind: 'interrogation-droid-named-systems', side: 'Rebel', payload: {
    named: shuffled,
    note: 'One of these contains the Rebel base.',
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

function runMissionEffect(G: GameState, side: Side, missionId: string, targetSystemId: SystemId, leaderIds: LeaderId[], targetLeaderId?: LeaderId): void {
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
  const ctx = Handlers.makeContext(side, { kind: 'mission', id: missionId }, { targetSystemId, targetLeaderId, leaderIds });
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
  // Per-turn action-card flags. These were set during last turn's
  // Assignment phase and become stale once the named leader returns to
  // pool during step 1 (Retrieve Leaders) below. Clear at refresh start
  // so e.g. Boba Fett's block doesn't persist across rounds (the
  // mission/action-card filter also checks live leader position, but
  // clearing the flag keeps the data tidy and avoids stale logs).
  if (G.actionCardFlags) {
    G.actionCardFlags.bobaBlockSystemIds = undefined;
    G.actionCardFlags.greejatusFreeMoveSystemId = undefined;
    G.actionCardFlags.tarkinFreeBuildSystemId = undefined;
    // Contingency Plan: Lando bonus expires at end of round if unused.
    G.actionCardFlags.landoContingencyBonus = undefined;
  }

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
  // Recruit may pause for player to pick which drawn card to keep.
  // On resume (resolveRecruitActionCardPick), refreshBuildIfApplicable
  // is called from there.
  if (refreshRecruitIfApplicable(G, logStart)) return;

  // Build may pause for BuildPick choices. If it does, refresh resumes via
  // resolveBuildPicks() → finishRefreshAfterBuild().
  if (refreshBuildIfApplicable(G, logStart)) return;

  finishRefreshAfterBuild(G, logStart);
}

/** Continues the refresh phase after the build step (which may have paused
 *  for BuildPick choices). Runs deploy, builds the report, advances to
 *  Assignment. If the deploy step needs player picks, this returns early
 *  and resumes via resolveDeployUnitPick. */
function finishRefreshAfterBuild(G: GameState, logStart: number): void {
  // Step 6: Deploy units (slide queue + per-unit deploy picks)
  if (refreshDeployUnits(G)) return; // paused for DeployUnitPick
  finishRefreshAfterDeploy(G, logStart);
}

/** Final step of the refresh phase: report + advance to Assignment. */
function finishRefreshAfterDeploy(G: GameState, logStart: number): void {
  if (G.isGameOver) return;
  buildRefreshReport(G, logStart);
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
  // Track "in-hand but condition not met" objectives so we can surface
  // them in the log. Players who satisfy the condition LATER in the same
  // refresh (e.g. via deploy) often report this as a bug — explaining
  // up front saves a problem-report round-trip.
  const checkedNotMet: { id: string; name: string; rulesText?: string }[] = [];
  for (const id of hand) {
    const card = G.catalog.objectives[id];
    if (!card || card.timing !== 'StartOfRefresh') continue;
    if (!objectiveConditionMet(G, id)) {
      checkedNotMet.push({ id, name: card.name, rulesText: card.rulesText });
      continue;
    }
    eligible.push({ id, rep: objectiveReputationGain(G, id) });
  }
  if (checkedNotMet.length > 0) {
    log(G, { kind: 'objective-check-not-met', side: 'Rebel', payload: {
      objectives: checkedNotMet,
      note: 'StartOfRefresh objectives are checked at the start of Refresh — before retrieve, ' +
            'draw missions, advance-time, recruit/build, and deploy. If you satisfy the ' +
            'condition only after deploys (e.g. fresh units landed in Rebel-loyalty systems), ' +
            'the objective stays in hand and will be re-checked at the next Refresh.',
    }});
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
  const detainedThisRound = new Set(
    (G.detainedLeadersNextRefresh ?? []).map((d) => `${d.side}:${d.leaderId}`)
  );
  const skippedReturn: string[] = [];
  for (const side of ['Rebel', 'Empire'] as const) {
    const f = faction(G, side);
    const retrieved: string[] = [];
    const tryReturn = (lid: string): boolean => {
      // Detained leaders skip THIS refresh's retrieve (single-use per RAW).
      if (detainedThisRound.has(`${side}:${lid}`)) {
        skippedReturn.push(lid);
        return false;
      }
      if (!f.leaderPool.includes(lid)) f.leaderPool.push(lid);
      retrieved.push(lid);
      return true;
    };
    // Leaders on missions return without revealing (rr p.9).
    for (const a of f.leadersOnMissions) {
      for (const lid of a.leaderIds) tryReturn(lid);
      f.missionHand.push(a.missionId);
    }
    f.leadersOnMissions = [];
    // Leaders on the board return to the pool.
    // Skipped (detained) ones stay where they are — they remain on the board
    // and become retrievable next refresh.
    const newBoard: typeof f.leadersOnBoard = {};
    for (const [sysId, list] of Object.entries(f.leadersOnBoard)) {
      const remaining: string[] = [];
      for (const lid of list) {
        const returned = tryReturn(lid);
        if (!returned) remaining.push(lid);
      }
      if (remaining.length > 0) newBoard[sysId] = remaining;
    }
    f.leadersOnBoard = newBoard;
    if (retrieved.length > 0) {
      log(G, { kind: 'refresh-retrieve', side, payload: { leaderIds: retrieved } });
    }
  }
  if (skippedReturn.length > 0) {
    log(G, { kind: 'detained-refresh-skip', payload: { leaderIds: skippedReturn } });
  }
  // RAW: Detained is single-use; clear the marker after applying.
  G.detainedLeadersNextRefresh = [];
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

/** Refresh recruit step. Each side draws 2 action cards and the player
 *  picks 1 to keep (which recruits the matching leader if able); the
 *  other goes to the bottom of the deck. Returns true if a player
 *  choice is pending (refresh paused). */
function refreshRecruitIfApplicable(G: GameState, logStart: number): boolean {
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
  if (!recruitOn[G.timeMarker]) return false;

  // Draw 2 per side and collect pending picks. Edge cases (deck < 2):
  // 0 cards → skip side. 1 card → no choice, auto-keep that card.
  const pending: { side: Side; drawnIds: [string, string] }[] = [];
  for (const side of ['Rebel', 'Empire'] as const) {
    const f = faction(G, side);
    if (f.actionDeck.length === 0) continue;
    if (f.actionDeck.length === 1) {
      const cardId = f.actionDeck.shift()!;
      applyRecruitedActionCard(G, side, cardId);
      continue;
    }
    const a = f.actionDeck.shift()!;
    const b = f.actionDeck.shift()!;
    pending.push({ side, drawnIds: [a, b] });
  }

  if (pending.length === 0) return false;
  if (!G.refreshPaused) G.refreshPaused = { logStart, pendingBuildPicks: [] };
  G.refreshPaused.pendingRecruitPicks = pending;
  promoteNextRecruitPick(G);
  return true;
}

/** Helper: keep card in hand, recruit the matching leader if eligible. */
function applyRecruitedActionCard(G: GameState, side: Side, cardId: string): void {
  const f = faction(G, side);
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
    log(G, { kind: 'recruit-action-only', side, payload: { cardId } });
  }
  f.actionHand.push(cardId);
}

function promoteNextRecruitPick(G: GameState): void {
  const r = G.refreshPaused;
  if (!r?.pendingRecruitPicks || r.pendingRecruitPicks.length === 0) return;
  const next = r.pendingRecruitPicks[0];
  G.pendingChoice = {
    kind: 'RecruitActionCardPick',
    side: next.side,
    drawnIds: next.drawnIds,
  };
  log(G, { kind: 'choice-request', side: next.side, payload: {
    kind: 'RecruitActionCardPick', cards: next.drawnIds,
  }});
}

/** Resolve a single side's recruit pick. The kept card goes to hand
 *  (and recruits the matching leader if eligible); the other goes to
 *  the bottom of the action deck. */
export function resolveRecruitActionCardPick(G: GameState, keepCardId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'RecruitActionCardPick') return { ok: false, reason: 'no-pending' };
  const r = G.refreshPaused;
  if (!r?.pendingRecruitPicks || r.pendingRecruitPicks.length === 0) return { ok: false, reason: 'no-refresh-pause' };
  const cur = r.pendingRecruitPicks[0];
  if (cur.side !== choice.side) return { ok: false, reason: 'side-mismatch' };
  const [a, b] = cur.drawnIds;
  if (keepCardId !== a && keepCardId !== b) return { ok: false, reason: 'invalid-pick' };
  const bottomed = keepCardId === a ? b : a;
  applyRecruitedActionCard(G, cur.side, keepCardId);
  const f = faction(G, cur.side);
  f.actionDeck.push(bottomed);
  log(G, { kind: 'recruit-pick-resolved', side: cur.side, payload: { kept: keepCardId, bottomed } });
  r.pendingRecruitPicks.shift();
  G.pendingChoice = undefined;
  if (r.pendingRecruitPicks.length > 0) {
    promoteNextRecruitPick(G);
    return { ok: true };
  }
  // All recruit picks done — clear field and proceed to build step.
  r.pendingRecruitPicks = undefined;
  const logStart = r.logStart;
  if (refreshBuildIfApplicable(G, logStart)) return { ok: true };
  G.refreshPaused = undefined;
  finishRefreshAfterBuild(G, logStart);
  return { ok: true };
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

/** All legal deploy-target systems for one unit type from `side`, per
 *  RR p.7. A system is legal if it's controlled (subjugated for Empire),
 *  has no enemy units, no sabotage, isn't destroyed, isn't remote. Rebel
 *  Base space is added if the base is still hidden. */
export function legalDeployTargets(G: GameState, side: Side): SystemId[] {
  const out: SystemId[] = [];
  for (const [sysId, ss] of Object.entries(G.map.systems)) {
    const sysDef = G.catalog.systems[sysId];
    if (!sysDef || sysDef.isRemote || ss.destroyed || ss.sabotage) continue;
    if (side === 'Rebel' && ss.loyalty !== 'rebel') continue;
    if (side === 'Empire' && ss.loyalty !== 'imperial' && !ss.subjugated) continue;
    const opp: Side = side === 'Rebel' ? 'Empire' : 'Rebel';
    if (ss.units.some((u) => u.side === opp)) continue;
    out.push(sysId);
  }
  if (side === 'Rebel' && !G.rebelBaseRevealed) {
    out.push('rebel-base-space');
  }
  return out;
}

/** Refresh deploy step. Slides queue 3→2→1, then queues a DeployUnitPick
 *  for each unit that falls off slot 1. Returns true if a choice is pending
 *  (caller must wait for resolveDeployUnitPick); false if everything
 *  auto-resolved (zero candidates → returned to slot 1, exactly one
 *  candidate → auto-deployed). */
function refreshDeployUnits(G: GameState): boolean {
  const queue: { side: Side; typeId: UnitTypeId }[] = [];
  for (const side of ['Rebel', 'Empire'] as const) {
    const f = faction(G, side);
    const deploying = f.buildQueue[1];
    f.buildQueue[1] = f.buildQueue[2];
    f.buildQueue[2] = f.buildQueue[3];
    f.buildQueue[3] = [];
    for (const typeId of deploying) {
      queue.push({ side, typeId });
    }
  }
  if (!G.refreshPaused) {
    // Defensive: should always be set during a refresh, but if not, create.
    G.refreshPaused = { logStart: G.turnLog.length, pendingBuildPicks: [] };
  }
  G.refreshPaused.pendingDeployPicks = queue;
  // Start the deploy-cap counter fresh for this Refresh phase.
  G.refreshPaused.deployedThisPhase = {};
  return promoteNextDeployPick(G);
}

/** Apply RR p.7 cap: filter `candidates` down to systems where this side
 *  has deployed fewer than 2 units in the current Refresh's deploy step. */
function applyDeployCap(G: GameState, side: Side, candidates: SystemId[]): SystemId[] {
  const counts = G.refreshPaused?.deployedThisPhase?.[side] ?? {};
  return candidates.filter((sid) => (counts[sid] ?? 0) < 2);
}

/** Record a successful deploy for the per-Refresh per-side per-system cap. */
function trackDeploy(G: GameState, side: Side, systemId: SystemId): void {
  const r = G.refreshPaused;
  if (!r) return;
  r.deployedThisPhase = r.deployedThisPhase ?? {};
  const bySys = (r.deployedThisPhase[side] = r.deployedThisPhase[side] ?? {});
  bySys[systemId] = (bySys[systemId] ?? 0) + 1;
}

/** Take the next pending deploy entry; auto-resolve if 0 or 1 candidates,
 *  otherwise post a DeployUnitPick choice. Returns true if we paused.
 *  RAW (RR p.7): max 2 deploys per side per system per Refresh — applied
 *  via applyDeployCap on every candidate set. */
function promoteNextDeployPick(G: GameState): boolean {
  const r = G.refreshPaused;
  if (!r?.pendingDeployPicks) return false;
  while (r.pendingDeployPicks.length > 0) {
    const next = r.pendingDeployPicks[0];
    const f = faction(G, next.side);
    const candidates = applyDeployCap(G, next.side, legalDeployTargets(G, next.side));
    if (candidates.length === 0) {
      // RAW: returns to slot 1 of build queue. (Includes the case where
      // every legal system is already saturated at the 2-deploy cap.)
      f.buildQueue[1].push(next.typeId);
      log(G, { kind: 'deploy-returned-to-queue', side: next.side, payload: {
        typeId: next.typeId,
        reason: legalDeployTargets(G, next.side).length === 0 ? 'no-legal-system' : 'all-systems-at-deploy-cap',
      }});
      r.pendingDeployPicks.shift();
      continue;
    }
    if (candidates.length === 1) {
      M.deployUnit(G, next.side, next.typeId, candidates[0]);
      trackDeploy(G, next.side, candidates[0]);
      r.pendingDeployPicks.shift();
      continue;
    }
    // Multiple legal targets — player picks.
    G.pendingChoice = {
      kind: 'DeployUnitPick',
      side: next.side,
      typeId: next.typeId,
      candidates,
    };
    log(G, { kind: 'choice-request', side: next.side, payload: {
      kind: 'DeployUnitPick', typeId: next.typeId, candidates,
    }});
    return true;
  }
  // All deploys done.
  r.pendingDeployPicks = undefined;
  return false;
}

/** Player picks a system to deploy the queued unit into. */
export function resolveDeployUnitPick(G: GameState, systemId: SystemId): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'DeployUnitPick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(systemId)) return { ok: false, reason: 'not-a-candidate' };
  // Defensive cap check — candidates list was already filtered by
  // applyDeployCap when the choice was posted, but re-check in case the
  // state changed between modal-post and player-submit.
  const cur = G.refreshPaused?.deployedThisPhase?.[pc.side]?.[systemId] ?? 0;
  if (cur >= 2) return { ok: false, reason: `deploy-cap-reached:${systemId}` };
  M.deployUnit(G, pc.side, pc.typeId, systemId);
  trackDeploy(G, pc.side, systemId);
  G.pendingChoice = undefined;
  const r = G.refreshPaused;
  if (r?.pendingDeployPicks) r.pendingDeployPicks.shift();
  if (promoteNextDeployPick(G)) return { ok: true };
  // All deploys done — finish refresh.
  const logStart = r?.logStart ?? 0;
  G.refreshPaused = undefined;
  finishRefreshAfterDeploy(G, logStart);
  return { ok: true };
}

// ============================================================================
// Assignment-phase action card play (14 cards, timing=Assignment)
// ============================================================================
//
// Rules: a player may play any number of action cards during their Assignment
// turn (rr p.4 — Assignment phase, "play action cards"). Each Assignment-timed
// card requires a named leader; the leader must be in the player's leader pool
// (i.e. NOT already on the board / on a mission / captured / eliminated).
// Playing the card places the leader on the named space and applies the
// card's effect, then discards the card to the action-card discard.
//
// Implementation status per card (* = full effect; † = leader placed + partial
// effect; ‡ = leader placed + log notice, full effect manual):
//   * rebel-planning          (place at Rebel Base, draw 1 objective)
//   * public-support          (place + gain 3 stormtroopers + freeze-exempt flag)
//   * an-old-friend           (place at Bespin/Kashyyyk + recruit Lando/Chewbacca)
//   * rebel-planning          (see above)
//   * temporary-alliance      (place + add the system's resource icons as build queue entries — simplified)
//   * brilliant-administrator (place + grant 1 build action via flag)
//   * local-rumors            (place + log "rebel base in this region: Y/N")
//   † ambush                  (place + DestroyUpToHealth pick on Imperial ground at system)
//   ‡ boba-fett-where         (place + set blocker flag — Rebels can't mission/action here this turn)
//   ‡ catch-them-by-surprise  (place Ozzel + log; manual fleet move expected by player on their next Command turn)
//   ‡ proceeding-as-planned   (place + log; project deck search is project-deck infra, not yet wired)
//   ‡ scouting-mission        (place + log; TIE relocate + auto-combat is complex)
//   ‡ independent-operation   (place at subjugated system + log; forced Imperial ground evacuation manual)
//   ‡ our-most-desperate-hour (place Leia on a mission card in hand — already handled by player at assign step; log notice)
//   ‡ start-the-evacuation    (no leader to place in pool; Rieekan + base-units move — manual)

export function playableAssignmentActionCards(G: GameState, side: Side): string[] {
  const f = faction(G, side);
  const out: string[] = [];
  for (const cid of f.actionHand) {
    const card = G.catalog.actions[cid];
    if (!card) continue;
    if (card.timing !== 'Assignment') continue;
    // Leader requirement: at least one named leader must be in the pool.
    const reqs = card.leaderRequirement ?? [];
    if (reqs.length > 0 && !reqs.some((lid) => f.leaderPool.includes(lid))) continue;
    out.push(cid);
  }
  return out;
}

/** Player explicitly opens the action-card play modal during their Assignment turn. */
export function requestAssignmentActionCardPlay(G: GameState, side: Side): { ok: boolean; reason?: string } {
  if (G.phase !== 'Assignment') return { ok: false, reason: 'wrong-phase' };
  if (G.currentPlayer !== side) return { ok: false, reason: 'not-your-turn' };
  if (G.pendingChoice) return { ok: false, reason: 'pending-choice' };
  const candidates = playableAssignmentActionCards(G, side);
  if (candidates.length === 0) return { ok: false, reason: 'no-playable-action-cards' };
  G.pendingChoice = { kind: 'PlayAssignmentActionCard', side, candidates };
  log(G, { kind: 'choice-request', side, payload: { kind: 'PlayAssignmentActionCard', candidates } });
  return { ok: true };
}

/** "Cancel" the play modal without picking. */
export function cancelAssignmentActionCardPlay(G: GameState): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'PlayAssignmentActionCard') return { ok: false, reason: 'no-pending' };
  G.pendingChoice = undefined;
  log(G, { kind: 'choice-cancel', side: pc.side, payload: { kind: 'PlayAssignmentActionCard' } });
  return { ok: true };
}

/** Per-card "needs a system pick?" + legal-system filter. */
function legalSystemsForAssignmentCard(G: GameState, side: Side, cardId: string): SystemId[] | null {
  // "Boba Fett, Where?" — Rebel cannot use action cards at systems where
  // Boba Fett is placed via the card. Pre-filter Rebel candidates so the
  // player doesn't even see those systems as options.
  const bobaBlocked = (sid: SystemId) =>
    side === 'Rebel'
    && (G.empire.leadersOnBoard[sid] ?? []).includes('boba-fett')
    && !!G.actionCardFlags?.bobaBlockSystemIds?.includes(sid);
  const all = Object.keys(G.map.systems).filter((sid) => !bobaBlocked(sid));
  switch (cardId) {
    case 'boba-fett-where':
    case 'brilliant-administrator':
    case 'public-support': {
      // Imperial system. Per card text "Imperial system" = loyalty=imperial OR subjugated.
      return all.filter((sid) => {
        const ss = G.map.systems[sid];
        return ss && (ss.loyalty === 'imperial' || ss.subjugated);
      });
    }
    case 'local-rumors': {
      // Any system with an Imperial unit.
      return all.filter((sid) => {
        const ss = G.map.systems[sid];
        return ss && ss.units.some((u) => u.side === 'Empire');
      });
    }
    case 'catch-them-by-surprise':
    case 'scouting-mission':
    case 'ambush': {
      // Any system.
      return all;
    }
    case 'an-old-friend': {
      return all.filter((sid) => sid === 'bespin' || sid === 'kashyyyk');
    }
    case 'independent-operation': {
      return all.filter((sid) => G.map.systems[sid]?.subjugated);
    }
    case 'temporary-alliance': {
      return all.filter((sid) => G.map.systems[sid]?.loyalty === 'neutral');
    }
    // No system pick needed:
    case 'rebel-planning':           return null; // Rebel Base
    case 'proceeding-as-planned':    return null; // attached to project, not a system
    case 'our-most-desperate-hour':  return null; // attached to a mission card in hand
    case 'start-the-evacuation':     return null; // moves units; no leader-placement
    default: return null;
  }
}

/** Default placement system for cards that don't take a system pick. */
function defaultPlacementSystemForCard(cardId: string): SystemId | null {
  if (cardId === 'rebel-planning') return 'rebel-base-space';
  return null;
}

/** Player picks a card from the PlayAssignmentActionCard candidates. If the
 *  card needs a system, posts an ActionCardSystemPick; else applies effect now. */
export function playAssignmentActionCard(G: GameState, cardId: string): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'PlayAssignmentActionCard') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(cardId)) return { ok: false, reason: 'not-a-candidate' };
  const side = pc.side;
  const card = G.catalog.actions[cardId];
  if (!card) return { ok: false, reason: 'unknown-card' };

  const legalSystems = legalSystemsForAssignmentCard(G, side, cardId);
  if (legalSystems !== null) {
    if (legalSystems.length === 0) return { ok: false, reason: 'no-legal-system' };
    // Swap pending choice from "pick card" → "pick system for this card".
    G.pendingChoice = { kind: 'ActionCardSystemPick', side, cardId, candidates: legalSystems };
    log(G, { kind: 'choice-request', side, payload: { kind: 'ActionCardSystemPick', cardId, candidates: legalSystems } });
    return { ok: true };
  }

  // No system pick — apply directly.
  G.pendingChoice = undefined;
  applyAssignmentActionCardEffect(G, side, cardId, defaultPlacementSystemForCard(cardId));
  return { ok: true };
}

/** Player picks the system for a card that needed one. */
export function resolveActionCardSystemPick(G: GameState, systemId: SystemId): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'ActionCardSystemPick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(systemId)) return { ok: false, reason: 'not-a-candidate' };
  // "Boba Fett, Where?" — RAW: "Rebels cannot attempt missions OR USE
  // ACTION CARDS here." Mirrors the same check in revealMission.
  if (pc.side === 'Rebel'
      && (G.empire.leadersOnBoard[systemId] ?? []).includes('boba-fett')
      && G.actionCardFlags?.bobaBlockSystemIds?.includes(systemId)) {
    return { ok: false, reason: `boba-fett-blocks-system:${systemId}` };
  }
  const { side, cardId } = pc;
  G.pendingChoice = undefined;
  applyAssignmentActionCardEffect(G, side, cardId, systemId);
  return { ok: true };
}

/** Helper: discard the card to action discard and (if it has a leader requirement)
 *  remove the chosen leader from the pool and place it on the target system. */
function consumeCardAndPlaceLeader(
  G: GameState, side: Side, cardId: string, systemId: SystemId | null,
): { leaderId: LeaderId | null } {
  const f = faction(G, side);
  // Discard the card.
  const i = f.actionHand.indexOf(cardId);
  if (i >= 0) f.actionHand.splice(i, 1);
  f.actionDiscard.push(cardId);

  const card = G.catalog.actions[cardId];
  const reqs = card?.leaderRequirement ?? [];
  let placed: LeaderId | null = null;
  for (const lid of reqs) {
    if (f.leaderPool.includes(lid)) { placed = lid; break; }
  }
  if (placed && systemId) {
    const pi = f.leaderPool.indexOf(placed);
    if (pi >= 0) f.leaderPool.splice(pi, 1);
    M.placeLeader(G, side, placed, systemId);
  }
  return { leaderId: placed };
}

/** Per-card effect dispatch. `systemId` is null for cards that don't place a leader. */
function applyAssignmentActionCardEffect(
  G: GameState, side: Side, cardId: string, systemId: SystemId | null,
): void {
  const { leaderId } = consumeCardAndPlaceLeader(G, side, cardId, systemId);
  log(G, { kind: 'action-card-play', side, payload: { cardId, leaderId, systemId, timing: 'Assignment' } });

  switch (cardId) {
    // ---------- Rebel ----------
    case 'rebel-planning': {
      M.drawObjective(G, 1);
      break;
    }
    case 'an-old-friend': {
      // Han at Bespin → recruit Lando; at Kashyyyk → recruit Chewbacca.
      const target = systemId === 'bespin' ? 'lando-calrissian'
                   : systemId === 'kashyyyk' ? 'chewbacca' : null;
      const f = faction(G, side);
      if (target && G.catalog.leaders[target]
          && !f.leaderPool.includes(target)
          && !f.eliminatedLeaders.includes(target)) {
        f.leaderPool.push(target);
        log(G, { kind: 'recruit-leader', side, payload: { leaderId: target, via: 'an-old-friend' } });
      }
      break;
    }
    case 'ambush': {
      // Destroy up to 3 health of Imperial ground units at the system.
      if (!systemId) break;
      const ss = G.map.systems[systemId];
      if (!ss) break;
      const candidates = ss.units
        .filter((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')
        .map((u) => u.instanceId);
      if (candidates.length === 0) {
        log(G, { kind: 'action-card-noop', side, payload: { cardId, reason: 'no-imperial-ground' } });
        break;
      }
      G.pendingChoice = {
        kind: 'DestroyUpToHealth',
        side, systemId, candidates, budget: 3, cardName: 'Ambush',
      };
      log(G, { kind: 'choice-request', side, payload: { kind: 'DestroyUpToHealth', card: 'Ambush', candidates, budget: 3 } });
      break;
    }
    case 'temporary-alliance': {
      // Post a TemporaryAllianceBuildPick choice so the Rebel picks the
      // specific unit type for each of the system's resource icons.
      if (!systemId) break;
      const sysDef = G.catalog.systems[systemId];
      if (!sysDef || !sysDef.buildSlot || sysDef.resources.length === 0) {
        log(G, { kind: 'action-card-noop', side, payload: { cardId, reason: 'no-build-icons' } });
        break;
      }
      G.pendingChoice = {
        kind: 'TemporaryAllianceBuildPick',
        side: 'Rebel',
        systemId,
        icons: sysDef.resources.map((r) => ({ theater: r.type, shape: r.shape })),
      };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: {
        kind: 'TemporaryAllianceBuildPick', systemId, iconCount: sysDef.resources.length,
      }});
      break;
    }
    case 'our-most-desperate-hour': {
      // RAW: search the assignment deck (mission deck) for a card, put Leia on it.
      // Engine doesn't yet expose mid-game mission-deck search. Log a partial.
      log(G, { kind: 'action-card-partial', side, payload: { cardId, note: 'Leia returned to pool; mission-deck search not yet automated — assign Leia to any mission this turn.' } });
      // Make sure Leia is in the pool (consumeCardAndPlaceLeader removed her if she was there).
      const f = faction(G, side);
      if (!f.leaderPool.includes('princess-leia')
          && !f.eliminatedLeaders.includes('princess-leia')) {
        f.leaderPool.push('princess-leia');
      }
      break;
    }
    case 'independent-operation': {
      log(G, { kind: 'action-card-partial', side, payload: { cardId, note: 'Lando placed in subjugated system; forced Imperial ground evacuation must be enacted manually.' } });
      break;
    }
    case 'start-the-evacuation': {
      log(G, { kind: 'action-card-partial', side, payload: { cardId, note: 'Move units from Rebel Base to any non-Imperial system manually (move-units UI not wired for this card).' } });
      break;
    }

    // ---------- Empire ----------
    case 'public-support': {
      // Gain 3 stormtroopers at the system; set "Greejatus does not pin units out" flag.
      if (!systemId) break;
      for (let i = 0; i < 3; i++) M.gainUnit(G, 'Empire', 'stormtrooper', systemId);
      G.actionCardFlags = G.actionCardFlags ?? {};
      G.actionCardFlags.greejatusFreeMoveSystemId = systemId;
      log(G, { kind: 'public-support-gain', side: 'Empire', payload: { systemId, stormtroopers: 3 } });
      break;
    }
    case 'brilliant-administrator': {
      // "Immediately build with it" — grant Empire one free build action at this system.
      G.actionCardFlags = G.actionCardFlags ?? {};
      G.actionCardFlags.tarkinFreeBuildSystemId = systemId ?? undefined;
      log(G, { kind: 'action-card-partial', side: 'Empire', payload: { cardId, note: 'Tarkin placed; "immediately build with it" needs manual build via your Command turn at this system.', systemId } });
      break;
    }
    case 'local-rumors': {
      if (!systemId) break;
      const sysDef = G.catalog.systems[systemId];
      const baseDef = G.catalog.systems[G.rebelBaseSystemId];
      const sameRegion = !!(sysDef && baseDef && sysDef.region === baseDef.region);
      log(G, { kind: 'local-rumors-reveal', side: 'Empire', payload: {
        systemId, region: sysDef?.region, baseInRegion: sameRegion,
      }});
      break;
    }
    case 'boba-fett-where': {
      if (!systemId) break;
      G.actionCardFlags = G.actionCardFlags ?? {};
      G.actionCardFlags.bobaBlockSystemIds = G.actionCardFlags.bobaBlockSystemIds ?? [];
      if (!G.actionCardFlags.bobaBlockSystemIds.includes(systemId)) {
        G.actionCardFlags.bobaBlockSystemIds.push(systemId);
      }
      log(G, { kind: 'boba-block', side: 'Empire', payload: { systemId } });
      break;
    }
    case 'catch-them-by-surprise': {
      log(G, { kind: 'action-card-partial', side: 'Empire', payload: { cardId, note: 'Ozzel placed; move a fleet now via the standard activation UI (this card lets you move during Assignment).' } });
      break;
    }
    case 'proceeding-as-planned': {
      log(G, { kind: 'action-card-partial', side: 'Empire', payload: { cardId, note: 'Leader returned to pool; project-deck search must be done manually until project assignment UI lands.' } });
      // Make sure leader is back in pool for manual assignment.
      const f = G.empire;
      for (const lid of (G.catalog.actions[cardId]?.leaderRequirement ?? [])) {
        if (!f.leaderPool.includes(lid) && !f.eliminatedLeaders.includes(lid)) f.leaderPool.push(lid);
      }
      break;
    }
    case 'scouting-mission': {
      log(G, { kind: 'action-card-partial', side: 'Empire', payload: { cardId, note: 'Leader placed; TIE Fighter relocation + auto-combat must be done manually.' } });
      break;
    }

    default: {
      log(G, { kind: 'action-card-unknown', side, payload: { cardId } });
      break;
    }
  }
}

/** Default unit pick for a resource icon (used by Temporary Alliance — simplified). */
function pickDefaultUnitForIcon(side: Side, icon: { type: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }): string | null {
  if (side === 'Rebel') {
    if (icon.type === 'space') {
      if (icon.shape === 'triangle') return 'x-wing';
      if (icon.shape === 'circle') return 'corellian-corvette';
      return 'mc-cruiser';
    }
    if (icon.shape === 'triangle') return 'rebel-trooper';
    if (icon.shape === 'circle') return 'airspeeder';
    return 'heavy-aa';
  }
  if (icon.type === 'space') {
    if (icon.shape === 'triangle') return 'tie-fighter';
    if (icon.shape === 'circle') return 'assault-carrier';
    return 'star-destroyer';
  }
  if (icon.shape === 'triangle') return 'stormtrooper';
  if (icon.shape === 'circle') return 'at-st';
  return 'at-at';
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
