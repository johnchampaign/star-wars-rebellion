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
import { log, pushNotice } from './log';
import * as Handlers from './handlers/registry';
import { missionTargets } from './missionTargets';
import { PROJECT_ONLY_UNIT_IDS } from './units';
import { rollDie, shuffle } from './rng';
import { objectiveConditionMet, objectiveReputationGain, objectiveReturnsToDeck, objectiveReturnsToHand, postPlayObjectiveChoice } from './objectives';

/** Time-track turns on which the Rebel recruits a new leader, per the printed
 *  16-space board (turns 2-5). Single source of truth shared by the engine's
 *  Refresh recruit step AND the UI turn tracker, so the "R" badge and the
 *  actual recruit can never disagree (issues #48/#59). */
export const RECRUIT_TIME_MARKERS: ReadonlySet<number> = new Set([2, 3, 4, 5]);

/** Time-track turns carrying a BUILD icon, per the printed 16-space board:
 *  the even turns 2 through 14 (turn 16, the final space, has none). Shared
 *  by the engine's Refresh build step and the UI turn tracker. */
export const BUILD_TIME_MARKERS: ReadonlySet<number> = new Set([2, 4, 6, 8, 10, 12, 14]);

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
    // Base (re)placed → searched-ruled-out knowledge resets to currently-
    // qualifying systems only.
    M.resetEmpireSearchedForBaseMove(G);
  }

  G.pendingRebelBasePick = undefined;
  log(G, { kind: 'pick-rebel-base', side: 'Rebel', payload: { systemId } });
  // The base pick can be the LAST remaining setup step (if the Rebel deployed
  // all units before choosing the base). maybeAdvanceFromSetup gates leaving
  // Setup on pendingRebelBasePick being cleared (above), and only this function
  // clears it — so it must re-check advancement here, exactly like
  // setupDeployUnit/setupAutoFill do. Without it, deploy-all-then-pick-base
  // soft-locks in Setup with both deployments empty and no legal actions.
  maybeAdvanceFromSetup(G);
  return { ok: true };
}

// ============================================================================
// Setup Phase — interactive unit placement (rr p.15 step 8)
// ============================================================================

let setupInstanceCounter = 100_000; // separate range from auto-setup
function mkSetupInstance(typeId: string, side: Side) {
  return { instanceId: `s${(++setupInstanceCounter).toString().padStart(6, '0')}`, typeId, side, damage: 0 };
}

/** Reseed setupInstanceCounter to max existing s-prefixed ID + 1.
 *  Mirror of mechanics.reseedInstanceCounters but for the s-prefix.
 *  Required after decoding a saved game — module-level counter otherwise
 *  starts at 100_000 every page reload, causing collisions with persisted
 *  setup-placed units. */
export function reseedSetupInstanceCounter(G: GameState): void {
  let maxS = 100_000;
  const visit = (units: { instanceId: string }[]): void => {
    for (const u of units) {
      const m = /^s(\d+)$/.exec(u.instanceId);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxS) maxS = n;
      }
    }
  };
  for (const ss of Object.values(G.map.systems)) visit(ss.units);
  visit(G.map.rebelBaseSpace.units);
  setupInstanceCounter = maxS;
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
    // Rebel: the Rebel Base space OR ONE populous system of the player's choice
    // — a neutral world or one with Rebel loyalty (RAW; confirmed by the
    // reporter who originally flagged #86: starting on a neutral world far from
    // the hidden base is a legitimate cat-and-mouse opening). Just not an
    // Imperial/subjugated system, Coruscant, or a remote (non-populous) world.
    if (systemId === 'rebel-base-space') {
      // always allowed
    } else {
      const ss = G.map.systems[systemId];
      if (!ss) return { ok: false, reason: 'unknown-system' };
      if (G.rebelDeployTarget && G.rebelDeployTarget !== systemId) {
        return { ok: false, reason: `rebel-already-chose-${G.rebelDeployTarget}` };
      }
      const def = G.catalog.systems[systemId];
      if (ss.subjugated || ss.loyalty === 'imperial' || def?.isCoruscant || def?.isRemote) {
        return { ok: false, reason: 'must-be-populous-rebel-or-neutral' };
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

/** Dismiss (acknowledge) the front-most pending report of a given type. Reports
 *  are queued in engine state and shown one at a time; the UI shifts them off as
 *  the player clicks OK. Online this must be an engine mutation submitted to the
 *  server — a local array shift on the redacted view would be undone by the next
 *  poll, locking the dialog. The reportType makes the dismissal unambiguous when
 *  more than one report kind is queued. */
export function acknowledgeReport(
  G: GameState,
  reportType: 'mission' | 'combat' | 'objective' | 'refresh',
): { ok: boolean; reason?: string } {
  const arr =
    reportType === 'mission' ? G.missionReports
    : reportType === 'combat' ? G.combatReports
    : reportType === 'objective' ? G.objectiveReports
    : G.refreshReports;
  if (!arr || arr.length === 0) return { ok: false, reason: `no-${reportType}-report` };
  arr.shift();
  return { ok: true };
}

/** Dismiss all queued info/notImplemented notices. Like acknowledgeReport, this
 *  is an engine mutation so online it can be submitted (clearing them on the
 *  server) — a local `G.pendingNotices = []` on the redacted view is undone by
 *  the next poll, re-showing the notice over and over. */
export function acknowledgeNotices(G: GameState, side?: Side): { ok: boolean; reason?: string } {
  if (!G.pendingNotices || G.pendingNotices.length === 0) return { ok: false, reason: 'no-notices' };
  if (side) {
    // Online: each seat clears only the notices it can see — its own + global
    // (untagged). Leaves the other side's notices for them to dismiss.
    const before = G.pendingNotices.length;
    G.pendingNotices = G.pendingNotices.filter((n) => n.side && n.side !== side);
    return { ok: G.pendingNotices.length < before, reason: 'no-matching-notices' };
  }
  G.pendingNotices = [];
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

  // RAW: players ALTERNATE during Assignment (RR p.4). After this side
  // assigns, control passes to the opponent — unless they've already
  // signalled done, in which case the current side keeps going.
  const opp: Side = side === 'Rebel' ? 'Empire' : 'Rebel';
  const done = assignmentDone(G);
  if (!done.has(opp)) {
    G.currentPlayer = opp;
  }
  // If opponent has already passed but current side still has leaders,
  // current side keeps the turn until they pass too.
  return { ok: true };
}

/** Undo a mission assignment during the Assignment phase (issue #76): return
 *  the mission's leader(s) to the pool and the mission card to hand, so the
 *  player can re-plan. Safe because nothing is revealed until Command — every
 *  Assignment-phase commitment is still just a plan. Does not change whose
 *  turn it is (it's a take-back, not an action). */
export function unassignLeader(G: GameState, side: Side, missionId: string): { ok: boolean; reason?: string } {
  if (G.phase !== 'Assignment') return { ok: false, reason: 'wrong-phase' };
  const f = faction(G, side);
  const idx = f.leadersOnMissions.findIndex((m) => m.missionId === missionId);
  if (idx < 0) return { ok: false, reason: 'not-assigned' };
  const entry = f.leadersOnMissions[idx];
  for (const lid of entry.leaderIds) {
    if (!f.leaderPool.includes(lid)) f.leaderPool.push(lid);
  }
  f.leadersOnMissions.splice(idx, 1);
  // An un-revealed assigned mission returns to the player's hand — including
  // ones fetched from the deck by Our Most Desperate Hour / Proceeding As
  // Planned. Per RR "Pass", an assigned-but-unrevealed mission goes to hand
  // with no special exception for fetched cards (RAW review of #108). This
  // matches the end-of-round Refresh cleanup, which also returns to hand, so
  // both paths now agree.
  if (!f.missionHand.includes(missionId)) f.missionHand.push(missionId);
  log(G, { kind: 'unassign-leader', side, payload: { missionId, leaderIds: entry.leaderIds, fromDeck: !!entry.fromDeck } });
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
  // Don't let the active side pass while ANY mid-resolution state is open.
  // Passing triggers advanceCommandTurn → if both sides have passed, phase
  // advances to Refresh, abandoning the open pendingMission/Choice/Combat
  // and silently losing the mission outcome. The opponent (who owes the
  // choice) needs a chance to resolve first.
  if (G.pendingMission) return { ok: false, reason: 'mission-pending' };
  if (G.pendingChoice) return { ok: false, reason: `choice-pending:${G.pendingChoice.kind}` };
  if (G.pendingCombat) return { ok: false, reason: 'combat-pending' };

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
  // Same rationale as revealMission's mid-resolution guard: don't let the
  // AI initiate a new activation (which can itself trigger combat) while
  // a prior mission/choice/combat is still resolving.
  if (G.pendingMission) return { ok: false, reason: 'mission-pending' };
  if (G.pendingChoice) return { ok: false, reason: `choice-pending:${G.pendingChoice.kind}` };
  if (G.pendingCombat) return { ok: false, reason: 'combat-pending' };

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
    // Greejatus's action card ("Janus does not stop units from moving out of
    // the system this turn") exempts the system he was placed in — without
    // this the flag was set but ignored, so the gained Stormtroopers stayed
    // pinned (player report: Doppeldecker).
    const greejatusExempt = side === 'Empire'
      && G.actionCardFlags?.greejatusFreeMoveSystemId === order.fromSystemId;
    if (youHaveLeaderHere && !greejatusExempt) {
      return { ok: false, reason: `friendly-leader-blocks-source:${order.fromSystemId}` };
    }
    // Adjacency check (rr p.9 — units can pass region borders but not impassable).
    if (order.fromSystemId === 'rebel-base-space') {
      // RAW ("Moving to and from the Rebel base"): while the base is hidden,
      // units may move FROM the Rebel Base space only to the base's own system
      // or a system adjacent to it. (Special missions that ignore adjacency —
      // Hidden Fleet, Lead the Strike Team, Plan the Assault, Rapid Mobilization
      // — move via their own handlers, not activateSystem.) Was skipping this
      // check entirely, so base units could activate to any planet (reporter).
      const baseId = G.rebelBaseSystemId;
      const baseAdj = G.catalog.adjacency[baseId] ?? [];
      if (targetSystemId !== baseId && !baseAdj.includes(targetSystemId)) {
        return { ok: false, reason: `base-not-adjacent-to-target:${targetSystemId}` };
      }
    } else {
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
  // Refuse if there's an unresolved mid-action state. Without this, the AI
  // loop would call revealMission again before the opponent's OpposeMission
  // (or other mid-resolution choice) gets handled, overwriting pendingMission
  // and silently dropping the prior mission's outcome. The human UI blocks
  // this naturally (modal stack); the engine has to enforce it for AI play.
  if (G.pendingMission) return { ok: false, reason: 'mission-already-resolving' };
  if (G.pendingChoice) return { ok: false, reason: `choice-pending:${G.pendingChoice.kind}` };
  if (G.pendingCombat) return { ok: false, reason: 'combat-pending' };

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

  // Pre-opposition Special-card triggers.
  // Blindside (Empire/Boba|Greejatus): if Boba or Greejatus is the resolver
  // AND Empire holds Blindside in hand, offer to discard so Rebel can't
  // send pool opposers.
  if (side === 'Empire' && card.isAttempt
    && G.empire.actionHand.includes('blindside')
    && (assigned.leaderIds.includes('boba-fett') || assigned.leaderIds.includes('janus-greejatus'))) {
    G.pendingChoice = {
      kind: 'BlindsideOffer',
      side: 'Empire',
      missionId, targetSystemId,
    };
    log(G, { kind: 'choice-request', side: 'Empire', payload: {
      kind: 'BlindsideOffer', missionId,
    }});
    return { ok: true };
  }
  // Wookie Guardian (Rebel/Chewie): if Empire reveals a specOps attempt at
  // a system where Chewie is, AND Rebel holds Wookie Guardian, offer to
  // discard to auto-fail.
  if (side === 'Empire' && card.isAttempt && card.skill === 'specOps'
    && G.rebel.actionHand.includes('wookie-guardian')
    && (G.rebel.leadersOnBoard[targetSystemId] ?? []).includes('chewbacca')) {
    G.pendingChoice = {
      kind: 'WookieGuardianOffer',
      side: 'Rebel',
      missionId, targetSystemId,
    };
    log(G, { kind: 'choice-request', side: 'Rebel', payload: {
      kind: 'WookieGuardianOffer', missionId,
    }});
    return { ok: true };
  }
  // Undercover (Rebel/Lando|Obi-Wan): if Empire reveals an attempt mission
  // AND Rebel holds Undercover AND Lando or Obi-Wan is on the board (but
  // not already at the target system), offer to relocate them to the
  // target — they'll then participate in opposition.
  if (side === 'Empire' && card.isAttempt && G.rebel.actionHand.includes('undercover')) {
    const undercoverCandidates: LeaderId[] = [];
    for (const lid of ['lando-calrissian', 'obi-wan-kenobi'] as LeaderId[]) {
      for (const [sysId, list] of Object.entries(G.rebel.leadersOnBoard)) {
        if (list.includes(lid) && sysId !== targetSystemId) {
          undercoverCandidates.push(lid);
          break;
        }
      }
    }
    if (undercoverCandidates.length > 0) {
      G.pendingChoice = {
        kind: 'UndercoverOffer',
        side: 'Rebel',
        missionId, targetSystemId,
        candidates: undercoverCandidates,
      };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: {
        kind: 'UndercoverOffer', missionId, candidates: undercoverCandidates.length,
      }});
      return { ok: true };
    }
  }

  return continueRevealAfterSpecialOffer(G, pending);
}

/** Append a human-readable intervention note to either (a) pm.interventions
 *  if the report hasn't been pushed yet (pre/during opposition), or
 *  (b) the most-recent missionReport if the report is already queued
 *  (post-roll ring triggers like C-3PO / Falcon / Son of Skywalker, or
 *  post-capture It Is Your Destiny). Lets the modal surface "this card
 *  fired and here's what it did" regardless of when in the mission lifecycle
 *  the trigger landed. */
function noteIntervention(G: GameState, pm: MissionResolution | undefined, note: string): void {
  if (pm && pm.stage !== 'effect' && pm.stage !== 'done' && pm.stage !== 'failed') {
    (pm.interventions ??= []).push(note);
    return;
  }
  // Post-report: tack onto the most recent report (which is the one being
  // resolved right now).
  const reports = G.missionReports;
  if (reports && reports.length > 0) {
    const last = reports[reports.length - 1];
    (last.interventions ??= []).push(note);
    return;
  }
  // Fallback — stash on pm so the next report-push picks it up.
  if (pm) (pm.interventions ??= []).push(note);
}

/** Post-blindside / post-wookie-guardian continuation of revealMission.
 *  Extracted so the offer resolvers can re-enter the standard reveal flow. */
function continueRevealAfterSpecialOffer(G: GameState, pending: MissionResolution): { ok: boolean } {
  const card = G.catalog.missions[pending.missionId];
  if (!card) return { ok: false };
  // Attempt missions: pause for the OPPOSING player to choose whether to
  // oppose (and which leader to send from pool).
  if (pending.stage === 'oppose') {
    const oppSide: Side = pending.resolverSide === 'Rebel' ? 'Empire' : 'Rebel';
    const oppFaction = oppSide === 'Rebel' ? G.rebel : G.empire;
    const existing = opposerLeadersAt(G, oppSide, pending.targetSystemId, pending.missionId);
    const pool = pending.blindsideActive ? [] : oppFaction.leaderPool.slice();
    const skill = card.skill as string;
    const countsAll = missionCountsAllSkills(G, pending.missionId);
    const attackerDice = countsAll
      ? totalAllSkills(G, pending.leaderIds as LeaderId[])
      : totalSkill(G, pending.leaderIds as LeaderId[], skill);

    G.pendingChoice = {
      kind: 'OpposeMission',
      missionId: pending.missionId, targetSystemId: pending.targetSystemId, opposerSide: oppSide,
      skill, attackerDice,
      attackerPortrait: portraitBonus(G, pending.missionId, pending.leaderIds as LeaderId[]),
      poolLeaders: pool,
      existingAtTarget: existing,
    };
    log(G, { kind: 'choice-request', side: oppSide, payload: {
      kind: 'OpposeMission', missionId: pending.missionId, attackerDice, existing, poolSize: pool.length,
    }});
    return { ok: true };
  }

  if (maybePostMissionRingTrigger(G, pending)) return { ok: true };
  if (pending.stage === 'effect') {
    // RESOLVE missions (isAttempt:false, e.g. Seek Yoda) skip the opposition
    // step — which is where attempt missions get their report. Without this
    // they resolved silently, so the player got no confirmation the mission
    // succeeded (player report #101: Seek Yoda at Dagobah, Luke → Jedi, with
    // no notification). Push a report so the same outcome modal shows. (Pushed
    // before runMissionEffect so it queues ahead of any sub-choice the effect
    // posts, matching the attempt-mission ordering.)
    if (card && !card.isAttempt) {
      (G.missionReports ??= []).push({
        missionId: pending.missionId,
        resolverSide: pending.resolverSide,
        targetSystemId: pending.targetSystemId,
        attackerLeaders: [...pending.leaderIds] as LeaderId[],
        opposerSide: pending.resolverSide === 'Rebel' ? 'Empire' : 'Rebel',
        opposerLeaders: [],
        skill: card.skill,
        result: 'auto-success',
        interventions: pending.interventions ? [...pending.interventions] : undefined,
      });
    }
    runMissionEffect(G, pending.resolverSide, pending.missionId, pending.targetSystemId, pending.leaderIds as LeaderId[], pending.targetLeaderId);
    if (G.pendingChoice) return { ok: true };
    discardOrReturnMission(G, pending.resolverSide, pending.missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
  } else if (pending.stage === 'failed') {
    discardOrReturnMission(G, pending.resolverSide, pending.missionId);
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
  // If a pendingCombat is sitting at its initial AddLeader step because
  // beginCombat fired while THIS mission's pendingChoice was still set
  // (so the activateSystem-side runCombat call bailed at runCombat's
  // "if (G.pendingChoice) return" early-out), resume it now. Without
  // this, the deferred combat freezes — pendingCombat exists, no
  // pendingChoice, but nothing ever re-invokes runCombat. Reproduced
  // by stuck-combat-live-state.json: Rebel reveals Hit And Run →
  // DestroyUpToHealth pending → Empire activates a different system →
  // beginCombat at ord-mantell → runCombat bails → DestroyUpToHealth
  // resolves here → combat never advances.
  if (G.pendingCombat && !G.pendingChoice && !G.isGameOver) {
    runCombat(G);
  }
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
      interventions: pm.interventions ? [...pm.interventions] : undefined,
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
  if (maybePostMissionRingTrigger(G, pm)) return { ok: true };
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
    interventions: pm.interventions ? [...pm.interventions] : undefined,
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
  // Pick the Rebel-side roll's faces. The Rebel may be the resolver OR the
  // opposer; "own" is whichever side the Yoda holder is on.
  const rebelIsResolver = pm.resolverSide === 'Rebel';
  const rebelFaces = rebelIsResolver ? stash.attFaces : stash.oppFaces;
  const ownSuccesses = rebelIsResolver ? stash.attSuccesses : stash.oppSuccesses;
  const oppFaces = rebelIsResolver ? stash.oppFaces : stash.attFaces;
  const oppSuccesses = rebelIsResolver ? stash.oppSuccesses : stash.attSuccesses;
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
    missionOwnSuccesses: ownSuccesses,
    missionOppFaces: [...oppFaces],
    missionOppSuccesses: oppSuccesses,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'YodaReroll', context: 'mission', blanks: blanks.length,
  }});
  return true;
}

