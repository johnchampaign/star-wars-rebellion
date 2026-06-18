// Phase machinery: Assignment / Command / Refresh.
// Combat (sub-machine, triggered mid-Command-turn) is implemented in combat.ts (next task).
// Effect handlers (mission/action/objective text) live in handlers/ (later task).
//
// See docs/engine.md §4–7.

import type {
  GameState, Side, SystemId, LeaderId, MissionResolution, UnitTypeId,
  ArmedActionCard, UnitInstanceId,
} from './types';
// (Phase advances from Setup → Assignment internally; no extra imports needed.)
import * as M from './mechanics';
import { beginCombat, runCombat } from './combat';
import { log, pushNotice } from './log';
import * as Handlers from './handlers/registry';
import { missionTargets } from './missionTargets';
import { PROJECT_ONLY_UNIT_IDS } from './units';
import { rollDie, shuffle } from './rng';
import { objectiveConditionMet, objectiveReputationGain, objectiveReturnsToDeck, objectiveReturnsToHand, postPlayObjectiveChoice, PERSISTENT_OBJECTIVES, COST_OBJECTIVES, OPT_IN_OBJECTIVES, timeForPeaceQueueTargets } from './objectives';

/** Time-track turns on which the Rebel recruits a new leader, per the printed
 *  16-space board (turns 2-5). Single source of truth shared by the engine's
 *  Refresh recruit step AND the UI turn tracker, so the "R" badge and the
 *  actual recruit can never disagree (issues #48/#59). */
export const RECRUIT_TIME_MARKERS: ReadonlySet<number> = new Set([2, 3, 4, 5]);

/** Time-track turns carrying a BUILD icon, per the printed 16-space board:
 *  the even turns 2 through 14 (turn 16, the final space, has none). Shared
 *  by the engine's Refresh build step and the UI turn tracker. */
export const BUILD_TIME_MARKERS: ReadonlySet<number> = new Set([2, 4, 6, 8, 10, 12, 14]);

/** RoE missions whose text says "Roll even if unopposed." These forgo the
 *  free auto-success when unopposed and instead roll the resolver's dice
 *  against a 0-success opposer, so their "up to the difference in
 *  successes" effect has a real margin to work with. */
const ROLL_EVEN_IF_UNOPPOSED: ReadonlySet<string> = new Set([
  'plant-explosives', 'assault',
]);

/** Subversion is an "Oppose" mission: you assign leaders to it, and it
 *  auto-triggers when the OPPONENT reveals a mission (you can't reveal it
 *  yourself). Both factions have New + Original variants — the New/Original pair
 *  just matches the active mission deck. The opposition logic is side-agnostic;
 *  these ids gate the auto-trigger lookup + the manual-reveal block. */