/** Post the mission-context R2-D2 flip choice if eligible. Returns true
 *  if posted. Eligibility: Rebel holds the Resourceful Astromech card AND
 *  an Empire side (attacker or opposer) rolled a non-blank face. */
/** Is the leader bearing `ring` present at the mission's target system?
 *  A leader sent on the mission (pm.leaderIds) is at the target during
 *  resolution; one standing there is in leadersOnBoard[target]. */
function ringHolderAtMissionTarget(G: GameState, pm: MissionResolution, ring: 'r2d2' | 'c3po'): boolean {
  const holder = M.findRingHolder(G, ring);
  if (!holder) return false;
  const onBoard = (G.rebel.leadersOnBoard[pm.targetSystemId] ?? []).includes(holder);
  const onThisMission = pm.leaderIds.includes(holder);
  return onBoard || onThisMission;
}

function maybePostMissionR2D2(G: GameState, pm: MissionResolution): boolean {
  // RAW: requires the R2-D2 ring on a leader in the mission's system.
  if (!ringHolderAtMissionTarget(G, pm, 'r2d2')) return false;
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

/** Post the mission-context One In A Million choice if eligible. Eligibility:
 *  Luke or Wedge is on the Rebel side, the card is in the Rebel's hand, AND
 *  the Rebel-side roll has at least one die to set. */
function maybePostMissionOneInAMillion(G: GameState, pm: MissionResolution): boolean {
  if (!G.rebel.actionHand.includes('one-in-a-million')) return false;
  // Find which side is Rebel.
  const rebelRole: 'attacker' | 'opposer' = pm.resolverSide === 'Rebel' ? 'attacker' : 'opposer';
  // Check Luke or Wedge participation. For the attacker, use pm.leaderIds.
  // For the opposer, look up leaders at the target system + check if pool
  // opposer (sent during OpposeMission) is luke/wedge — those went into pm
  // via... hmm, we don't have an explicit "opposerLeaderIds" on pm.
  // Use a simpler check: Luke or Wedge present in Rebel's leadersOnBoard at
  // the target system. (For attacker, they'd already be there too.)
  const here = G.rebel.leadersOnBoard[pm.targetSystemId] ?? [];
  const lukeOrWedgeHere = here.some((l) => l === 'luke-skywalker' || l === 'luke-skywalker-jedi' || l === 'wedge-antilles');
  const lukeOrWedgeAttacker = rebelRole === 'attacker'
    && (pm.leaderIds as LeaderId[]).some((l) => l === 'luke-skywalker' || l === 'luke-skywalker-jedi' || l === 'wedge-antilles');
  if (!lukeOrWedgeHere && !lukeOrWedgeAttacker) return false;
  const stash = pm.r2d2Pending;
  if (!stash) return false;
  const faces = rebelRole === 'attacker' ? stash.attFaces : stash.oppFaces;
  const colors = rebelRole === 'attacker' ? stash.attColors : stash.oppColors;
  if (faces.length === 0) return false;
  G.pendingChoice = {
    kind: 'OneInAMillionOffer',
    side: 'Rebel',
    context: 'mission',
    rebelRoleInRoll: rebelRole,
    faces: [...faces],
    colors: [...colors],
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'OneInAMillionOffer', context: 'mission', rebelRole, dice: faces.length,
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
  // One In A Million: Rebel may set up to 2 dice faces.
  if (maybePostMissionOneInAMillion(G, pm)) return;
  // All pause points cleared. Finalize the roll.
  const c = { skill: G.catalog.missions[pm.missionId]?.skill ?? '', opposerSide: pm.resolverSide === 'Rebel' ? 'Empire' as Side : 'Rebel' as Side };
  finalizeMissionRoll(
    G, pm, c, c.skill,
    stash.attDice, stash.opposerDice,
    stash.attFaces, stash.oppFaces,
    stash.attSuccesses, stash.oppSuccesses,
    stash.portrait, stash.oppLeaderIds,
  );
  pm.r2d2Pending = undefined;
  if (maybePostMissionRingTrigger(G, pm)) return;
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
    // Discard the R2-D2 ring: remove from bearer, card to discard pile.
    const holder = M.findRingHolder(G, 'r2d2');
    if (holder) M.removeAttachment(G, holder, 'r2d2');
    G.rebel.actionDiscard.push('resourceful-astromech');
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
  // After R2-D2, check One In A Million before finalizing.
  if (maybePostMissionOneInAMillion(G, pm)) return { ok: true };
  const c = { skill: G.catalog.missions[pm.missionId]?.skill ?? '', opposerSide: pm.resolverSide === 'Rebel' ? 'Empire' as Side : 'Rebel' as Side };
  finalizeMissionRoll(
    G, pm, c, c.skill,
    stash.attDice, stash.opposerDice,
    stash.attFaces, stash.oppFaces,
    stash.attSuccesses, stash.oppSuccesses,
    stash.portrait, stash.oppLeaderIds,
  );
  pm.r2d2Pending = undefined;
  if (maybePostMissionRingTrigger(G, pm)) return { ok: true };
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

/** Undo the last Stolen Plans pick — moves the most recently ordered card
 *  back into the remaining pool, so a misclick is recoverable. */
export function undoStolenPlansPick(G: GameState): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'StolenPlansReorder') return { ok: false, reason: 'no-pending-stolen-plans' };
  if (choice.orderedTop.length === 0) return { ok: false, reason: 'nothing-to-undo' };
  const card = choice.orderedTop.pop()!;
  choice.remaining.push(card);
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
  const sourceSystemId = choice.sourceSystemId ?? 'rebel-base-space';
  const cap = validateMoveOrderTransport(G, 'Rebel', {
    fromSystemId: sourceSystemId, unitInstanceIds: shipIds,
  });
  if (!cap.ok) return { ok: false, reason: `plan-the-assault-transport:${cap.reason}` };
  // Move each picked ship from its origin to the target system.
  for (const sid of shipIds) {
    M.moveUnit(G, sid, sourceSystemId, targetSystemId);
  }
  log(G, { kind: 'plan-the-assault-move', side: 'Rebel', payload: {
    targetSystemId, shipsSent: shipIds.length,
  }});
  G.pendingChoice = undefined;

  // Kick off combat at the target if both sides now have units there.
  // Source system for retreat purposes = the ships' origin.
  beginCombat(G, 'Rebel', sourceSystemId, targetSystemId);
  runCombat(G);

  // If combat is paused for a choice, leave it. Otherwise resume mission
  // resolution machinery (mission discard + advance command turn).
  if (G.pendingChoice || G.pendingCombat) return { ok: true };
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Lead The Strike Team: Rebel picks up to 4 ground units in rebel-base-space
 *  to move to the target system (ignoring transport restriction and
 *  adjacency), then combat resolves there. */
export function resolveLeadStrikeTeamUnits(G: GameState, unitIds: string[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'LeadStrikeTeamUnits') {
    return { ok: false, reason: 'no-pending-lead-strike-team' };
  }
  if (unitIds.length > choice.max) return { ok: false, reason: `too-many:${unitIds.length}/${choice.max}` };
  const seen = new Set<string>();
  for (const uid of unitIds) {
    if (!choice.availableUnitIds.includes(uid)) return { ok: false, reason: `illegal-unit:${uid}` };
    if (seen.has(uid)) return { ok: false, reason: `duplicate:${uid}` };
    seen.add(uid);
  }
  const targetSystemId = choice.targetSystemId;
  // After the base is revealed (RR p.11) the units live in the base's system,
  // not the base space — move them from wherever the handler found them.
  const sourceSystemId = choice.sourceSystemId ?? 'rebel-base-space';
  // Ignoring transport restriction and adjacency — just move them.
  for (const uid of unitIds) M.moveUnit(G, uid, sourceSystemId, targetSystemId);
  log(G, { kind: 'lead-strike-team-move', side: 'Rebel', payload: {
    targetSystemId, unitsSent: unitIds.length,
  }});
  G.pendingChoice = undefined;
  // Resolve combat at the target (retreat source = the units' origin).
  beginCombat(G, 'Rebel', sourceSystemId, targetSystemId);
  runCombat(G);
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
  if (option === 'cruiser' && M.unitsAvailableInSupply(G, 'mon-cala-cruiser') <= 0) {
    // RR p.6 component limits: cannot place a cruiser when all 3 are already
    // in play / queued. Refuse so the player must pick the loyalty option.
    return { ok: false, reason: 'no-cruiser-in-supply' };
  }
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

/** Plant False Lead — the Rebel places each taken probe card on the top or
 *  bottom of the probe deck. `placements` must cover exactly the taken cards;
 *  the first-listed "top" card ends up on top of the deck. (#64 follow-up) */
export function resolvePlantFalseLeadPlacement(
  G: GameState,
  placements: { cardId: string; position: 'top' | 'bottom' }[],
): { ok: boolean; reason?: string } {
  const c = G.pendingChoice;
  if (!c || c.kind !== 'PlantFalseLeadPlacement') return { ok: false, reason: 'no-pending' };
  const want = [...c.cards].sort();
  const got = placements.map((p) => p.cardId).sort();
  if (got.length !== want.length || got.some((id, i) => id !== want[i])) {
    return { ok: false, reason: 'placements-must-cover-taken-cards' };
  }
  const top = placements.filter((p) => p.position === 'top').map((p) => p.cardId);
  const bottom = placements.filter((p) => p.position === 'bottom').map((p) => p.cardId);
  if (top.length) G.probeDeck.unshift(...top);     // first listed = top of deck
  if (bottom.length) G.probeDeck.push(...bottom);
  log(G, { kind: 'plant-false-lead', side: 'Rebel', payload: {
    moved: c.cards.length, top: top.length, bottom: bottom.length,
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
  // RAW: Rapid Mobilization ignores adjacency, but it does NOT lift the
  // general "cannot move units out of a system that contains your own leader"
  // restriction (rr p.2). This is the BGG-confirmed edge case: after an RM
  // base-move places a Rebel leader in the old base system, a second RM
  // cannot evacuate that system's units. (Threads 1718633 / 1773892.)
  if (unitInstanceIds.length > 0 && (G.rebel.leadersOnBoard[sourceSystemId] ?? []).length > 0) {
    return { ok: false, reason: `friendly-leader-blocks-source:${sourceSystemId}` };
  }
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
  // Base relocated → reset searched-ruled-out knowledge to systems that still
  // qualify (still subjugated / Imperial-loyal).
  M.resetEmpireSearchedForBaseMove(G);
  log(G, { kind: 'rapid-mobilization-base-established', side: 'Rebel', payload: {
    fromSystemId: old, toSystemId: systemId, baseRevealed: choice.baseRevealed,
  }});
  G.pendingChoice = undefined;
  finishRapidMobilization(G);
  return { ok: true };
}

/** Post-finalize ring triggers. Called after finalizeMissionRoll sets
 *  pm.stage. Returns true if a choice was posted (caller pauses; the choice
 *  resolver will continue the mission flow). C-3PO and Falcon are mutually
 *  exclusive in that the stage gates them: C-3PO only on 'failed' diplomacy,
 *  Falcon only on 'effect' (success). */
function maybePostMissionRingTrigger(G: GameState, pm: MissionResolution): boolean {
  if (pm.resolverSide !== 'Rebel') return false;
  // C-3PO: failed diplomacy.
  if (pm.stage === 'failed') {
    const card = G.catalog.missions[pm.missionId];
    // RAW: requires the C-3PO ring on a leader in the failed mission's system.
    if (card?.skill === 'diplomacy' && ringHolderAtMissionTarget(G, pm, 'c3po')) {
      G.pendingChoice = {
        kind: 'C3POOffer',
        side: 'Rebel',
        missionId: pm.missionId,
        targetSystemId: pm.targetSystemId,
      };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: {
        kind: 'C3POOffer', missionId: pm.missionId, targetSystemId: pm.targetSystemId,
      }});
      return true;
    }
  }
  // Falcon: success at a system with captured leaders, Han or Chewie among
  // the resolvers, and the Falcon card in hand.
  if (pm.stage === 'effect') {
    const hasFalcon = G.rebel.actionHand.includes('the-milleninium-falcon');
    const hanOrChewie = (pm.leaderIds as LeaderId[]).some((l) => l === 'han-solo' || l === 'chewbacca');
    const falconCandidates = (G.empire.capturedLeaders ?? [])
      .filter((c) => c.systemId === pm.targetSystemId)
      .map((c) => c.leaderId);
    if (hasFalcon && hanOrChewie && falconCandidates.length > 0) {
      G.pendingChoice = {
        kind: 'FalconOffer',
        side: 'Rebel',
        missionId: pm.missionId,
        targetSystemId: pm.targetSystemId,
        candidates: falconCandidates,
      };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: {
        kind: 'FalconOffer', missionId: pm.missionId, candidates: falconCandidates.length,
      }});
      return true;
    }
    // Son of Skywalker: Luke present + card in hand + Seek Yoda or Daring Rescue in deck.
    const hasSoS = G.rebel.actionHand.includes('son-of-skywalker');
    const lukePresent = (pm.leaderIds as LeaderId[]).some((l) => l === 'luke-skywalker' || l === 'luke-skywalker-jedi');
    if (hasSoS && lukePresent) {
      const sosCandidates = G.rebel.missionDeck.filter((mid) => mid === 'seek-yoda' || mid === 'daring-rescue');
      if (sosCandidates.length > 0) {
        G.pendingChoice = {
          kind: 'SonOfSkywalkerOffer',
          side: 'Rebel',
          missionId: pm.missionId,
          candidates: sosCandidates,
        };
        log(G, { kind: 'choice-request', side: 'Rebel', payload: {
          kind: 'SonOfSkywalkerOffer', missionId: pm.missionId, candidates: sosCandidates.length,
        }});
        return true;
      }
    }
  }
  return false;
}

/** Shared continuation: after a ring-offer resolves (accepted or skipped),
 *  process pm.stage just like the original call sites do. */
function continueAfterRingTrigger(G: GameState, pm: MissionResolution): void {
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

/** One In A Million (mission context): Rebel sets up to 2 dice faces to
 *  results of choice. `picks` is an array of { index, face } objects;
 *  empty array = skip without discarding. */
export function resolveOneInAMillionMission(
  G: GameState, picks: { index: number; face: string }[]
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'OneInAMillionOffer' || pc.context !== 'mission') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm || !pm.r2d2Pending) return { ok: false, reason: 'no-stash' };
  const stash = pm.r2d2Pending;
  if (picks.length > 2) return { ok: false, reason: 'too-many-picks' };
  const validFaces = new Set(['blank', 'hit', 'direct-hit']);
  if (picks.length > 0) {
    const seen = new Set<number>();
    for (const p of picks) {
      if (seen.has(p.index)) return { ok: false, reason: 'dup-index' };
      seen.add(p.index);
      if (!validFaces.has(p.face)) return { ok: false, reason: `bad-face:${p.face}` };
    }
    const facesArr = pc.rebelRoleInRoll === 'attacker' ? stash.attFaces : stash.oppFaces;
    for (const p of picks) {
      if (p.index < 0 || p.index >= facesArr.length) return { ok: false, reason: `bad-index:${p.index}` };
    }
    // Apply.
    for (const p of picks) facesArr[p.index] = p.face;
    if (pc.rebelRoleInRoll === 'attacker') {
      stash.attSuccesses = successesFromFaces(stash.attFaces);
    } else {
      stash.oppSuccesses = successesFromFaces(stash.oppFaces);
    }
    // Discard the card.
    const i = G.rebel.actionHand.indexOf('one-in-a-million');
    if (i >= 0) {
      G.rebel.actionHand.splice(i, 1);
      G.rebel.actionDiscard.push('one-in-a-million');
    }
    log(G, { kind: 'one-in-a-million-applied', side: 'Rebel', payload: {
      context: 'mission', rebelRole: pc.rebelRoleInRoll, picks,
      explanation: `One In A Million — set ${picks.length} dice to chosen faces.`,
    }});
    noteIntervention(G, pm,
      `Rebel played One In A Million: reset ${picks.length} of the ${pc.rebelRoleInRoll === 'attacker' ? 'attacker' : 'opposer'}'s dice to chosen faces.`,
    );
  } else {
    log(G, { kind: 'one-in-a-million-skipped', side: 'Rebel', payload: { context: 'mission' } });
  }
  G.pendingChoice = undefined;
  // Finalize the roll.
  const c = { skill: G.catalog.missions[pm.missionId]?.skill ?? '', opposerSide: pm.resolverSide === 'Rebel' ? 'Empire' as Side : 'Rebel' as Side };
  finalizeMissionRoll(
    G, pm, c, c.skill,
    stash.attDice, stash.opposerDice,
    stash.attFaces, stash.oppFaces,
    stash.attSuccesses, stash.oppSuccesses,
    stash.portrait, stash.oppLeaderIds,
  );
  pm.r2d2Pending = undefined;
  if (maybePostMissionRingTrigger(G, pm)) return { ok: true };
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

/** Noble Sacrifice: Rebel chooses to eliminate captured Obi-Wan for +1 rep,
 *  or accept the capture. */
export function resolveNobleSacrificeOffer(G: GameState, accept: boolean): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'NobleSacrificeOffer') return { ok: false, reason: 'no-pending' };
  const e = G.empire;
  const handIdx = G.rebel.actionHand.indexOf('noble-sacrifice');
  const ci = e.capturedLeaders?.findIndex((c) => c.leaderId === 'obi-wan-kenobi') ?? -1;
  // If accepting is no longer possible (card already gone, or Obi-Wan is no
  // longer captured — e.g. auto-rescued before this resolved), treat it as a
  // skip rather than failing: returning !ok here would strand the pending
  // choice forever (deadlock). The offer just lapses.
  if (accept && handIdx >= 0 && ci >= 0) {
    e.capturedLeaders!.splice(ci, 1); // ci >= 0 implies the array exists
    // Add to Rebel eliminated leaders.
    if (!G.rebel.eliminatedLeaders.includes('obi-wan-kenobi')) {
      G.rebel.eliminatedLeaders.push('obi-wan-kenobi');
    }
    // Discard the card.
    G.rebel.actionHand.splice(handIdx, 1);
    G.rebel.actionDiscard.push('noble-sacrifice');
    // +1 Rebel reputation.
    M.gainReputation(G, 1);
    log(G, { kind: 'noble-sacrifice-applied', side: 'Rebel', payload: {
      explanation: 'Noble Sacrifice — Obi-Wan eliminated for +1 reputation.',
    }});
    noteIntervention(G, G.pendingMission,
      'Rebel played Noble Sacrifice: Obi-Wan eliminated rather than captured (+1 Rebel reputation).',
    );
  } else {
    log(G, { kind: 'noble-sacrifice-skipped', side: 'Rebel', payload: {} });
  }
  G.pendingChoice = undefined;
  // captureLeader DEFERRED the automatic "no Imperial units → rescued" check
  // while this use-window was open. Now that it's resolved, run it for every
  // system still holding a captured leader. On accept Obi-Wan is already
  // eliminated; on decline he (and any others) auto-rescue if unguarded. In
  // normal play this is a no-op — captures always leave an Imperial unit
  // present — but it keeps the deferred rescue correct.
  for (const sysId of new Set((G.empire.capturedLeaders ?? []).map((c) => c.systemId))) {
    M.maybeAutoRescue(G, sysId);
  }
  // captureLeader posted this choice mid-resolution and the original
  // call-chain has already unwound (mission resolver bailed on pendingChoice).
  // If we're still mid-mission, resume the mission flow so it doesn't strand.
  if (G.pendingMission) {
    resumeMissionAfterChoice(G);
  }
  return { ok: true };
}

/** It Is Your Destiny: Empire picks one rescuing leader to capture, or skip. */
export function resolveItIsYourDestinyOffer(G: GameState, leaderId: LeaderId | null): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'ItIsYourDestinyOffer') return { ok: false, reason: 'no-pending' };
  if (leaderId !== null) {
    if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
    const i = G.empire.actionHand.indexOf('it-is-your-destiny');
    if (i < 0) return { ok: false, reason: 'card-not-in-hand' };
    G.empire.actionHand.splice(i, 1);
    G.empire.actionDiscard.push('it-is-your-destiny');
    G.pendingChoice = undefined;
    M.captureLeader(G, leaderId, 'captured');
    log(G, { kind: 'it-is-your-destiny-applied', side: 'Empire', payload: {
      capturedLeader: leaderId,
      explanation: 'Vader captures a rescuer.',
    }});
    noteIntervention(G, G.pendingMission,
      `Empire played It Is Your Destiny: Vader captured ${G.catalog.leaders[leaderId]?.name ?? leaderId} during the rescue attempt.`,
    );
  } else {
    log(G, { kind: 'it-is-your-destiny-skipped', side: 'Empire', payload: {} });
    G.pendingChoice = undefined;
  }
  // This offer is posted mid-mission (during a rescue effect). Resume the
  // mission flow so it doesn't strand — unless capturing the rescuer posted a
  // follow-on choice (e.g. Noble Sacrifice), in which case that resolver
  // resumes once it's answered. Without this, pendingMission was left orphaned
  // with no pendingChoice → both AIs idle → deadlock.
  if (G.pendingMission && !G.pendingChoice) {
    resumeMissionAfterChoice(G);
  }
  return { ok: true };
}