const SUBVERSION_MISSION_IDS: ReadonlySet<string> = new Set([
  'subversion-new', 'subversion-original',           // Empire (oppose a Rebel mission)
  'subversion-new-rebel', 'subversion-original-rebel', // Rebel (oppose an Imperial mission)
]);

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
  G: GameState, n: number, minor: number, _side: Side, _systemId: SystemId,
): { successes: number; faces: string[]; colors: ('red' | 'black' | 'green')[] } {
  // Of the total `n` dice to roll, `minor` come from minor skill icons.
  // RoE rulebook ("Minor Skills" / "Green Dice"): "Each minor skill icon
  // allows the leader to roll 1 green die" and "A player cannot roll more
  // than 3 green dice when attempting a mission." Crucially, minor skills
  // roll ONLY green — they never spill over into red/black. So green is
  // capped at 3 and any minor icons beyond the cap roll NOTHING (player
  // report #350: we were wrongly promoting the minor-overflow to red/black,
  // inflating the major-die count). The red+black split covers only the
  // non-minor dice: the true major icons plus any extra-die bonuses
  // (e.g. Subversion).
  const minorRolled = G.expansion?.enabled ? minor : 0;
  const greenCount = Math.min(minorRolled, 3);
  const major = Math.max(0, n - minorRolled);
  const red = Math.min(major, 5);
  const black = Math.min(Math.max(0, major - 5), 5);
  const faces: string[] = [];
  const colors: ('red' | 'black' | 'green')[] = [];
  for (let i = 0; i < red; i++) {
    const r = rollDie(G.rng, 'red');
    faces.push(r.face); colors.push('red');
  }
  for (let i = 0; i < black; i++) {
    const r = rollDie(G.rng, 'black');
    faces.push(r.face); colors.push('black');
  }
  for (let i = 0; i < greenCount; i++) {
    const r = rollDie(G.rng, 'green');
    faces.push(r.face); colors.push('green');
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
  // Match ALL the wordings a "target a captured leader" mission uses — base
  // "against a captured leader" AND the RoE paraphrases "on a captured leader",
  // "on a captured leader's system", "on a captured leader in a remote system"
  // (We're the Bait, Break Their Will, Exploit Weakness, Make an Example). The
  // narrow "against" match silently dropped those, so the prisoner never rolled
  // opposition (player reports #356/#357). Mirrors missionTargets' own check.
  return card.rulesText.toLowerCase().includes('captured leader');
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

/** Leaders that contribute to the ATTEMPTING side's mission roll. RR p.8:
 *  "Each player rolls a number of dice equal to the combined number of skill
 *  icons on ALL of his leaders in the system" — not just the leaders assigned
 *  to the mission card. So a leader already in the target system (e.g. Han
 *  sitting at Kashyyyk while Chewie reveals Wookiee Uprising) adds his icons
 *  too. The mission-assigned leaders are placed in the system on reveal, so
 *  leadersOnBoard[target] already contains them; this just folds in any others.
 *  (The leader-portrait +2 bonus still keys only on the assigned leaders.) */
function attemptingLeadersAt(G: GameState, side: Side, systemId: SystemId, missionLeaderIds: LeaderId[]): LeaderId[] {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const here = new Set<string>(f.leadersOnBoard[systemId] ?? []);
  for (const lid of missionLeaderIds) here.add(lid);
  return [...here] as LeaderId[];
}

/** Sum of matching-skill icons across a leader set. */
/** Split-by-major/minor skill count for a leader set on a single skill.
 *  Used both for mission skill-cost checks (sum) and dice rolls (the minor
 *  part rolls GREEN dice in RoE per rules p.8). */
export function totalSkill(G: GameState, leaderIds: LeaderId[], skill: string): { major: number; minor: number } {
  let major = 0, minor = 0;
  for (const lid of leaderIds) {
    const ld = G.catalog.leaders[lid];
    if (!ld) continue;
    major += ld.skills[skill as keyof typeof ld.skills] ?? 0;
    if (G.expansion?.enabled) {
      minor += ld.minorSkills[skill as keyof typeof ld.minorSkills] ?? 0;
      minor += ringMinorSkillBonus(G, lid, skill as 'diplomacy' | 'intel' | 'specOps' | 'logistics');
    }
  }
  return { major, minor };
}

/** Split-by-major/minor sum of ALL skill icons across a leader set. Used
 *  by missions that say "count all skill icons during this attempt"
 *  (Interrogation Droid, Lure of the Dark Side, etc.). RR p.9. With the
 *  RoE expansion enabled, minor skill icons (printed and ring-granted)
 *  also count, and roll green dice per rules p.8. */
function totalAllSkills(G: GameState, leaderIds: LeaderId[]): { major: number; minor: number } {
  let major = 0, minor = 0;
  for (const lid of leaderIds) {
    const ld = G.catalog.leaders[lid];
    if (!ld) continue;
    major += (ld.skills.diplomacy ?? 0) + (ld.skills.intel ?? 0)
           + (ld.skills.specOps ?? 0) + (ld.skills.logistics ?? 0);
    if (G.expansion?.enabled) {
      minor += (ld.minorSkills.diplomacy ?? 0) + (ld.minorSkills.intel ?? 0)
             + (ld.minorSkills.specOps ?? 0) + (ld.minorSkills.logistics ?? 0);
      for (const k of ['diplomacy', 'intel', 'specOps', 'logistics'] as const) {
        minor += ringMinorSkillBonus(G, lid, k);
      }
    }
  }
  return { major, minor };
}

/** RoE ring-granted minor-skill bonuses. K-2SO (the He Means Well ring)
 *  grants +1 minor SpecOps and +1 minor Intel to the bearer. The bonus
 *  counts as a minor icon for both mission skill-cost satisfaction (rules
 *  p.8) and the green-dice mission roll (TODO when mission greens land).
 *  Returns 0 when expansion is off or the leader has no relevant ring. */
function ringMinorSkillBonus(G: GameState, leaderId: string, skill: 'diplomacy' | 'intel' | 'specOps' | 'logistics'): number {
  if (!G.expansion?.enabled) return 0;
  let bonus = 0;
  const rings = G.leaderAttachments?.[leaderId] ?? [];
  if (rings.includes('k2so')) {
    if (skill === 'specOps' || skill === 'intel') bonus += 1;
  }
  return bonus;
}

/** Card-specific bonus dice added to the ATTEMPTING side's mission roll,
 *  on top of the leaders' skill icons. Currently only Build Alliance:
 *  "If there are Rebel units in this system, roll 2 additional dice."
 *  (player reports #147/#149). Returns 0 for every other mission. */
function missionExtraAttackerDice(G: GameState, missionId: string, targetSystemId: SystemId): number {
  if (missionId === 'build-alliance') {
    const ss = G.map.systems[targetSystemId];
    const hasRebelUnit = (ss?.units ?? []).some((u) => u.side === 'Rebel');
    return hasRebelUnit ? 2 : 0;
  }
  return 0;
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
  // RAW (rr p.15): the Empire draws its 2 starting probe cards now that the
  // Rebel base probe is out of the deck (interactive path; the auto-setup path
  // drew them in createGame). #189. Only if not already drawn.
  if ((G.empire.probeHand?.length ?? 0) === 0) {
    G.empire.probeHand = G.probeDeck.splice(0, 2);
    log(G, { kind: 'empire-starting-probes', side: 'Empire', payload: { count: G.empire.probeHand.length } });
  }
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
    const def = G.catalog.systems[systemId];
    const isImperialSys = ss.loyalty === 'imperial' || ss.subjugated;
    const isDsuc = typeId === 'death-star-under-construction';
    if (G.expansion?.enabled && def?.isRemote) {
      // RoE (rules p.8): the Empire chooses ONE remote system to hold its Death
      // Star Under Construction + companion units. Once chosen, that is the only
      // remote system its starting units may go to. (Mirrors rebelDeployTarget.)
      if (G.empireDeployTarget && G.empireDeployTarget !== systemId) {
        return { ok: false, reason: `empire-already-chose-${G.empireDeployTarget}` };
      }
      G.empireDeployTarget = systemId;
    } else if (isDsuc) {
      // The DSUC may only be placed on the chosen remote system, never on an
      // Imperial-loyalty / subjugated world.
      return { ok: false, reason: 'dsuc-must-be-remote' };
    } else if (!isImperialSys) {
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

/** Undo a setup placement: pull a unit back off the board and return it to the
 *  pending-deployment pool (player request — you couldn't change a setup
 *  placement). Only valid during Setup while deployment is still pending. If the
 *  player removes their last unit from the chosen deploy target, the target is
 *  cleared so they can pick a different system. */
export function setupUndoDeployUnit(G: GameState, side: Side, typeId: string, systemId: SystemId): { ok: boolean; reason?: string } {
  if (G.phase !== 'Setup') return { ok: false, reason: 'wrong-phase' };
  if (!G.pendingDeployment) return { ok: false, reason: 'no-pending-deployment' };
  const dest = systemId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[systemId];
  if (!dest) return { ok: false, reason: 'unknown-system' };
  // Only setup units exist on the board at this point, so any matching
  // side+type unit here was placed during setup.
  const ui = dest.units.findIndex((u) => u.side === side && u.typeId === typeId);
  if (ui < 0) return { ok: false, reason: `no-such-unit-placed:${typeId}@${systemId}` };
  dest.units.splice(ui, 1);
  G.pendingDeployment[side].push(typeId);
  log(G, { kind: 'setup-undeploy', side, payload: { typeId, systemId } });
  // Clear the single-system deploy target if this was the last unit there, so
  // the player can re-choose where their forces start.
  if (side === 'Rebel' && G.rebelDeployTarget === systemId
    && !(G.map.systems[systemId]?.units ?? []).some((u) => u.side === 'Rebel')) {
    G.rebelDeployTarget = undefined;
  }
  if (side === 'Empire' && G.empireDeployTarget === systemId
    && !(G.map.systems[systemId]?.units ?? []).some((u) => u.side === 'Empire')) {
    G.empireDeployTarget = undefined;
  }
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

    // RoE (rules p.8): the Death Star Under Construction (+ 4 TIE Fighters +
    // 1 Stormtrooper) must go on one chosen remote system. Seed that first so
    // auto-fill doesn't try to place the DSUC on an Imperial world (illegal).
    if (G.expansion?.enabled && remaining.includes('death-star-under-construction')) {
      const remote = G.empireDeployTarget
        ?? Object.entries(G.map.systems).find(([id]) => G.catalog.systems[id]?.isRemote)?.[0];
      if (remote) {
        G.empireDeployTarget = remote;
        for (const typeId of ['death-star-under-construction', 'tie-fighter', 'tie-fighter',
          'tie-fighter', 'tie-fighter', 'stormtrooper']) {
          const i = remaining.indexOf(typeId);
          if (i >= 0) { G.map.systems[remote].units.push(mkSetupInstance(typeId, 'Empire')); remaining.splice(i, 1); }
        }
      }
    }

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
  reportType: 'mission' | 'combat' | 'objective' | 'refresh' | 'activation',
): { ok: boolean; reason?: string } {
  const arr =
    reportType === 'mission' ? G.missionReports
    : reportType === 'combat' ? G.combatReports
    : reportType === 'objective' ? G.objectiveReports
    : reportType === 'activation' ? G.activationReports
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
    // A droid ring (R2-D2 / C-3PO) in the opening hand attaches immediately at
    // game start, before the first Assignment turn (Immediate timing; mirrors
    // recruit-time attachment, #221). Posts an AttachRingPick if one is waiting.
    flushStartingRings(G);
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

  // RAW (rules: "the Rebel player assigns any of their leaders to missions,
  // followed by the Imperial player"): the active player assigns ALL of their
  // leaders before the turn passes — assignment does NOT alternate leader-by-
  // leader (that was the bug). The turn passes only when the player signals
  // done via skipAssignment(): Rebel first (all), then Empire (all). So we
  // leave G.currentPlayer untouched here.
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
  // Where the unassigned mission goes:
  //  - A normally-assigned mission (drawn into hand) returns to the HAND, per
  //    RR "Pass" — matching the end-of-round Refresh cleanup.
  //  - A mission FETCHED from the deck by Our Most Desperate Hour / Proceeding
  //    As Planned was never in hand; it was pulled out with a specific leader
  //    on it (Leia for OMDH). Returning it to hand lets the player re-assign it
  //    to anyone, dropping the compulsory leader and effectively keeping a
  //    deck-searched card for free (player #280). It returns to the DECK
  //    instead, undoing the search. (Corrects the #108 hand-return ruling, which
  //    conflicted with #89's "don't put the fetched card in hand".)
  if (entry.fromDeck) {
    if (!f.missionDeck.includes(missionId)) f.missionDeck.push(missionId);
    // The action card that fetched it was discarded when played — return it to
    // hand too, so undoing the mission fully undoes the play (player #279).
    if (entry.viaCard) {
      const di = (f.actionDiscard ?? []).indexOf(entry.viaCard);
      if (di >= 0) f.actionDiscard.splice(di, 1);
      if (!f.actionHand.includes(entry.viaCard)) f.actionHand.push(entry.viaCard);
    }
  } else if (!f.missionHand.includes(missionId)) {
    f.missionHand.push(missionId);
  }
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
    // Both done — offer the Rebel an end-of-Assignment False Orders window
    // (#293). If it posts a choice, the resolver advances to Command afterward;
    // otherwise advance now.
    if (!maybeOfferFalseOrders(G)) enterCommandPhase(G);
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
  // RoE Under the Radar: offer to return a held probe at the start of the
  // Rebel's first Command turn.
  maybeOfferUnderTheRadarReturn(G);
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
  // RoE: an Immediate objective drawn during this action (Heist, Covert
  // Operation, Rebel Planning, or the setup draw caught on turn 1) reveals and
  // resolves now — pause for its placement before advancing. The resolver
  // re-enters advanceCommandTurn to chain / advance.
  if (flushImmediateObjectiveActivations(G, 'command')) return;
  // RoE: drain the current player's Immediate action cards (Rebel Extremist /
  // Under the Radar / Early Promotion) before advancing — they trigger on draw,
  // not on demand. The resolvers re-enter advanceCommandTurn to chain/continue.
  if (flushImmediateActionCards(G)) return;
  if (G.passedThisCommand.length >= 2) {
    // RoE Sweep the Area auto-reveal fires at end-of-Command-phase (right
    // before Refresh kicks off).
    autoRevealArmedActionCards(G, 'Empire', 'empire-command-end');
    processPendingRapidMobilizations(G);
    return;
  }
  // Pass to the other side, but skip them if they have already passed.
  const next = other(G.currentPlayer);
  if (G.passedThisCommand.includes(next)) {
    // The other side is passed; current player keeps going. If it's
    // Empire's turn that's still ongoing, Secret Facility might already
    // have fired on the original turn-start — fine, it's been removed.
    return;
  }
  G.currentPlayer = next;
  // RoE Secret Facility auto-reveal fires at the start of an Empire
  // Command turn (the first one after arming).
  if (next === 'Empire') {
    autoRevealArmedActionCards(G, 'Empire', 'empire-command-start');
  }
  // RoE Under the Radar: offer to return a held probe at the start of a
  // Rebel Command turn.
  if (next === 'Rebel') {
    maybeOfferUnderTheRadarReturn(G);
  }
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
  // The Rebel may activate the hidden "Rebel Base" space itself to pull units IN
  // from the base's system or an adjacent one (rr "Moving to or from the Rebel
  // Base"; player report). Otherwise the target must be a real map system.
  const targetIsBaseSpace = targetSystemId === 'rebel-base-space';
  if (targetIsBaseSpace) {
    if (side !== 'Rebel') return { ok: false, reason: 'base-space-rebel-only' };
    if (G.rebelBaseRevealed) return { ok: false, reason: 'base-revealed-no-base-space' };
    if (!G.rebelBaseSystemId) return { ok: false, reason: 'no-rebel-base' };
  } else if (!G.map.systems[targetSystemId]) {
    return { ok: false, reason: 'unknown-target-system' };
  }

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
    if (targetIsBaseSpace) {
      // Moving INTO the hidden Rebel Base space: the source must be the base's
      // own system or a system adjacent to it (rr "Moving to or from the Rebel
      // Base"). Sources can't themselves be the base space.
      if (order.fromSystemId === 'rebel-base-space') {
        return { ok: false, reason: 'source-cannot-be-base-space' };
      }
      const baseId = G.rebelBaseSystemId;
      const baseAdj = G.catalog.adjacency[baseId] ?? [];
      if (order.fromSystemId !== baseId && !baseAdj.includes(order.fromSystemId)) {
        return { ok: false, reason: `source-not-base-or-adjacent:${order.fromSystemId}` };
      }
    } else if (order.fromSystemId === 'rebel-base-space') {
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

  // Execute moves (capturing what moved, grouped by source + unit type, for the
  // activation report surfaced to both players). Capture each unit's type from
  // the source BEFORE moving it (afterward it's gone from the source system).
  const reportMoves: { fromSystemId: SystemId; units: { typeId: UnitTypeId; count: number }[] }[] = [];
  for (const order of moveOrders) {
    const counts = new Map<UnitTypeId, number>();
    for (const uid of order.unitInstanceIds) {
      const inst = G.map.systems[order.fromSystemId]?.units.find((u) => u.instanceId === uid);
      if (inst) counts.set(inst.typeId, (counts.get(inst.typeId) ?? 0) + 1);
      M.moveUnit(G, uid, order.fromSystemId, targetSystemId);
    }
    if (counts.size > 0) {
      reportMoves.push({
        fromSystemId: order.fromSystemId,
        units: [...counts.entries()].map(([typeId, count]) => ({ typeId, count })),
      });
    }
  }

  log(G, { kind: 'activate-system', side, payload: { leaderId, targetSystemId, orders: moveOrders.length } });

  // Combat check: if both sides have units in the target system, run combat.
  const opp: Side = side === 'Rebel' ? 'Empire' : 'Rebel';
  const ss = G.map.systems[targetSystemId];
  const oppHere = ss?.units.some((u) => u.side === opp) ?? false;
  const myHere = ss?.units.some((u) => u.side === side) ?? false;
  const willFight = oppHere && myHere;

  // Activation report (both sides). Only surface when something noteworthy
  // happened — units moved or a battle is starting — so a lone leader
  // repositioning doesn't spam a modal. Queued like the other reports; pushed
  // BEFORE combat so it sits ahead of any combat report this activation spawns.
  if (reportMoves.length > 0 || willFight) {
    (G.activationReports ??= []).push({
      side, leaderId, targetSystemId, moves: reportMoves, startedCombat: willFight,
      seq: G.turnLog.length,
    });
  }

  if (willFight) {
    // Source system: use the first move order's from, or the target itself if no moves.
    const src = moveOrders[0]?.fromSystemId ?? targetSystemId;
    beginCombat(G, side, src, targetSystemId);
    runCombat(G);
    // The command hand-off after a fight is done in finishCombatTail once combat
    // FULLY resolves — combat is resumable and pauses across rounds for player
    // choices. Advancing here would flip the turn mid-combat, or (if an
    // immediate-card flush inside advanceCommandTurn short-circuits) leave the
    // turn un-advanced entirely, so the same player goes again (#268).
    return { ok: true };
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

  // RoE "Subversion" — Oppose-timing missions don't reveal proactively;
  // they auto-fire from resolveOpposition when their owning side opposes
  // an enemy mission. Refuse a direct reveal so a player can't sidestep
  // the trigger by clicking Reveal at any system.
  if (SUBVERSION_MISSION_IDS.has(missionId)) {
    return { ok: false, reason: 'subversion-auto-triggers' };
  }

  // Skill check: sum of matching skill icons across assigned leaders must
  // meet card.skillCost. RoE rules p.8: minor icons count toward the
  // total too — totalSkill returns both halves.
  const need = card.skill;
  if (!need) return { ok: false, reason: 'mission-has-no-skill' };
  const skillCount = totalSkill(G, assigned.leaderIds, need);
  const total = skillCount.major + skillCount.minor;
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
    const attLeaders = attemptingLeadersAt(G, pending.resolverSide, pending.targetSystemId, pending.leaderIds as LeaderId[]);
    const attSkill = countsAll
      ? totalAllSkills(G, attLeaders)
      : totalSkill(G, attLeaders, skill);
    const attackerDice = attSkill.major + attSkill.minor
      + missionExtraAttackerDice(G, pending.missionId, pending.targetSystemId);

    // Subversion (#311): if the opposer has a Subversion mission assigned, using
    // it is a "may" — surface it so the opposer can choose (resolveOpposition's
    // useSubversion). Blindside suppresses it (the opposer is locked out).
    const subvAssigned = pending.blindsideActive ? undefined
      : oppFaction.leadersOnMissions.find((m) => SUBVERSION_MISSION_IDS.has(m.missionId));
    G.pendingChoice = {
      kind: 'OpposeMission',
      missionId: pending.missionId, targetSystemId: pending.targetSystemId, opposerSide: oppSide,
      skill, attackerDice,
      attackerPortrait: portraitBonus(G, pending.missionId, pending.leaderIds as LeaderId[]),
      poolLeaders: pool,
      existingAtTarget: existing,
      subversion: subvAssigned
        ? { missionId: subvAssigned.missionId, leaderIds: subvAssigned.leaderIds as LeaderId[] }
        : undefined,
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
        seq: G.turnLog.length,
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
    runMissionEffect(G, pending.resolverSide, pending.missionId, pending.targetSystemId, pending.leaderIds as LeaderId[], pending.targetLeaderId, pending.successMargin);
    if (G.pendingChoice) return { ok: true };
    discardOrReturnMission(G, pending.resolverSide, pending.missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
  } else if (pending.stage === 'failed') {
    // RoE "Post Bounty" (Empire/Jabba): after a Rebel mission fails, Empire
    // may discard the card to slap a bounty ring on one of the Rebel
    // leaders who attempted it. RAW also requires Jabba is accessible
    // (pool, on a mission, or on the board). The offer pauses cleanup;
    // resolvePostBountyOffer attaches the ring (or declines) and then runs
    // the same discard/advance tail.
    if (G.expansion?.enabled
        && pending.resolverSide === 'Rebel'
        && G.empire.actionHand.includes('post-bounty')
        && jabbaAccessible(G)
        && !G.pendingChoice) {
      const candidates = (pending.leaderIds as LeaderId[]).filter(
        (lid) => !G.leaderAttachments?.[lid]?.includes('bounty'),
      );
      if (candidates.length > 0) {
        G.pendingChoice = {
          kind: 'PostBountyOffer',
          side: 'Empire',
          missionId: pending.missionId,
          candidates,
        };
        log(G, { kind: 'choice-request', side: 'Empire', payload: {
          kind: 'PostBountyOffer', missionId: pending.missionId, candidates: candidates.length,
        }});
        return { ok: true };
      }
    }
    discardOrReturnMission(G, pending.resolverSide, pending.missionId);
    G.pendingMission = undefined;
    if (!G.isGameOver) advanceCommandTurn(G);
  }
  return { ok: true };
}

/** Is Jabba currently in play on the Empire side? (pool, on board, or
 *  assigned to a mission). Used by Post Bounty's offer gate. */
function jabbaAccessible(G: GameState): boolean {
  const e = G.empire;
  if (e.leaderPool.includes('jabba' as LeaderId)) return true;
  if (e.leadersOnMissions.some((m) => m.leaderIds.includes('jabba' as LeaderId))) return true;
  for (const board of Object.values(e.leadersOnBoard)) {
    if (board.includes('jabba' as LeaderId)) return true;
  }
  return false;
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
export function resolveOpposition(
  G: GameState, opposerLeaderId: LeaderId | null, useSubversion = true,
): { ok: boolean; reason?: string } {
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

  // RoE "Subversion" (Empire or Rebel, RoE Oppose-timing mission). When the
  // opposing side has Subversion (New or Original) assigned and CHOOSES to use
  // it (`useSubversion` — RAW "may", #311): the assigned leaders join the
  // opposition at the target system, the Subversion mission card discards, and
  // the opposition rolls +1 die. Both Subversion variants share the same effect;
  // they exist to match the active mission deck (New for roeMissions=on, Original
  // for off).
  let subversionBonus = 0;
  const opposerFaction = c.opposerSide === 'Rebel' ? G.rebel : G.empire;
  const subvAssigned = useSubversion
    ? opposerFaction.leadersOnMissions.find((m) => SUBVERSION_MISSION_IDS.has(m.missionId))
    : undefined;
  if (subvAssigned) {
    for (const lid of subvAssigned.leaderIds) {
      M.placeLeader(G, c.opposerSide, lid, pm.targetSystemId);
    }
    const i = opposerFaction.leadersOnMissions.indexOf(subvAssigned);
    if (i >= 0) opposerFaction.leadersOnMissions.splice(i, 1);
    opposerFaction.missionDiscard.push(subvAssigned.missionId);
    subversionBonus = 1;
    log(G, { kind: 'subversion-trigger', side: c.opposerSide, payload: {
      missionId: subvAssigned.missionId,
      leaderIds: subvAssigned.leaderIds,
      targetSystemId: pm.targetSystemId,
    }});
    noteIntervention(G, pm,
      `${c.opposerSide} played ${G.catalog.missions[subvAssigned.missionId]?.name ?? 'Subversion'}: ` +
      `moved their assigned leader${subvAssigned.leaderIds.length === 1 ? '' : 's'} to ` +
      `${G.catalog.systems[pm.targetSystemId]?.name ?? pm.targetSystemId} and rolled +1 die.`,
    );
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
  // RoE "Roll even if unopposed" missions (Plant Explosives, Assault) need
  // the resolver's success count to bound their effect ("destroy up to the
  // difference in successes"), so they roll against a 0-success opposer
  // instead of taking the free auto-success.
  const rollsEvenIfUnopposed = ROLL_EVEN_IF_UNOPPOSED.has(pm.missionId);
  if (oppLeaderIds.length === 0 && !rollsEvenIfUnopposed) {
    log(G, { kind: 'mission-unopposed', side: pm.resolverSide, payload: {
      missionId: pm.missionId,
      result: 'auto-success',
    }});
    G.missionReports.push({
      // Stamp queue-time ordering so the UI shows this report in true
      // chronological order relative to other queued reports (combat etc.).
      // The other three mission-report push sites set this; the unopposed
      // path was the only one missing it, so an unopposed mission sorted as
      // MAX_SAFE_INTEGER and could display out of order (#193, #178).
      seq: G.turnLog.length,
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
    const attLeaders = attemptingLeadersAt(G, pm.resolverSide, pm.targetSystemId, pm.leaderIds as LeaderId[]);
    const attSkillSplit = countsAll
      ? totalAllSkills(G, attLeaders)
      : totalSkill(G, attLeaders, skill);
    const attackerDice = attSkillSplit.major + attSkillSplit.minor
      + missionExtraAttackerDice(G, pm.missionId, pm.targetSystemId);
    const oppSkillSplit = countsAll
      ? totalAllSkills(G, oppLeaderIds as LeaderId[])
      : totalSkill(G, oppLeaderIds as LeaderId[], skill);
    // RoE Subversion adds 1 die to the opposition. Counted as a major die
    // (red/black per the standard split).
    const opposerDice = oppSkillSplit.major + oppSkillSplit.minor + subversionBonus;
    const att = rollMissionDice(G, attackerDice, attSkillSplit.minor, pm.resolverSide, pm.targetSystemId);
    const opp = rollMissionDice(G, opposerDice, oppSkillSplit.minor, c.opposerSide, pm.targetSystemId);
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
      portrait, oppLeaderIds as LeaderId[],
      pm.r2d2Pending.attColors, pm.r2d2Pending.oppColors);
    pm.r2d2Pending = undefined;
  }

  // Continue mission resolution.
  if (maybePostMissionRingTrigger(G, pm)) return { ok: true };
  if (pm.stage === 'effect') {
    runMissionEffect(G, pm.resolverSide, pm.missionId, pm.targetSystemId, pm.leaderIds as LeaderId[], pm.targetLeaderId, pm.successMargin);
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
  // Per-die colors (red/black/green) parallel to the faces arrays — lets the
  // report modal render RoE minor-skill GREEN dice as green (#minor-dice).
  attColors?: string[],
  oppColors?: string[],
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
    seq: G.turnLog.length,
    missionId: pm.missionId,
    resolverSide: pm.resolverSide,
    targetSystemId: pm.targetSystemId,
    attackerLeaders: [...pm.leaderIds] as LeaderId[],
    opposerSide: c.opposerSide,
    opposerLeaders: [...oppLeaderIds] as LeaderId[],
    skill,
    attackerDice: { count: Math.min(attackerDice, 10), faces: attFaces, colors: attColors, successes: attSuccesses },
    opposerDice: { count: Math.min(opposerDice, 10), faces: oppFaces, colors: oppColors, successes: oppSuccesses },
    portraitBonus: portrait,
    attackerTotal,
    result: succeeded ? 'success' : 'failure',
    interventions: pm.interventions ? [...pm.interventions] : undefined,
  });
  // RoE: record the winning margin for "destroy up to the difference in
  // successes" effects. Only meaningful on success; clamp >= 0.
  pm.successMargin = succeeded ? Math.max(0, attackerTotal - oppSuccesses) : 0;
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
  // The Rebel's OWN roll is the non-Empire side. Surface it (and the running
  // success tallies, INCLUDING the resolver's portrait bonus so the comparison
  // matches the real outcome) so the flip decision isn't made blind (forum
  // report). The portrait bonus belongs to the resolver = the attacker side.
  const rebelIsResolver = empireSide === 'opposer';
  const rebelFaces = empireSide === 'attacker' ? stash.oppFaces : stash.attFaces;
  const rebelSuccesses = (empireSide === 'attacker' ? stash.oppSuccesses : stash.attSuccesses)
    + (rebelIsResolver ? stash.portrait : 0);
  const empireSuccesses = (empireSide === 'attacker' ? stash.attSuccesses : stash.oppSuccesses)
    + (rebelIsResolver ? 0 : stash.portrait);
  G.pendingChoice = {
    kind: 'R2D2Flip',
    side: 'Rebel',
    context: 'mission',
    systemId: pm.targetSystemId,
    flippableDieIndices: flippable,
    missionFaces: [...empireFaces],
    ownFaces: [...rebelFaces],
    ownSuccesses: rebelSuccesses,
    empireSuccesses,
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
    stash.attColors, stash.oppColors,
  );
  pm.r2d2Pending = undefined;
  if (maybePostMissionRingTrigger(G, pm)) return;
  if (pm.stage === 'effect') {
    runMissionEffect(G, pm.resolverSide, pm.missionId, pm.targetSystemId, pm.leaderIds as LeaderId[], pm.targetLeaderId, pm.successMargin);
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
    stash.attColors, stash.oppColors,
  );
  pm.r2d2Pending = undefined;
  if (maybePostMissionRingTrigger(G, pm)) return { ok: true };
  if (pm.stage === 'effect') {
    runMissionEffect(G, pm.resolverSide, pm.missionId, pm.targetSystemId, pm.leaderIds as LeaderId[], pm.targetLeaderId, pm.successMargin);
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
    // Place orderedTop back on the chosen deck. orderedTop[0] is topmost, so
    // unshift in reverse to land [0] at index 0. Prepare For Battle targets a
    // base tactic deck; everything else the Rebel objective deck (#329).
    const deck =
      choice.deckKind === 'space-tactic' ? (G.spaceTacticDeck ??= []) :
      choice.deckKind === 'ground-tactic' ? (G.groundTacticDeck ??= []) :
      (G.rebel.objectiveDeck ??= []);
    for (let i = choice.orderedTop.length - 1; i >= 0; i--) {
      deck.unshift(choice.orderedTop[i]);
    }
    log(G, { kind: 'stolen-plans-reorder', side: choice.side, payload: { order: [...choice.orderedTop], deck: choice.deckKind ?? 'objective' } });
    G.pendingChoice = undefined;
    resumeMissionAfterChoice(G);
  }
  return { ok: true };
}

/** Prepare For Battle (base combat): the Rebel chose which tactic deck to peek;
 *  draw the top 4 and reorder them via the StolenPlansReorder modal (#329). */
export function resolvePrepareForBattleDeckPick(
  G: GameState, deckKind: 'space-tactic' | 'ground-tactic'
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'PrepareForBattleDeckPick') return { ok: false, reason: 'no-pending' };
  if (!choice.options.includes(deckKind)) return { ok: false, reason: 'not-an-option' };
  const deck = deckKind === 'space-tactic' ? (G.spaceTacticDeck ??= []) : (G.groundTacticDeck ??= []);
  const n = Math.min(4, deck.length);
  const drawn = deck.splice(0, n);
  if (drawn.length < 2) {
    // Nothing to reorder — put it back and finish the mission.
    for (let i = drawn.length - 1; i >= 0; i--) deck.unshift(drawn[i]);
    log(G, { kind: 'prepare-for-battle-peek', side: 'Rebel', payload: { deck: deckKind, cards: [...drawn] } });
    G.pendingChoice = undefined;
    resumeMissionAfterChoice(G);
    return { ok: true };
  }
  G.pendingChoice = {
    kind: 'StolenPlansReorder', side: 'Rebel', missionId: 'prepare-for-battle',
    remaining: drawn, orderedTop: [], deckKind,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'StolenPlansReorder', count: drawn.length, via: 'prepare-for-battle', deck: deckKind,
  }});
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

/** Behind Enemy Lines (Rebel, RoE): Rebel picks up to 5 units from the
 *  Rebel Base to move to the target, then combat resolves. Mirrors
 *  resolveLeadStrikeTeamUnits but isn't ground-restricted and reads the
 *  recorded source container (post-reveal aware). */
export function resolveBehindEnemyLinesUnits(G: GameState, unitIds: string[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'BehindEnemyLinesUnits') {
    return { ok: false, reason: 'no-pending-behind-enemy-lines' };
  }
  if (unitIds.length > choice.max) return { ok: false, reason: `too-many:${unitIds.length}/${choice.max}` };
  const seen = new Set<string>();
  for (const uid of unitIds) {
    if (!choice.availableUnitIds.includes(uid)) return { ok: false, reason: `illegal-unit:${uid}` };
    if (seen.has(uid)) return { ok: false, reason: `duplicate:${uid}` };
    seen.add(uid);
  }
  const { targetSystemId, sourceSystemId } = choice;
  // Behind Enemy Lines waives leaders and adjacency but NOT transport (#281):
  // ground units still need carrier capacity among the moved ships. Reject a
  // selection that can't be transported.
  const v = validateMoveOrderTransport(G, 'Rebel', { fromSystemId: sourceSystemId as SystemId, unitInstanceIds: unitIds });
  if (!v.ok) return { ok: false, reason: `transport:${v.reason}` };
  for (const uid of unitIds) M.moveUnit(G, uid, sourceSystemId, targetSystemId);
  log(G, { kind: 'behind-enemy-lines', side: 'Rebel', payload: {
    systemId: targetSystemId, moved: unitIds.length,
  }});
  G.pendingChoice = undefined;
  beginCombat(G, 'Rebel', sourceSystemId, targetSystemId);
  runCombat(G);
  if (G.pendingChoice || G.pendingCombat) return { ok: true };
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** We're the Bait (Empire, RoE): Empire picks Rebel ground units (combined
 *  health <= healthBudget) to drag from the Rebel Base to the target, then
 *  combat resolves. */
export function resolveWereTheBaitUnits(G: GameState, unitIds: string[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'WereTheBaitUnits') {
    return { ok: false, reason: 'no-pending-were-the-bait' };
  }
  const seen = new Set<string>();
  let totalHealth = 0;
  const container = choice.sourceSystemId === 'rebel-base-space'
    ? G.map.rebelBaseSpace : G.map.systems[choice.sourceSystemId];
  for (const uid of unitIds) {
    if (!choice.availableUnitIds.includes(uid)) return { ok: false, reason: `illegal-unit:${uid}` };
    if (seen.has(uid)) return { ok: false, reason: `duplicate:${uid}` };
    seen.add(uid);
    const u = container?.units.find((x) => x.instanceId === uid);
    if (!u) return { ok: false, reason: `unit-missing:${uid}` };
    totalHealth += G.catalog.unitTypes[u.typeId]?.health.value ?? 0;
  }
  if (totalHealth > choice.healthBudget) {
    return { ok: false, reason: `over-budget:${totalHealth}/${choice.healthBudget}` };
  }
  const { targetSystemId, sourceSystemId } = choice;
  for (const uid of unitIds) M.moveUnit(G, uid, sourceSystemId, targetSystemId);
  log(G, { kind: 'were-the-bait', side: 'Empire', payload: {
    systemId: targetSystemId, moved: unitIds.length, totalHealth,
  }});
  G.pendingChoice = undefined;
  beginCombat(G, 'Empire', sourceSystemId, targetSystemId);
  runCombat(G);
  if (G.pendingChoice || G.pendingCombat) return { ok: true };
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Under the Radar (Rebel, RoE): pick a probe from the peeked top 4 to
 *  hold facedown. It's removed from the deck; the others stay on top in
 *  their original order. */
export function resolveUnderTheRadarKeep(G: GameState, probeId: string): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'UnderTheRadarKeep') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(probeId)) return { ok: false, reason: 'not-a-candidate' };
  const idx = G.probeDeck.indexOf(probeId);
  if (idx < 0) return { ok: false, reason: 'probe-not-in-deck' };
  G.probeDeck.splice(idx, 1);
  G.rebel.heldProbe = probeId;
  log(G, { kind: 'under-the-radar-keep', side: 'Rebel', payload: { probeId } });
  const autoFlush = pc.autoFlush;
  const viaRecruit = pc.viaRecruit;
  G.pendingChoice = undefined;
  // Fired immediately on being recruited (#289): resume the paused recruit/
  // refresh flow so the rest of refresh proceeds.
  if (viaRecruit) return continueRecruitFlow(G);
  // Only when auto-triggered on draw: chain + continue the turn (manual play
  // just resolves the card without advancing).
  if (autoFlush) advanceCommandTurn(G);
  return { ok: true };
}

/** Under the Radar return offer: at the start of a Rebel Command turn, the
 *  Rebel may return the held probe to the top of the probe deck. */
export function resolveUnderTheRadarReturn(G: GameState, accept: boolean): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'UnderTheRadarReturn') return { ok: false, reason: 'no-pending' };
  if (accept && G.rebel.heldProbe) {
    G.probeDeck.unshift(G.rebel.heldProbe);
    log(G, { kind: 'under-the-radar-return', side: 'Rebel', payload: { probeId: G.rebel.heldProbe } });
    G.rebel.heldProbe = undefined;
  } else {
    log(G, { kind: 'under-the-radar-keep-holding', side: 'Rebel', payload: { probeId: G.rebel.heldProbe } });
  }
  G.pendingChoice = undefined;
  return { ok: true };
}

/** Post the Under the Radar return offer when a Rebel Command turn begins
 *  and the Rebel holds a facedown probe. Safe to call from turn-boundary
 *  hooks — no-ops if there's no held probe, it's not the Rebel's turn, or
 *  a choice is already pending. */
function maybeOfferUnderTheRadarReturn(G: GameState): void {
  if (G.phase !== 'Command') return;
  if (G.currentPlayer !== 'Rebel') return;
  if (!G.rebel.heldProbe) return;
  if (G.pendingChoice || G.pendingMission || G.pendingCombat) return;
  G.pendingChoice = { kind: 'UnderTheRadarReturn', side: 'Rebel', heldProbe: G.rebel.heldProbe };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'UnderTheRadarReturn', heldProbe: G.rebel.heldProbe,
  }});
}

/** Heist (Rebel/Jyn, RoE): resolve the player's choice. `action` is
 *  'draw' (take the top objective — only legal at a DS/DSUC) or
 *  'remove:<markerSource>' (remove that target marker). */
export function resolveHeistChoice(G: GameState, action: string): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'HeistChoice') return { ok: false, reason: 'no-pending' };
  if (action === 'draw') {
    if (!pc.canDrawObjective) return { ok: false, reason: 'draw-not-available' };
    M.drawObjective(G, 1);
    log(G, { kind: 'heist-draw-objective', side: 'Rebel', payload: { systemId: pc.systemId } });
  } else if (action.startsWith('remove:')) {
    const source = action.slice('remove:'.length);
    if (!pc.markerSources.includes(source)) return { ok: false, reason: 'marker-not-present' };
    // Raid Outposts scores +1 when grabbed via Heist; other markers just lift.
    if (source === 'raid-outposts-2') M.removeRaidOutpostMarker(G, pc.systemId);
    else M.removeTargetMarker(G, pc.systemId, source, 'Rebel');
  } else {
    return { ok: false, reason: `bad-action:${action}` };
  }
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Establish Trade Relations choice: 'loyalty' = gain 2 loyalty in the system;
 *  'cruiser' = place 1 Mon Calamari Cruiser on space 3 of the build queue. */
export function resolveEstablishTradeChoice(G: GameState, action: 'loyalty' | 'cruiser'): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'EstablishTradeChoice') return { ok: false, reason: 'no-pending' };
  G.pendingChoice = undefined;
  if (action === 'cruiser') {
    G.rebel.buildQueue[3].push('mon-cala-cruiser' as UnitTypeId);
    log(G, { kind: 'establish-trade-relations', side: 'Rebel', payload: {
      systemId: pc.systemId, chose: 'cruiser', slot: 3,
    }});
  } else {
    M.gainLoyalty(G, 'Rebel', pc.systemId, 2);
    log(G, { kind: 'establish-trade-relations', side: 'Rebel', payload: {
      systemId: pc.systemId, chose: 'loyalty', amount: 2,
    }});
  }
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Break Their Will (Empire, RoE): Empire named a system; reveal to the
 *  Empire whether the Rebel base is in that system's region. */
export function resolveBreakTheirWillPick(G: GameState, systemId: SystemId): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'BreakTheirWillPick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(systemId)) return { ok: false, reason: 'not-a-candidate' };
  const named = G.catalog.systems[systemId];
  const baseDef = G.catalog.systems[G.rebelBaseSystemId];
  const inRegion = !!named && !!baseDef && baseDef.region === named.region;
  log(G, { kind: 'break-their-will-probe', side: 'Empire', payload: {
    systemId, region: named?.region, baseInRegion: inRegion,
  }});
  pushNotice(G, `btw-${systemId}-t${G.timeMarker}`, 'Break Their Will',
    inRegion
      ? `The Rebel base IS in ${named?.name ?? systemId}'s region.`
      : `The Rebel base is NOT in ${named?.name ?? systemId}'s region.`);
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Imperial Might (Empire, RoE): Empire picks up to `max` units (by index
 *  into the slot-1 snapshot) to deploy at the target, then the 2-leaders →
 *  Coruscant clause runs. Indices reference the queueTypeIds snapshot; we
 *  remove the matching entries from the live build queue by value-and-count
 *  (each chosen index consumes one matching type id from slot 1). */
export function resolveImperialMightUnits(G: GameState, queueIndices: number[]): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'ImperialMightUnits') return { ok: false, reason: 'no-pending' };
  if (queueIndices.length > pc.max) return { ok: false, reason: `too-many:${queueIndices.length}/${pc.max}` };
  const seen = new Set<number>();
  for (const i of queueIndices) {
    if (i < 0 || i >= pc.queueTypeIds.length) return { ok: false, reason: `bad-index:${i}` };
    if (seen.has(i)) return { ok: false, reason: `duplicate:${i}` };
    seen.add(i);
  }
  const sysId = pc.targetSystemId;
  const slot1 = G.empire.buildQueue[1];
  const taken: string[] = [];
  // Remove one matching entry from the live queue per chosen index.
  for (const i of queueIndices) {
    const typeId = pc.queueTypeIds[i];
    const liveIdx = slot1.indexOf(typeId);
    if (liveIdx >= 0) { slot1.splice(liveIdx, 1); taken.push(typeId); }
  }
  for (const typeId of taken) M.deployUnit(G, 'Empire', typeId, sysId);
  log(G, { kind: 'imperial-might-deploy', side: 'Empire', payload: { systemId: sysId, unitTypes: taken } });
  // 2-leaders → Coruscant clause.
  if (pc.leaderIds.length >= 2) {
    for (const lid of pc.leaderIds) {
      M.returnLeader(G, 'Empire', lid);
      M.placeLeader(G, 'Empire', lid, 'coruscant');
    }
    log(G, { kind: 'imperial-might-move-leaders', side: 'Empire', payload: { leaderIds: [...pc.leaderIds] } });
  }
  G.pendingChoice = undefined;
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
  if (choice.unitCap != null && instanceIds.length > choice.unitCap) {
    return { ok: false, reason: `over-unit-cap:${instanceIds.length}/${choice.unitCap}` };
  }
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

/** Public Uprising: Rebel picks unit composition for 1 circle + 2 triangles.
 *  RAW: "gain 1 circle and 2 triangle units (ships and/or ground units)." So
 *  ANY Rebel unit of the matching icon shape is legal — not just a hardcoded
 *  pair. The old signature only permitted x-wing / rebel-trooper for the
 *  triangles, so a player couldn't take a Rebel Transport (also a triangle
 *  ship) — player report #205. Validate each pick against its required tier. */
export function resolvePublicUprisingPick(G: GameState, picks: {
  circle: string;
  triangles: string[];
}): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'PublicUprisingPick') return { ok: false, reason: 'no-pending' };
  if (picks.triangles.length !== 2) return { ok: false, reason: 'expected-2-triangles' };
  // RoE units are only buildable when the expansion's unit toggle is on — reject
  // them in a base game (regression #215: Public Uprising offered Nebulon-B etc.).
  const legal = (tid: string) => {
    const u = G.catalog.unitTypes[tid];
    return !!u && (u.set !== 'rote' || G.expansion?.roeUnits === true);
  };
  const tierOf = (tid: string) => G.catalog.unitTypes[tid]?.tier;
  if (tierOf(picks.circle) !== 'circle' || !legal(picks.circle)) return { ok: false, reason: `bad-circle-unit:${picks.circle}` };
  for (const t of picks.triangles) {
    if (tierOf(t) !== 'triangle' || !legal(t)) return { ok: false, reason: `bad-triangle-unit:${t}` };
  }
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

/** Trust in the Force: Rebel picks which triangle ground unit to destroy. The
 *  destroy is the card's final effect, so just apply it and clear (#316). */