/** Undercover: Rebel picks Lando or Obi-Wan to relocate to the target system,
 *  or skip. Then continues the reveal flow. */
export function resolveUndercoverOffer(G: GameState, leaderId: LeaderId | null): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'UndercoverOffer') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm) return { ok: false, reason: 'no-mission' };
  if (leaderId !== null) {
    if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
    const i = G.rebel.actionHand.indexOf('undercover');
    if (i < 0) return { ok: false, reason: 'card-not-in-hand' };
    G.rebel.actionHand.splice(i, 1);
    G.rebel.actionDiscard.push('undercover');
    // Remove leader from current system, place at target.
    for (const list of Object.values(G.rebel.leadersOnBoard)) {
      const j = list.indexOf(leaderId);
      if (j >= 0) list.splice(j, 1);
    }
    if (!G.rebel.leadersOnBoard[pc.targetSystemId]) G.rebel.leadersOnBoard[pc.targetSystemId] = [];
    G.rebel.leadersOnBoard[pc.targetSystemId].push(leaderId);
    log(G, { kind: 'undercover-applied', side: 'Rebel', payload: {
      leaderId, targetSystemId: pc.targetSystemId,
    }});
    noteIntervention(G, pm,
      `Rebel played Undercover: ${G.catalog.leaders[leaderId]?.name ?? leaderId} relocated to ${G.catalog.systems[pc.targetSystemId]?.name ?? pc.targetSystemId} to oppose.`,
    );
  } else {
    log(G, { kind: 'undercover-skipped', side: 'Rebel', payload: {} });
  }
  G.pendingChoice = undefined;
  continueRevealAfterSpecialOffer(G, pm);
  return { ok: true };
}

/** Son of Skywalker: Rebel chooses one of Seek Yoda or Daring Rescue from
 *  the deck (or skip). The chosen mission moves into hand; card discards. */
export function resolveSonOfSkywalkerOffer(G: GameState, missionIdOrNull: string | null): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'SonOfSkywalkerOffer') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm) return { ok: false, reason: 'no-mission' };
  if (missionIdOrNull !== null) {
    if (!pc.candidates.includes(missionIdOrNull)) return { ok: false, reason: 'bad-mission' };
    const i = G.rebel.actionHand.indexOf('son-of-skywalker');
    if (i < 0) return { ok: false, reason: 'card-not-in-hand' };
    G.rebel.actionHand.splice(i, 1);
    G.rebel.actionDiscard.push('son-of-skywalker');
    const j = G.rebel.missionDeck.indexOf(missionIdOrNull);
    if (j >= 0) G.rebel.missionDeck.splice(j, 1);
    G.rebel.missionHand.push(missionIdOrNull);
    log(G, { kind: 'son-of-skywalker-applied', side: 'Rebel', payload: {
      pulledMissionId: missionIdOrNull,
    }});
    noteIntervention(G, pm,
      `Rebel played Son of Skywalker: pulled "${G.catalog.missions[missionIdOrNull]?.name ?? missionIdOrNull}" from the mission deck into hand.`,
    );
  } else {
    log(G, { kind: 'son-of-skywalker-skipped', side: 'Rebel', payload: {} });
  }
  G.pendingChoice = undefined;
  continueAfterRingTrigger(G, pm);
  return { ok: true };
}

/** Blindside: Empire chooses to discard the card (suppressing pool oppose)
 *  or skip. Continues into the standard reveal flow. */
export function resolveBlindsideOffer(G: GameState, accept: boolean): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'BlindsideOffer') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm) return { ok: false, reason: 'no-mission' };
  if (accept) {
    const i = G.empire.actionHand.indexOf('blindside');
    if (i < 0) return { ok: false, reason: 'card-not-in-hand' };
    G.empire.actionHand.splice(i, 1);
    G.empire.actionDiscard.push('blindside');
    pm.blindsideActive = true;
    log(G, { kind: 'blindside-applied', side: 'Empire', payload: { missionId: pm.missionId } });
    noteIntervention(G, pm,
      'Empire played Blindside: Rebel cannot send leaders from pool to oppose.',
    );
  } else {
    log(G, { kind: 'blindside-skipped', side: 'Empire', payload: { missionId: pm.missionId } });
  }
  G.pendingChoice = undefined;
  continueRevealAfterSpecialOffer(G, pm);
  return { ok: true };
}

/** Wookie Guardian: Rebel chooses to discard the card (auto-failing the
 *  Empire specOps mission) or skip. */
export function resolveWookieGuardianOffer(G: GameState, accept: boolean): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'WookieGuardianOffer') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm) return { ok: false, reason: 'no-mission' };
  if (accept) {
    const i = G.rebel.actionHand.indexOf('wookie-guardian');
    if (i < 0) return { ok: false, reason: 'card-not-in-hand' };
    G.rebel.actionHand.splice(i, 1);
    G.rebel.actionDiscard.push('wookie-guardian');
    pm.stage = 'failed';
    log(G, { kind: 'wookie-guardian-applied', side: 'Rebel', payload: {
      missionId: pm.missionId, explanation: 'Chewbacca auto-stops the Empire special-ops mission.',
    }});
    noteIntervention(G, pm,
      'Rebel played Wookie Guardian: Chewbacca auto-stops this Empire special-ops mission.',
    );
    // Push a fail-report so the player sees a modal explaining why the
    // mission was auto-stopped (instead of the mission silently vanishing).
    (G.missionReports ??= []).push({
      missionId: pm.missionId,
      resolverSide: pm.resolverSide,
      targetSystemId: pm.targetSystemId,
      attackerLeaders: [...pm.leaderIds] as LeaderId[],
      opposerSide: pm.resolverSide === 'Rebel' ? 'Empire' : 'Rebel',
      opposerLeaders: [],
      skill: G.catalog.missions[pm.missionId]?.skill ?? '',
      result: 'failure',
      interventions: [...(pm.interventions ?? [])],
    });
    G.pendingChoice = undefined;
    // Continue to the standard 'failed' path directly.
    discardOrReturnMission(G, pm.resolverSide, pm.missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
    return { ok: true };
  }
  log(G, { kind: 'wookie-guardian-skipped', side: 'Rebel', payload: { missionId: pm.missionId } });
  G.pendingChoice = undefined;
  continueRevealAfterSpecialOffer(G, pm);
  return { ok: true };
}

/** C-3PO: Rebel chooses whether to discard the C-3PO ring to convert a
 *  failed diplomacy mission to a success. */
export function resolveC3POOffer(G: GameState, accept: boolean): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'C3POOffer') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm) return { ok: false, reason: 'no-mission' };
  if (accept) {
    // Discard the C-3PO ring: remove from bearer, card to discard pile.
    const holder = M.findRingHolder(G, 'c3po');
    if (!holder) return { ok: false, reason: 'ring-not-attached' };
    M.removeAttachment(G, holder, 'c3po');
    G.rebel.actionDiscard.push('human-cyborg-relations');
    pm.stage = 'effect';
    log(G, { kind: 'c3po-applied', side: 'Rebel', payload: {
      missionId: pm.missionId, targetSystemId: pm.targetSystemId,
      explanation: 'C-3PO ring discarded — diplomacy failure converted to success.',
    }});
    noteIntervention(G, pm,
      'Rebel played C-3PO (Human-Cyborg Relations): diplomacy failure converted to success.',
    );
  } else {
    log(G, { kind: 'c3po-skipped', side: 'Rebel', payload: { missionId: pm.missionId } });
  }
  G.pendingChoice = undefined;
  continueAfterRingTrigger(G, pm);
  return { ok: true };
}

/** Millennium Falcon: Rebel chooses to discard the Falcon ring and rescue
 *  one captured leader at the target system (or skip). */
export function resolveFalconOffer(G: GameState, leaderId: LeaderId | null): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'FalconOffer') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm) return { ok: false, reason: 'no-mission' };
  if (leaderId !== null) {
    if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
    const i = G.rebel.actionHand.indexOf('the-milleninium-falcon');
    if (i < 0) return { ok: false, reason: 'card-not-in-hand' };
    G.rebel.actionHand.splice(i, 1);
    G.rebel.actionDiscard.push('the-milleninium-falcon');
    M.rescueLeader(G, leaderId, 'millennium-falcon');
    log(G, { kind: 'falcon-applied', side: 'Rebel', payload: {
      missionId: pm.missionId, targetSystemId: pm.targetSystemId, leaderId,
      explanation: `Millennium Falcon ring discarded — rescued ${leaderId} from ${pm.targetSystemId}.`,
    }});
    noteIntervention(G, pm,
      `Rebel played Millennium Falcon: rescued ${G.catalog.leaders[leaderId]?.name ?? leaderId} from ${G.catalog.systems[pm.targetSystemId]?.name ?? pm.targetSystemId}.`,
    );
  } else {
    log(G, { kind: 'falcon-skipped', side: 'Rebel', payload: { missionId: pm.missionId } });
  }
  G.pendingChoice = undefined;
  continueAfterRingTrigger(G, pm);
  return { ok: true };
}

/** Brilliant Administrator: Empire picks the unit type per resource icon
 *  at Tarkin's system and queues each pick. Mirror of Temporary Alliance for
 *  Empire units. */
export function resolveBrilliantAdministratorBuildPick(
  G: GameState, typeIds: (string | null)[]
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'BrilliantAdministratorBuildPick') return { ok: false, reason: 'no-pending' };
  if (typeIds.length !== choice.icons.length) return { ok: false, reason: 'length-mismatch' };
  const sysDef = G.catalog.systems[choice.systemId];
  if (!sysDef || !sysDef.buildSlot) return { ok: false, reason: 'no-build-slot' };
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  for (let i = 0; i < typeIds.length; i++) {
    const tid = typeIds[i];
    if (tid === null) continue;
    const icon = choice.icons[i];
    const t = G.catalog.unitTypes[tid];
    if (!t || t.side !== 'Empire') return { ok: false, reason: `bad-type:${tid}` };
    if (PROJECT_ONLY_UNIT_IDS.has(tid)) return { ok: false, reason: `project-only:${tid}` };
    if (t.theater !== icon.theater) return { ok: false, reason: `theater-mismatch:${tid}` };
    const need = tierRank[icon.shape] ?? 2;
    const have = tierRank[t.tier ?? 'square'] ?? 2;
    if (have > need) return { ok: false, reason: `tier-too-high:${tid}` };
  }
  let added = 0;
  for (let i = 0; i < typeIds.length; i++) {
    const tid = typeIds[i];
    if (!tid) continue;
    M.buildToQueue(G, 'Empire', tid, sysDef.buildSlot, choice.systemId);
    added++;
  }
  log(G, { kind: 'brilliant-administrator-built', side: 'Empire', payload: {
    systemId: choice.systemId, added, picks: typeIds,
  }});
  G.pendingChoice = undefined;
  return { ok: true };
}

/** Catch Them By Surprise: Empire moves units from a chosen source to
 *  Ozzel's system. Transport-validated; source must be adjacent. */
export function resolveCatchThemBySurpriseMovePick(
  G: GameState, sourceSystemId: SystemId, unitInstanceIds: string[]
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'CatchThemBySurpriseMovePick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidateSourceSystemIds.includes(sourceSystemId)) return { ok: false, reason: 'bad-source' };
  if (unitInstanceIds.length > 0) {
    const v = validateMoveOrderTransport(G, 'Empire', {
      fromSystemId: sourceSystemId, unitInstanceIds,
    });
    if (!v.ok) return { ok: false, reason: v.reason };
  }
  const targetSystemId = choice.targetSystemId;
  for (const uid of unitInstanceIds) M.moveUnit(G, uid, sourceSystemId, targetSystemId);
  log(G, { kind: 'catch-them-by-surprise-move', side: 'Empire', payload: {
    fromSystemId: sourceSystemId, toSystemId: targetSystemId,
    moved: unitInstanceIds.length, movedIds: unitInstanceIds,
  }});
  G.pendingChoice = undefined;
  // Moving a fleet into an enemy-occupied system initiates combat (RAW general
  // movement rule — the card's whole point is the surprise attack). beginCombat
  // self-guards on both sides being present, so this is a no-op if no Rebels are
  // at the destination. Previously this resolver moved the fleet but never
  // offered battle (player report — Brad Miller / BGG).
  beginCombat(G, 'Empire', sourceSystemId, targetSystemId);
  if (G.pendingCombat) runCombat(G);
  return { ok: true };
}

/** Scouting Mission: Empire relocates up to 4 TIE Fighters from any systems
 *  to the target system, ignoring transport+adjacency. Triggers combat if
 *  Rebel ships are present at the destination. */
export function resolveScoutingMissionTIEPick(
  G: GameState, unitInstanceIds: string[]
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'ScoutingMissionTIEPick') return { ok: false, reason: 'no-pending' };
  if (unitInstanceIds.length > choice.maxPicks) return { ok: false, reason: 'too-many-picks' };
  for (const uid of unitInstanceIds) {
    if (!choice.candidateUnitIds.includes(uid)) return { ok: false, reason: `not-a-candidate:${uid}` };
  }
  // Locate each TIE's source system and move it.
  for (const uid of unitInstanceIds) {
    let fromSysId: SystemId | null = null;
    for (const sid of Object.keys(G.map.systems)) {
      if (G.map.systems[sid].units.some((u) => u.instanceId === uid)) { fromSysId = sid; break; }
    }
    if (!fromSysId) continue;
    M.moveUnit(G, uid, fromSysId, choice.targetSystemId);
  }
  log(G, { kind: 'scouting-mission-relocate', side: 'Empire', payload: {
    targetSystemId: choice.targetSystemId, moved: unitInstanceIds.length, movedIds: unitInstanceIds,
  }});
  G.pendingChoice = undefined;
  // If Rebel ships present, trigger combat.
  const ss = G.map.systems[choice.targetSystemId];
  if (ss && ss.units.some((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'space')) {
    beginCombat(G, 'Empire', choice.targetSystemId, choice.targetSystemId);
    runCombat(G);
  }
  return { ok: true };
}

/** Our Most Desperate Hour: Rebel picks a mission from the deck, pulls it
 *  into hand, and assigns Leia to it. */
export function resolveOurMostDesperateHourPick(
  G: GameState, missionId: string
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'OurMostDesperateHourPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(missionId)) return { ok: false, reason: 'bad-mission' };
  const f = G.rebel;
  const deckIdx = f.missionDeck.indexOf(missionId);
  if (deckIdx < 0) return { ok: false, reason: 'mission-not-in-deck-anymore' };
  f.missionDeck.splice(deckIdx, 1);
  // Pull Leia out of any prior assignment, then attach to this mission.
  for (const list of Object.values(f.leadersOnBoard)) {
    const i = list.indexOf('princess-leia');
    if (i >= 0) list.splice(i, 1);
  }
  const poolIdx = f.leaderPool.indexOf('princess-leia');
  if (poolIdx >= 0) f.leaderPool.splice(poolIdx, 1);
  // Remove Leia from any existing mission assignment.
  for (const am of f.leadersOnMissions) {
    am.leaderIds = am.leaderIds.filter((l) => l !== 'princess-leia');
  }
  f.leadersOnMissions = f.leadersOnMissions.filter((m) => m.leaderIds.length > 0);
  // The card is pulled straight from the deck into the ASSIGNED area with Leia
  // on it — exactly like a normally-assigned mission (which lives only in
  // leadersOnMissions, not in hand). Do NOT also add it to the hand, or it
  // shows up twice and can be "taken back" from hand (player report #89).
  f.leadersOnMissions.push({ missionId, leaderIds: ['princess-leia'], fromDeck: true });
  log(G, { kind: 'our-most-desperate-hour-applied', side: 'Rebel', payload: {
    missionId, leaderId: 'princess-leia',
  }});
  G.pendingChoice = undefined;
  return { ok: true };
}

/** Proceeding As Planned: Empire picks a project from the deck, pulls into
 *  hand, and assigns the resolver leader to it. */
export function resolveProceedingAsPlannedPick(
  G: GameState, missionId: string
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'ProceedingAsPlannedPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(missionId)) return { ok: false, reason: 'bad-mission' };
  const f = G.empire;
  // Projects are pulled from the PROJECT deck, not the mission deck (#104).
  const deckIdx = f.projectDeck?.indexOf(missionId) ?? -1;
  if (deckIdx < 0) return { ok: false, reason: 'project-not-in-deck-anymore' };
  f.projectDeck!.splice(deckIdx, 1);
  const leaderId = choice.leaderId;
  // Make sure the resolver isn't already on a mission.
  for (const am of f.leadersOnMissions) {
    am.leaderIds = am.leaderIds.filter((l) => l !== leaderId);
  }
  f.leadersOnMissions = f.leadersOnMissions.filter((m) => m.leaderIds.length > 0);
  const poolIdx = f.leaderPool.indexOf(leaderId);
  if (poolIdx >= 0) f.leaderPool.splice(poolIdx, 1);
  // Assigned only (like a normal assignment) — not also added to hand, which
  // would duplicate it and let it be taken back (cf. #89 for the Rebel twin).
  // fromDeck so un-assigning returns it to the project deck, not hand (#108).
  f.leadersOnMissions.push({ missionId, leaderIds: [leaderId], fromDeck: true });
  log(G, { kind: 'proceeding-as-planned-applied', side: 'Empire', payload: {
    missionId, leaderId,
  }});
  G.pendingChoice = undefined;
  return { ok: true };
}

/** Start The Evacuation: Rebel moves picked units from the Rebel Base space
 *  to a non-Imperial system (transport-validated). */
export function resolveStartEvacuationPick(
  G: GameState, targetSystemId: SystemId, unitInstanceIds: string[]
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'StartEvacuationPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidateSystemIds.includes(targetSystemId)) return { ok: false, reason: 'bad-system' };
  for (const uid of unitInstanceIds) {
    if (!choice.candidateUnitIds.includes(uid)) return { ok: false, reason: `not-a-candidate:${uid}` };
  }
  if (unitInstanceIds.length > 0) {
    const v = validateMoveOrderTransport(G, 'Rebel', {
      fromSystemId: 'rebel-base-space', unitInstanceIds,
    });
    if (!v.ok) return { ok: false, reason: v.reason };
  }
  for (const uid of unitInstanceIds) M.moveUnit(G, uid, 'rebel-base-space', targetSystemId);
  log(G, { kind: 'start-evacuation-applied', side: 'Rebel', payload: {
    targetSystemId, moved: unitInstanceIds.length, movedIds: unitInstanceIds,
  }});
  G.pendingChoice = undefined;
  return { ok: true };
}

/** Independent Operation: Empire picks an Imperial-occupied destination to
 *  evacuate the displaced ground units to. */
export function resolveIndependentOperationEvacPick(
  G: GameState, destinationSystemId: SystemId
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'IndependentOperationEvacPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidateSystemIds.includes(destinationSystemId)) return { ok: false, reason: 'bad-destination' };
  for (const uid of choice.groundUnitIds) {
    M.moveUnit(G, uid, choice.fromSystemId, destinationSystemId);
  }
  log(G, { kind: 'independent-operation-evac', side: 'Empire', payload: {
    fromSystemId: choice.fromSystemId, toSystemId: destinationSystemId,
    moved: choice.groundUnitIds.length,
  }});
  G.pendingChoice = undefined;
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

/** Generic build-from-resource-icons resolver. The player picked a unit type
 *  per icon (or null to skip). Validates type/theater/tier per icon, queues the
 *  builds, then resumes the mission/project flow. Replaces the old auto-pick
 *  (defaultUnitForIcon) used by Construct Factory / Address Delays / Establish
 *  Trade Relations. */
export function resolveBuildFromIconsPick(
  G: GameState, typeIds: (string | null)[]
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'BuildFromIconsPick') return { ok: false, reason: 'no-pending' };
  if (typeIds.length !== choice.icons.length) return { ok: false, reason: 'length-mismatch' };
  const sysDef = G.catalog.systems[choice.systemId];
  if (!sysDef || !sysDef.buildSlot) return { ok: false, reason: 'no-build-slot' };
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  for (let i = 0; i < typeIds.length; i++) {
    const tid = typeIds[i];
    if (tid === null) continue;
    const icon = choice.icons[i];
    const t = G.catalog.unitTypes[tid];
    if (!t || t.side !== choice.side) return { ok: false, reason: `bad-type:${tid}` };
    if (PROJECT_ONLY_UNIT_IDS.has(tid)) return { ok: false, reason: `project-only:${tid}` };
    if (t.theater !== icon.theater) return { ok: false, reason: `theater-mismatch:${tid}` };
    if (t.class === 'structure') return { ok: false, reason: `structure:${tid}` };
    const need = tierRank[icon.shape] ?? 2;
    const have = tierRank[t.tier ?? 'square'] ?? 2;
    if (have > need) return { ok: false, reason: `tier-too-high:${tid}` };
  }
  let added = 0;
  for (let i = 0; i < typeIds.length; i++) {
    const tid = typeIds[i];
    if (!tid) continue;
    M.buildToQueue(G, choice.side, tid, sysDef.buildSlot, choice.systemId);
    added++;
  }
  log(G, { kind: 'build-from-icons', side: choice.side, payload: {
    systemId: choice.systemId, label: choice.label, added, picks: typeIds,
  }});
  G.pendingChoice = undefined;
  // These effects resolve inside a mission/project (runMissionEffect), so
  // resume the mission flow (discard + advance command turn). Action-card
  // build effects use the separate Temporary Alliance flow.
  if (G.pendingMission) resumeMissionAfterChoice(G);
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
  // Surface the result to the Empire AND rule out every OTHER system — the
  // base is one of these three, so everything else is eliminated (shown as
  // yellow searched-X). Mirrors Long Range Probe's behaviour.
  const named = new Set(shuffled);
  if (!G.empireSearchedRuledOut) G.empireSearchedRuledOut = [];
  for (const sid of Object.keys(G.map.systems)) {
    if (sid === 'rebel-base-space' || named.has(sid)) continue;
    if (!G.empireSearchedRuledOut.includes(sid)) G.empireSearchedRuledOut.push(sid);
  }
  const names = shuffled.map((sid) => G.catalog.systems[sid]?.name ?? sid).join(', ');
  pushNotice(G, `interrogation-droid-t${G.timeMarker}`, 'Interrogation Droid',
    `The Rebel base is one of these three systems: ${names}. Every other system has been ruled out on the map.`);
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
  // play one objective at start of Refresh phase, just before step 1). If 2+
  // objectives are eligible the Rebel chooses which to score (only one per
  // refresh), so this may PAUSE and resume via resolvePlayObjectivePick().
  if (refreshPlayStartOfRefreshObjectives(G, logStart)) return;
  if (G.isGameOver) return;

  continueRefreshAfterObjectives(G, logStart);
}