export function resolveTrustInTheForceDestroyPick(G: GameState, instanceId: string): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'TrustInTheForceDestroyPick') return { ok: false, reason: 'no-pending' };
  if (!choice.candidates.includes(instanceId)) return { ok: false, reason: `bad-target:${instanceId}` };
  M.destroyUnit(G, instanceId, 'trust-in-the-force');
  G.pendingChoice = undefined;
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
  // RR p.11: draw and LOOK at the probe cards (4, or 8 with two leaders) BEFORE
  // deciding whether to establish a new base — the player gets this info either
  // way. If they keep the base, the drawn probes are shuffled to the bottom of
  // the deck (handled in resolveRapidMobilizationBranch).
  const n = next.twoLeaders ? 8 : 4;
  const drawnProbeIds = M.drawProbe(G, n);
  const baseCandidates = drawnProbeIds
    .map((pid) => G.catalog.probes[pid]?.systemId)
    .filter((s): s is SystemId => !!s)
    .filter((sid) => rebelBaseCandidateLegal(G, sid));
  log(G, { kind: 'rapid-mobilization-probe-draw', side: 'Rebel', payload: {
    count: n, twoLeaders: next.twoLeaders, drawnProbeIds,
  }});
  G.pendingChoice = {
    kind: 'RapidMobilizationBranch',
    side: 'Rebel',
    twoLeaders: next.twoLeaders,
    baseRevealed,
    moveUnitsAvailable: !baseRevealed,
    drawnProbeIds,
    baseCandidates,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'RapidMobilizationBranch', twoLeaders: next.twoLeaders, baseRevealed,
    endOfPhase: true, remaining: queue.length, drawnProbes: drawnProbeIds.length,
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
  const drawn = choice.drawnProbeIds ?? [];
  // RR p.11: "When the Rebel player chooses not to establish a new base, all
  // drawn probe cards are shuffled and placed on the bottom of the probe deck."
  const returnProbesToBottom = () => {
    if (drawn.length > 0) {
      G.probeDeck.push(...shuffle(G.rng, [...drawn]));
      log(G, { kind: 'rapid-mobilization-probes-to-bottom', side: 'Rebel', payload: {
        count: drawn.length,
      }});
    }
  };
  if (branch === 'move-units') {
    // Keep the base; the looked-at probes go to the bottom of the deck.
    returnProbesToBottom();
    G.pendingChoice = { kind: 'RapidMobilizationMovePick', side: 'Rebel' };
    log(G, { kind: 'choice-request', side: 'Rebel', payload: {
      kind: 'RapidMobilizationMovePick',
    }});
    return { ok: true };
  }
  // Establish a new Rebel Base from the already-drawn probes (the new base is
  // placed facedown, so it becomes HIDDEN regardless of the old base's state; a
  // system with Imperial loyalty/units or a destroyed marker cannot be chosen).
  const probeSystemIds = choice.baseCandidates ?? [];
  // RR: "If all cards drawn are systems that have Imperial loyalty, Imperial
  // units, or a destroyed system marker, the Rebel player cannot establish a
  // new base this round." Don't post a dead-end pick — the drawn probes go to
  // the bottom (no base established) and this RM ends.
  if (probeSystemIds.length === 0) {
    log(G, { kind: 'rapid-mobilization-base-no-legal-candidate', side: 'Rebel', payload: {
      twoLeaders, drawnCount: drawn.length,
    }});
    returnProbesToBottom();
    G.pendingChoice = undefined;
    finishRapidMobilization(G);
    return { ok: true };
  }
  G.pendingChoice = {
    kind: 'RapidMobilizationBasePick', side: 'Rebel',
    baseRevealed, probeSystemIds,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'RapidMobilizationBasePick', baseRevealed, candidates: probeSystemIds.length,
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
  // Moving units is OPTIONAL ("up to 5"): the player may keep the base and move
  // nothing. Don't require a valid source when no units are being moved — else a
  // Rebel with no eligible source system gets stuck unable to resolve the card
  // and keep their base (BGG report). The source only matters when units move.
  if (unitInstanceIds.length === 0) {
    log(G, { kind: 'rapid-mobilization-move-applied', side: 'Rebel', payload: {
      sourceSystemId: sourceSystemId || null, movedCount: 0, movedIds: [],
    }});
    G.pendingChoice = undefined;
    finishRapidMobilization(G);
    return { ok: true };
  }
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
  // Immobile units (structures) can never be moved by a move ability — even one
  // that ignores transport/adjacency. Reject so the player can't relocate a
  // Shield Generator / Ion Cannon / Golan Turret via Rapid Mobilization (BGG
  // report). They only move when the base itself is discovered.
  for (const uid of unitInstanceIds) {
    const u = src.units.find((x) => x.instanceId === uid);
    if (u && G.catalog.unitTypes[u.typeId]?.transport.immobile) {
      return { ok: false, reason: `immobile-unit:${u.typeId}` };
    }
  }
  // Transport capacity STILL applies. Rapid Mobilization's text only says it
  // ignores ADJACENCY, not transport restrictions — so per the general rule
  // ("he must follow all movement rules and restrictions ... must obey transport
  // capacity" unless an ability says "ignore transport restrictions"), ground
  // units and restriction-icon fighters need capital-ship capacity from the same
  // source (BGG report). This was unchecked.
  if (unitInstanceIds.length > 0) {
    const cap = validateMoveOrderTransport(G, 'Rebel', {
      fromSystemId: sourceSystemId, unitInstanceIds,
    });
    if (!cap.ok) return { ok: false, reason: cap.reason };
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

/** A system may NOT become the new Rebel Base if it has Imperial loyalty,
 *  Imperial units, or a destroyed-system marker (RR "Establishing a New Base"). */
function rebelBaseCandidateLegal(G: GameState, systemId: SystemId): boolean {
  const ss = G.map.systems[systemId];
  if (!ss) return false;
  if (ss.destroyed) return false;
  if (ss.loyalty === 'imperial') return false;
  if (ss.units.some((u) => u.side === 'Empire')) return false;
  return true;
}

/** Rapid Mobilization establish-base sub-pick: relocate the Rebel Base to the
 *  chosen system. RR: the new base is placed facedown, so it becomes HIDDEN —
 *  even when the old base was revealed. If the old base was revealed, its units
 *  and leaders (which sit in the actual old system) move back to the hidden
 *  "Rebel Base" space along with the relocation. */
export function resolveRapidMobilizationBasePick(
  G: GameState, systemId: SystemId
): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'RapidMobilizationBasePick') return { ok: false, reason: 'no-pending' };
  if (!choice.probeSystemIds || !choice.probeSystemIds.includes(systemId)) {
    return { ok: false, reason: 'not-a-drawn-probe-candidate' };
  }
  if (!rebelBaseCandidateLegal(G, systemId)) return { ok: false, reason: 'illegal-base-system' };
  const old = G.rebelBaseSystemId;
  const wasRevealed = !!G.rebelBaseRevealed;

  // RAW (rr p.11): "After establishing a new base, the Rebel player will not
  // have any units at the 'Rebel Base' space until he moves units to it or
  // deploys units there." So the base UNITS are LEFT BEHIND at the old
  // location; the new (hidden) base space starts EMPTY. Leaders still move
  // with the base into the hidden Rebel Base space. (Player report #191: the
  // old code carried all units along to the new base.)
  const oldSys = G.map.systems[old];
  if (wasRevealed) {
    // Revealed base: units already sit at the old system — leave them there.
    // Only the leaders return to the hidden "Rebel Base" space.
    const rebLeaders = G.rebel.leadersOnBoard[old] ?? [];
    if (rebLeaders.length > 0) {
      G.rebel.leadersOnBoard['rebel-base-space'] = [
        ...(G.rebel.leadersOnBoard['rebel-base-space'] ?? []),
        ...rebLeaders,
      ];
      delete G.rebel.leadersOnBoard[old];
    }
  } else {
    // Hidden base: units sit in the abstract "Rebel Base" space — drop them at
    // the (now-abandoned) old location so the new base starts empty. Leaders
    // stay in the base space and move with the base.
    if (oldSys && G.map.rebelBaseSpace.units.length > 0) {
      oldSys.units.push(...G.map.rebelBaseSpace.units);
      G.map.rebelBaseSpace.units = [];
    }
  }

  // RoE Show No Fear: its target marker sits on the old base system and is
  // removed when a new base is established. The objective is then spent —
  // discard it from hand so it can't re-place its marker and resume scoring.
  const snfSystems = M.systemsWithTargetMarker(G, 'show-no-fear-3');
  if (snfSystems.length > 0) {
    for (const sid of snfSystems) M.removeTargetMarker(G, sid, 'show-no-fear-3', 'Rebel');
    const hand = G.rebel.objectiveHand ?? [];
    const i = hand.indexOf('show-no-fear-3');
    if (i >= 0) {
      hand.splice(i, 1);
      (G.rebel.objectiveDiscard ??= []).push('show-no-fear-3');
    }
  }

  G.rebelBaseSystemId = systemId;
  G.rebelBaseRevealed = false; // new base is placed facedown — hidden again.
  // Base relocated → reset searched-ruled-out knowledge to systems that still
  // qualify (still subjugated / Imperial-loyal).
  M.resetEmpireSearchedForBaseMove(G);
  log(G, { kind: 'rapid-mobilization-base-established', side: 'Rebel', payload: {
    fromSystemId: old, toSystemId: systemId, baseRevealed: false, wasRevealed,
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
    // Son of Skywalker: Luke present + card in hand + Seek Yoda or Daring Rescue
    // in deck. The expansion mission deck swaps Daring Rescue for its RoE
    // equivalent, Critical Rescue, so accept that id too — otherwise only Seek
    // Yoda was ever offered in an expansion game (#296).
    const hasSoS = G.rebel.actionHand.includes('son-of-skywalker');
    const lukePresent = (pm.leaderIds as LeaderId[]).some((l) => l === 'luke-skywalker' || l === 'luke-skywalker-jedi');
    if (hasSoS && lukePresent) {
      const sosCandidates = G.rebel.missionDeck.filter(
        (mid) => mid === 'seek-yoda' || mid === 'daring-rescue' || mid === 'critical-rescue');
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
    runMissionEffect(G, pm.resolverSide, pm.missionId, pm.targetSystemId, pm.leaderIds as LeaderId[], pm.targetLeaderId, pm.successMargin);
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
    stash.attColors, stash.oppColors,
  );
  pm.r2d2Pending = undefined;
  if (maybePostMissionRingTrigger(G, pm)) return { ok: true };
  if (pm.stage === 'effect') {
    runMissionEffect(G, pm.resolverSide, pm.missionId, pm.targetSystemId, pm.leaderIds as LeaderId[], pm.targetLeaderId, pm.successMargin);
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

/** Post Bounty (Empire/Jabba, RoE Special): Empire picks one Rebel leader
 *  to bounty (attach 'bounty' ring), or declines (leaderId === null). The
 *  ring fires when the leader is later captured (mechanics.captureLeader),
 *  costing the Rebels 1 reputation. Either way, the failed-mission cleanup
 *  tail runs after the offer resolves. */
export function resolvePostBountyOffer(G: GameState, leaderId: LeaderId | null): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'PostBountyOffer') return { ok: false, reason: 'no-pending' };
  const pm = G.pendingMission;
  if (!pm) return { ok: false, reason: 'no-mission' };
  if (leaderId !== null) {
    if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
    const handIdx = G.empire.actionHand.indexOf('post-bounty');
    if (handIdx < 0) return { ok: false, reason: 'card-not-in-hand' };
    G.empire.actionHand.splice(handIdx, 1);
    G.empire.actionDiscard.push('post-bounty');
    M.attachRing(G, leaderId, 'bounty');
    log(G, { kind: 'post-bounty-applied', side: 'Empire', payload: {
      leaderId, missionId: pm.missionId,
    }});
  } else {
    log(G, { kind: 'post-bounty-skipped', side: 'Empire', payload: { missionId: pm.missionId } });
  }
  G.pendingChoice = undefined;
  // Run the same failed-mission cleanup tail as the inline branch above.
  discardOrReturnMission(G, pm.resolverSide, pm.missionId);
  G.pendingMission = undefined;
  if (!G.isGameOver) advanceCommandTurn(G);
  return { ok: true };
}

/** Regional Aid (Rebel, RoE): Rebel picks the "elsewhere in region"
 *  system to gain the second loyalty marker on. */
export function resolveRegionalAidPick(G: GameState, systemId: SystemId): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'RegionalAidPick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(systemId)) return { ok: false, reason: 'not-a-candidate' };
  M.gainLoyalty(G, 'Rebel', systemId, 1);
  log(G, { kind: 'regional-aid-second', side: 'Rebel', payload: {
    systemId, targetSystemId: pc.targetSystemId,
  }});
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

// ---- Superlaser Online destruction aftermath (#284 loyalty + #286 cull) ----

/** The Empire's ground at `sysId` that exceeds the transport capacity of its
 *  ships there — but only when there's a genuine CHOICE of which to lose, i.e.
 *  capacity > 0 (some survive) and the ground isn't all one interchangeable
 *  type. Returns null otherwise: capacity 0 (all ground lost) and no-excess are
 *  left to the destroySystem auto-cull invariant. RR p.7 "Destroyed Systems". */
function empireDestroyedCull(
  G: GameState, sysId: SystemId
): { candidates: UnitInstanceId[]; destroyCount: number } | null {
  const ss = G.map.systems[sysId];
  if (!ss || ss.destroyed) return null; // already destroyed → cull already applied
  const ground = ss.units.filter(
    (u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground');
  const capacity = ss.units
    .filter((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'space')
    .reduce((s, u) => s + (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0), 0);
  const excess = ground.length - capacity;
  if (excess <= 0 || capacity <= 0) return null;             // none survive a choice
  if (new Set(ground.map((u) => u.typeId)).size < 2) return null; // all same type → no real pick
  return { candidates: ground.map((u) => u.instanceId), destroyCount: excess };
}

/** Post the Empire's "choose which excess ground to lose" pick when a system is
 *  being destroyed and a genuine choice exists. Returns true (and pauses) if a
 *  choice was posted; false otherwise. Called BEFORE the system is destroyed so
 *  the auto-cull invariant (which only acts on destroyed systems) can't preempt
 *  the choice. (#286) */
export function postDestroyedSystemCull(G: GameState, sysId: SystemId): boolean {
  const cull = empireDestroyedCull(G, sysId);
  if (!cull) return false;
  G.pendingChoice = {
    kind: 'DestroyedSystemCull', side: 'Empire', systemId: sysId,
    candidates: cull.candidates, destroyCount: cull.destroyCount,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'DestroyedSystemCull', systemId: sysId, destroyCount: cull.destroyCount, candidates: cull.candidates.length,
  }});
  return true;
}

/** Destroy the system, then run the Superlaser loyalty pick (#284): post a
 *  SuperlaserLoyaltyPick for 2+ candidates, auto-apply for 1, no-op for 0.
 *  Sets G.pendingChoice when it pauses for the pick. Shared by the handler and
 *  the cull resolver. */
export function superlaserAftermath(G: GameState, sysId: SystemId): void {
  const sysDef = G.catalog.systems[sysId];
  M.destroySystem(G, sysId);
  if (G.isGameOver || !sysDef) return;
  const candidates = Object.values(G.catalog.systems)
    .filter((s) => s.id !== sysId && s.region === sysDef.region && !s.isRemote
      && !s.isCoruscant && !G.map.systems[s.id]?.destroyed)
    .map((s) => s.id);
  if (candidates.length === 0) return;
  if (candidates.length === 1) { M.gainLoyalty(G, 'Empire', candidates[0], 1); return; }
  G.pendingChoice = {
    kind: 'SuperlaserLoyaltyPick', side: 'Empire', candidates, destroyedSystemId: sysId,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'SuperlaserLoyaltyPick', candidates: candidates.length, destroyedSystemId: sysId,
  }});
}

/** Resolve the Empire's choice of which excess ground to lose when a system is
 *  destroyed (#286): destroy the chosen units, then finish the superlaser
 *  (destroy the system + loyalty pick), then resume the mission unless the
 *  loyalty pick is now pending. */
export function resolveDestroyedSystemCull(
  G: GameState, instanceIds: string[]
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'DestroyedSystemCull') return { ok: false, reason: 'no-pending' };
  if (instanceIds.length !== pc.destroyCount) return { ok: false, reason: `expected-${pc.destroyCount}-units` };
  const seen = new Set<string>();
  for (const uid of instanceIds) {
    if (!pc.candidates.includes(uid as never)) return { ok: false, reason: `not-a-candidate:${uid}` };
    if (seen.has(uid)) return { ok: false, reason: `duplicate:${uid}` };
    seen.add(uid);
  }
  const sysId = pc.systemId;
  for (const uid of instanceIds) M.destroyUnit(G, uid, 'destroyed-system-overflow');
  log(G, { kind: 'destroyed-system-cull', side: 'Empire', payload: {
    systemId: sysId, destroyed: instanceIds.length,
  }});
  G.pendingChoice = undefined;
  superlaserAftermath(G, sysId);
  if (!G.pendingChoice) resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Superlaser Online: the Empire picks which populous system in the region
 *  gains 1 Imperial loyalty (player #284). */
export function resolveSuperlaserLoyaltyPick(G: GameState, systemId: SystemId): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'SuperlaserLoyaltyPick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(systemId)) return { ok: false, reason: 'not-a-candidate' };
  M.gainLoyalty(G, pc.side, systemId, 1);
  log(G, { kind: 'superlaser-loyalty', side: pc.side, payload: {
    systemId, destroyedSystemId: pc.destroyedSystemId,
  }});
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Draw Them Out (Empire/Krennic, RoE): Empire picks which Rebel leader
 *  to pull from the pool and place at the target system. */
export function resolveDrawThemOutPick(G: GameState, leaderId: LeaderId): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'DrawThemOutPick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
  const pool = G.rebel.leaderPool;
  const idx = pool.indexOf(leaderId);
  if (idx < 0) return { ok: false, reason: 'leader-not-in-pool' };
  pool.splice(idx, 1);
  M.placeLeader(G, 'Rebel', leaderId, pc.systemId);
  log(G, { kind: 'draw-them-out', side: 'Empire', payload: {
    leaderId, systemId: pc.systemId,
  }});
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Reconnaissance (Rebel, RoE): pick a discarded mission to return to
 *  hand. */
export function resolveReconnaissancePick(G: GameState, missionId: string): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'ReconnaissancePick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(missionId)) return { ok: false, reason: 'card-not-in-pile' };
  const pile = G.rebel.missionDiscard;
  const idx = pile.indexOf(missionId);
  if (idx < 0) return { ok: false, reason: 'card-missing-from-discard' };
  const [recovered] = pile.splice(idx, 1);
  G.rebel.missionHand.push(recovered);
  log(G, { kind: 'reconnaissance-recover', side: 'Rebel', payload: { missionId: recovered } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** RoE mission recruit (Hire Mercenaries, Imperial/Rebel Promotion, My
 *  Only Hope) — when 2+ candidates were eligible, the player picks one
 *  here. The chosen leader is added to the pool and placed at the
 *  recorded system, mirroring the auto-resolution path in recruitAndPlace. */
export function resolveMissionRecruitLeaderPick(G: GameState, leaderId: LeaderId): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'MissionRecruitLeaderPick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
  const f = pc.side === 'Rebel' ? G.rebel : G.empire;
  f.leaderPool.push(leaderId);
  log(G, { kind: 'recruit-leader', side: pc.side, payload: { leaderId, via: pc.cause } });
  M.placeLeader(G, pc.side, leaderId, pc.systemId);
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Secret Mission (Rebel/Cassian, RoE): Rebel picks a mission from the
 *  peeked top 6 of the mission deck to add to hand. Resolves once
 *  `kept.length === keepCount`; remaining peeked cards then shuffle back
 *  into the deck. */
export function resolveSecretMissionPick(G: GameState, missionId: string): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'SecretMissionPick') return { ok: false, reason: 'no-pending' };
  const idx = pc.remaining.indexOf(missionId);
  if (idx < 0) return { ok: false, reason: 'card-not-in-peek' };
  const [taken] = pc.remaining.splice(idx, 1);
  pc.kept.push(taken);
  if (pc.kept.length >= pc.keepCount) {
    for (const mid of pc.kept) G.rebel.missionHand.push(mid);
    const deck = G.rebel.missionDeck;
    const rest = [...pc.remaining, ...deck];
    shuffle(G.rng, rest);
    G.rebel.missionDeck = rest;
    log(G, { kind: 'secret-mission', side: 'Rebel', payload: {
      kept: pc.kept, andor: pc.keepCount === 2,
    }});
    G.pendingChoice = undefined;
    resumeMissionAfterChoice(G);
  }
  return { ok: true };
}

/** Discredit Rebellion (Empire/Motti, RoE): Rebel chooses to wipe all
 *  sabotage markers off the board (avoids the rep-loss risk) or to roll
 *  dice — 2 dice with Motti, 1 otherwise. At least 1 special symbol on the
 *  roll loses the Rebel 1 reputation (RAW card text). */
export function resolveDiscreditRebellion(G: GameState, action: 'remove' | 'roll'): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'DiscreditRebellionChoice') return { ok: false, reason: 'no-pending' };
  G.pendingChoice = undefined;
  if (action === 'remove') {
    let removed = 0;
    for (const sid of pc.sabotageSystemIds) {
      const ss = G.map.systems[sid];
      if (ss?.sabotage) { ss.sabotage = false; removed++; }
    }
    log(G, { kind: 'discredit-rebellion-remove', side: 'Rebel', payload: {
      systemIds: pc.sabotageSystemIds, removed,
    }});
  } else {
    const faces: string[] = [];
    for (let i = 0; i < pc.diceCount; i++) faces.push(rollDie(G.rng, 'red').face);
    // RAW (card text): "If he rolls at least 1 special, he loses 1 reputation."
    // The trigger is the special symbol, NOT a hit/direct-hit.
    const special = faces.some((f) => f === 'special');
    log(G, { kind: 'discredit-rebellion-roll', side: 'Rebel', payload: { faces, special, diceCount: pc.diceCount } });
    if (special) M.loseReputation(G, 1);
  }
  resumeMissionAfterChoice(G);
  return { ok: true };
}

/** Ambitions of Power (Empire/Motti or Jabba, RoE Special): Empire accepts
 *  to discard the card for +1 leader-pool cap, or declines (the cap then
 *  eliminates as usual). After answering, re-run enforceLeaderPoolCap to
 *  apply the new cap (or proceed with the elimination). */
export function resolveAmbitionsOfPowerOffer(G: GameState, accept: boolean): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'AmbitionsOfPowerOffer') return { ok: false, reason: 'no-pending' };
  if (accept) {
    const handIdx = G.empire.actionHand.indexOf('ambitions-of-power');
    if (handIdx < 0) return { ok: false, reason: 'card-not-in-hand' };
    G.empire.actionHand.splice(handIdx, 1);
    G.empire.actionDiscard.push('ambitions-of-power');
    G.empire.leaderPoolCapBonus = (G.empire.leaderPoolCapBonus ?? 0) + 1;
    log(G, { kind: 'ambitions-of-power-applied', side: 'Empire', payload: {
      newCap: 8 + G.empire.leaderPoolCapBonus,
    }});
  } else {
    log(G, { kind: 'ambitions-of-power-skipped', side: 'Empire', payload: {} });
  }
  G.pendingChoice = undefined;
  // Re-enter the cap enforcement — on accept the bonus may now cover the pool;
  // on decline it posts the LeaderPoolEliminate choice.
  M.enforceLeaderPoolCap(G, 'Empire');
  return { ok: true };
}

/** Resolve the RoE leader-pool elimination choice: remove the chosen leader
 *  from the pool (RoE p.8 — the player picks which to eliminate), then re-run
 *  the cap so it re-posts if the side is still over, or chains to the other
 *  side. */
export function resolveLeaderPoolEliminate(G: GameState, leaderId: LeaderId): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'LeaderPoolEliminate') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'not-a-candidate' };
  const side = pc.side;
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const idx = f.leaderPool.indexOf(leaderId);
  if (idx >= 0) f.leaderPool.splice(idx, 1);
  (f.eliminatedLeaders ??= []).push(leaderId);
  log(G, { kind: 'leader-pool-cap-eliminate', side, payload: { leaderId, chosen: true } });
  G.pendingChoice = undefined;
  // Re-run this side's cap (re-posts if still over); if now at the cap, run the
  // other side's (which may have been deferred while this choice was pending).
  M.enforceLeaderPoolCap(G, side) || M.enforceLeaderPoolCap(G, side === 'Rebel' ? 'Empire' : 'Rebel');
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
      seq: G.turnLog.length,
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
    // RoE units are only buildable when the expansion's unit toggle is on —
    // reject them in a base game (same class as regression #215; the AI was
    // picking an Assault Tank for a ground-triangle icon, player #219).
    if (t.set === 'rote' && G.expansion?.roeUnits !== true) return { ok: false, reason: `roe-unit-in-base-game:${tid}` };
    if (PROJECT_ONLY_UNIT_IDS.has(tid)) return { ok: false, reason: `project-only:${tid}` };
    if (t.theater !== icon.theater) return { ok: false, reason: `theater-mismatch:${tid}` };
    const need = tierRank[icon.shape] ?? 2;
    const have = tierRank[t.tier ?? 'square'] ?? 2;
    // EXACT tier — a resource icon builds a unit of THAT size (rules ref
    // "Resource Icons"); you can't downgrade to a smaller unit (player #214).
    if (have !== need) return { ok: false, reason: `tier-mismatch:${tid}` };
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
  f.leadersOnMissions.push({ missionId, leaderIds: ['princess-leia'], fromDeck: true, viaCard: 'our-most-desperate-hour' });
  log(G, { kind: 'our-most-desperate-hour-applied', side: 'Rebel', payload: {
    missionId, leaderId: 'princess-leia',
  }});
  // FFG FAQ (May 2019): used during Assignment, so the Rebel MAY add a second
  // leader to this mission (#309). Offer it; the resolver clears the choice.
  maybeOfferSecondLeader(G, 'Rebel', missionId, 'Our Most Desperate Hour');
  return { ok: true };
}

/** FFG FAQ (May 2019): an Assignment-phase ability that places a leader on a
 *  mission (OMDH, Proceeding As Planned) lets the player assign a SECOND leader
 *  to it. Posts an AssignSecondLeaderPick when the side has a pool leader to add;
 *  otherwise clears the pending choice. (#309) */
function maybeOfferSecondLeader(G: GameState, side: Side, missionId: string, cardName: string): void {
  const f = faction(G, side);
  const candidates = [...f.leaderPool];
  if (candidates.length === 0) { G.pendingChoice = undefined; return; }
  G.pendingChoice = { kind: 'AssignSecondLeaderPick', side, missionId, candidates, cardName };
  log(G, { kind: 'choice-request', side, payload: {
    kind: 'AssignSecondLeaderPick', missionId, candidates: candidates.length, cardName,
  }});
}

/** Resolve the optional second-leader assignment (#309). `leaderId === null`
 *  declines; otherwise commit that pool leader to the named mission (max 2). */
export function resolveAssignSecondLeader(
  G: GameState, leaderId: LeaderId | null
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'AssignSecondLeaderPick') return { ok: false, reason: 'no-pending' };
  if (leaderId !== null) {
    if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'not-a-candidate' };
    const f = faction(G, pc.side);
    const i = f.leaderPool.indexOf(leaderId);
    if (i < 0) return { ok: false, reason: 'leader-not-in-pool' };
    const am = f.leadersOnMissions.find((m) => m.missionId === pc.missionId);
    if (!am) return { ok: false, reason: 'mission-not-assigned' };
    if (am.leaderIds.length >= 2) return { ok: false, reason: 'already-two-leaders' };
    f.leaderPool.splice(i, 1);
    am.leaderIds.push(leaderId);
    log(G, { kind: 'assign-leader', side: pc.side, payload: {
      missionId: pc.missionId, leaderIds: [leaderId], via: pc.cardName,
    }});
  } else {
    log(G, { kind: 'choice-cancel', side: pc.side, payload: { kind: 'AssignSecondLeaderPick' } });
  }
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
  f.leadersOnMissions.push({ missionId, leaderIds: [leaderId], fromDeck: true, viaCard: 'proceeding-as-planned' });
  log(G, { kind: 'proceeding-as-planned-applied', side: 'Empire', payload: {
    missionId, leaderId,
  }});
  // FFG FAQ (May 2019): Assignment-phase ability → the Empire MAY add a second
  // leader to this project (#309).
  maybeOfferSecondLeader(G, 'Empire', missionId, 'Proceeding As Planned');
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
    // RoE units only buildable when the expansion's unit toggle is on (#219).
    if (t.set === 'rote' && G.expansion?.roeUnits !== true) return { ok: false, reason: `roe-unit-in-base-game:${tid}` };
    if (t.theater !== icon.theater) return { ok: false, reason: `theater-mismatch:${tid}` };
    const need = tierRank[icon.shape] ?? 2;
    const have = tierRank[t.tier ?? 'square'] ?? 2;
    // EXACT tier — a resource icon builds a unit of THAT size (rules ref
    // "Resource Icons"); you can't downgrade to a smaller unit (player #214).
    if (have !== need) return { ok: false, reason: `tier-mismatch:${tid}` };
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
    // RoE units only buildable when the expansion's unit toggle is on (#219).
    if (t.set === 'rote' && G.expansion?.roeUnits !== true) return { ok: false, reason: `roe-unit-in-base-game:${tid}` };
    if (PROJECT_ONLY_UNIT_IDS.has(tid)) return { ok: false, reason: `project-only:${tid}` };
    if (t.theater !== icon.theater) return { ok: false, reason: `theater-mismatch:${tid}` };
    // Structures (Shield Generator, Ion Cannon, Golan Turret) ARE buildable from
    // resource icons — they carry a ground build icon per the printed components
    // (#161), the normal Refresh build offers them, and Temporary Alliance's
    // resolver already allows them. This path wrongly rejected them, so missions
    // like Establish Trade / Construct Factory couldn't build a structure on an
    // (orange) ground-square icon (player report #209). Tier check below already
    // keeps them to the right-sized icon.
    const need = tierRank[icon.shape] ?? 2;
    const have = tierRank[t.tier ?? 'square'] ?? 2;
    // EXACT tier — a resource icon builds a unit of THAT size (rules ref
    // "Resource Icons"); you can't downgrade to a smaller unit (player #214).
    if (have !== need) return { ok: false, reason: `tier-mismatch:${tid}` };
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

/** RoE Safe Haven — deploy the chosen build-queue units (0..2) to the mission
 *  system, then resume. `pickedIndices` are indices into the choice's `units`
 *  list; up to 2, duplicates ignored. An empty list = "take none" (legal —
 *  the card is "up to 2"). */
export function resolveSafeHavenPick(G: GameState, pickedIndices: number[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'SafeHavenPick') return { ok: false, reason: 'no-pending-safe-haven' };
  const picks = [...new Set(pickedIndices)].filter((i) => i >= 0 && i < choice.units.length).slice(0, 2);
  // Resolve the picks to {slot, typeId}, then remove them from the queue
  // highest-index-first within each slot so earlier indices stay valid.
  const chosen = picks.map((i) => choice.units[i]);
  for (const slot of [1, 2, 3] as const) {
    const idxs = chosen.filter((u) => u.slot === slot).map((u) => u.index).sort((a, b) => b - a);
    for (const idx of idxs) G.rebel.buildQueue[slot].splice(idx, 1);
  }
  const deployed: string[] = [];
  for (const u of chosen) { M.deployUnit(G, 'Rebel', u.typeId, choice.systemId); deployed.push(u.typeId); }
  log(G, { kind: 'safe-haven-deploy', side: 'Rebel', payload: { systemId: choice.systemId, unitTypes: deployed } });
  G.pendingChoice = undefined;
  resumeMissionAfterChoice(G);
  return { ok: true };
}

function runMissionEffect(G: GameState, side: Side, missionId: string, targetSystemId: SystemId, leaderIds: LeaderId[], targetLeaderId?: LeaderId, successMargin?: number): void {
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
  const ctx = Handlers.makeContext(side, { kind: 'mission', id: missionId }, { targetSystemId, targetLeaderId, leaderIds, successMargin });
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

  // RoE Cinematic Confrontation: eliminate Imperial leaders marked during this
  // Command phase (their last ground unit fell while the Rebel held the card).
  if (G.cinematicMarkedForElimination && G.cinematicMarkedForElimination.length > 0) {
    for (const leaderId of G.cinematicMarkedForElimination) {
      M.eliminateLeader(G, 'Empire', leaderId);
      log(G, { kind: 'cinematic-confrontation-eliminate', side: 'Rebel', payload: { leaderId } });
    }
    G.cinematicMarkedForElimination = [];
  }

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

  // Pre-step: persistent RoE objectives (Show No Fear / Raid Outposts scoring,
  // then Raid Outposts / Rebel Cell placement, then the Rebel Cell discard
  // option). This resumable machine may PAUSE on a placement/discard choice
  // (resolved via resolveRaidOutpostsPlace / resolveRebelCellPlace /
  // resolveRebelCellDiscard, which re-enter and continue).
  G.refreshPreStep = 0;
  G.refreshRebelCellDiscardTaken = false;
  if (advanceRefreshPreSteps(G, logStart)) return;
  if (G.isGameOver) return;

  // Then the one-shot StartOfRefresh objective step (rr p.10 — Rebel may play
  // one objective at start of Refresh). May PAUSE via resolvePlayObjectivePick.
  runOneShotObjectivesThenContinue(G, logStart);
}

/** Steps 1–6 of the Refresh phase, after the start-of-refresh objective step.
 *  Split out so it can resume after the objective choice paused. */
function continueRefreshAfterObjectives(G: GameState, logStart: number): void {
  // Step 1: Retrieve leaders
  refreshRetrieveLeaders(G);
  if (G.isGameOver) return;

  // Step 2: Draw missions (down to limit). PAUSES if a side must choose which
  // cards to discard over the 10-card limit; resumes via resolveHandLimitDiscard
  // → continueRefreshAfterMissionDraw.
  if (refreshDrawMissions(G, logStart)) return;

  continueRefreshAfterMissionDraw(G, logStart);
}

/** Refresh steps 3-4, after the mission draw (split out so the hand-limit
 *  discard choice can pause between step 2 and step 3). */
function continueRefreshAfterMissionDraw(G: GameState, logStart: number): void {
  // Step 3: Launch probe droids
  M.drawProbe(G, 2);

  // Step 4: Draw objective
  M.drawObjective(G, 1);
  if (G.isGameOver) return;
  // RoE: an Immediate objective just drawn (Raid Outposts / Rebel Cell) reveals
  // and resolves now — pause for its placement choice, resume at step 5.
  if (flushImmediateObjectiveActivations(G, 'refresh-draw')) return;

  continueRefreshAfterObjectiveDraw(G, logStart);
}

/** Refresh steps 5-6, after the objective draw (split out so an Immediate
 *  objective's placement choice can pause between step 4 and step 5). */
function continueRefreshAfterObjectiveDraw(G: GameState, logStart: number): void {
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
  // RoE leader-pool cap (rules p.8): a player can have at most 8 leaders in
  // their pool. Refresh is the natural enforcement point — leaders return from
  // missions/board in step 1 and any recruit lands in step 5. Over the cap, the
  // player CHOOSES which leader to eliminate: enforceLeaderPoolCap posts a
  // LeaderPoolEliminate choice (resolved during Assignment, like the Ambitions
  // offer) and the resolver re-runs the cap until both sides are at the limit.
  // The second call is a no-op while the first side's choice is pending (the
  // !pendingChoice guard); the resolver chains to the other side. No-op when
  // expansion.enabled is false.
  M.enforceLeaderPoolCap(G, 'Rebel');
  M.enforceLeaderPoolCap(G, 'Empire');
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
  reb.seq = G.turnLog.length; emp.seq = G.turnLog.length;
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
  // RoE action-cost objectives apply a side-effect when scored.
  applyObjectiveScoreSideEffect(G, objectiveId);
  log(G, { kind: 'play-objective', side: 'Rebel', payload: {
    objectiveId, reputation: rep,
  }});
  M.recordObjectiveScored(G, objectiveId, rep, 'refresh', G.turnLog.length);
  M.gainReputation(G, rep);
}

/** Side-effects applied when an RoE action-cost objective is scored. The card
 *  has already been removed from hand by the caller. Exported for tests. */
export function applyObjectiveScoreSideEffect(G: GameState, objectiveId: string): void {
  if (objectiveId === 'the-long-war-1') {
    // Discard 2 other objective cards from hand. Player choice in RAW; the
    // card is opt-in so auto-discarding the first two others is acceptable
    // for auto-play. (A future UI prompt could let the player pick which.)
    const hand = G.rebel.objectiveHand ?? [];
    const discarded: string[] = [];
    for (let i = hand.length - 1; i >= 0 && discarded.length < 2; i--) {
      discarded.push(hand.splice(i, 1)[0]);
    }
    if (!G.rebel.objectiveDiscard) G.rebel.objectiveDiscard = [];
    G.rebel.objectiveDiscard.push(...discarded);
    log(G, { kind: 'the-long-war-discard', side: 'Rebel', payload: { discarded } });
  } else if (objectiveId === 'a-time-for-peace-2') {
    // Destroy 2 triangle + 1 circle + 1 square units from the REBEL's OWN build
    // queue (the disarmament cost to play the card — #341). Remove high-index-
    // first within each slot so earlier indices stay valid as we splice.
    const targets = timeForPeaceQueueTargets(G);
    if (targets) {
      const destroyed: string[] = [];
      const bySlot = new Map<1 | 2 | 3, number[]>();
      for (const t of targets) {
        const arr = bySlot.get(t.slot) ?? [];
        arr.push(t.index);
        bySlot.set(t.slot, arr);
        destroyed.push(t.typeId);
      }
      for (const [slot, indices] of bySlot) {
        indices.sort((a, b) => b - a);
        for (const idx of indices) G.rebel.buildQueue[slot].splice(idx, 1);
      }
      log(G, { kind: 'a-time-for-peace-destroy', side: 'Rebel', payload: { destroyed } });
    }
  }
}

/** Show No Fear (persistent): on first activation place a target marker at the
 *  Rebel Base's system; each Refresh the marker stands, gain 1 reputation. The
 *  marker is removed (and the spent card discarded) when the base relocates
 *  (see establishBase). Exported for tests. Non-pausing. */
export function processPersistentObjectives(G: GameState): void {
  const hand = G.rebel.objectiveHand ?? [];
  if (hand.includes('show-no-fear-3')) {
    // RAW (card): "If the marker is still present AT THE START of each Refresh
    // phase, gain 1 reputation." The Refresh in which the marker is first
    // placed does NOT score — the marker was not present at the start of it.
    // So decide scoring on the board state at entry, THEN place if missing.
    const presentAtStart = M.systemsWithTargetMarker(G, 'show-no-fear-3').length > 0;
    if (presentAtStart) {
      M.recordObjectiveScored(G, 'show-no-fear-3', 1, 'refresh', G.turnLog.length);
      log(G, { kind: 'show-no-fear-score', side: 'Rebel', payload: { reputation: 1 } });
      M.gainReputation(G, 1);
    } else {
      // First Refresh the objective is in hand: place the marker on the base
      // system. Scoring begins next Refresh. (When the base later moves the
      // marker is removed and the objective discarded, so it never re-places.)
      const baseSys = G.rebelBaseSystemId;
      if (baseSys && !M.hasTargetMarker(G, baseSys, 'show-no-fear-3')) {
        M.placeTargetMarker(G, baseSys, 'show-no-fear-3', 'Rebel');
      }
    }
  }
}

/** Raid Outposts (persistent): for each of the card's target markers, the Rebel
 *  "raids" the outpost when it satisfies the general RoE target-marker removal
 *  rule (rulebook p.8) — the Rebel has a GROUND unit in the system AND the
 *  opponent has NO ground units there. Then remove the marker and gain 1
 *  reputation. Non-pausing. (Heist can also remove one; see the heist handler.)
 *  Exported for tests. */
export function scoreRaidOutposts(G: GameState): void {
  if (!(G.rebel.objectiveHand ?? []).includes('raid-outposts-2')) return;
  for (const sid of M.systemsWithTargetMarker(G, 'raid-outposts-2')) {
    const units = G.map.systems[sid]?.units ?? [];
    const hasRebelGround = units.some(
      (u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground',
    );
    // RAW: you only remove a target marker if your opponent has NO ground units
    // in the system.
    const hasEmpireGround = units.some(
      (u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground',
    );
    if (!hasRebelGround || hasEmpireGround) continue;
    M.removeRaidOutpostMarker(G, sid); // removes marker + scores +1
    if (G.isGameOver) return;
  }
}

/** Has Raid Outposts been activated (its 2 markers placed)? Tracked via an
 *  explicit flag because the markers are later removed as they score. */
function persistentActivated(G: GameState, objectiveId: string): boolean {
  return (G.rebel.activatedPersistentObjectives ?? []).includes(objectiveId);
}
function markPersistentActivated(G: GameState, objectiveId: string): void {
  const list = (G.rebel.activatedPersistentObjectives ??= []);
  if (!list.includes(objectiveId)) list.push(objectiveId);
}

/** RoE p.8: an objective card with "Immediate" at the top is revealed and
 *  resolved when DRAWN into the Rebel's hand. The two Immediate objectives —
 *  Raid Outposts (the Imperial places 2 markers in remotes) and Rebel Cell
 *  (the Rebel places 1 marker in a Rebel system) — place their target markers.
 *  This scans the hand for an un-activated Immediate objective and posts its
 *  placement choice (tagged with `resumeKind` so the resolver knows how to
 *  continue). Returns true if it posted a choice (the caller must pause/return).
 *  Called at the top of advanceCommandTurn (Command-phase + setup draws) and
 *  after the Refresh draw step. Activates one at a time; chains via the
 *  resolver. */
export function flushImmediateObjectiveActivations(G: GameState, resumeKind: import('./types').ImmediateResume): boolean {
  if (G.pendingChoice) return false; // never stack on an open choice
  const hand = G.rebel.objectiveHand ?? [];
  // Raid Outposts — the IMPERIAL player places 2 markers in remote systems.
  if (hand.includes('raid-outposts-2') && !persistentActivated(G, 'raid-outposts-2')) {
    const remotes = Object.keys(G.map.systems).filter(
      (id) => G.catalog.systems[id]?.isRemote && !G.map.systems[id].destroyed,
    );
    if (remotes.length >= 2) {
      markPersistentActivated(G, 'raid-outposts-2');
      G.pendingChoice = { kind: 'RaidOutpostsPlace', side: 'Empire', legal: remotes, count: 2, logStart: G.turnLog.length, resumeKind };
      log(G, { kind: 'choice-request', side: 'Empire', payload: { kind: 'RaidOutpostsPlace', count: 2 } });
      return true;
    }
    // Fewer than 2 remotes (essentially never): revealed but can't place.
    markPersistentActivated(G, 'raid-outposts-2');
  }
  // Rebel Cell — the Rebel places 1 marker in a Rebel-loyalty system.
  if (hand.includes('rebel-cell-2') && !persistentActivated(G, 'rebel-cell-2')) {
    const rebelSystems = Object.entries(G.map.systems)
      .filter(([, ss]) => ss.loyalty === 'rebel' && !ss.destroyed)
      .map(([id]) => id);
    if (rebelSystems.length >= 1) {
      markPersistentActivated(G, 'rebel-cell-2');
      G.pendingChoice = { kind: 'RebelCellPlace', side: 'Rebel', legal: rebelSystems, logStart: G.turnLog.length, resumeKind };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: { kind: 'RebelCellPlace' } });
      return true;
    }
    // RAW: an Immediate objective resolves WHEN DRAWN. With no Rebel-loyalty
    // system to place the marker in, the ability simply has no effect (no
    // marker). Mark it resolved so it never fires later at a surprising moment
    // once a Rebel system happens to appear mid-Command (#262). Mirrors the
    // raid-outposts-2 "can't place → still activated" handling above.
    markPersistentActivated(G, 'rebel-cell-2');
    log(G, { kind: 'objective-immediate-no-target', side: 'Rebel', payload: {
      objectiveId: 'rebel-cell-2', reason: 'no-rebel-system',
    }});
  }
  return false;
}