/** Steps 1–6 of the Refresh phase, after the start-of-refresh objective step.
 *  Split out so it can resume after the objective choice paused. */
function continueRefreshAfterObjectives(G: GameState, logStart: number): void {
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

/** Play one StartOfRefresh objective: remove from hand, return-to-deck or box
 *  per the card, log it, record the report entry, and gain the reputation. */
function playRefreshObjective(G: GameState, objectiveId: string, rep: number): void {
  const hand = G.rebel.objectiveHand ?? [];
  const handIdx = hand.indexOf(objectiveId);
  if (handIdx < 0) return;
  hand.splice(handIdx, 1);
  if (objectiveReturnsToHand(G, objectiveId)) {
    // Card explicitly returns to hand (Heart of the Empire) — re-scorable
    // next turn while Coruscant stays Rebel-held. Put it straight back.
    hand.push(objectiveId);
  } else if (objectiveReturnsToDeck(G, objectiveId)) {
    if (!G.rebel.objectiveDeck) G.rebel.objectiveDeck = [];
    G.rebel.objectiveDeck.push(objectiveId);
  }
  // Otherwise the card is returned to the game box (just removed from play).
  log(G, { kind: 'play-objective', side: 'Rebel', payload: {
    objectiveId, reputation: rep,
  }});
  (G.objectiveReports ??= []).push({ objectiveId, reputation: rep, via: 'refresh' });
  M.gainReputation(G, rep);
}

/** Resolve the player's start-of-refresh objective choice and resume the
 *  refresh phase. `objectiveId` must be one of the posted candidates. */
export function resolvePlayObjectivePick(
  G: GameState, objectiveId: string
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'PlayObjective' || pc.window !== 'refresh') {
    return { ok: false, reason: 'no-pending' };
  }
  if (!pc.legal.includes(objectiveId)) return { ok: false, reason: 'illegal' };
  const logStart = pc.logStart ?? G.turnLog.length;
  G.pendingChoice = undefined;
  playRefreshObjective(G, objectiveId, objectiveReputationGain(G, objectiveId));
  if (G.isGameOver) return { ok: true };
  continueRefreshAfterObjectives(G, logStart);
  return { ok: true };
}

/** RR p.10: "Only one objective can be played during each Refresh Phase."
 *  Collect every eligible StartOfRefresh objective the Rebel holds whose
 *  condition is met. If exactly one, play it; if 2+, post a PlayObjective
 *  choice (returns true = paused) so the player picks which to score. */
function refreshPlayStartOfRefreshObjectives(G: GameState, logStart: number): boolean {
  const hand = G.rebel.objectiveHand;
  if (!hand || hand.length === 0) return false;
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
  if (eligible.length === 0) return false;
  // RR p.10: only one objective per refresh. With a single eligible card
  // there's no decision to make — play it. With 2+, let the player choose
  // which one to score (the rest stay in hand for a future refresh).
  if (eligible.length === 1) {
    playRefreshObjective(G, eligible[0].id, eligible[0].rep);
    return false;
  }
  postPlayObjectiveChoice(G, eligible.map((e) => e.id), 'refresh', logStart);
  return true;
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
  // Time-track icons, confirmed against the printed 16-space board:
  //   Recruit icons: turns 2, 3, 4, 5            (RECRUIT_TIME_MARKERS)
  //   Build icons:   turns 2, 4, 6, 8, 10, 12, 14 (BUILD_TIME_MARKERS)
  //   Turn 16 is the final space (no recruit/build icon). The game can end
  //   earlier — Rebel wins when reputation meets the time marker; Empire
  //   wins by capturing the base.
  // Recruit fires on time-track turns 2-5 (confirmed against the printed
  // 16-space board). Was wrongly {2,4,6}, so turn 3 never recruited even
  // though the turn tracker promised it (issues #48/#59). The UI imports
  // RECRUIT_TIME_MARKERS too, so the tracker and engine can't drift apart.
  if (!RECRUIT_TIME_MARKERS.has(G.timeMarker)) return false;

  // Draw 2 per side and collect pending picks. Edge cases (deck < 2):
  // 0 cards → skip side. 1 card → no choice, auto-keep that card.
  const pending: { side: Side; drawnIds: string[] }[] = [];
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

/** A leader can be recruited only if they aren't already in play anywhere.
 *  A leader is "in play" (already recruited, can't be recruited again) if
 *  they're in the pool, on the board, out on a mission, captured (Rebel
 *  leaders held by the Empire are still recruited — just captured), or
 *  eliminated. Each recruitable leader appears on TWO recruit cards, so the
 *  duplicate card lingers in the deck after recruitment and must be treated
 *  as recruiting no one. */
export function leaderRecruitable(G: GameState, side: Side, lid: string): boolean {
  if (!G.catalog.leaders[lid]) return false;
  const f = faction(G, side);
  if (f.leaderPool.includes(lid as LeaderId)) return false;
  if (f.eliminatedLeaders.includes(lid as LeaderId)) return false;
  for (const arr of Object.values(f.leadersOnBoard)) {
    if (arr.includes(lid as LeaderId)) return false;
  }
  if (f.leadersOnMissions.some((m) => m.leaderIds.includes(lid as LeaderId))) return false;
  // Captured Rebel leaders are held by the Empire but are still "recruited".
  if (side === 'Rebel' && (G.empire.capturedLeaders ?? []).some((c) => c.leaderId === lid)) return false;
  return true;
}

/** Auto-recruit path (used only when a side has a single card to draw, so
 *  there's no card choice). Recruits the first still-recruitable leader on
 *  the card. The rare 1-card edge does not surface a leader chooser even if
 *  the card lists two recruitable leaders; the common 2-card path does, via
 *  recruitLeaderFromCard. */
function applyRecruitedActionCard(G: GameState, side: Side, cardId: string): void {
  const f = faction(G, side);
  const card = G.catalog.actions[cardId];
  const eligible = (card?.leaderRequirement ?? []).filter((lid) => leaderRecruitable(G, side, lid));
  if (eligible.length > 0) {
    f.leaderPool.push(eligible[0]);
    log(G, { kind: 'recruit-leader', side, payload: { leaderId: eligible[0], cardId } });
  } else {
    log(G, { kind: 'recruit-action-only', side, payload: { cardId } });
  }
  f.actionHand.push(cardId);
}

/** Add the kept recruit card to hand and recruit a leader from it. A card may
 *  list more than one leader (e.g. One in a Million → Luke OR Wedge). If 2+
 *  of them are still eligible, POST a RecruitLeaderPick so the player chooses
 *  (returns true = paused). With 0 or 1 eligible, recruit automatically and
 *  return false. (Issue #62: the engine used to auto-take leaderRequirement[0]
 *  and silently drop the other leader.) */
function recruitLeaderFromCard(G: GameState, side: Side, cardId: string): boolean {
  const f = faction(G, side);
  f.actionHand.push(cardId);
  const card = G.catalog.actions[cardId];
  const eligible = (card?.leaderRequirement ?? []).filter((lid) => leaderRecruitable(G, side, lid));
  if (eligible.length === 0) {
    log(G, { kind: 'recruit-action-only', side, payload: { cardId } });
    return false;
  }
  if (eligible.length === 1) {
    f.leaderPool.push(eligible[0]);
    log(G, { kind: 'recruit-leader', side, payload: { leaderId: eligible[0], cardId } });
    return false;
  }
  G.pendingChoice = { kind: 'RecruitLeaderPick', side, cardId, candidates: eligible };
  log(G, { kind: 'choice-request', side, payload: { kind: 'RecruitLeaderPick', cardId, candidates: eligible } });
  return true;
}

/** After a recruit pick is fully resolved (card kept + leader chosen),
 *  advance to the next side's recruit pick, else proceed to the build step /
 *  finish the refresh. Shared by the card-pick and leader-pick resolvers. */
function continueRecruitFlow(G: GameState): { ok: boolean; reason?: string } {
  const r = G.refreshPaused;
  if (r?.pendingRecruitPicks && r.pendingRecruitPicks.length > 0) {
    promoteNextRecruitPick(G);
    return { ok: true };
  }
  const logStart = r?.logStart ?? 0;
  if (r) r.pendingRecruitPicks = undefined;
  if (refreshBuildIfApplicable(G, logStart)) return { ok: true };
  G.refreshPaused = undefined;
  finishRefreshAfterBuild(G, logStart);
  return { ok: true };
}

/** True if NONE of the drawn cards shows a still-recruitable leader. Per RAW,
 *  only then may the player keep drawing deeper. */
function noRecruitableAmongDrawn(G: GameState, side: Side, drawnIds: string[]): boolean {
  for (const cid of drawnIds) {
    const card = G.catalog.actions[cid];
    if ((card?.leaderRequirement ?? []).some((lid) => leaderRecruitable(G, side, lid))) {
      return false;
    }
  }
  return true;
}

function promoteNextRecruitPick(G: GameState): void {
  const r = G.refreshPaused;
  if (!r?.pendingRecruitPicks || r.pendingRecruitPicks.length === 0) return;
  const next = r.pendingRecruitPicks[0];
  const f = faction(G, next.side);
  // RAW: the player may continue drawing one card at a time ONLY while none of
  // the drawn cards shows a recruitable leader (and the deck still has cards).
  const canDrawMore =
    f.actionDeck.length > 0 && noRecruitableAmongDrawn(G, next.side, next.drawnIds);
  G.pendingChoice = {
    kind: 'RecruitActionCardPick',
    side: next.side,
    drawnIds: next.drawnIds,
    canDrawMore,
  };
  log(G, { kind: 'choice-request', side: next.side, payload: {
    kind: 'RecruitActionCardPick', cards: next.drawnIds,
  }});
}

/** RAW draw-deeper: when none of the currently-drawn recruit cards shows a
 *  still-recruitable leader, the player may draw one more card from the top of
 *  the action deck. It joins the drawn set; the player then keeps one of all
 *  drawn cards (the rest go to the bottom). Re-posts the pick. */
export function recruitDrawAnother(G: GameState): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'RecruitActionCardPick') return { ok: false, reason: 'no-pending' };
  const r = G.refreshPaused;
  if (!r?.pendingRecruitPicks || r.pendingRecruitPicks.length === 0) return { ok: false, reason: 'no-refresh-pause' };
  const cur = r.pendingRecruitPicks[0];
  if (cur.side !== choice.side) return { ok: false, reason: 'side-mismatch' };
  const f = faction(G, cur.side);
  // Guard: only legal while no drawn card is recruitable and the deck has cards.
  if (f.actionDeck.length === 0) return { ok: false, reason: 'deck-empty' };
  if (!noRecruitableAmongDrawn(G, cur.side, cur.drawnIds)) return { ok: false, reason: 'recruitable-available' };
  const drawn = f.actionDeck.shift()!;
  cur.drawnIds.push(drawn);
  log(G, { kind: 'recruit-draw-another', side: cur.side, payload: { drawn } });
  G.pendingChoice = undefined;
  promoteNextRecruitPick(G);
  return { ok: true };
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
  if (!cur.drawnIds.includes(keepCardId)) return { ok: false, reason: 'invalid-pick' };
  // The unchosen drawn cards all go to the bottom of the deck, in draw order.
  const bottomed = cur.drawnIds.filter((id) => id !== keepCardId);
  const f = faction(G, cur.side);
  for (const id of bottomed) f.actionDeck.push(id);
  log(G, { kind: 'recruit-pick-resolved', side: cur.side, payload: { kept: keepCardId, bottomed } });
  r.pendingRecruitPicks.shift();
  G.pendingChoice = undefined;
  // Recruit the leader from the kept card. If the card lists 2+ eligible
  // leaders, this posts a RecruitLeaderPick and pauses; the leader-pick
  // resolver then continues the flow. (#62)
  if (recruitLeaderFromCard(G, cur.side, keepCardId)) return { ok: true };
  return continueRecruitFlow(G);
}

/** Resolve the RecruitLeaderPick: the player chose which leader from a
 *  multi-leader recruit card to add to the pool, then the recruit flow
 *  continues. (#62) */