/** RoE: action cards with "Immediate" timing resolve when they're in hand and
 *  playable — they are NOT held for a manual play (player reports #233/#234/#235:
 *  Immediate cards like Rebel Extremist / Under the Radar persisted instead of
 *  triggering on draw). Mirrors flushImmediateObjectiveActivations: triggers the
 *  current player's first playable Immediate "resolve-now" action card (removing
 *  it from hand and applying its effect, which may post a sub-choice), draining
 *  any that resolve inline. The Empire arm cards (Secret Facility / Sweep the
 *  Area) keep their own arm/reveal flow and are excluded here. Returns true if it
 *  posted a choice — the caller must pause/return; the matching resolver then
 *  re-enters advanceCommandTurn to chain and continue. */
const ARM_IMMEDIATE_CARDS = new Set(['secret-facility', 'sweep-the-area']);
export function flushImmediateActionCards(G: GameState): boolean {
  while (!G.pendingChoice && !G.isGameOver) {
    const side = G.currentPlayer;
    const f = faction(G, side);
    const cardId = playableImmediateActionCards(G, side).find((cid) => !ARM_IMMEDIATE_CARDS.has(cid));
    if (!cardId) return false;
    const i = f.actionHand.indexOf(cardId);
    if (i < 0) return false;
    f.actionHand.splice(i, 1);
    f.actionDiscard.push(cardId);
    log(G, { kind: 'action-card-play', side, payload: { cardId, leaderId: null, systemId: null, timing: 'Immediate' } });
    applyImmediateActionCardEffect(G, side, cardId, /*viaFlush*/ true);
  }
  return !!G.pendingChoice;
}

/** Resumable Refresh pre-step machine: runs the persistent-objective sequence
 *  (Show No Fear + Raid Outposts scoring, then Raid Outposts / Rebel Cell
 *  placement, then the Rebel Cell discard option) before the one-shot objective
 *  step. Returns true if it posted a choice and PAUSED — the matching resolver
 *  re-enters via advanceRefreshPreSteps to continue. The cursor on G survives
 *  the pause so non-pausing scoring runs exactly once per Refresh. Exported
 *  for tests. */
export function advanceRefreshPreSteps(G: GameState, logStart: number): boolean {
  G.refreshPreStep ??= 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    switch (G.refreshPreStep) {
      case 0:
        processPersistentObjectives(G); // Show No Fear place + score
        if (G.isGameOver) return false;
        G.refreshPreStep = 1; break;
      case 1:
        scoreRaidOutposts(G); // remove markers raided by Rebel ground units, score
        if (G.isGameOver) return false;
        G.refreshPreStep = 2; break;
      case 2: {
        // Rebel Cell's recurring "discard 1 objective to gain 1 reputation"
        // (placement now happens on draw — flushImmediateObjectiveActivations).
        const hand = G.rebel.objectiveHand ?? [];
        const markerPresent = M.systemsWithTargetMarker(G, 'rebel-cell-2').length > 0;
        const discardable = hand.filter((id) => id !== 'rebel-cell-2');
        if (hand.includes('rebel-cell-2') && markerPresent && discardable.length >= 1) {
          G.pendingChoice = { kind: 'RebelCellDiscard', side: 'Rebel', legal: discardable, logStart };
          log(G, { kind: 'choice-request', side: 'Rebel', payload: { kind: 'RebelCellDiscard', legal: discardable } });
          return true;
        }
        G.refreshPreStep = 3; break;
      }
      default:
        return false; // all pre-steps done
    }
  }
}

/** After pre-steps complete, run the one-shot StartOfRefresh objective step
 *  (unless Rebel Cell's discard already replaced it this Refresh) and continue
 *  the Refresh. Shared by enterRefreshPhase and the pre-step resolvers. */
function runOneShotObjectivesThenContinue(G: GameState, logStart: number): void {
  if (G.refreshRebelCellDiscardTaken) {
    G.refreshRebelCellDiscardTaken = false;
    continueRefreshAfterObjectives(G, logStart);
    return;
  }
  if (refreshPlayStartOfRefreshObjectives(G, logStart)) return;
  if (G.isGameOver) return;
  continueRefreshAfterObjectives(G, logStart);
}

/** Resolve Raid Outposts placement: the Imperial picks `count` remote systems
 *  to receive the card's target markers. */
export function resolveRaidOutpostsPlace(
  G: GameState, systemIds: SystemId[]
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'RaidOutpostsPlace') return { ok: false, reason: 'no-pending' };
  const uniq = [...new Set(systemIds)];
  if (uniq.length !== pc.count) return { ok: false, reason: 'wrong-count' };
  if (!uniq.every((s) => pc.legal.includes(s))) return { ok: false, reason: 'illegal-system' };
  const logStart = pc.logStart ?? G.turnLog.length;
  const resumeKind = pc.resumeKind ?? 'command';
  for (const sid of uniq) M.placeTargetMarker(G, sid, 'raid-outposts-2', 'Empire');
  markPersistentActivated(G, 'raid-outposts-2');
  G.pendingChoice = undefined;
  resumeAfterImmediateObjective(G, resumeKind, logStart);
  return { ok: true };
}

/** Resume after an Immediate objective's placement choice resolves, dispatching
 *  on where it was drawn. */
function resumeAfterImmediateObjective(G: GameState, resumeKind: import('./types').ImmediateResume, logStart: number): void {
  if (G.isGameOver) return;
  if (resumeKind === 'refresh-draw') {
    continueRefreshAfterObjectiveDraw(G, logStart);
  } else {
    // 'command' — re-enter advanceCommandTurn, which re-flushes any further
    // un-activated Immediate objective, then advances the turn.
    advanceCommandTurn(G);
  }
}

/** Resolve Rebel Cell placement: the Rebel picks the Rebel system to mark. */
export function resolveRebelCellPlace(
  G: GameState, systemId: SystemId
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'RebelCellPlace') return { ok: false, reason: 'no-pending' };
  if (!pc.legal.includes(systemId)) return { ok: false, reason: 'illegal-system' };
  const logStart = pc.logStart ?? G.turnLog.length;
  const resumeKind = pc.resumeKind ?? 'command';
  M.placeTargetMarker(G, systemId, 'rebel-cell-2', 'Rebel');
  markPersistentActivated(G, 'rebel-cell-2');
  G.pendingChoice = undefined;
  resumeAfterImmediateObjective(G, resumeKind, logStart);
  return { ok: true };
}

/** Resolve Rebel Cell's discard option: discard the chosen objective for +1
 *  reputation, or decline (objectiveId = null). Taking it replaces playing a
 *  one-shot objective this Refresh. */
export function resolveRebelCellDiscard(
  G: GameState, objectiveId: string | null
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'RebelCellDiscard') return { ok: false, reason: 'no-pending' };
  const logStart = pc.logStart ?? G.turnLog.length;
  if (objectiveId !== null) {
    if (!pc.legal.includes(objectiveId)) return { ok: false, reason: 'illegal' };
    const hand = G.rebel.objectiveHand ?? [];
    const i = hand.indexOf(objectiveId);
    if (i >= 0) hand.splice(i, 1);
    (G.rebel.objectiveDiscard ??= []).push(objectiveId);
    log(G, { kind: 'rebel-cell-discard', side: 'Rebel', payload: { discarded: objectiveId } });
    M.recordObjectiveScored(G, 'rebel-cell-2', 1, 'refresh', G.turnLog.length);
    M.gainReputation(G, 1);
    G.refreshRebelCellDiscardTaken = true;
  }
  G.pendingChoice = undefined;
  G.refreshPreStep = 5;
  if (G.isGameOver) return { ok: true };
  runOneShotObjectivesThenContinue(G, logStart);
  return { ok: true };
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
  const logStart = pc.logStart ?? G.turnLog.length;
  // Decline sentinel (empty string) — allowed only when the choice permits it
  // (a cost-bearing objective the player may opt out of, #183). Skip playing
  // any objective and continue the refresh.
  if (objectiveId === '') {
    if (!pc.allowDecline) return { ok: false, reason: 'decline-not-allowed' };
    G.pendingChoice = undefined;
    log(G, { kind: 'objective-declined', side: 'Rebel', payload: { legal: pc.legal } });
    continueRefreshAfterObjectives(G, logStart);
    return { ok: true };
  }
  if (!pc.legal.includes(objectiveId)) return { ok: false, reason: 'illegal' };
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
/** Exported for tests. */
export function refreshPlayStartOfRefreshObjectives(G: GameState, logStart: number): boolean {
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
    // Base objectives use 'StartOfRefresh'; RoE objectives use 'Refresh' for
    // the same start-of-Refresh window. Treat them as equivalent.
    if (!card || (card.timing !== 'StartOfRefresh' && card.timing !== 'Refresh')) continue;
    // Persistent place-on-play objectives (Show No Fear etc.) stay in hand and
    // score via processPersistentObjectives — not the one-shot play path.
    if (PERSISTENT_OBJECTIVES.has(id)) continue;
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
  // RR p.10: only one objective per refresh, and playing is a "MAY". With a
  // single FREE eligible card there's no decision worth a prompt — auto-play
  // it. But cost-bearing objectives (The Long War discards 2 of your other
  // objectives, #183) must be opt-in: route them through the choice with a
  // decline option so the player isn't forced to pay the cost. 2+ eligible
  // always prompts.
  // Objectives that must prompt rather than auto-play: cost objectives (pay
  // your own cards) and opt-in objectives (free but a big irreversible board
  // change — A Time for Peace, #325). Both get a decline option.
  const needsPrompt = eligible.some((e) => COST_OBJECTIVES.has(e.id) || OPT_IN_OBJECTIVES.has(e.id));
  if (eligible.length === 1 && !needsPrompt) {
    playRefreshObjective(G, eligible[0].id, eligible[0].rep);
    return false;
  }
  postPlayObjectiveChoice(G, eligible.map((e) => e.id), 'refresh', logStart, needsPrompt);
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

/** Refresh step 2: draw 2 missions per side, then enforce the 10-card hand
 *  limit. RR p.12: the player CHOOSES which cards to discard down to 10 — it's
 *  not an automatic trim (player report: "I wasn't allowed to choose what to
 *  discard; it simply didn't draw"). Returns true if a HandLimitDiscard choice
 *  is now pending (Refresh pauses; resolveHandLimitDiscard resumes it). */
function refreshDrawMissions(G: GameState, logStart: number): boolean {
  const queue: { side: Side; count: number; discardable: string[] }[] = [];
  for (const side of ['Rebel', 'Empire'] as const) {
    M.drawMission(G, side, 2);
    const f = faction(G, side);
    // Per RR p.12: only non-project mission cards count toward the 10-card
    // limit. Starting missions also cannot be discarded.
    const counting = f.missionHand.filter((id) => !G.catalog.missions[id]?.isProject);
    const over = counting.length - STARTING_HAND_LIMIT;
    if (over <= 0) continue;
    const discardable = f.missionHand.filter((id) => {
      const c = G.catalog.missions[id];
      return c && !c.isStarting && !c.isProject;
    });
    // Can't discard more than exist as discardable (starting cards are exempt).
    const count = Math.min(over, discardable.length);
    if (count > 0) queue.push({ side, count, discardable });
  }
  if (queue.length === 0) return false;
  G.pendingHandLimitDiscards = { logStart, queue };
  postNextHandLimitDiscard(G);
  return true;
}

/** Post the HandLimitDiscard choice for the next queued side. */
function postNextHandLimitDiscard(G: GameState): void {
  const p = G.pendingHandLimitDiscards;
  if (!p || p.queue.length === 0) return;
  const next = p.queue[0];
  G.pendingChoice = {
    kind: 'HandLimitDiscard', side: next.side, count: next.count, discardable: next.discardable,
  };
  log(G, { kind: 'choice-request', side: next.side, payload: {
    kind: 'HandLimitDiscard', count: next.count, choices: next.discardable.length,
  }});
}

/** Resolve a HandLimitDiscard: discard the chosen missions, then resume Refresh
 *  (the next over-limit side, or steps 3-6). */
export function resolveHandLimitDiscard(G: GameState, missionIds: string[]): { ok: boolean; reason?: string } {
  const choice = G.pendingChoice;
  if (!choice || choice.kind !== 'HandLimitDiscard') return { ok: false, reason: 'no-pending' };
  const p = G.pendingHandLimitDiscards;
  if (!p || p.queue.length === 0) return { ok: false, reason: 'no-queue' };
  const cur = p.queue[0];
  if (missionIds.length !== cur.count) return { ok: false, reason: `expected-${cur.count}-discards` };
  // Validate by COUNT, not set membership: with duplicate mission copies (#287)
  // a hand can legitimately hold two cards with the same id, so discarding two
  // of that id is legal as long as you hold that many. The old no-duplicates
  // check rejected it, which froze the Refresh phase when the AI (or a player)
  // picked two copies of one mission (#300).
  const avail = new Map<string, number>();
  for (const id of cur.discardable) avail.set(id, (avail.get(id) ?? 0) + 1);
  const used = new Map<string, number>();
  for (const id of missionIds) {
    const u = (used.get(id) ?? 0) + 1;
    used.set(id, u);
    if (u > (avail.get(id) ?? 0)) return { ok: false, reason: `not-discardable:${id}` };
  }
  const f = faction(G, cur.side);
  for (const id of missionIds) {
    const i = f.missionHand.indexOf(id);
    if (i >= 0) f.missionHand.splice(i, 1);
    f.missionDiscard.push(id);
    log(G, { kind: 'mission-hand-trim', side: cur.side, payload: { missionId: id } });
  }
  p.queue.shift();
  G.pendingChoice = undefined;
  if (p.queue.length > 0) {
    postNextHandLimitDiscard(G);
    return { ok: true };
  }
  const logStart = p.logStart;
  G.pendingHandLimitDiscards = undefined;
  continueRefreshAfterMissionDraw(G, logStart);
  return { ok: true };
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

/** Issue #221: a droid-ring recruit card ("He Means Well" → K-2SO, the base
 *  R2-D2 / C-3PO cards) carries an Immediate ring effect. Rather than leave the
 *  card in hand to be played later during Assignment, offer the ring the moment
 *  the leader is recruited. Returns true (caller pauses) if it posted an
 *  AttachRingPick; the ring is resolved by resolveAttachRing, which resumes the
 *  recruit flow because the choice is tagged viaRecruit. */
function maybeOfferRecruitRing(G: GameState, side: Side, cardId: string): boolean {
  const ringId = DROID_RING_CARDS[cardId];
  if (!ringId) return false;
  if (side !== 'Rebel') return false; // all current ring cards are Rebel
  if (M.findRingHolder(G, ringId)) return false; // single ring at a time
  const f = faction(G, side);
  if (!f.actionHand.includes(cardId)) return false; // recruitLeaderFromCard kept it
  // Leader requirement (He Means Well needs Cassian, just recruited above).
  const reqs = G.catalog.actions[cardId]?.leaderRequirement ?? [];
  if (reqs.length > 0 && !reqs.some((lid) => f.leaderPool.includes(lid))) return false;
  const candidates = nonRingedLeadersOf(G, side); // card targets a non-ringed leader
  if (candidates.length === 0) return false;
  G.pendingChoice = { kind: 'AttachRingPick', side, cardId, ringId, candidates, viaRecruit: true };
  log(G, { kind: 'choice-request', side, payload: { kind: 'AttachRingPick', cardId, ringId, candidates } });
  return true;
}

/** RAW (Rules Reference, "Immediate"): an Immediate action card "must be used
 *  as soon as the player gains the card … immediately revealed and resolved."
 *  When a non-ring Immediate card (e.g. Under the Radar) is recruited and its
 *  leader requirement is now satisfied, fire its effect right away instead of
 *  letting it sit in hand for an at-will play (#289). Returns true if the effect
 *  posted a sub-choice (the recruit flow pauses; the sub-choice's resolver
 *  resumes it); false otherwise (the caller continues the recruit flow). */
function maybeFireRecruitImmediate(G: GameState, side: Side, cardId: string): boolean {
  const card = G.catalog.actions[cardId];
  if (!card || card.timing !== 'Immediate') return false;
  if (DROID_RING_CARDS[cardId]) return false;       // handled by the ring path
  if (cardId === 'the-milleninium-falcon') return false; // passive from-hand trigger
  const f = faction(G, side);
  if (!f.actionHand.includes(cardId)) return false;
  const reqs = card.leaderRequirement ?? [];
  if (reqs.length > 0 && !reqs.some((lid) => f.leaderPool.includes(lid))) return false;
  // Reveal + resolve now; the card leaves the hand to the discard.
  const i = f.actionHand.indexOf(cardId);
  f.actionHand.splice(i, 1);
  f.actionDiscard.push(cardId);
  log(G, { kind: 'action-card-play', side, payload: {
    cardId, leaderId: null, systemId: null, timing: 'Immediate', viaRecruit: true,
  }});
  applyImmediateActionCardEffect(G, side, cardId);
  // If the effect posted a sub-choice, tag it `viaRecruit` so its resolver
  // resumes the paused recruit/refresh flow instead of stranding it. Recruitable
  // Immediate cards post one of: UnderTheRadarKeep (Under the Radar) or
  // ArmCardProbePick (Secret Facility / Sweep the Area). BOTH resolvers honour
  // the flag. A new recruitable Immediate card that posts a DIFFERENT sub-choice
  // MUST teach that choice's resolver to resume on viaRecruit, or recruiting it
  // will freeze the Refresh (regression #314/#310 — Sweep the Area).
  const pc = G.pendingChoice as { viaRecruit?: boolean } | undefined;
  if (pc) { pc.viaRecruit = true; return true; }
  return false;
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
  if (maybeOfferRecruitRing(G, cur.side, keepCardId)) return { ok: true };
  if (maybeFireRecruitImmediate(G, cur.side, keepCardId)) return { ok: true };
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
  if (maybeOfferRecruitRing(G, c.side, c.cardId)) return { ok: true };
  if (maybeFireRecruitImmediate(G, c.side, c.cardId)) return { ok: true };
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
      // Rebel ground SQUARE builds the base-game structures (Shield Generator,
      // Ion Cannon) — they carry a ground-square build icon per the printed
      // components, and Target the Shield Generators / the Defensive Position
      // objective only make sense if the Rebel can build them (player #161).
      // Available in base game too (3 SG + 3 IC ship in the base box).
      if (shape === 'square')   return ['shield-generator', 'ion-cannon'];
    }
  } else {
    if (type === 'space') {
      if (shape === 'triangle') return roe
        ? ['tie-fighter', 'tie-striker']
        : ['tie-fighter'];
      if (shape === 'circle')   return ['assault-carrier'];
      // The Interdictor is NOT an icon-build: it only enters the queue via the
      // "Interdictor Development" project (player report #349). So a square space
      // icon builds a Star Destroyer in both base and RoE.
      if (shape === 'square')   return ['star-destroyer']; // SSD + Interdictor are project-only
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
        // Ground triangle — use the shared icon→units map so the Rebel Base
        // offers the same ground-triangle options as any other system. In the
        // base game that's just the Rebel Trooper (auto-applied), but with RoE
        // units on it's Trooper OR Vanguard, which must be a player choice
        // rather than a hardcoded trooper (issue #240).
        const baseGround = legalUnitsForIcon('Rebel', 'ground', 'triangle', G)
          .filter((t) => M.unitsAvailableInSupply(G, t) > 0);
        if (baseGround.length === 0) {
          log(G, { kind: 'build-wasted-no-supply', side: 'Rebel', payload: {
            sourceSystemId: 'rebel-base', slot: 1, iconType: 'ground', iconShape: 'triangle',
            legalUnitTypes: legalUnitsForIcon('Rebel', 'ground', 'triangle', G),
          }});
        } else if (baseGround.length === 1) {
          M.buildToQueue(G, 'Rebel', baseGround[0], 1, 'rebel-base');
          sideAutoApplied.push({ sourceSystemId: 'rebel-base', slot: 1, unitTypeId: baseGround[0] });
        } else {
          sidePicks.push({
            sourceSystemId: 'rebel-base', slot: 1,
            iconType: 'ground', iconShape: 'triangle',
            legalUnitTypes: baseGround,
            available: availabilityFor(G, baseGround),
          });
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
    // An empty string is an explicit "skip this icon" (the UI sends it when an
    // icon's every legal unit is exhausted by other picks in the same batch).
    if (c === '') {
      log(G, { kind: 'build-wasted-no-supply', side: cur.side, payload: {
        sourceSystemId: p.sourceSystemId, slot: p.slot,
        iconType: p.iconType, iconShape: p.iconShape, legalUnitTypes: p.legalUnitTypes,
      }});
      continue;
    }
    if (!p.legalUnitTypes.includes(c)) {
      return { ok: false, reason: `illegal-pick:${c}` };
    }
    // Hard supply gate (RAW holding pool). Checked live so two same-shape icons
    // in one batch can't both spend the last token — each buildToQueue above
    // decrements the pool that this read sees. When the pool is exhausted the
    // build is simply WASTED (RAW: "you can only build a unit you still have a
    // token for"), not an error — erroring here hard-froze the build modal when
    // every legal unit for an icon was used up by earlier picks (player #217).
    if (M.unitsAvailableInSupply(G, c) <= 0) {
      log(G, { kind: 'build-wasted-no-supply', side: cur.side, payload: {
        sourceSystemId: p.sourceSystemId, slot: p.slot,
        iconType: p.iconType, iconShape: p.iconShape, legalUnitTypes: p.legalUnitTypes,
      }});
      continue;
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
export function legalDeployTargets(G: GameState, side: Side, typeId?: UnitTypeId): SystemId[] {
  const opp: Side = side === 'Rebel' ? 'Empire' : 'Rebel';
  const out: Set<SystemId> = new Set();
  const passesBase = (sysId: string, ss: typeof G.map.systems[string]): boolean => {
    const sysDef = G.catalog.systems[sysId];
    if (!sysDef || sysDef.isRemote || ss.destroyed || ss.sabotage) return false;
    if (side === 'Rebel' && ss.loyalty !== 'rebel') return false;
    if (side === 'Empire' && ss.loyalty !== 'imperial' && !ss.subjugated) return false;
    if (ss.units.some((u) => u.side === opp)) return false;
    return true;
  };
  for (const [sysId, ss] of Object.entries(G.map.systems)) {
    if (passesBase(sysId, ss)) out.add(sysId);
  }
  if (side === 'Rebel' && !G.rebelBaseRevealed) {
    out.add('rebel-base-space');
  }

  // RoE Shield Bunker — Empire-only extras to the deploy target set.
  // Rules p.8 has two distinct widenings:
  //
  // 1. EASY DEPLOYMENT — Shield Bunker (the unit being deployed) may be
  //    placed in ANY system (remote or populous) that contains at least 1
  //    Imperial ground unit and no Rebel units. Loyalty doesn't matter.
  //    Fires only when typeId === 'shield-bunker'.
  //
  // 2. LOCAL REINFORCEMENT — when an Imperial Shield Bunker is already in a
  //    REMOTE system with no Rebel units, Imperial may deploy ANY unit
  //    there as if it were a loyal system. Fires for any typeId. RAW also
  //    notes "this cannot be used during the build step while the Shield
  //    Bunker is being deployed" — that's the build-action restriction; the
  //    refresh-deploy path (which this function feeds) is unaffected.
  if (G.expansion?.enabled && side === 'Empire') {
    for (const [sysId, ss] of Object.entries(G.map.systems)) {
      if (out.has(sysId)) continue;
      if (ss.destroyed) continue;
      const sysDef = G.catalog.systems[sysId];
      if (!sysDef) continue;
      if (ss.units.some((u) => u.side === 'Rebel')) continue;
      const isRemote = sysDef.isRemote;
      const hasImpGround = ss.units.some(
        (u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground',
      );
      const hasImpShieldBunker = ss.units.some(
        (u) => u.side === 'Empire' && u.typeId === 'shield-bunker',
      );
      // 1. Easy deployment for a Shield Bunker
      if (typeId === 'shield-bunker' && hasImpGround) {
        out.add(sysId);
        continue;
      }
      // 2. Local reinforcement at a remote Shield Bunker
      if (isRemote && hasImpShieldBunker) {
        out.add(sysId);
      }
    }
  }

  return Array.from(out);
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
    const candidates = applyDeployCap(G, next.side, legalDeployTargets(G, next.side, next.typeId));
    if (candidates.length === 0) {
      // RAW: returns to slot 1 of build queue. (Includes the case where
      // every legal system is already saturated at the 2-deploy cap.)
      f.buildQueue[1].push(next.typeId);
      log(G, { kind: 'deploy-returned-to-queue', side: next.side, payload: {
        typeId: next.typeId,
        reason: legalDeployTargets(G, next.side, next.typeId).length === 0 ? 'no-legal-system' : 'all-systems-at-deploy-cap',
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
  // (Declining to deploy — leaving a unit on build queue space 1 per rr "Deploy
  // Units" — is handled by declineDeployUnit(), wired to the "Leave on build
  // queue" button in the deploy picker.)
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

/** Decline to deploy the unit currently offered by a DeployUnitPick. RR p.7:
 *  "If a player cannot (or does not wish to) deploy some of his units, he
 *  places these units back on the '1' space of his build queue." So instead of
 *  forcing a system pick, the player may send this unit back to build-queue
 *  slot 1 (player report: "no way to leave units on Build Queue 1"). */
export function declineDeployUnit(G: GameState): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'DeployUnitPick') return { ok: false, reason: 'no-pending' };
  const f = faction(G, pc.side);
  f.buildQueue[1].push(pc.typeId);
  log(G, { kind: 'deploy-declined-to-queue', side: pc.side, payload: { typeId: pc.typeId } });
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
// Cards that ATTACH as a ring during a Rebel Assignment turn (Immediate
// timing in the printed game; we wedge them into the Assignment-card path
// because there's no separate "play immediate card" affordance yet). Name
// is historical — droid rings were the first members; K-2SO (He Means
// Well) is RoE.
const DROID_RING_CARDS: Record<string, 'r2d2' | 'c3po' | 'k2so'> = {
  'resourceful-astromech': 'r2d2',
  'human-cyborg-relations': 'c3po',
  'he-means-well': 'k2so',
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
      // All current ring-attach cards are Rebel.
      if (side !== 'Rebel') { continue; }
      // Ring isn't already held by someone else (single ring at a time).
      if (M.findRingHolder(G, DROID_RING_CARDS[cid])) { continue; }
      // Leader requirement (RoE He Means Well needs Cassian; base droid
      // rings have an empty requirement list, so this is a no-op for them).
      const reqs = card.leaderRequirement ?? [];
      if (reqs.length > 0 && !reqs.some((lid) => f.leaderPool.includes(lid))) continue;
      out.push(cid);
      continue;
    }
    if (card.timing !== 'Assignment') continue;
    // End-of-phase cards (False Orders) are NOT offered during a normal
    // Assignment turn — they get a dedicated window after BOTH sides finish
    // assigning (maybeOfferFalseOrders). Playing them earlier does nothing
    // because the Empire hasn't assigned its leaders yet (#293).
    if (END_OF_ASSIGNMENT_CARDS.has(cid)) continue;
    // Leader requirement: at least one named leader must be in the pool.
    const reqs = card.leaderRequirement ?? [];
    if (reqs.length > 0 && !reqs.some((lid) => f.leaderPool.includes(lid))) continue;
    out.push(cid);
  }
  return out;
}

/** Assignment-timing cards that resolve at the END of the phase rather than on
 *  the player's own turn. False Orders targets the Empire's just-made
 *  assignments, so it must wait until the Empire is done (#293). */
const END_OF_ASSIGNMENT_CARDS = new Set<string>(['false-orders']);

/** All of a side's leaders (pool + on-board + on-missions), deduped — the legal
 *  attach targets for a droid ring. */
function allLeadersOf(G: GameState, side: Side): LeaderId[] {
  const f = faction(G, side);
  const set = new Set<LeaderId>(f.leaderPool);
  for (const list of Object.values(f.leadersOnBoard)) for (const lid of list) set.add(lid as LeaderId);
  for (const am of f.leadersOnMissions) for (const lid of am.leaderIds) set.add(lid as LeaderId);
  return [...set];
}

// The three droid rings. Yoda / dark-side / bounty are other attachment kinds,
// NOT rings, so they don't make a leader "ringed".
const DROID_RINGS = ['r2d2', 'c3po', 'k2so'] as const;

/** Legal targets for a droid ring: a side's leaders that don't already bear a
 *  ring. The ring cards specify a "non-ringed leader" — you can't stack a
 *  second droid ring on a leader who already has one. */
function nonRingedLeadersOf(G: GameState, side: Side): LeaderId[] {
  const att = G.leaderAttachments ?? {};
  return allLeadersOf(G, side).filter((lid) => {
    const rings = att[lid] ?? [];
    return !DROID_RINGS.some((r) => rings.includes(r));
  });
}

/** Droid-ring action cards (R2-D2 / C-3PO) are dealt in the Rebel's opening
 *  hand and carry an Immediate "attach this ring" effect, so — exactly like a
 *  ring acquired by recruiting (#221) — the ring should attach the moment the
 *  game begins rather than waiting for the player to play the card manually.
 *  Offer the first un-attached droid ring still in the Rebel's hand as an
 *  AttachRingPick; resolveAttachRing chains to the next via the viaStartingHand
 *  tag. Returns true (caller pauses) if it posted a choice. Idempotent: a ring
 *  already on a leader is skipped, so re-entry is a no-op. */
export function flushStartingRings(G: GameState): boolean {
  if (G.pendingChoice) return false;
  const f = faction(G, 'Rebel');
  for (const cid of f.actionHand) {
    const ringId = DROID_RING_CARDS[cid];
    if (!ringId) continue;
    if (M.findRingHolder(G, ringId)) continue; // already attached
    const reqs = G.catalog.actions[cid]?.leaderRequirement ?? [];
    if (reqs.length > 0 && !reqs.some((lid) => f.leaderPool.includes(lid))) continue;
    const candidates = nonRingedLeadersOf(G, 'Rebel');
    if (candidates.length === 0) continue;
    G.pendingChoice = { kind: 'AttachRingPick', side: 'Rebel', cardId: cid, ringId, candidates, viaStartingHand: true };
    log(G, { kind: 'choice-request', side: 'Rebel', payload: { kind: 'AttachRingPick', cardId: cid, ringId, candidates } });
    return true;
  }
  return false;
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
  const viaRecruit = pc.viaRecruit;
  const viaStartingHand = pc.viaStartingHand;
  G.pendingChoice = undefined;
  // When the ring was offered at recruit time (#221), resume the paused
  // refresh recruit flow so the rest of recruit/build proceeds.
  if (viaRecruit) return continueRecruitFlow(G);
  // When offered from the opening hand, chain to the next un-attached starting
  // ring (a hand could hold both R2-D2 and C-3PO).
  if (viaStartingHand) { flushStartingRings(G); return { ok: true }; }
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

// ===== RoE False Orders — end-of-Assignment window (#293) ====================

/** Apply False Orders to one lone Imperial assignment: return its leader to the
 *  Empire pool and the mission card to the Empire hand. */
function applyFalseOrdersTo(
  G: GameState, lone: GameState['empire']['leadersOnMissions'][number],
): void {
  const lid = lone.leaderIds[0];
  const mid = lone.missionId;
  const idx = G.empire.leadersOnMissions.indexOf(lone);
  if (idx >= 0) G.empire.leadersOnMissions.splice(idx, 1);
  if (!G.empire.leaderPool.includes(lid)) G.empire.leaderPool.push(lid);
  G.empire.missionHand.push(mid);
  log(G, { kind: 'false-orders', side: 'Rebel', payload: { targetLeaderId: lid, missionId: mid } });
}

/** Offer the Rebel a False Orders play at the end of the Assignment phase, once
 *  the Empire has finished assigning. Returns true (and posts a choice) when the
 *  Rebel holds the card AND there's a lone Imperial leader to target; otherwise
 *  returns false so the caller proceeds straight to Command. */
function maybeOfferFalseOrders(G: GameState): boolean {
  if (G.pendingChoice) return false;
  if (!G.rebel.actionHand.includes('false-orders')) return false;
  const candidates = G.empire.leadersOnMissions
    .filter((m) => m.leaderIds.length === 1)
    .map((m) => ({ missionId: m.missionId, leaderId: m.leaderIds[0] as LeaderId }));
  if (candidates.length === 0) return false;
  G.currentPlayer = 'Rebel';
  G.pendingChoice = { kind: 'FalseOrdersWindow', side: 'Rebel', cardId: 'false-orders', candidates };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'FalseOrdersWindow', candidates: candidates.map((c) => c.leaderId),
  }});
  return true;
}

/** Resolve the False Orders window. `targetLeaderId === null` declines (keeps the
 *  card); otherwise return that lone Imperial leader to the pool and its mission
 *  to the Imperial hand, discarding False Orders. Either way, advance to Command. */
export function resolveFalseOrders(
  G: GameState, targetLeaderId: LeaderId | null,
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'FalseOrdersWindow') return { ok: false, reason: 'no-pending' };
  if (targetLeaderId !== null) {
    const lone = G.empire.leadersOnMissions.find(
      (m) => m.leaderIds.length === 1 && m.leaderIds[0] === targetLeaderId);
    if (!lone) return { ok: false, reason: 'not-a-candidate' };
    // Discard False Orders from the Rebel hand.
    const i = G.rebel.actionHand.indexOf('false-orders');
    if (i >= 0) { G.rebel.actionHand.splice(i, 1); G.rebel.actionDiscard.push('false-orders'); }
    log(G, { kind: 'action-card-play', side: 'Rebel', payload: {
      cardId: 'false-orders', leaderId: null, systemId: null, timing: 'Assignment',
    }});
    applyFalseOrdersTo(G, lone);
  } else {
    log(G, { kind: 'choice-cancel', side: 'Rebel', payload: { kind: 'FalseOrdersWindow' } });
  }
  G.pendingChoice = undefined;
  enterCommandPhase(G);
  return { ok: true };
}

// ===== RoE Immediate-action-card play affordance =============================
//
// Most Immediate cards in the base game are droid rings (resolved via the
// AttachRingPick path during Assignment). RoE adds Immediate cards with
// other effects — Under the Radar, Lord Vader's Orders, etc. — that need
// a dedicated "play immediate card" path. The flow mirrors the Assignment
// one: requestImmediateActionCardPlay posts a PlayImmediateActionCard
// choice listing eligible cards; playImmediateActionCard applies the
// chosen card's effect via applyImmediateActionCardEffect. The button is
// shown to the player during their own turn (Assignment or Command) when
// at least one Immediate card is playable.

export function playableImmediateActionCards(G: GameState, side: Side): string[] {
  const f = faction(G, side);
  const out: string[] = [];
  for (const cid of f.actionHand) {
    const card = G.catalog.actions[cid];
    if (!card) continue;
    if (card.timing !== 'Immediate') continue;
    // Droid rings (R2-D2 / C-3PO / K-2SO) go through AttachRingPick during
    // an Assignment turn, NOT this play-immediate path.
    if (DROID_RING_CARDS[cid]) continue;
    // The Millennium Falcon works as a passive trigger FROM HAND (its
    // auto-rescue fires as a FalconOffer after a successful Han/Chewie
    // mission). It has no manual-play effect, so offering it here just lets
    // the player waste it on a no-op (player report #185). Keep it in hand.
    if (cid === 'the-milleninium-falcon') continue;
    // Leader requirement: at least one named leader must be in the pool.
    const reqs = card.leaderRequirement ?? [];
    if (reqs.length > 0 && !reqs.some((lid) => f.leaderPool.includes(lid))) continue;
    out.push(cid);
  }
  return out;
}

export function requestImmediateActionCardPlay(G: GameState, side: Side): { ok: boolean; reason?: string } {
  if (G.currentPlayer !== side) return { ok: false, reason: 'not-your-turn' };
  if (G.pendingChoice) return { ok: false, reason: 'pending-choice' };
  const candidates = playableImmediateActionCards(G, side);
  if (candidates.length === 0) return { ok: false, reason: 'no-playable-immediate-cards' };
  G.pendingChoice = { kind: 'PlayImmediateActionCard', side, candidates };
  log(G, { kind: 'choice-request', side, payload: { kind: 'PlayImmediateActionCard', candidates } });
  return { ok: true };
}

export function cancelImmediateActionCardPlay(G: GameState): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'PlayImmediateActionCard') return { ok: false, reason: 'no-pending' };
  G.pendingChoice = undefined;
  log(G, { kind: 'choice-cancel', side: pc.side, payload: { kind: 'PlayImmediateActionCard' } });
  return { ok: true };
}

export function playImmediateActionCard(G: GameState, cardId: string): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'PlayImmediateActionCard') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(cardId)) return { ok: false, reason: 'not-a-candidate' };
  const side = pc.side;
  const f = faction(G, side);
  const i = f.actionHand.indexOf(cardId);
  if (i < 0) return { ok: false, reason: 'card-not-in-hand' };
  f.actionHand.splice(i, 1);
  f.actionDiscard.push(cardId);
  G.pendingChoice = undefined;
  log(G, { kind: 'action-card-play', side, payload: {
    cardId, leaderId: null, systemId: null, timing: 'Immediate',
  }});
  applyImmediateActionCardEffect(G, side, cardId);
  return { ok: true };
}