export function resolveRecruitLeaderPick(G: GameState, leaderId: LeaderId): { ok: boolean; reason?: string } {
  const c = G.pendingChoice;
  if (!c || c.kind !== 'RecruitLeaderPick') return { ok: false, reason: 'no-pending' };
  if (!c.candidates.includes(leaderId)) return { ok: false, reason: 'invalid-leader' };
  const f = faction(G, c.side);
  f.leaderPool.push(leaderId);
  log(G, { kind: 'recruit-leader', side: c.side, payload: { leaderId, cardId: c.cardId } });
  G.pendingChoice = undefined;
  return continueRecruitFlow(G);
}

/** Return the legal unit type IDs a side may build for one (type, shape)
 *  resource icon. Base-game scope; expansion units would extend this. */
export function legalUnitsForIcon(
  side: Side, type: 'space' | 'ground', shape: 'triangle' | 'circle' | 'square',
  // Pass G to opt into RoE build options when expansion.roeUnits is on. The
  // RoE roster is additive (not a swap) per the rules p.8 — base units stay
  // buildable, the RoE units add new options on the same build icons.
  // Optional so existing call sites continue to work for base-only games.
  G?: { expansion?: { roeUnits?: boolean } },
): string[] {
  const roe = G?.expansion?.roeUnits === true;
  if (side === 'Rebel') {
    if (type === 'space') {
      // Rebel Transport's build icon is a space TRIANGLE (not circle) per
      // the reference mat — so the space-triangle build offers 3 options
      // (issue #50), and the space-circle build is just the Corvette.
      if (shape === 'triangle') return roe
        ? ['x-wing', 'y-wing', 'rebel-transport', 'u-wing']
        : ['x-wing', 'y-wing', 'rebel-transport'];
      if (shape === 'circle')   return roe
        ? ['corellian-corvette', 'nebulon-b-frigate']
        : ['corellian-corvette'];
      if (shape === 'square')   return ['mon-cala-cruiser'];
    } else {
      if (shape === 'triangle') return roe
        ? ['rebel-trooper', 'rebel-vanguard']
        : ['rebel-trooper'];
      if (shape === 'circle')   return roe
        ? ['airspeeder', 'golan-arms-turret']
        : ['airspeeder'];
      if (shape === 'square')   return []; // no base-game Rebel square ground
    }
  } else {
    if (type === 'space') {
      if (shape === 'triangle') return roe
        ? ['tie-fighter', 'tie-striker']
        : ['tie-fighter'];
      if (shape === 'circle')   return ['assault-carrier'];
      // Interdictor is a normal square space build in RoE (not a project).
      if (shape === 'square')   return roe
        ? ['star-destroyer', 'interdictor']
        : ['star-destroyer']; // SSD is a project, not an icon-build
    } else {
      if (shape === 'triangle') return roe
        ? ['stormtrooper', 'assault-tank']
        : ['stormtrooper'];
      if (shape === 'circle')   return roe
        ? ['at-st', 'shield-bunker']
        : ['at-st'];
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
  available?: Record<string, number>;
};

/** Snapshot holding-pool supply remaining for each legal unit type. Single-
 *  type auto-applies are pushed to the queue immediately, so unitsCommitted
 *  already reflects them; the only thing this snapshot can't foresee is which
 *  type an as-yet-undecided multi-option pick will consume — that within-batch
 *  race is settled by the hard supply check in resolveBuildPicks. */
function availabilityFor(G: GameState, legal: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of legal) out[t] = M.unitsAvailableInSupply(G, t);
  return out;
}

/** Collect all this turn's build entries. Icons with only one legal unit
 *  type auto-apply immediately; icons with multiple legal types are queued
 *  for player choice. Returns true if a BuildPick is now pending (the
 *  refresh phase is paused). */
function refreshBuildIfApplicable(G: GameState, logStart: number): boolean {
  // Build happens on time-track turns 2,4,6,8,10,12,14 (the even turns up
  // to 14) per the printed 16-space board — turn 16 (the final space) has
  // NO build icon. Was "every even turn", which wrongly built on 16 too.
  if (!BUILD_TIME_MARKERS.has(G.timeMarker)) return false;

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

      let icons = sysDef.resources; // resources live on the catalog SystemDef, not SystemState
      if (side === 'Rebel') {
        if (ss.loyalty !== 'rebel' || ss.subjugated) continue;
      } else {
        if (ss.loyalty !== 'imperial' && !ss.subjugated) continue;
        // Subjugated (still has Rebel loyalty underneath) → leftmost icon only.
        if (ss.subjugated && ss.loyalty !== 'imperial') icons = icons.slice(0, 1);
      }

      const slot = (sysDef.buildSlot ?? 1) as 1 | 2 | 3;
      for (const icon of icons) {
        const legal = legalUnitsForIcon(side, icon.type, icon.shape, G);
        if (legal.length === 0) continue;
        // RAW: you can only build a unit you still have a token for in the
        // holding pool. Drop types that are exhausted so the player isn't
        // offered (and can't waste the pick on) something with 0 supply.
        const buildable = legal.filter((t) => M.unitsAvailableInSupply(G, t) > 0);
        if (buildable.length === 0) {
          // No supply for ANY unit this icon could make → the build is
          // wasted. Surface it so the player understands why nothing was
          // produced, rather than silently dropping the icon.
          log(G, { kind: 'build-wasted-no-supply', side, payload: {
            sourceSystemId: sysId, slot, iconType: icon.type, iconShape: icon.shape,
            legalUnitTypes: legal,
          }});
          continue;
        }
        if (buildable.length === 1) {
          M.buildToQueue(G, side, buildable[0], slot, sysId);
          sideAutoApplied.push({ sourceSystemId: sysId, slot, unitTypeId: buildable[0] });
        } else {
          sidePicks.push({
            sourceSystemId: sysId, slot,
            iconType: icon.type, iconShape: icon.shape,
            legalUnitTypes: buildable,
            available: availabilityFor(G, buildable),
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
        // Ground triangle has only one legal type — auto-apply (if any Rebel
        // Troopers remain in the holding pool; otherwise the icon is wasted).
        if (M.unitsAvailableInSupply(G, 'rebel-trooper') > 0) {
          M.buildToQueue(G, 'Rebel', 'rebel-trooper', 1, 'rebel-base');
          sideAutoApplied.push({ sourceSystemId: 'rebel-base', slot: 1, unitTypeId: 'rebel-trooper' });
        } else {
          log(G, { kind: 'build-wasted-no-supply', side: 'Rebel', payload: {
            sourceSystemId: 'rebel-base', slot: 1, iconType: 'ground', iconShape: 'triangle',
            legalUnitTypes: ['rebel-trooper'],
          }});
        }
        // Space triangle — use the shared icon→units map so the Rebel Base
        // offers the same space-triangle options as any other system
        // (X-Wing / Y-Wing / Rebel Transport), instead of a hardcoded list
        // that drifted out of sync (issue #50).
        const baseSpace = legalUnitsForIcon('Rebel', 'space', 'triangle', G)
          .filter((t) => M.unitsAvailableInSupply(G, t) > 0);
        if (baseSpace.length === 0) {
          log(G, { kind: 'build-wasted-no-supply', side: 'Rebel', payload: {
            sourceSystemId: 'rebel-base', slot: 1, iconType: 'space', iconShape: 'triangle',
            legalUnitTypes: legalUnitsForIcon('Rebel', 'space', 'triangle', G),
          }});
        } else if (baseSpace.length === 1) {
          M.buildToQueue(G, 'Rebel', baseSpace[0], 1, 'rebel-base');
          sideAutoApplied.push({ sourceSystemId: 'rebel-base', slot: 1, unitTypeId: baseSpace[0] });
        } else {
          sidePicks.push({
            sourceSystemId: 'rebel-base', slot: 1,
            iconType: 'space', iconShape: 'triangle',
            legalUnitTypes: baseSpace,
            available: availabilityFor(G, baseSpace),
          });
        }
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
    // Hard supply gate (RAW holding pool). Checked live so two same-shape
    // icons in one batch can't both spend the last token — each buildToQueue
    // above decrements the pool that this read sees.
    if (M.unitsAvailableInSupply(G, c) <= 0) {
      return { ok: false, reason: `no-supply:${c}` };
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
    // Group by unit type (stable, in first-appearance order) so the player
    // deploys ALL of one type before the next, instead of the queue flipping
    // back and forth between types mid-deploy — which makes it easy to drop a
    // unit on the wrong system (player report). e.g. TIE,TIE,AT-AT,TIE,SD
    // becomes TIE,TIE,TIE,AT-AT,SD.
    const order: UnitTypeId[] = [];
    const byType = new Map<UnitTypeId, number>();
    for (const typeId of deploying) {
      if (!byType.has(typeId)) { byType.set(typeId, 0); order.push(typeId); }
      byType.set(typeId, byType.get(typeId)! + 1);
    }
    for (const typeId of order) {
      for (let i = 0; i < byType.get(typeId)!; i++) queue.push({ side, typeId });
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
    // Death Star completion (RAW): the finished Death Star is placed in the
    // system where it was being built, replacing the "under construction"
    // marker — it is NOT a free-choice deploy. Without this the marker stayed
    // on the board forever after completion (player report #103).
    if (next.typeId === 'death-star') {
      let dsucSys: SystemId | null = null;
      let dsucIdx = -1;
      for (const [sid, ss] of Object.entries(G.map.systems)) {
        const idx = ss.units.findIndex(
          (u) => u.side === 'Empire' && u.typeId === 'death-star-under-construction',
        );
        if (idx >= 0) { dsucSys = sid; dsucIdx = idx; break; }
      }
      if (dsucSys) {
        // Remove the marker (completion, not destruction — no combat/plans
        // side-effects) and deploy the real Death Star in its place.
        const removed = G.map.systems[dsucSys].units.splice(dsucIdx, 1)[0];
        log(G, { kind: 'death-star-completed', side: 'Empire', payload: {
          systemId: dsucSys, replacedUnit: removed.instanceId,
        }});
        M.deployUnit(G, 'Empire', 'death-star', dsucSys);
        r.pendingDeployPicks.shift();
        continue;
      }
      // No marker found (e.g. it was destroyed mid-build) — fall through to a
      // normal deploy so the unit isn't silently dropped.
    }
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

/** Droid "ring" action cards the Rebel may ATTACH during their Assignment
 *  phase: in hand and not already attached to a leader. */
const DROID_RING_CARDS: Record<string, 'r2d2' | 'c3po'> = {
  'resourceful-astromech': 'r2d2',
  'human-cyborg-relations': 'c3po',
};

export function playableAssignmentActionCards(G: GameState, side: Side): string[] {
  const f = faction(G, side);
  const out: string[] = [];
  for (const cid of f.actionHand) {
    const card = G.catalog.actions[cid];
    if (!card) continue;
    // Droid ring cards (timing 'Immediate') can be ATTACHED during Assignment,
    // as long as the ring isn't already on a leader.
    if (DROID_RING_CARDS[cid]) {
      if (side === 'Rebel' && !M.findRingHolder(G, DROID_RING_CARDS[cid])) out.push(cid);
      continue;
    }
    if (card.timing !== 'Assignment') continue;
    // Leader requirement: at least one named leader must be in the pool.
    const reqs = card.leaderRequirement ?? [];
    if (reqs.length > 0 && !reqs.some((lid) => f.leaderPool.includes(lid))) continue;
    out.push(cid);
  }
  return out;
}

/** All of a side's leaders (pool + on-board + on-missions), deduped — the legal
 *  attach targets for a droid ring. */
function allLeadersOf(G: GameState, side: Side): LeaderId[] {
  const f = faction(G, side);
  const set = new Set<LeaderId>(f.leaderPool);
  for (const list of Object.values(f.leadersOnBoard)) for (const lid of list) set.add(lid as LeaderId);
  for (const am of f.leadersOnMissions) for (const lid of am.leaderIds) set.add(lid as LeaderId);
  return [...set];
}

/** Resolve the player's choice of which leader to attach a droid ring to. */
export function resolveAttachRing(G: GameState, leaderId: LeaderId): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'AttachRingPick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'not-a-candidate' };
  const f = faction(G, pc.side);
  // The card leaves the hand into an attached/in-play state — NOT the discard
  // pile. It is discarded only when the ring's effect is used.
  const i = f.actionHand.indexOf(pc.cardId);
  if (i < 0) return { ok: false, reason: 'card-not-in-hand' };
  f.actionHand.splice(i, 1);
  M.attachRing(G, leaderId, pc.ringId);
  log(G, { kind: 'action-card-play', side: pc.side, payload: {
    cardId: pc.cardId, leaderId, systemId: null, timing: 'attach-ring',
  }});
  G.pendingChoice = undefined;
  return { ok: true };
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

  // Droid ring card → pick a leader to attach the ring to (not a system).
  const ringId = DROID_RING_CARDS[cardId];
  if (ringId) {
    const candidates = allLeadersOf(G, side);
    if (candidates.length === 0) return { ok: false, reason: 'no-leader-to-attach' };
    G.pendingChoice = { kind: 'AttachRingPick', side, cardId, ringId, candidates };
    log(G, { kind: 'choice-request', side, payload: { kind: 'AttachRingPick', cardId, ringId, candidates } });
    return { ok: true };
  }

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
      const inPlay = new Set(allLeadersOf(G, side));
      const captured = (G.empire.capturedLeaders ?? []).some((c) => c.leaderId === target);
      if (target && systemId && G.catalog.leaders[target]
          && !inPlay.has(target)
          && !f.eliminatedLeaders.includes(target)
          && !captured) {
        // RAW (card): "Place the recruited leader in Han Solo's system" — NOT
        // the leader pool. Han was just placed on `systemId` by the generic
        // assignment-card placement, so the recruited friend joins him there
        // (player reports: nicktenny / MightyFaben — Chewie/Lando were landing
        // in the ready-leaders pool instead of on Kashyyyk/Bespin).
        (f.leadersOnBoard[systemId] ??= []).push(target);
        log(G, { kind: 'recruit-leader', side, payload: { leaderId: target, via: 'an-old-friend', systemId } });
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
      // Sabotage blocks all building at this system (RAW).
      if (G.map.systems[systemId]?.sabotage) {
        log(G, { kind: 'action-card-noop', side, payload: { cardId, reason: 'sabotage-blocks-build' } });
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
      // RAW: "Search the assignment deck for a card and put Leia on it."
      // Make sure Leia is in the pool first (consumeCardAndPlaceLeader may
      // have placed her on a system if systemId was set — pull her back).
      const f = faction(G, side);
      for (const list of Object.values(f.leadersOnBoard)) {
        const i = list.indexOf('princess-leia');
        if (i >= 0) list.splice(i, 1);
      }
      if (!f.leaderPool.includes('princess-leia')
          && !f.eliminatedLeaders.includes('princess-leia')) {
        f.leaderPool.push('princess-leia');
      }
      const candidates = [...f.missionDeck];
      if (candidates.length === 0) {
        log(G, { kind: 'action-card-noop', side, payload: { cardId, reason: 'mission-deck-empty' } });
        break;
      }
      G.pendingChoice = {
        kind: 'OurMostDesperateHourPick',
        side: 'Rebel',
        candidates,
      };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: {
        kind: 'OurMostDesperateHourPick', deckSize: candidates.length,
      }});
      break;
    }
    case 'independent-operation': {
      // Lando is now in `systemId`. Find Imperial ground there; if any,
      // post a choice for the EMPIRE to pick an Imperial-occupied system
      // to evacuate them to.
      if (!systemId) break;
      const ss = G.map.systems[systemId];
      if (!ss) break;
      const groundUnitIds = ss.units
        .filter((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')
        .map((u) => u.instanceId);
      if (groundUnitIds.length === 0) {
        log(G, { kind: 'action-card-noop', side, payload: { cardId, reason: 'no-imperial-ground' } });
        break;
      }
      const candidateSystemIds = Object.keys(G.map.systems).filter((sid) => {
        if (sid === systemId) return false;
        return G.map.systems[sid].units.some((u) => u.side === 'Empire');
      });
      if (candidateSystemIds.length === 0) {
        // Empire has no other system to retreat to — units stay (RAW edge).
        log(G, { kind: 'action-card-noop', side, payload: { cardId, reason: 'no-imperial-destination' } });
        break;
      }
      G.pendingChoice = {
        kind: 'IndependentOperationEvacPick',
        side: 'Empire',
        fromSystemId: systemId,
        candidateSystemIds,
        groundUnitIds,
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'IndependentOperationEvacPick', fromSystemId: systemId,
        units: groundUnitIds.length, destinations: candidateSystemIds.length,
      }});
      break;
    }
    case 'start-the-evacuation': {
      // Pick target system without Imperial units + which Rebel Base units
      // to move there (transport-validated).
      const candidateSystemIds = Object.keys(G.map.systems).filter((sid) => {
        return !G.map.systems[sid].units.some((u) => u.side === 'Empire');
      });
      const candidateUnitIds = G.map.rebelBaseSpace.units
        .filter((u) => {
          if (u.side !== 'Rebel') return false;
          const t = G.catalog.unitTypes[u.typeId];
          return !!t && !t.transport.immobile;
        })
        .map((u) => u.instanceId);
      if (candidateUnitIds.length === 0 || candidateSystemIds.length === 0) {
        log(G, { kind: 'action-card-noop', side, payload: { cardId, reason: 'no-evac-targets' } });
        break;
      }
      G.pendingChoice = {
        kind: 'StartEvacuationPick',
        side: 'Rebel',
        candidateSystemIds,
        candidateUnitIds,
      };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: {
        kind: 'StartEvacuationPick',
        systems: candidateSystemIds.length, units: candidateUnitIds.length,
      }});
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
      // "Place Tarkin in an Imperial system and immediately build with it."
      // Post a single-system build pick scoped to the system's resource icons.
      if (!systemId) break;
      const sysDef = G.catalog.systems[systemId];
      if (!sysDef || !sysDef.buildSlot || sysDef.resources.length === 0) {
        log(G, { kind: 'action-card-noop', side: 'Empire', payload: { cardId, reason: 'no-build-icons' } });
        break;
      }
      // Sabotage blocks all building at this system (RAW).
      if (G.map.systems[systemId]?.sabotage) {
        log(G, { kind: 'action-card-noop', side: 'Empire', payload: { cardId, reason: 'sabotage-blocks-build' } });
        break;
      }
      G.pendingChoice = {
        kind: 'BrilliantAdministratorBuildPick',
        side: 'Empire',
        systemId,
        icons: sysDef.resources.map((r) => ({ theater: r.type, shape: r.shape })),
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'BrilliantAdministratorBuildPick', systemId, iconCount: sysDef.resources.length,
      }});
      break;
    }
    case 'local-rumors': {
      if (!systemId) break;
      const sysDef = G.catalog.systems[systemId];
      const baseDef = G.catalog.systems[G.rebelBaseSystemId];
      const region = sysDef?.region;
      const sameRegion = !!(sysDef && baseDef && sysDef.region === baseDef.region);
      log(G, { kind: 'local-rumors-reveal', side: 'Empire', payload: {
        systemId, region, baseInRegion: sameRegion,
      }});
      // Rule out the whole region on the probe map when the base isn't there.
      // Local Rumors is region intel (RAW: the Rebel says whether the base is
      // in this system's region), so a "no" eliminates EVERY system in that
      // region — including neutral worlds that recordEmpireSearched skips.
      let ruledOut = 0;
      if (!sameRegion && region != null && !G.rebelBaseRevealed) {
        if (!G.empireSearchedRuledOut) G.empireSearchedRuledOut = [];
        const set = new Set(G.empireSearchedRuledOut);
        for (const [sid, def] of Object.entries(G.catalog.systems)) {
          if (def.region === region && sid !== 'rebel-base-space' && sid !== G.rebelBaseSystemId) {
            set.add(sid);
            ruledOut++;
          }
        }
        G.empireSearchedRuledOut = [...set];
      }
      // Surface the result — the reporter played it and got no feedback (#95).
      const sysName = sysDef?.name ?? systemId;
      pushNotice(
        G,
        `local-rumors-t${G.timeMarker}-${systemId}`,
        'Local Rumors',
        sameRegion
          ? `The Rebel base IS somewhere in ${sysName}'s region (Region ${region}). Focus your search there.`
          : `The Rebel base is NOT in ${sysName}'s region (Region ${region}). All ${ruledOut} systems in that region are ruled out on your probe map.`,
      );
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
      // "Move a fleet immediately." Ozzel's placement system is the move
      // destination; the Empire picks a source from an adjacent system
      // with Empire units, then which units to move.
      if (!systemId) break;
      const adj = G.catalog.adjacency[systemId] ?? [];
      const candidateSourceSystemIds = adj.filter((sid) => {
        const ss = G.map.systems[sid];
        return ss && ss.units.some((u) => u.side === 'Empire');
      });
      if (candidateSourceSystemIds.length === 0) {
        log(G, { kind: 'action-card-noop', side: 'Empire', payload: { cardId, reason: 'no-adjacent-empire-source' } });
        break;
      }
      G.pendingChoice = {
        kind: 'CatchThemBySurpriseMovePick',
        side: 'Empire',
        targetSystemId: systemId,
        candidateSourceSystemIds,
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'CatchThemBySurpriseMovePick', targetSystemId: systemId,
        sources: candidateSourceSystemIds.length,
      }});
      break;
    }
    case 'scouting-mission': {
      // "Move up to 4 TIE Fighters from any system(s) to this system,
      //  ignoring transport restrictions and adjacency. If there are
      //  Rebel ships in this system, resolve a combat."
      if (!systemId) break;
      const candidateUnitIds: string[] = [];
      for (const sid of Object.keys(G.map.systems)) {
        if (sid === systemId) continue;
        for (const u of G.map.systems[sid].units) {
          if (u.side === 'Empire' && u.typeId === 'tie-fighter') candidateUnitIds.push(u.instanceId);
        }
      }
      if (candidateUnitIds.length === 0) {
        // No TIEs elsewhere — still trigger combat if Rebel ships present.
        const ss = G.map.systems[systemId];
        if (ss && ss.units.some((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'space')) {
          beginCombat(G, 'Empire', systemId, systemId);
          runCombat(G);
        }
        log(G, { kind: 'action-card-noop', side: 'Empire', payload: { cardId, reason: 'no-tie-fighters-elsewhere' } });
        break;
      }
      G.pendingChoice = {
        kind: 'ScoutingMissionTIEPick',
        side: 'Empire',
        targetSystemId: systemId,
        candidateUnitIds,
        maxPicks: 4,
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'ScoutingMissionTIEPick', targetSystemId: systemId,
        candidates: candidateUnitIds.length,
      }});
      break;
    }
    case 'proceeding-as-planned': {
      // RAW: "Search the project deck for 1 project and assign this leader to it."
      // The "project deck" = projects in the Empire's mission deck.
      const f = G.empire;
      // Ozzel or Jerjerrod is the resolver; find which one was on the card.
      const reqs = G.catalog.actions[cardId]?.leaderRequirement ?? [];
      let resolverLeader: string | null = null;
      for (const lid of reqs) {
        // consumeCardAndPlaceLeader puts them somewhere; find them.
        if (f.leaderPool.includes(lid)) { resolverLeader = lid; break; }
        for (const [, list] of Object.entries(f.leadersOnBoard)) {
          if (list.includes(lid)) { resolverLeader = lid; break; }
        }
        if (resolverLeader) break;
      }
      // Default to first requirement if we couldn't locate them.
      if (!resolverLeader) resolverLeader = reqs[0] ?? null;
      if (!resolverLeader) {
        log(G, { kind: 'action-card-noop', side: 'Empire', payload: { cardId, reason: 'no-resolver-leader' } });
        break;
      }
      // Pull the leader back into the pool so the choice resolver can
      // re-place them onto the chosen project.
      for (const list of Object.values(f.leadersOnBoard)) {
        const i = list.indexOf(resolverLeader);
        if (i >= 0) list.splice(i, 1);
      }
      if (!f.leaderPool.includes(resolverLeader) && !f.eliminatedLeaders.includes(resolverLeader)) {
        f.leaderPool.push(resolverLeader);
      }
      // RAW: "Search the PROJECT DECK for 1 project." Projects live in their
      // own deck (G.empire.projectDeck, seeded at setup) — NOT the regular
      // mission deck. Searching missionDeck found nothing and wrongly reported
      // "no projects" even when the project deck was full (player report #104).
      const projectCandidates = [...(f.projectDeck ?? [])];
      if (projectCandidates.length === 0) {
        log(G, { kind: 'action-card-noop', side: 'Empire', payload: { cardId, reason: 'project-deck-empty' } });
        pushNotice(
          G,
          `proceeding-as-planned-no-projects-t${G.timeMarker}`,
          'Proceeding As Planned — no project to search',
          'The project deck is empty, so there was no project to search for. The leader was still placed.',
        );
        break;
      }
      G.pendingChoice = {
        kind: 'ProceedingAsPlannedPick',
        side: 'Empire',
        leaderId: resolverLeader as LeaderId,
        candidates: projectCandidates,
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'ProceedingAsPlannedPick', leaderId: resolverLeader, count: projectCandidates.length,
      }});
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