/** Per-card Immediate-action-card effect dispatch. New cards add a switch case. */
function applyImmediateActionCardEffect(G: GameState, side: Side, cardId: string, viaFlush = false): void {
  switch (cardId) {
    case 'under-the-radar': {
      // RAW: "Look at the top 4 probe cards. Keep 1 facedown, replace the
      // others at the top or bottom of the deck in any order. At the start
      // of your turn in the Command phase, you may return that probe card
      // to the top of the probe deck."
      //
      // The Rebel picks which of the top 4 to hold facedown; the others
      // stay on top in their original order (we skip the minor top/bottom
      // reorder nicety). The held probe is pulled out of the deck and
      // stored on rebel.heldProbe; a return offer fires at the start of
      // each subsequent Rebel Command turn.
      if (G.rebel.heldProbe) {
        // Already holding one — RAW has no slot for a second; no-op.
        log(G, { kind: 'under-the-radar-noop', side, payload: { reason: 'already-holding-probe' } });
        break;
      }
      const peek = G.probeDeck.slice(0, 4);
      if (peek.length === 0) {
        log(G, { kind: 'under-the-radar-noop', side, payload: { reason: 'empty-probe-deck' } });
        break;
      }
      if (peek.length === 1) {
        // Only one card to choose — hold it without prompting.
        G.probeDeck.shift();
        G.rebel.heldProbe = peek[0];
        log(G, { kind: 'under-the-radar-keep', side: 'Rebel', payload: { probeId: peek[0], auto: true } });
        break;
      }
      G.pendingChoice = { kind: 'UnderTheRadarKeep', side: 'Rebel', candidates: peek };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: {
        kind: 'UnderTheRadarKeep', candidates: peek.length,
      }});
      break;
    }
    case 'early-promotion':
    case 'rebel-extremist': {
      // RAW binary branch: draw a starting action card, OR take the recruit
      // branch (Early Promotion → recruit Motti + place Motti & Tarkin;
      // Rebel Extremist → lose 1 rep + recruit Saw Gerrera). Post a branch
      // choice when the starting-action draw pile has a card; otherwise the
      // draw branch is unavailable, so go straight to recruit.
      const startingDeck = (side === 'Empire' ? G.empire : G.rebel).startingActionDeck ?? [];
      if (startingDeck.length === 0) {
        applyStartingCardRecruitBranch(G, cardId);
        break;
      }
      G.pendingChoice = { kind: 'StartingCardBranch', side, cardId, canDraw: true };
      log(G, { kind: 'choice-request', side, payload: {
        kind: 'StartingCardBranch', cardId, canDraw: true,
      }});
      break;
    }
    case 'secret-facility':
    case 'sweep-the-area': {
      // RoE: "Place 1 of your probe cards facedown under this card." The
      // card was just consumed by playImmediateActionCard — we need to
      // UN-consume it and route through the arming choice instead, which
      // pulls the card back into pending state and queues an
      // ArmCardProbePick. RAW requires Empire to have at least one probe
      // in hand to play these.
      const e = G.empire;
      if (!e.probeHand || e.probeHand.length === 0) {
        // No probes — the card would have nothing facedown. Already
        // discarded; treat as a wasted play.
        log(G, { kind: 'arm-card-noop', side, payload: { cardId, reason: 'no-probes-in-hand' } });
        break;
      }
      // Un-discard the card and queue the arming choice.
      const di = e.actionDiscard.lastIndexOf(cardId);
      if (di >= 0) e.actionDiscard.splice(di, 1);
      G.pendingChoice = {
        kind: 'ArmCardProbePick',
        side: 'Empire',
        cardId,
        candidates: [...e.probeHand],
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'ArmCardProbePick', cardId, probes: e.probeHand.length,
      }});
      break;
    }
    default: {
      log(G, { kind: 'action-card-unknown', side, payload: { cardId, timing: 'Immediate' } });
      break;
    }
  }
  // A flush-triggered card's sub-choice must, when resolved, re-enter
  // advanceCommandTurn to chain the next Immediate card and continue the turn.
  // A MANUALLY played card must NOT advance the turn — so tag only flush plays.
  if (viaFlush && G.pendingChoice) {
    (G.pendingChoice as { autoFlush?: boolean }).autoFlush = true;
  }
}

/** Apply the RECRUIT branch of Early Promotion / Rebel Extremist (the
 *  non-draw side of the binary). Shared by the auto path (empty starting
 *  deck) and the branch resolver. */
function applyStartingCardRecruitBranch(G: GameState, cardId: string): void {
  if (cardId === 'early-promotion') {
    // Recruit Motti, then place Motti + Tarkin at the first Imperial system.
    if (leaderRecruitable(G, 'Empire', 'motti')) {
      G.empire.leaderPool.push('motti' as LeaderId);
      log(G, { kind: 'recruit-leader', side: 'Empire', payload: { leaderId: 'motti', via: 'early-promotion' } });
    }
    const targetSys = Object.entries(G.map.systems)
      .find(([_sid, ss]) => ss.loyalty === 'imperial' || ss.subjugated)?.[0];
    if (targetSys) {
      // Tarkin's leader id is 'grand-moff-tarkin', not 'tarkin' — the wrong id
      // meant indexOf never found him, so Early Promotion placed Motti but left
      // Tarkin stranded in the pool (#266).
      for (const lid of ['motti', 'grand-moff-tarkin'] as LeaderId[]) {
        const i = G.empire.leaderPool.indexOf(lid);
        if (i >= 0) {
          G.empire.leaderPool.splice(i, 1);
          M.placeLeader(G, 'Empire', lid, targetSys);
        }
      }
    }
  } else if (cardId === 'rebel-extremist') {
    M.loseReputation(G, 1);
    if (leaderRecruitable(G, 'Rebel', 'saw-gerrera')) {
      G.rebel.leaderPool.push('saw-gerrera' as LeaderId);
      log(G, { kind: 'recruit-leader', side: 'Rebel', payload: { leaderId: 'saw-gerrera', via: 'rebel-extremist' } });
    }
  }
}

/** Resolve the Early Promotion / Rebel Extremist binary branch. `action`
 *  is 'draw' (take 1 from the starting-action draw pile) or 'recruit'
 *  (the Motti / Saw branch). */
export function resolveStartingCardBranch(G: GameState, action: 'draw' | 'recruit'): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'StartingCardBranch') return { ok: false, reason: 'no-pending' };
  const f = faction(G, pc.side);
  if (action === 'draw') {
    const deck = f.startingActionDeck ?? [];
    if (deck.length === 0) return { ok: false, reason: 'starting-deck-empty' };
    const drawn = deck.shift()!;
    f.actionHand.push(drawn);
    log(G, { kind: 'starting-card-draw', side: pc.side, payload: { cardId: drawn, via: pc.cardId } });
  } else {
    applyStartingCardRecruitBranch(G, pc.cardId);
  }
  const autoFlush = (pc as { autoFlush?: boolean }).autoFlush;
  G.pendingChoice = undefined;
  // Only when this was auto-triggered on draw: drain further Immediate cards
  // and continue the turn. A manual play just resolves the card.
  if (autoFlush) advanceCommandTurn(G);
  return { ok: true };
}

/** Resolve the arming step for Secret Facility / Sweep the Area: stash the
 *  card + chosen probe in faction.armedActionCards. The probe is consumed
 *  (removed from probeHand). */
export function resolveArmCardProbePick(G: GameState, probeId: string): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'ArmCardProbePick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(probeId)) return { ok: false, reason: 'bad-probe' };
  const e = G.empire;
  const pi = (e.probeHand ?? []).indexOf(probeId);
  if (pi < 0) return { ok: false, reason: 'probe-not-in-hand' };
  const probe = G.catalog.probes[probeId];
  if (!probe) return { ok: false, reason: 'unknown-probe' };
  e.probeHand!.splice(pi, 1);
  if (!e.armedActionCards) e.armedActionCards = [];
  e.armedActionCards.push({
    cardId: pc.cardId,
    probeSystemId: probe.systemId,
    armedAt: G.timeMarker,
  });
  const viaRecruit = pc.viaRecruit;
  G.pendingChoice = undefined;
  log(G, { kind: 'arm-card', side: 'Empire', payload: {
    cardId: pc.cardId, probeSystemId: probe.systemId, probeId,
  }});
  // Armed via an Immediate card that fired on being recruited (#314): resume the
  // paused recruit/refresh flow so the phase doesn't dead-stop.
  if (viaRecruit) return continueRecruitFlow(G);
  return { ok: true };
}

/** Auto-reveal all of `side`'s armed cards whose trigger matches `phaseEvent`.
 *  Called from the appropriate turn-transition hooks. Each card-id's reveal
 *  effect lives in revealArmedActionCard. */
export function autoRevealArmedActionCards(G: GameState, side: Side, phaseEvent: 'empire-command-start' | 'empire-command-end'): void {
  if (side !== 'Empire') return;
  const f = G.empire;
  if (!f.armedActionCards || f.armedActionCards.length === 0) return;
  // Cards fire in order they were armed; each fires once and is removed.
  const toFire: ArmedActionCard[] = [];
  const keep: ArmedActionCard[] = [];
  for (const a of f.armedActionCards) {
    const trigger = a.cardId === 'secret-facility' ? 'empire-command-start'
                  : a.cardId === 'sweep-the-area'  ? 'empire-command-end'
                  : null;
    if (trigger === phaseEvent) toFire.push(a);
    else keep.push(a);
  }
  if (toFire.length === 0) return;
  f.armedActionCards = keep;
  for (const a of toFire) revealArmedActionCard(G, a);
}

function revealArmedActionCard(G: GameState, armed: ArmedActionCard): void {
  const sys = armed.probeSystemId;
  // The action card discards at reveal.
  G.empire.actionDiscard.push(armed.cardId);
  log(G, { kind: 'reveal-armed-card', side: 'Empire', payload: {
    cardId: armed.cardId, systemId: sys, armedAt: armed.armedAt,
  }});
  switch (armed.cardId) {
    case 'secret-facility': {
      // RAW: "reveal to place 1 Shield Bunker and 1 triangle ground unit
      // in that system. Resolve combat." The triangle ground unit is the
      // Stormtrooper.
      M.deployUnit(G, 'Empire', 'shield-bunker', sys);
      M.deployUnit(G, 'Empire', 'stormtrooper', sys);
      if (!G.pendingCombat) {
        beginCombat(G, 'Empire', sys, sys);
        runCombat(G);
      }
      break;
    }
    case 'sweep-the-area': {
      // RAW: "reveal to capture 1 leader in that system. Move the captured
      // leader to the closest system with Imperial units." Capture the
      // first Rebel leader at the system; relocate via shortest BFS to a
      // system with Imperial units. If no Rebel leader is there, the
      // reveal lapses with no effect.
      const ss = G.map.systems[sys];
      const rebelHere = (G.rebel.leadersOnBoard[sys] ?? [])[0];
      if (!rebelHere) {
        log(G, { kind: 'reveal-armed-card-noop', side: 'Empire', payload: {
          cardId: armed.cardId, reason: 'no-rebel-leader-here', systemId: sys,
        }});
        break;
      }
      M.captureLeader(G, rebelHere, 'captured');
      // Move to closest Imperial-unit-system. BFS over adjacency.
      const dest = closestImperialUnitSystem(G, sys);
      if (dest && dest !== sys) {
        const cap = (G.empire.capturedLeaders ?? []).find((c) => c.leaderId === rebelHere);
        if (cap) cap.systemId = dest;
        log(G, { kind: 'sweep-the-area-relocate', side: 'Empire', payload: {
          leaderId: rebelHere, from: sys, to: dest,
        }});
      }
      void ss;
      break;
    }
    default: {
      log(G, { kind: 'reveal-armed-card-unknown', payload: { cardId: armed.cardId } });
      break;
    }
  }
}

/** BFS over adjacency from `sysId` to find the closest system that has at
 *  least one Imperial unit. Returns sysId itself if Imperial units are
 *  already there; null if no such system is reachable. */
function closestImperialUnitSystem(G: GameState, sysId: SystemId): SystemId | null {
  const hasImperial = (sid: SystemId): boolean => {
    const ss = G.map.systems[sid];
    return !!ss && ss.units.some((u) => u.side === 'Empire');
  };
  if (hasImperial(sysId)) return sysId;
  const seen = new Set<string>([sysId]);
  const queue: SystemId[] = [sysId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const adj = G.catalog.adjacency[cur] ?? [];
    for (const next of adj) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (hasImperial(next)) return next;
      queue.push(next);
    }
  }
  return null;
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
    // RoE Wave-D additions.
    case 'trust-in-the-force': {
      // RAW: "Place this leader in a subjugated system. Gain 1 loyalty and
      // destroy 1 triangle ground unit in system."
      return all.filter((sid) => G.map.systems[sid]?.subjugated);
    }
    // No system pick needed:
    case 'rebel-planning':           return null; // Rebel Base
    case 'proceeding-as-planned':    return null; // attached to project, not a system
    case 'our-most-desperate-hour':  return null; // attached to a mission card in hand
    case 'start-the-evacuation':     return null; // moves units; no leader-placement
    // RoE Wave-D — no system pick:
    case 'lord-vader-s-orders':      return null; // peeks Rebel objective deck
    case 'false-orders':             return null; // operates on Empire's assigned missions
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
    const candidates = nonRingedLeadersOf(G, side); // card targets a non-ringed leader
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
      // Dedupe: the project deck holds duplicate copies of the same project
      // (rr base deck = 10 cards, 5 names), but the picker only needs each
      // distinct project once. resolveProceedingAsPlannedPick removes one copy
      // by index, so a single id in the candidate list maps to one card.
      const projectCandidates = [...new Set(f.projectDeck ?? [])];
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
    // ---------- Rise of the Empire — Wave D action cards ----------
    case 'trust-in-the-force': {
      // RAW: place leader in subjugated system (consumeCardAndPlaceLeader
      // already did the placement). Gain 1 loyalty + destroy 1 triangle
      // ground unit in that system.
      if (!systemId) break;
      M.gainLoyalty(G, 'Rebel', systemId, 1);
      const ss = G.map.systems[systemId];
      if (ss) {
        const triangleGround = ss.units.filter((u) => {
          if (u.side !== 'Empire') return false;
          const t = G.catalog.unitTypes[u.typeId];
          return t?.theater === 'ground' && t?.tier === 'triangle';
        });
        if (triangleGround.length === 1) {
          M.destroyUnit(G, triangleGround[0].instanceId, 'trust-in-the-force');
        } else if (triangleGround.length >= 2) {
          // 2+ distinct targets (e.g. stormtrooper vs assault-tank) → the Rebel
          // chooses which to destroy (#316 audit).
          G.pendingChoice = {
            kind: 'TrustInTheForceDestroyPick', side: 'Rebel', systemId,
            candidates: triangleGround.map((u) => u.instanceId),
          };
          log(G, { kind: 'choice-request', side: 'Rebel', payload: {
            kind: 'TrustInTheForceDestroyPick', candidates: triangleGround.length,
          }});
        }
      }
      break;
    }
    case 'false-orders': {
      // Reached only via the dedicated end-of-Assignment window now (#293);
      // kept as a defensive no-op for the generic dispatch path. The real
      // effect runs in resolveFalseOrders against the player-chosen target.
      const lone = G.empire.leadersOnMissions.find((m) => m.leaderIds.length === 1);
      if (lone) applyFalseOrdersTo(G, lone);
      else log(G, { kind: 'action-card-noop', side: 'Rebel', payload: {
        cardId, reason: 'no-lone-imperial-assignment',
      }});
      break;
    }
    case 'lord-vader-s-orders': {
      // RAW: "Look at the top 3 objective cards and replace them on top of
      // the deck in any order." Reuses the existing StolenPlansReorder
      // choice + modal — same UX as the base Stolen Plans mission, with
      // 3 cards instead of 4. The choice's missionId field carries the
      // card id (informational); the resolver doesn't run mission-resume
      // when there's no pendingMission.
      const deck = G.rebel.objectiveDeck;
      if (!deck || deck.length === 0) break;
      const n = Math.min(3, deck.length);
      const drawn = deck.splice(0, n);
      if (drawn.length === 1) {
        // No reordering possible; just put back.
        deck.unshift(drawn[0]);
        log(G, { kind: 'lord-vader-s-orders-peek', side: 'Empire', payload: {
          objectiveIds: [...drawn],
        }});
        break;
      }
      G.pendingChoice = {
        kind: 'StolenPlansReorder',
        side: 'Empire',
        missionId: cardId,
        remaining: drawn,
        orderedTop: [],
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'StolenPlansReorder', count: drawn.length, via: 'lord-vader-s-orders',
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
