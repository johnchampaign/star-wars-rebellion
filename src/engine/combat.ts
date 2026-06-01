// Combat sub-machine — held in G.pendingCombat, driven by runCombat().
// Triggered from phases.activateSystem when both sides end up in the same
// theater of a system. See docs/engine.md §9.
//
// Current scope: dice rolls, damage assignment (auto), unit destruction (with
// the "still attacks this round" rule), retreat, end-of-combat cleanup.
// Deferred to #18 (effect handlers): tactic-card draw/play, action-card
// Start-of-Combat triggers, structure-destruction-on-no-ground-attacker rule.

import type {
  GameState, Side, SystemId, UnitInstance, UnitInstanceId, Theater, DieColor, DieResult,
  CombatState, CombatReport, CombatAttackReport, LeaderId,
} from './types';
import * as M from './mechanics';
import * as objectives from './objectives';
import { rollDie, shuffle } from './rng';
import { log } from './log';

function other(s: Side): Side { return s === 'Rebel' ? 'Empire' : 'Rebel'; }

function unitsInSystem(G: GameState, sysId: SystemId): UnitInstance[] {
  return sysId === 'rebel-base-space' ? G.map.rebelBaseSpace.units : G.map.systems[sysId].units;
}

function unitsOf(G: GameState, side: Side, sysId: SystemId, theater?: Theater): UnitInstance[] {
  return unitsInSystem(G, sysId).filter((u) => {
    if (u.side !== side) return false;
    if (!theater) return true;
    const t = G.catalog.unitTypes[u.typeId];
    return t?.theater === theater;
  });
}

function bothSidesHaveTheater(G: GameState, sysId: SystemId, theater: Theater): boolean {
  return unitsOf(G, 'Rebel', sysId, theater).length > 0
      && unitsOf(G, 'Empire', sysId, theater).length > 0;
}

/** True if either side can still destroy an enemy unit somewhere — i.e. combat
 *  can still make progress. False = genuine standoff (end inconclusively).
 *  "Can damage" = a side has a unit that rolls ≥1 die in a contested theater
 *  AND the opponent has a unit destructible by normal hits (health.color !==
 *  null; the Death Star is invulnerable to dice, only Death Star Plans removes
 *  it). This distinguishes a real attrition fight — e.g. a Death Star (4 attack
 *  dice) grinding down a Rebel fleet, which SHOULD play out to an Empire win —
 *  from a true standoff where neither side can ever destroy the other. */
function combatCanProgress(G: GameState, sysId: SystemId): boolean {
  for (const theater of ['space', 'ground'] as const) {
    if (!bothSidesHaveTheater(G, sysId, theater)) continue;
    for (const [atk, def] of [['Rebel', 'Empire'], ['Empire', 'Rebel']] as const) {
      const hasAttacker = unitsOf(G, atk, sysId, theater).some((u) => {
        const t = G.catalog.unitTypes[u.typeId];
        return t ? (t.attack.red + t.attack.black) > 0 : false;
      });
      const hasDestructibleTarget = unitsOf(G, def, sysId, theater).some((u) => {
        const t = G.catalog.unitTypes[u.typeId];
        return t ? t.health.color !== null : false;
      });
      if (hasAttacker && hasDestructibleTarget) return true;
    }
  }
  return false;
}

function bothSidesPresent(G: GameState, sysId: SystemId): boolean {
  return bothSidesHaveTheater(G, sysId, 'space') || bothSidesHaveTheater(G, sysId, 'ground');
}

// (tryYodaRerollCombat removed — Yoda reroll in combat is now a player
//  choice queued via the YodaReroll ChoiceRequest. Missions still use the
//  auto-reroll path in phases.ts; that's untouched.)

function leaderTacticValueIn(G: GameState, side: Side, sysId: SystemId, theater: Theater): number {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const here = f.leadersOnBoard[sysId] ?? [];
  let best = 0;
  for (const lid of here) {
    const ldr = G.catalog.leaders[lid];
    if (!ldr) continue;
    const v = ldr.tacticValues[theater];
    if (v > best) best = v;
  }
  return best;
}

// ============================================================================
// Begin / drive combat
// ============================================================================

/** Initiate combat. Called from activateSystem after movement. */
export function beginCombat(
  G: GameState, attackerSide: Side, attackerSourceSystemId: SystemId, systemId: SystemId
): void {
  if (G.pendingCombat) return; // already in combat
  if (!bothSidesPresent(G, systemId)) return; // nothing to fight

  const initialReport: CombatReport = {
    systemId, attackerSide,
    // Snapshot whether the system was subjugated at combat START. Winning a
    // ground battle here liberates the system (clears subjugated) BEFORE the
    // combat-objective check runs, so reading the live flag afterward always
    // reads false. Liberation (win a ground battle in a subjugated system)
    // needs the at-start value. (Issue #53.)
    systemSubjugatedAtStart: !!G.map.systems[systemId]?.subjugated,
    addedLeaders: [],
    drawnTactics: { side: attackerSide, spaceCount: 0, groundCount: 0 },
    rounds: [], structureDestructions: [],
    retreatDestructions: [],
    winner: null, totalRounds: 0,
  };
  const state: CombatState = {
    systemId, attackerSide, attackerSourceSystemId,
    step: 'AddLeader', round: 1,
    attackerHand: [], defenderHand: [],
    retreated: [], report: initialReport,
  };
  G.pendingCombat = state;
  log(G, { kind: 'combat-begin', payload: { systemId, attackerSide } });
}

/** Drive the combat forward. RESUMABLE: returns early whenever a player
 *  choice is queued (G.pendingChoice set). Callers re-enter via runCombat
 *  after resolveCombatAttackerTactics / resolveCombatDefenderTactics. */
export function runCombat(G: GameState): void {
  if (!G.pendingCombat) return;
  if (G.pendingChoice) return; // a tactic-choice modal is open
  const c = G.pendingCombat;

  // Step 1: Add Leader (RR p.4-5 step 1) — each side that lacks a leader-
  // with-tactic-values in the system MAY take one leader from their pool
  // and place it. "May" is key: this is the player's call, not automatic.
  // Engine posts a CombatAddLeaderPick choice; the AI handler picks the
  // best one (or declines), the UI shows the human a modal with leader
  // options + a "Don't add" button.
  if (c.step === 'AddLeader') {
    c.addLeaderSidesOffered = c.addLeaderSidesOffered ?? [];
    for (const side of [c.attackerSide, other(c.attackerSide)] as const) {
      if (c.addLeaderSidesOffered.includes(side)) continue;
      const f = side === 'Rebel' ? G.rebel : G.empire;
      const here = f.leadersOnBoard[c.systemId] ?? [];
      const hasTacticLeaderHere = here.some((lid) => {
        const ldr = G.catalog.leaders[lid];
        return ldr && (ldr.tacticValues.space + ldr.tacticValues.ground) > 0;
      });
      if (hasTacticLeaderHere) {
        c.addLeaderSidesOffered.push(side);
        continue;
      }
      const candidates: string[] = [];
      for (const lid of f.leaderPool) {
        const ldr = G.catalog.leaders[lid];
        if (!ldr) continue;
        const v = ldr.tacticValues.space + ldr.tacticValues.ground;
        if (v <= 0) continue; // skill-only leaders can't be the combat add
        candidates.push(lid);
      }
      if (candidates.length === 0) {
        // No legal pool leader → nothing to choose; skip silently.
        c.addLeaderSidesOffered.push(side);
        continue;
      }
      // Post the choice and pause.
      c.addLeaderSidesOffered.push(side);
      G.pendingChoice = {
        kind: 'CombatAddLeaderPick',
        side, systemId: c.systemId, candidates,
      };
      log(G, { kind: 'choice-request', side, payload: {
        kind: 'CombatAddLeaderPick', candidates: candidates.length,
      }});
      return; // wait for resolveCombatAddLeaderPick
    }
    c.step = 'DrawTactics';
  }

  // Step 2: Draw tactic cards based on leader tactic values, only for theaters
  // where both sides have units.
  if (c.step === 'DrawTactics') {
    for (const side of [c.attackerSide, other(c.attackerSide)] as const) {
      const hand = side === c.attackerSide ? c.attackerHand : c.defenderHand;
      if (bothSidesHaveTheater(G, c.systemId, 'space')) {
        const n = leaderTacticValueIn(G, side, c.systemId, 'space');
        for (let i = 0; i < n; i++) {
          const card = G.spaceTacticDeck.shift();
          if (card) hand.push(card);
        }
      }
      if (bothSidesHaveTheater(G, c.systemId, 'ground')) {
        const n = leaderTacticValueIn(G, side, c.systemId, 'ground');
        for (let i = 0; i < n; i++) {
          const card = G.groundTacticDeck.shift();
          if (card) hand.push(card);
        }
      }
    }
    log(G, { kind: 'combat-draw-tactics', payload: { attackerHand: c.attackerHand.length, defenderHand: c.defenderHand.length } });
    c.report.drawnTactics = {
      side: c.attackerSide,
      spaceCount: c.attackerHand.filter((cid) => G.catalog.tactics[cid]?.theater === 'space').length
                + c.defenderHand.filter((cid) => G.catalog.tactics[cid]?.theater === 'space').length,
      groundCount: c.attackerHand.filter((cid) => G.catalog.tactics[cid]?.theater === 'ground').length
                 + c.defenderHand.filter((cid) => G.catalog.tactics[cid]?.theater === 'ground').length,
    };
    c.step = 'Round';
  }

  // Step 2.5: Start-of-Combat action-card window. Each side may play one
  // or more action cards with timing 'StartOfCombat' (RR pp.4-5). Posted
  // once per combat, before round 1.
  if (!c.startOfCombatActionsDone) {
    c.startOfCombatSidesOffered = c.startOfCombatSidesOffered ?? [];
    for (const side of [c.attackerSide, other(c.attackerSide)] as const) {
      if (c.startOfCombatSidesOffered.includes(side)) continue;
      const playable = listStartOfCombatPlayable(G, c, side);
      if (playable.length === 0) {
        c.startOfCombatSidesOffered.push(side);
        continue;
      }
      c.startOfCombatSidesOffered.push(side);
      G.pendingChoice = {
        kind: 'CombatStartActionCards',
        side, systemId: c.systemId, playable,
      };
      log(G, { kind: 'choice-request', side, payload: {
        kind: 'CombatStartActionCards', playable: playable.length,
      }});
      return;
    }
    c.startOfCombatActionsDone = true;
  }

  // Step 3: Combat rounds, until end condition. Loop is resumable across
  // tactic-choice pauses: re-entering runCombat picks up at the next
  // not-yet-done theater of the current round.
  let safetyCounter = 0;
  while (c.step === 'Round') {
    safetyCounter++;
    if (safetyCounter > 100) {
      log(G, { kind: 'combat-safety-abort' });
      break;
    }
    if (!c.roundTheatersDone) c.roundTheatersDone = [];

    // Space sub-step
    if (!c.roundTheatersDone.includes('space') && bothSidesHaveTheater(G, c.systemId, 'space')) {
      runTheater(G, c, 'space');
      if (G.pendingChoice) return; // paused for tactic choice
      if (G.isGameOver) { c.step = 'Ended'; break; }
      c.roundTheatersDone.push('space');
    } else if (!c.roundTheatersDone.includes('space')) {
      // No space combat this round (only one side has space units) — mark done.
      c.roundTheatersDone.push('space');
    }
    // Ground sub-step
    if (!c.roundTheatersDone.includes('ground') && bothSidesHaveTheater(G, c.systemId, 'ground')) {
      runTheater(G, c, 'ground');
      if (G.pendingChoice) return; // paused for tactic choice
      if (G.isGameOver) { c.step = 'Ended'; break; }
      c.roundTheatersDone.push('ground');
    } else if (!c.roundTheatersDone.includes('ground')) {
      c.roundTheatersDone.push('ground');
    }

    // Retreat decision (RR pp.5-6) — each side may retreat at most once
    // per combat. Defender goes first per RAW; then attacker.
    if (!c.retreatStepDoneThisRound) {
      // Skip the retreat step entirely if combat is effectively over (no
      // shared theater still has both sides). Offering retreat to a side
      // whose opponent is already wiped is pointless and reads as a bug.
      const stillContested =
        bothSidesHaveTheater(G, c.systemId, 'space') ||
        bothSidesHaveTheater(G, c.systemId, 'ground');
      if (!stillContested) {
        c.retreatStepDoneThisRound = true;
        c.step = 'Ended';
        break;
      }
      c.retreatDecidedThisRound = c.retreatDecidedThisRound ?? [];
      for (const side of [other(c.attackerSide), c.attackerSide] as const) {
        if (c.retreated.includes(side)) continue; // already retreated this combat
        if (c.retreatDecidedThisRound.includes(side)) continue; // already decided this round (declined or retreated)
        if (c.flags?.cannotRetreatThisRound?.[side]) continue; // No Escape (single-round)
        if (c.flags?.opponentCannotRetreat?.includes(side)) continue; // Keep Them From Escaping (whole combat)
        const dests = legalRetreatDestinations(G, c, side);
        const hasUnits = unitsOf(G, side, c.systemId).length > 0;
        // RAW (rr p.5): retreat is led by a leader — "take one of his leaders
        // from the system and place it in an adjacent system." With no leader
        // present, the side simply cannot retreat; skip the option entirely.
        const leadersHere = (side === 'Rebel' ? G.rebel : G.empire).leadersOnBoard[c.systemId] ?? [];
        if (dests.length === 0 || !hasUnits || leadersHere.length === 0) continue;
        G.pendingChoice = {
          kind: 'RetreatDecision',
          side, systemId: c.systemId,
          legalDestinations: dests,
          availableUnits: unitsOf(G, side, c.systemId).map((u) => u.instanceId),
          leadersInSystem: [...leadersHere],
        };
        log(G, { kind: 'choice-request', side, payload: {
          kind: 'RetreatDecision', destinations: dests.length,
        }});
        return; // wait for resolveRetreatDecision
      }
      c.retreatStepDoneThisRound = true;
    }

    // End check: do both sides still have units in some shared theater?
    const continues =
      bothSidesHaveTheater(G, c.systemId, 'space') ||
      bothSidesHaveTheater(G, c.systemId, 'ground');
    if (!continues) {
      c.step = 'Ended';
    } else {
      // Stalemate guard. The combat ends normally only when one side is cleared
      // from every shared theater — but if NEITHER side can destroy the other
      // it would loop forever (the local safetyCounter can't catch this; it
      // resets on every per-round choice-pause re-entry).
      //
      // Crucially this is a STRUCTURAL check, not "no kills for N rounds": an
      // attrition fight where one side CAN damage the other (e.g. a Death Star
      // grinding down a Rebel fleet — it rolls 4 dice and kills ships every
      // round, the Rebels just can't kill it back) is NOT a stalemate and must
      // play out to its conclusion (here, the Rebel fleet is wiped and the
      // Empire wins). We only end inconclusively when neither side can deal
      // lethal damage at all (two 0-attack forces, or a Death Star Under
      // Construction vs units that can't scratch it).
      let endStalemate = false;
      if (!combatCanProgress(G, c.systemId)) {
        log(G, { kind: 'combat-stalemate-end', payload: {
          systemId: c.systemId, round: c.round,
          explanation: 'Neither side can destroy the other — combat ended inconclusively.',
        }});
        endStalemate = true;
      } else {
        // Backstop for pathological no-progress loops where damage IS
        // structurally possible but never lands (e.g. a defender that can
        // block indefinitely). Far beyond any real fight's length, so a
        // genuine attrition grind is never cut short.
        const NO_PROGRESS_BACKSTOP = 25;
        const totalUnits =
          unitsOf(G, 'Rebel', c.systemId).length + unitsOf(G, 'Empire', c.systemId).length;
        if (c.stalemateBaselineCount === undefined || totalUnits < c.stalemateBaselineCount) {
          c.stalemateBaselineCount = totalUnits;
          c.stalemateRounds = 0;
        } else {
          c.stalemateRounds = (c.stalemateRounds ?? 0) + 1;
        }
        if ((c.stalemateRounds ?? 0) >= NO_PROGRESS_BACKSTOP) {
          log(G, { kind: 'combat-stalemate-end', payload: {
            systemId: c.systemId, round: c.round,
            explanation: 'Combat made no progress for many rounds — ended inconclusively.',
          }});
          endStalemate = true;
        }
      }
      if (endStalemate) {
        c.step = 'Ended';
      } else {
        c.round++;
        c.roundTheatersDone = undefined; // reset for next round
        c.retreatStepDoneThisRound = false;
        c.retreatDecidedThisRound = []; // each round each side gets a fresh retreat decision
        // No Escape only lasts the round it was played.
        if (c.flags?.cannotRetreatThisRound) c.flags.cannotRetreatThisRound = {};
      }
    }
  }

  endCombat(G);
}

// ============================================================================
// Theater step (one round, both sides attack)
// ============================================================================

/** Begin or continue the current theater step. Returns early if a player
 *  choice is queued. Idempotent re-entry via runCombat. */
function runTheater(G: GameState, c: CombatState, theater: Theater): void {
  // Initialise theater-step bookkeeping (only on first entry, not on resume).
  if (c.activeTheater !== theater) {
    c.activeTheater = theater;
    c.theaterStaged = [];
    c.theaterAttackersDone = [];
    // Find or create this round's report bucket.
    let idx = c.report.rounds.findIndex((r) => r.round === c.round);
    if (idx < 0) {
      c.report.rounds.push({ round: c.round, attacks: [] });
      idx = c.report.rounds.length - 1;
    }
    c.currentRoundReportIdx = idx;
  }

  const order: Side[] = [c.attackerSide, other(c.attackerSide)];
  for (const attacker of order) {
    if (G.isGameOver) break;
    if (c.theaterAttackersDone!.includes(attacker)) continue;
    beginAttack(G, c, attacker, theater);
    if (G.pendingChoice) return; // paused for a choice; resume on next call
    // beginAttack with no choice means side had no units — skip.
  }

  // Apply destructions (RR p.5 — end of theater step).
  finalizeTheaterDestructions(G, c, theater);

  // Clear "cannot block until step end" flags — they only last this step.
  if (c.flags?.cannotBlockUntilStepEnd) c.flags.cannotBlockUntilStepEnd = {};

  // Clear theater-step state.
  c.activeTheater = undefined;
  c.theaterStaged = undefined;
  c.theaterAttackersDone = undefined;
  c.currentRoundReportIdx = undefined;
}

/** Roll dice for `side`, queue the attacker-tactics choice if appropriate.
 *  If no units to roll, marks the side done and returns. */
function beginAttack(G: GameState, c: CombatState, side: Side, theater: Theater): void {
  const myUnits = unitsOf(G, side, c.systemId, theater);
  if (myUnits.length === 0) {
    c.theaterAttackersDone!.push(side);
    return;
  }

  // Sum attack values, capped at 5R + 5B per attack (rr p.4).
  let red = 0, black = 0;
  for (const u of myUnits) {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    red += t.attack.red;
    black += t.attack.black;
  }
  red = Math.min(5, red);
  black = Math.min(5, black);

  // "According To My Design" (Emperor Palpatine start-of-combat action card):
  // Rebel rolls 1 fewer red die and 2 fewer black dice for the first round
  // of air AND ground combat. Apply BEFORE rolling. Floor at 0 so a small
  // Rebel attack doesn't go negative.
  let accordingToMyDesignReduction: { red: number; black: number } | null = null;
  if (c.flags?.accordingToMyDesignActive && side === 'Rebel' && c.round === 1) {
    const redCut = Math.min(1, red);
    const blackCut = Math.min(2, black);
    red -= redCut;
    black -= blackCut;
    accordingToMyDesignReduction = { red: redCut, black: blackCut };
  }

  // Roll dice.
  const dice: DieResult[] = [];
  for (let i = 0; i < red; i++) dice.push(rollDie(G.rng, 'red' as DieColor));
  for (let i = 0; i < black; i++) dice.push(rollDie(G.rng, 'black' as DieColor));

  // Stash the in-flight attack. The phase will be set by advanceAttackToTactics
  // based on which pre-tactic pause point (Yoda / Special) applies first.
  c.pendingAttack = {
    side, theater,
    phase: 'awaitingYodaReroll', // placeholder; advanceAttackToTactics may change it
    dice,
    attackerUnits: myUnits.length,
    bonusDamage: 0,
    tacticsPlayed: [],
  };
  // Surface the dice-reduction in the per-attack tactics log so the player
  // can see why fewer dice rolled than expected.
  if (accordingToMyDesignReduction) {
    c.pendingAttack.tacticsPlayed.push({
      card: 'according-to-my-design',
      detail: `Empire: −${accordingToMyDesignReduction.red}R / −${accordingToMyDesignReduction.black}B Rebel dice (round 1)`,
    });
    log(G, { kind: 'combat-action-card-applied', side: 'Empire', payload: {
      card: 'according-to-my-design',
      targetSide: side, theater, round: c.round,
      reducedRed: accordingToMyDesignReduction.red,
      reducedBlack: accordingToMyDesignReduction.black,
    }});
  }
  advanceAttackToTactics(G, c);
}

/** Walk the pre-AttackerTactics pause points (Yoda reroll, Special-die
 *  spend). Queues whichever applies first. If none apply, falls through to
 *  queueing CombatAttackerTactics. Called from beginAttack and from each
 *  pre-tactic resolver. */
function advanceAttackToTactics(G: GameState, c: CombatState): void {
  const pa = c.pendingAttack;
  if (!pa) return;

  // 1) Yoda reroll — Rebel only, once per round, requires Yoda holder
  //    at the system, requires at least one blank die.
  if (canQueueYodaReroll(G, c, pa.side)) {
    const blanks = pa.dice
      .map((d, i) => d.face === 'blank' ? i : -1)
      .filter((i) => i >= 0);
    if (blanks.length > 0) {
      const yodaHolder = findYodaHolder(G);
      if (yodaHolder) {
        pa.phase = 'awaitingYodaReroll';
        G.pendingChoice = {
          kind: 'YodaReroll',
          side: 'Rebel', context: 'combat',
          theater: pa.theater, systemId: c.systemId,
          blankIndices: blanks, holderLeaderId: yodaHolder,
        };
        log(G, { kind: 'choice-request', side: 'Rebel', payload: {
          kind: 'YodaReroll', blanks: blanks.length,
        }});
        return;
      }
    }
  }

  // 1b) R2-D2 flip — when Empire just rolled, give the Rebel a chance to
  //     discard the Resourceful Astromech ring to turn 1 of Empire's dice
  //     to the blank side. RAW: "discard to turn 1 opponent's die to the
  //     blank side." Player can skip to preserve the card for a future roll.
  // RAW: the R2-D2 ring must be attached to a Rebel leader who is present in
  // this combat's system. (Trigger no longer fires just from holding the card.)
  const r2d2Holder = M.findRingHolder(G, 'r2d2');
  const r2d2Here = !!r2d2Holder && (G.rebel.leadersOnBoard[c.systemId] ?? []).includes(r2d2Holder);
  if (!pa.r2d2Resolved && pa.side === 'Empire' && r2d2Here) {
    const flippable = pa.dice
      .map((d, i) => d.face !== 'blank' ? i : -1)
      .filter((i) => i >= 0);
    if (flippable.length > 0) {
      pa.phase = 'awaitingR2D2Flip';
      G.pendingChoice = {
        kind: 'R2D2Flip',
        // REQUIRED: routes the player's response to Combat.resolveR2D2Flip (vs
        // the mission resolver). Omitting it left context undefined, so the
        // combat board's R2-D2 panel (gated on context === 'combat') never
        // rendered and the game hung on the unresolved choice.
        context: 'combat',
        side: 'Rebel', theater: pa.theater, systemId: c.systemId,
        flippableDieIndices: flippable,
      };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: {
        kind: 'R2D2Flip', flippable: flippable.length, theater: pa.theater,
      }});
      return;
    }
  }

  // 1c) One In A Million — Rebel side, Luke or Wedge at the system, card in
  //     hand, at least 1 die. Lets the Rebel set up to 2 dice faces.
  if (!pa.oneInAMillionResolved && pa.side === 'Rebel'
      && G.rebel.actionHand.includes('one-in-a-million')) {
    const here = G.rebel.leadersOnBoard[c.systemId] ?? [];
    const lukeOrWedge = here.some((l) => l === 'luke-skywalker' || l === 'luke-skywalker-jedi' || l === 'wedge-antilles');
    if (lukeOrWedge && pa.dice.length > 0) {
      pa.phase = 'awaitingOneInAMillion';
      G.pendingChoice = {
        kind: 'OneInAMillionOffer',
        side: 'Rebel',
        context: 'combat',
        rebelRoleInRoll: 'attacker',
        faces: pa.dice.map((d) => d.face),
        colors: pa.dice.map((d) => d.color),
      };
      log(G, { kind: 'choice-request', side: 'Rebel', payload: {
        kind: 'OneInAMillionOffer', context: 'combat', theater: pa.theater, dice: pa.dice.length,
      }});
      return;
    }
  }

  // 2) Special-die spend — only for the attacker, only if specials present.
  const specials = pa.dice.filter((d) => d.face === 'special').length;
  if (specials > 0 && !pa.specialsResolved) {
    const hand = pa.side === c.attackerSide ? c.attackerHand : c.defenderHand;
    const specialCards = hand.filter((cid) => {
      const card = G.catalog.tactics[cid];
      if (!card) return false;
      if (card.theater !== pa.theater) return false;
      return /special/i.test(card.rulesText ?? '');
    });
    pa.phase = 'awaitingSpecialSpend';
    G.pendingChoice = {
      kind: 'SpecialDieSpend',
      side: pa.side, theater: pa.theater, systemId: c.systemId,
      specialCount: specials, specialCards,
    };
    log(G, { kind: 'choice-request', side: pa.side, payload: {
      kind: 'SpecialDieSpend', count: specials, playable: specialCards.length,
    }});
    return;
  }

  // 3) Default — queue CombatAttackerTactics.
  pa.phase = 'awaitingAttackerTactics';
  const hand = (pa.side === c.attackerSide ? c.attackerHand : c.defenderHand)
    .filter((cid) => G.catalog.tactics[cid]?.theater === pa.theater);
  G.pendingChoice = {
    kind: 'CombatAttackerTactics',
    side: pa.side, theater: pa.theater, dice: pa.dice,
    hand,
    attackerUnits: pa.attackerUnits,
    systemId: c.systemId,
  };
  log(G, { kind: 'choice-request', side: pa.side, payload: {
    kind: 'CombatAttackerTactics', theater: pa.theater,
    dice: pa.dice.length,
    hits: pa.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length,
    hand: hand.length,
  }});
}

/** Return true if Yoda reroll is currently available for this side. */
function canQueueYodaReroll(G: GameState, c: CombatState, side: Side): boolean {
  if (side !== 'Rebel') return false;
  if (c.yodaRerollUsedRound === c.round) return false;
  if (G.yodaRerollUsedThisRound) return false;
  const holder = findYodaHolder(G);
  if (!holder) return false;
  const here = G.rebel.leadersOnBoard[c.systemId] ?? [];
  return here.includes(holder);
}

function findYodaHolder(G: GameState): LeaderId | null {
  if (!G.leaderAttachments) return null;
  for (const lid of Object.keys(G.leaderAttachments)) {
    if (G.leaderAttachments[lid].includes('yoda')) return lid as LeaderId;
  }
  return null;
}

/** Resolve One In A Million (combat context). `picks` sets up to 2 dice
 *  faces in the current pendingAttack. Empty picks = skip (keep card). */
export function resolveOneInAMillionCombat(
  G: GameState, picks: { index: number; face: string }[]
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingOneInAMillion') return { ok: false, reason: 'no-one-in-a-million-phase' };
  if (!G.pendingChoice || G.pendingChoice.kind !== 'OneInAMillionOffer' || G.pendingChoice.context !== 'combat') {
    return { ok: false, reason: 'no-choice' };
  }
  if (picks.length > 2) return { ok: false, reason: 'too-many-picks' };
  const validFaces = new Set(['blank', 'hit', 'direct-hit', 'special']);
  if (picks.length > 0) {
    const seen = new Set<number>();
    for (const p of picks) {
      if (seen.has(p.index)) return { ok: false, reason: 'dup-index' };
      seen.add(p.index);
      if (!validFaces.has(p.face)) return { ok: false, reason: `bad-face:${p.face}` };
      if (p.index < 0 || p.index >= pa.dice.length) return { ok: false, reason: `bad-index:${p.index}` };
    }
    for (const p of picks) pa.dice[p.index] = { color: pa.dice[p.index].color, face: p.face as DieResult['face'] };
    // Discard the card.
    const i = G.rebel.actionHand.indexOf('one-in-a-million');
    if (i >= 0) {
      G.rebel.actionHand.splice(i, 1);
      G.rebel.actionDiscard.push('one-in-a-million');
    }
    log(G, { kind: 'one-in-a-million-applied', side: 'Rebel', payload: {
      context: 'combat', theater: pa.theater, picks,
      explanation: `One In A Million — set ${picks.length} combat dice to chosen faces.`,
    }});
  } else {
    log(G, { kind: 'one-in-a-million-skipped', side: 'Rebel', payload: { context: 'combat' } });
  }
  pa.oneInAMillionResolved = true;
  G.pendingChoice = undefined;
  advanceAttackToTactics(G, c);
  runCombat(G);
  return { ok: true };
}

/** Resolve the Yoda reroll choice. `rerollIndex` is the dice index to
 *  reroll, or null to decline. */
export function resolveYodaReroll(
  G: GameState, rerollIndex: number | null
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingYodaReroll') return { ok: false, reason: 'no-yoda-phase' };
  if (!G.pendingChoice || G.pendingChoice.kind !== 'YodaReroll') return { ok: false, reason: 'no-choice' };

  if (rerollIndex !== null) {
    if (rerollIndex < 0 || rerollIndex >= pa.dice.length) return { ok: false, reason: 'bad-index' };
    if (pa.dice[rerollIndex].face !== 'blank') return { ok: false, reason: 'not-blank' };
    const fresh = rollDie(G.rng, pa.dice[rerollIndex].color);
    log(G, { kind: 'yoda-reroll', side: 'Rebel', payload: {
      holder: G.pendingChoice.holderLeaderId, systemId: c.systemId,
      color: pa.dice[rerollIndex].color, oldFace: 'blank', newFace: fresh.face,
    }});
    pa.dice[rerollIndex] = fresh;
    c.yodaRerollUsedRound = c.round;
    G.yodaRerollUsedThisRound = true;
  }
  G.pendingChoice = undefined;
  advanceAttackToTactics(G, c);
  return { ok: true };
}

/** Resolve R2-D2 (Resourceful Astromech) flip. `flipIndex === null` means
 *  the Rebel skipped — card stays in hand. Otherwise flip the die at
 *  flipIndex to blank and discard the card from the Rebel's action hand. */
export function resolveR2D2Flip(
  G: GameState, flipIndex: number | null
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingR2D2Flip') return { ok: false, reason: 'no-r2d2-phase' };
  if (!G.pendingChoice || G.pendingChoice.kind !== 'R2D2Flip') return { ok: false, reason: 'no-choice' };

  if (flipIndex !== null) {
    if (flipIndex < 0 || flipIndex >= pa.dice.length) return { ok: false, reason: 'bad-index' };
    const before = pa.dice[flipIndex].face;
    if (before === 'blank') return { ok: false, reason: 'already-blank' };
    pa.dice[flipIndex] = { ...pa.dice[flipIndex], face: 'blank' };
    // Discard the R2-D2 ring: remove it from its bearer and put the card in
    // the discard pile (it lived attached-to-a-leader, not in hand).
    const holder = M.findRingHolder(G, 'r2d2');
    if (holder) M.removeAttachment(G, holder, 'r2d2');
    G.rebel.actionDiscard.push('resourceful-astromech');
    log(G, { kind: 'r2d2-flip', side: 'Rebel', payload: {
      systemId: c.systemId, theater: pa.theater,
      dieIndex: flipIndex,
      flippedFrom: before,
      explanation: `R2-D2 ring discarded — turned an Empire ${pa.dice[flipIndex].color} die showing "${before}" to blank.`,
    }});
  } else {
    log(G, { kind: 'r2d2-skipped', side: 'Rebel', payload: { systemId: c.systemId, theater: pa.theater } });
  }
  pa.r2d2Resolved = true;
  G.pendingChoice = undefined;
  advanceAttackToTactics(G, c);
  return { ok: true };
}

/** Resolve the special-die spend choice. `draws` is the count of specials
 *  spent on drawing tactic cards (each draw spends 1 special); `playCardIds`
 *  is the list of special-requiring cards to play (each spends 1 special).
 *  Total spent must be ≤ specialCount. */
export function resolveSpecialDieSpend(
  G: GameState,
  plays: { draws: number; playCardIds: string[] }
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingSpecialSpend') return { ok: false, reason: 'no-special-phase' };
  if (!G.pendingChoice || G.pendingChoice.kind !== 'SpecialDieSpend') return { ok: false, reason: 'no-choice' };
  const ch = G.pendingChoice;
  const totalSpent = plays.draws + plays.playCardIds.length;
  if (totalSpent > ch.specialCount) return { ok: false, reason: 'over-spend' };
  if (plays.draws < 0) return { ok: false, reason: 'bad-draws' };

  const hand = pa.side === c.attackerSide ? c.attackerHand : c.defenderHand;

  // Draws — pull from the theater deck.
  for (let i = 0; i < plays.draws; i++) {
    const deck = pa.theater === 'space' ? G.spaceTacticDeck : G.groundTacticDeck;
    const drawn = deck.shift();
    if (!drawn) break;
    hand.push(drawn);
    pa.tacticsPlayed.push({ card: drawn, detail: `drew via special` });
    log(G, { kind: 'combat-special-draw', side: pa.side, payload: { card: drawn } });
  }

  // Special-required card plays — discard each and apply the card's effect
  // where we know it. Unknown special cards still discard with a logged note.
  for (const cid of plays.playCardIds) {
    if (!ch.specialCards.includes(cid)) return { ok: false, reason: `not-special-card:${cid}` };
    if (!hand.includes(cid)) return { ok: false, reason: `not-in-hand:${cid}` };
    discardCard(G, hand, cid);
    applySpecialTacticEffect(G, c, pa.side, cid);
  }

  pa.specialsResolved = true;
  G.pendingChoice = undefined;
  advanceAttackToTactics(G, c);
  return { ok: true };
}

/** Resume attack after attacker's tactic-card plays. Apply rerolls/bonus,
 *  then queue defender-tactics choice. */
export function resolveCombatAttackerTactics(
  G: GameState,
  plays: { concentrateFireCardId?: string | null; damageBoostCardIds?: string[] },
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingAttackerTactics') return { ok: false, reason: 'no-pending-attack' };
  if (!G.pendingChoice || G.pendingChoice.kind !== 'CombatAttackerTactics') return { ok: false, reason: 'no-attacker-choice' };

  const hand = pa.side === c.attackerSide ? c.attackerHand : c.defenderHand;

  // Concentrate Fire: reroll up to 2 blanks.
  if (plays.concentrateFireCardId) {
    const cid = plays.concentrateFireCardId;
    if (!hand.includes(cid) || !cid.includes('concentrate-fire')) {
      return { ok: false, reason: 'bad-concentrate-fire-card' };
    }
    let rerolls = 0;
    const newDice = pa.dice.map((d) => {
      if (rerolls >= 2) return d;
      if (d.face === 'blank') {
        rerolls++;
        return rollDie(G.rng, d.color);
      }
      return d;
    });
    if (rerolls > 0) {
      discardCard(G, hand, cid);
      pa.dice = newDice;
      pa.tacticsPlayed.push({ card: cid, detail: `rerolled ${rerolls} blank dice` });
      log(G, { kind: 'combat-tactic', side: pa.side, payload: { card: cid, rerolls } });
    }
  }

  // Damage boosts: each plays for its tabulated bonus. We track the source
  // card per bonus hit so the damage-assignment step can enforce per-card
  // target constraints (Onslaught spreads, Take It Down concentrates).
  for (const cid of plays.damageBoostCardIds ?? []) {
    if (!hand.includes(cid)) continue;
    const amount = cid.includes('take-it-down') ? 2
                : cid.includes('onslaught')   ? 2
                : cid.includes('critical-hit') ? 1
                : 0;
    if (amount === 0) continue;
    discardCard(G, hand, cid);
    pa.bonusDamage += amount;
    (pa.bonusDamageSources ??= []).push({ source: cid, amount });
    pa.tacticsPlayed.push({ card: cid, detail: `+${amount} damage` });
    log(G, { kind: 'combat-tactic', side: pa.side, payload: { card: cid, bonusDamage: amount } });
  }

  // Log the resolved attack roll now (post-rerolls).
  log(G, {
    kind: 'combat-attack', side: pa.side,
    payload: {
      theater: pa.theater,
      dice: pa.dice.map((d) => ({ color: d.color, face: d.face })),
      attackers: pa.attackerUnits,
    },
  });

  // Compute incoming hits for the defender's window.
  const hitsRolled = pa.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
  const incomingHits = hitsRolled + pa.bonusDamage;

  // Check if any defender units survive in the staged sense.
  const defenderSide = other(pa.side);
  const stagedSet = new Set(c.theaterStaged ?? []);
  const liveTargets = unitsOf(G, defenderSide, c.systemId, pa.theater)
    .filter((u) => !stagedSet.has(u.instanceId));
  // Unstoppable Assault: defender forfeits the block window this attack.
  const blocked = c.flags?.cannotBlockUntilStepEnd?.[defenderSide] ?? false;
  if (incomingHits === 0 || liveTargets.length === 0 || blocked) {
    // Skip defender-tactics window; finalise this attack with zero blocks.
    if (blocked) {
      log(G, { kind: 'combat-tactic-effect', side: pa.side, payload: { effect: 'unstoppable-assault-prevents-block' } });
    }
    G.pendingChoice = undefined;
    finalizeAttack(G, c, /*blocks*/0);
    if (G.pendingChoice) return { ok: true }; // damage-assignment may have queued
    runCombat(G);
    return { ok: true };
  }

  // Queue defender-tactics window.
  pa.phase = 'awaitingDefenderTactics';
  const defHand = (defenderSide === c.attackerSide ? c.attackerHand : c.defenderHand)
    .filter((cid) => G.catalog.tactics[cid]?.theater === pa.theater);
  G.pendingChoice = {
    kind: 'CombatDefenderTactics',
    side: defenderSide,
    theater: pa.theater,
    incomingHits,
    hand: defHand,
    systemId: c.systemId,
  };
  log(G, { kind: 'choice-request', side: defenderSide, payload: {
    kind: 'CombatDefenderTactics', theater: pa.theater, incomingHits, hand: defHand.length,
  }});
  return { ok: true };
}

/** Resume attack after defender's block plays. Apply blocks, then damage. */
export function resolveCombatDefenderTactics(
  G: GameState,
  plays: { blockCardIds: string[]; sacrificeCardIds: string[] },
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingDefenderTactics') return { ok: false, reason: 'no-pending-attack' };
  if (!G.pendingChoice || G.pendingChoice.kind !== 'CombatDefenderTactics') return { ok: false, reason: 'no-defender-choice' };

  const defenderSide = other(pa.side);
  const defHand = defenderSide === c.attackerSide ? c.attackerHand : c.defenderHand;

  let blocks = 0;
  let sacrificeIdx = 0;
  for (const cid of plays.blockCardIds) {
    if (!defHand.includes(cid)) continue;
    if (cid.includes('defensive-formation')) {
      discardCard(G, defHand, cid);
      blocks++;
      pa.tacticsPlayed.push({ card: cid, detail: 'blocked 1 damage' });
      log(G, { kind: 'combat-tactic', side: defenderSide, payload: { card: cid, blocked: 1 } });
    } else if (cid.includes('dig-in') || cid.includes('outmaneuver')) {
      // Requires sacrificing a second card.
      const sacrifice = plays.sacrificeCardIds[sacrificeIdx++];
      if (!sacrifice || !defHand.includes(sacrifice) || sacrifice === cid) continue;
      discardCard(G, defHand, cid);
      discardCard(G, defHand, sacrifice);
      blocks++;
      pa.tacticsPlayed.push({ card: cid, detail: `blocked 1 (discarded ${sacrifice})` });
      log(G, { kind: 'combat-tactic', side: defenderSide, payload: { card: cid, blocked: 1, discarded: sacrifice } });
    }
  }
  // Clear the defender-tactics choice before finalizeAttack runs — it may
  // queue a new CombatAssignDamage choice on top.
  G.pendingChoice = undefined;
  finalizeAttack(G, c, blocks);
  // If finalizeAttack queued damage assignment, return now and wait for
  // resolveCombatAssignDamage. Otherwise (no hits / no targets), the
  // attack already finished and we can continue the combat loop.
  if (G.pendingChoice) return { ok: true };
  runCombat(G);
  return { ok: true };
}

/** Queue the damage-assignment choice (RR p.5 — attacker chooses which
 *  defender units take each hit, subject to color matching). When the
 *  attacker is the human, the UI prompts; AI auto-resolves via heuristic.
 *  If there's nothing to assign (no hits or no targets), records the
 *  report and finishes the attack inline. */
function finalizeAttack(G: GameState, c: CombatState, blocksApplied: number): void {
  const pa = c.pendingAttack!;

  // Build the full hit list (rolled hits + bonus damage from tactics).
  type Hit = { color: 'red' | 'black' | null; face: 'hit' | 'direct-hit'; source?: string };
  const rawHits: Hit[] = [];
  for (const d of pa.dice) {
    if (d.face === 'hit' || d.face === 'direct-hit') {
      rawHits.push({ color: d.color as 'red' | 'black', face: d.face });
    }
  }
  // Bonus damage from take-it-down / critical-hit / onslaught / bombardment
  // acts as direct-hit on any colour. Tag each with its source card so the
  // damage-assignment resolver can enforce per-card target constraints.
  const tagged = pa.bonusDamageSources ?? [];
  let tagBudgetLeft = pa.bonusDamage;
  for (const { source, amount } of tagged) {
    for (let i = 0; i < amount && tagBudgetLeft > 0; i++) {
      rawHits.push({ color: null, face: 'direct-hit', source });
      tagBudgetLeft--;
    }
  }
  // Fallback: any bonus damage not accounted for in sources (shouldn't
  // happen but safer than losing hits) gets added as unsourced.
  for (let i = 0; i < tagBudgetLeft; i++) {
    rawHits.push({ color: null, face: 'direct-hit' });
  }

  // "Target the Star Destroyers" (Wedge) — Rebel space attack, convert up
  // to 2 black hits to red so they can damage Star Destroyers / other
  // red-health Imperial ships. RAW says "up to 2"; we auto-apply max since
  // the player elected to play the card, and only edge-case red-health
  // unit lists make conversion ever undesirable.
  if (c.flags?.targetTheStarDestroyersActive && pa.side === 'Rebel' && pa.theater === 'space') {
    let converted = 0;
    for (const h of rawHits) {
      if (converted >= 2) break;
      if (h.color === 'black' && h.face === 'hit') {
        h.color = 'red';
        converted++;
      }
    }
    if (converted > 0) {
      pa.tacticsPlayed.push({
        card: 'target-the-star-destroyers',
        detail: `Rebel: converted ${converted} black hit${converted === 1 ? '' : 's'} to red.`,
      });
      log(G, { kind: 'combat-action-card-applied', side: 'Rebel', payload: {
        card: 'target-the-star-destroyers', convertedBlackToRed: converted, theater: pa.theater, round: c.round,
      }});
    }
  }

  // Defender's blocks knock off the first N hits.
  const applicableHits = rawHits.slice(blocksApplied);

  // Compute eligible targets (color-matched, not already staged for death,
  // skip Death Star which has health.color === null).
  const stagedSet = new Set(c.theaterStaged ?? []);
  const liveTargets = unitsOf(G, other(pa.side), c.systemId, pa.theater)
    .filter((u) => !stagedSet.has(u.instanceId));

  const isLegalTarget = (h: Hit, u: UnitInstance): boolean => {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.health.color === null) return false; // undamageable
    if (h.face === 'direct-hit') return true;
    return h.color !== null && t.health.color === h.color;
  };

  const targetsByHit: string[][] = applicableHits.map(
    (h) => liveTargets.filter((u) => isLegalTarget(h, u)).map((u) => u.instanceId)
  );

  // No work to do → record report and finish.
  if (applicableHits.length === 0 || targetsByHit.every((t) => t.length === 0)) {
    pushAttackReport(G, c, blocksApplied, 0);
    c.theaterAttackersDone!.push(pa.side);
    c.pendingAttack = undefined;
    return;
  }

  // Pause for the attacker to pick targets per hit.
  pa.phase = 'awaitingDamageAssignment';
  pa.pendingAssignment = { blocksApplied, applicableHits };
  G.pendingChoice = {
    kind: 'CombatAssignDamage',
    side: pa.side,
    theater: pa.theater,
    systemId: c.systemId,
    hits: applicableHits,
    targetsByHit,
  };
  log(G, { kind: 'choice-request', side: pa.side, payload: {
    kind: 'CombatAssignDamage', theater: pa.theater, hits: applicableHits.length,
  }});
}

/** Apply the attacker's per-hit target picks, then push the attack report
 *  and continue combat. `assignments[i]` is the instanceId to hit with
 *  `hits[i]`, or null to skip (no legal target / chosen to waste). */
export function resolveCombatAssignDamage(
  G: GameState, assignments: (string | null)[]
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingDamageAssignment' || !pa.pendingAssignment) {
    return { ok: false, reason: 'no-pending-assignment' };
  }
  if (!G.pendingChoice || G.pendingChoice.kind !== 'CombatAssignDamage') {
    return { ok: false, reason: 'no-choice' };
  }
  const choice = G.pendingChoice;
  if (assignments.length !== choice.hits.length) {
    return { ok: false, reason: 'assignment-count-mismatch' };
  }

  // RAW: per-card target constraints on bonus-damage hits.
  //   take-it-down: all hits from this card must hit the SAME target.
  //   onslaught:    hits from this card must hit DIFFERENT targets (no
  //                 stacking on one unit).
  // Group assignments by source card, then validate.
  const bySource = new Map<string, (string | null)[]>();
  for (let i = 0; i < choice.hits.length; i++) {
    const src = choice.hits[i].source;
    if (!src) continue;
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(assignments[i]);
  }
  for (const [src, picks] of bySource) {
    const real = picks.filter((p): p is string => p !== null);
    if (real.length <= 1) continue; // single hit (e.g. critical-hit) — no constraint
    if (src.includes('take-it-down')) {
      const first = real[0];
      if (!real.every((p) => p === first)) {
        return { ok: false, reason: `take-it-down-requires-same-target:${src}` };
      }
    } else if (src.includes('onslaught')) {
      if (new Set(real).size !== real.length) {
        return { ok: false, reason: `onslaught-requires-different-targets:${src}` };
      }
    }
    // critical-hit / bombardment: no constraint (single hit or generic)
  }

  let damageApplied = 0;
  const stagedSet = new Set(c.theaterStaged ?? []);
  for (let i = 0; i < assignments.length; i++) {
    const target = assignments[i];
    if (target === null) continue;
    if (!choice.targetsByHit[i].includes(target)) {
      return { ok: false, reason: `illegal-target-at-hit-${i}:${target}` };
    }
    if (stagedSet.has(target)) {
      // Target is already dead from an earlier hit this same assignment.
      // Skip the hit (the engine doesn't auto-redirect — that's the
      // attacker's responsibility in RAW; we don't pick for them).
      continue;
    }
    const dead = M.damageUnit(G, target, 1);
    damageApplied++;
    if (dead) {
      stagedSet.add(target);
      (c.theaterStaged ??= []).push(target);
    }
  }

  pushAttackReport(G, c, pa.pendingAssignment.blocksApplied, damageApplied);
  c.theaterAttackersDone!.push(pa.side);
  c.pendingAttack = undefined;
  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

/** Helper: build the CombatAttackReport for the just-finished attack and
 *  push it into the current round bucket. */
function pushAttackReport(G: GameState, c: CombatState, blocksApplied: number, damageApplied: number): void {
  const pa = c.pendingAttack!;
  const rawHitsCount = pa.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
  const report: CombatAttackReport = {
    side: pa.side, theater: pa.theater,
    attackerUnits: pa.attackerUnits,
    dice: pa.dice.map((d) => ({ color: d.color, face: d.face })),
    tacticsPlayed: pa.tacticsPlayed,
    hitsRolled: rawHitsCount,
    bonusDamage: pa.bonusDamage,
    blockedDamage: Math.min(blocksApplied, rawHitsCount + pa.bonusDamage),
    damageApplied,
    destroyed: [],
  };
  const bucketIdx = c.currentRoundReportIdx;
  if (bucketIdx !== undefined && c.report.rounds[bucketIdx]) {
    c.report.rounds[bucketIdx].attacks.push(report);
  }
}

/** Apply this theater step's staged destructions and attribute to reports. */
function finalizeTheaterDestructions(G: GameState, c: CombatState, theater: Theater): void {
  const staged = c.theaterStaged ?? [];
  if (staged.length === 0) return;
  const bucketIdx = c.currentRoundReportIdx;
  const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
  for (const unitId of staged) {
    if (G.isGameOver) break;
    const u = ss.units.find((x) => x.instanceId === unitId);
    const typeId = u?.typeId ?? 'unknown';
    M.destroyUnit(G, unitId, 'combat');
    if (bucketIdx !== undefined && c.report.rounds[bucketIdx]) {
      const lastAttack = c.report.rounds[bucketIdx].attacks
        .filter((a) => a.theater === theater)
        .slice(-1)[0];
      if (lastAttack) lastAttack.destroyed.push({ typeId, instanceId: unitId });
    }
  }
}

// ----- Tactic-card helpers --------------------------------------

function discardCard(G: GameState, hand: string[], cardId: string): void {
  const i = hand.indexOf(cardId);
  if (i < 0) return;
  hand.splice(i, 1);
  const card = G.catalog.tactics[cardId];
  if (!card) return;
  if (card.theater === 'space') G.spaceTacticDiscard.push(cardId);
  else G.groundTacticDiscard.push(cardId);
}

// (pickTarget removed — damage assignment is now player-driven via the
//  CombatAssignDamage choice; the engine no longer picks targets.)

// ============================================================================
// End of combat
// ============================================================================

// ============================================================================
// Tactic-card effects (special-die spend path)
// ============================================================================

/** Apply the rules-text effect of a special-requiring tactic card. Best-effort
 *  per-card dispatch by ID substring. Unknown cards just log a "played" note. */
function applySpecialTacticEffect(G: GameState, c: CombatState, side: Side, cardId: string): void {
  const pa = c.pendingAttack!;
  if (cardId.includes('brilliant-strategy')) {
    // "Draw 2 tactic cards from either deck, or 1 from each." MVP: draw 1
    // from each (mixed-deck split). Side's hand grows by 2.
    const hand = side === c.attackerSide ? c.attackerHand : c.defenderHand;
    const space = G.spaceTacticDeck.shift();
    const ground = G.groundTacticDeck.shift();
    if (space) hand.push(space);
    if (ground) hand.push(ground);
    pa.tacticsPlayed.push({ card: cardId, detail: `Brilliant Strategy: +${(space ? 1 : 0) + (ground ? 1 : 0)} cards` });
    log(G, { kind: 'combat-tactic', side, payload: { card: cardId, drew: [space, ground].filter(Boolean) } });
    return;
  }
  if (cardId.includes('bombardment')) {
    // "Deal damage equal to the red attack value of 1 of your ships."
    // MVP: pick the ship with the highest red attack value and apply that
    // many bonus-damage direct-hits to the pendingAttack. Damage falls
    // through to the defender via the regular CombatAssignDamage queue.
    const ss = G.map.systems[c.systemId];
    const ships = (ss?.units ?? []).filter((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      return u.side === side && t?.theater === 'space';
    });
    let bestRed = 0;
    for (const u of ships) {
      const t = G.catalog.unitTypes[u.typeId];
      if ((t?.attack.red ?? 0) > bestRed) bestRed = t!.attack.red;
    }
    pa.bonusDamage += bestRed;
    if (bestRed > 0) (pa.bonusDamageSources ??= []).push({ source: cardId, amount: bestRed });
    pa.tacticsPlayed.push({ card: cardId, detail: `Bombardment: +${bestRed} damage` });
    log(G, { kind: 'combat-tactic', side, payload: { card: cardId, bombardment: bestRed } });
    return;
  }
  if (cardId.includes('unstoppable-assault')) {
    // "During this [theater] battle step, your opponent cannot block damage."
    // Set the defender-cannot-block flag — applied at end of this attack's
    // defender-tactics step.
    const opp = other(side);
    G.pendingCombat!.flags ??= {};
    G.pendingCombat!.flags.cannotBlockUntilStepEnd ??= {};
    G.pendingCombat!.flags.cannotBlockUntilStepEnd[opp] = true;
    pa.tacticsPlayed.push({ card: cardId, detail: 'Unstoppable Assault: opponent cannot block' });
    log(G, { kind: 'combat-tactic', side, payload: { card: cardId, suppressesBlock: true } });
    return;
  }
  if (cardId.includes('no-escape')) {
    // "Your opponent cannot retreat from combat this round."
    const opp = other(side);
    G.pendingCombat!.flags ??= {};
    G.pendingCombat!.flags.cannotRetreatThisRound ??= {};
    G.pendingCombat!.flags.cannotRetreatThisRound[opp] = true;
    pa.tacticsPlayed.push({ card: cardId, detail: 'No Escape: opponent cannot retreat this round' });
    log(G, { kind: 'combat-tactic', side, payload: { card: cardId, suppressesRetreat: true } });
    return;
  }
  if (cardId.includes('escape-plan')) {
    // "When you retreat, your units do not need to be transported."
    G.pendingCombat!.flags ??= {};
    G.pendingCombat!.flags.retreatIgnoresTransport ??= {};
    G.pendingCombat!.flags.retreatIgnoresTransport[side] = true;
    pa.tacticsPlayed.push({ card: cardId, detail: 'Escape Plan: retreat ignores transport' });
    log(G, { kind: 'combat-tactic', side, payload: { card: cardId, retreatTransport: false } });
    return;
  }
  // Unknown special card — log only.
  pa.tacticsPlayed.push({ card: cardId, detail: 'played (effect not yet wired)' });
  log(G, { kind: 'combat-tactic', side, payload: { card: cardId, viaSpecial: true } });
}

// ============================================================================
// Start-of-Combat action cards + Retreat helpers
// ============================================================================

/** Per-card effect for StartOfCombat action cards. Most modify dice / draw
 *  tactic cards / capture leaders at start of combat. Wired here best-effort;
 *  cards without explicit handling are silently consumed (a "discard with no
 *  effect" warning is logged so it's visible to the player). */
function applyStartOfCombatActionCardEffect(G: GameState, c: CombatState, side: Side, cardId: string): void {
  const hand = side === c.attackerSide ? c.attackerHand : c.defenderHand;
  switch (cardId) {
    case 'more-dangerous-than-you-realize': {
      // RAW: "Draw either 3 space tactic or 3 ground tactic cards." Player
      // picks. Post a sub-choice; the resolver draws the cards and resumes
      // the start-of-combat batch.
      G.pendingChoice = {
        kind: 'MoreDangerousTheaterPick',
        side,
        cardId,
      };
      log(G, { kind: 'choice-request', side, payload: {
        kind: 'MoreDangerousTheaterPick', cardId,
      }});
      return;
    }
    case 'according-to-my-design': {
      // RAW: Rebel rolls 1 fewer red die and 2 fewer black dice in round 1
      // of air AND ground combat. Set a flag the attack-roll path reads.
      c.flags = c.flags ?? {};
      c.flags.accordingToMyDesignActive = true;
      log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'rebel-rolls-1R-2B-fewer-round1' } });
      return;
    }
    case 'keep-them-from-escaping': {
      // RAW: Rebel units cannot retreat.
      c.flags = c.flags ?? {};
      c.flags.opponentCannotRetreat = (c.flags.opponentCannotRetreat ?? []);
      if (!c.flags.opponentCannotRetreat.includes('Rebel')) c.flags.opponentCannotRetreat.push('Rebel');
      log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'rebel-cannot-retreat' } });
      return;
    }
    case 'good-intel': {
      // RAW: Rebel player must keep tactic cards faceup. Engine has perfect
      // info anyway, so this is effectively a no-op in code — we log it.
      log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'no-op (engine has perfect info)' } });
      return;
    }
    case 'its-a-trap': {
      // RAW: During round 1, opponent cannot play space tactic cards.
      c.flags = c.flags ?? {};
      c.flags.opponentNoSpaceTacticsRound = 1;
      log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'empire-no-space-tactics-round-1' } });
      return;
    }
    case 'point-blank-assault': {
      // RAW: All units in the system have -1 health (minimum 1) for combat.
      // Applied as combat-only damage to every unit at start.
      c.flags = c.flags ?? {};
      c.flags.allUnitsMinusOneHealthApplied = true;
      const ss = G.map.systems[c.systemId];
      if (ss) {
        for (const u of ss.units) {
          const t = G.catalog.unitTypes[u.typeId];
          const max = t?.health.value ?? 1;
          if (max > 1) u.damage = Math.max(u.damage ?? 0, 1);
        }
      }
      log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'all-units-minus-1-hp-min-1' } });
      return;
    }
    case 'target-the-star-destroyers': {
      // RAW (Wedge): "During the space battle of each combat round, treat
      // up to 2 of your black hits as red hits." Whole-combat flag read by
      // finalizeAttack; auto-applies max (player chose to play the card, so
      // they want the conversion maximized).
      c.flags = c.flags ?? {};
      c.flags.targetTheStarDestroyersActive = true;
      log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'rebel-converts-up-to-2-black-hits-to-red-per-space-round' } });
      return;
    }
    case 'fully-operational': {
      // RAW (Moff Jerjerrod): "If either a Death Star or Death Star Under
      // Construction is in this system, destroy 1 Rebel ship of your
      // choice in the system."
      const ss = G.map.systems[c.systemId];
      const hasDeathStar = !!ss?.units.some((u) => u.typeId === 'death-star' || u.typeId === 'death-star-under-construction');
      if (!hasDeathStar) {
        log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'no-effect (no Death Star in system)' } });
        return;
      }
      // Find eligible Rebel ships (space units, not structures).
      const candidates = (ss?.units ?? [])
        .filter((u) => {
          const t = G.catalog.unitTypes[u.typeId];
          return t && t.side === 'Rebel' && t.theater === 'space' && t.class !== 'structure';
        })
        .map((u) => u.instanceId);
      if (candidates.length === 0) {
        log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'no-effect (no Rebel ships)' } });
        return;
      }
      G.pendingChoice = {
        kind: 'FullyOperationalTargetPick',
        side, systemId: c.systemId, candidates,
      };
      log(G, { kind: 'choice-request', side, payload: {
        kind: 'FullyOperationalTargetPick', cardId, candidates: candidates.length,
      }});
      return;
    }
    case 'target-the-generator': {
      // RAW (Veers): "Destroy 1 structure in the system."
      const ss = G.map.systems[c.systemId];
      const candidates = (ss?.units ?? [])
        .filter((u) => G.catalog.unitTypes[u.typeId]?.class === 'structure')
        .map((u) => u.instanceId);
      if (candidates.length === 0) {
        log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'no-effect (no structures)' } });
        return;
      }
      G.pendingChoice = {
        kind: 'TargetTheGeneratorPick',
        side, systemId: c.systemId, candidates,
      };
      log(G, { kind: 'choice-request', side, payload: {
        kind: 'TargetTheGeneratorPick', cardId, candidates: candidates.length,
      }});
      return;
    }
    case 'ready-for-action': {
      // RAW (Piett / Veers): "Take a leader from the leader pool, place in
      // combat, and get him back at end of fight."
      const f = side === 'Rebel' ? G.rebel : G.empire;
      const candidates = [...f.leaderPool];
      if (candidates.length === 0) {
        log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: 'no-effect (empty leader pool)' } });
        return;
      }
      G.pendingChoice = {
        kind: 'ReadyForActionLeaderPick',
        side, systemId: c.systemId, candidates,
      };
      log(G, { kind: 'choice-request', side, payload: {
        kind: 'ReadyForActionLeaderPick', cardId, candidates: candidates.length,
      }});
      return;
    }
    default: {
      log(G, { kind: 'combat-action-card-not-implemented', side, payload: { card: cardId } });
      return;
    }
  }
}

/** Action-card IDs in `side`'s hand that have timing === 'StartOfCombat'
 *  and whose leaderRequirement (if any) is satisfied by leaders at the
 *  combat system. */
function listStartOfCombatPlayable(G: GameState, c: CombatState, side: Side): string[] {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const leadersHere = new Set(f.leadersOnBoard[c.systemId] ?? []);
  return f.actionHand.filter((cid) => {
    const card = G.catalog.actions[cid];
    if (!card || card.timing !== 'StartOfCombat') return false;
    const req = card.leaderRequirement ?? [];
    if (req.length === 0) return true;
    return req.some((lid) => leadersHere.has(lid));
  });
}

/** Resolve the Start-of-Combat action-card window for one side. `cardIds`
 *  are the cards the side chooses to play (each is discarded; effect
 *  invocation is best-effort via the handler registry — cards without
 *  registered handlers just discard with a 'no-handler' note). */
export function resolveCombatStartActionCards(
  G: GameState, cardIds: string[]
): { ok: boolean; reason?: string } {
  if (!G.pendingCombat) return { ok: false, reason: 'no-pending-combat' };
  const c = G.pendingCombat;
  if (!G.pendingChoice || G.pendingChoice.kind !== 'CombatStartActionCards') {
    return { ok: false, reason: 'no-choice' };
  }
  const ch = G.pendingChoice;
  const side = ch.side;
  const f = side === 'Rebel' ? G.rebel : G.empire;

  // Validate all cards up front so a half-resolved batch doesn't leave the
  // state weird if one is illegal.
  for (const cid of cardIds) {
    if (!ch.playable.includes(cid)) return { ok: false, reason: `not-playable:${cid}` };
    if (!f.actionHand.includes(cid)) return { ok: false, reason: `not-in-hand:${cid}` };
  }
  // Clear the start-of-combat choice immediately so a card effect can post
  // its own sub-choice without colliding.
  G.pendingChoice = undefined;
  // Stash the remaining-cards queue + acting side so a mid-batch sub-choice
  // (e.g. MoreDangerousTheaterPick) can resume.
  c.startOfCombatBatch = { side, remaining: [...cardIds] };
  const resumeOk = processStartOfCombatBatch(G, c);
  if (!resumeOk) return { ok: true }; // paused on a sub-choice; resolver continues
  advanceStartOfCombatAfterSideDone(G, c, side);
  return { ok: true };
}

/** Drain `c.startOfCombatBatch.remaining`, applying each card's effect.
 *  Returns true if the batch finished, false if it paused on a sub-choice. */
function processStartOfCombatBatch(G: GameState, c: CombatState): boolean {
  const batch = c.startOfCombatBatch;
  if (!batch) return true;
  const f = batch.side === 'Rebel' ? G.rebel : G.empire;
  while (batch.remaining.length > 0) {
    const cid = batch.remaining.shift()!;
    // Re-check hand presence (the card might have been discarded out-of-band).
    if (!f.actionHand.includes(cid)) continue;
    f.actionHand.splice(f.actionHand.indexOf(cid), 1);
    f.actionDiscard.push(cid);
    log(G, { kind: 'combat-action-card', side: batch.side, payload: { card: cid } });
    applyStartOfCombatActionCardEffect(G, c, batch.side, cid);
    if (G.pendingChoice) return false; // paused — caller resumes via resolver
  }
  c.startOfCombatBatch = undefined;
  return true;
}

/** After one side's start-of-combat batch finishes, hand off to the other
 *  side's window (if they have playable cards), or mark the window done
 *  and continue combat. */
function advanceStartOfCombatAfterSideDone(G: GameState, c: CombatState, side: Side): void {
  c.startOfCombatSidesOffered = c.startOfCombatSidesOffered ?? [];
  if (!c.startOfCombatSidesOffered.includes(side)) {
    c.startOfCombatSidesOffered.push(side);
  }
  const otherSide = other(side);
  if (!c.startOfCombatSidesOffered.includes(otherSide)) {
    const other_playable = listStartOfCombatPlayable(G, c, otherSide);
    c.startOfCombatSidesOffered.push(otherSide);
    if (other_playable.length > 0) {
      G.pendingChoice = {
        kind: 'CombatStartActionCards',
        side: otherSide, systemId: c.systemId, playable: other_playable,
      };
      log(G, { kind: 'choice-request', side: otherSide, payload: {
        kind: 'CombatStartActionCards', playable: other_playable.length,
      }});
      return;
    }
  }
  c.startOfCombatActionsDone = true;
  runCombat(G);
}

/** Resolve "More Dangerous Than You Realize" — draw 3 from the chosen deck
 *  and resume the start-of-combat batch. */
export function resolveMoreDangerousTheaterPick(
  G: GameState, theater: 'space' | 'ground'
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'MoreDangerousTheaterPick') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const side = pc.side;
  const cardId = pc.cardId;
  const hand = side === c.attackerSide ? c.attackerHand : c.defenderHand;
  const deck = theater === 'space' ? G.spaceTacticDeck : G.groundTacticDeck;
  const drawn: string[] = [];
  for (let i = 0; i < 3; i++) {
    const card = deck.shift();
    if (card) { hand.push(card); drawn.push(card); }
  }
  log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, drew: drawn, theater } });
  G.pendingChoice = undefined;
  // Capture the batch's acting side BEFORE processing (process may clear it).
  const batchSide = c.startOfCombatBatch?.side ?? side;
  const finished = processStartOfCombatBatch(G, c);
  if (!finished) return { ok: true };
  advanceStartOfCombatAfterSideDone(G, c, batchSide);
  return { ok: true };
}

/** "Fully Operational" target pick. `instanceId` = the Rebel ship to
 *  destroy. Continues the start-of-combat batch. */
export function resolveFullyOperationalTargetPick(
  G: GameState, instanceId: string
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'FullyOperationalTargetPick') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (!pc.candidates.includes(instanceId)) return { ok: false, reason: 'bad-target' };
  M.destroyUnit(G, instanceId, 'fully-operational');
  log(G, { kind: 'combat-action-card-effect', side: pc.side, payload: {
    card: 'fully-operational', destroyed: instanceId,
  }});
  G.pendingChoice = undefined;
  const batchSide = c.startOfCombatBatch?.side ?? pc.side;
  const finished = processStartOfCombatBatch(G, c);
  if (!finished) return { ok: true };
  advanceStartOfCombatAfterSideDone(G, c, batchSide);
  return { ok: true };
}

/** "Target the Generator" structure pick. `instanceId` = the structure
 *  to destroy. Continues the start-of-combat batch. */
export function resolveTargetTheGeneratorPick(
  G: GameState, instanceId: string
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'TargetTheGeneratorPick') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (!pc.candidates.includes(instanceId)) return { ok: false, reason: 'bad-target' };
  M.destroyUnit(G, instanceId, 'target-the-generator');
  log(G, { kind: 'combat-action-card-effect', side: pc.side, payload: {
    card: 'target-the-generator', destroyed: instanceId,
  }});
  G.pendingChoice = undefined;
  const batchSide = c.startOfCombatBatch?.side ?? pc.side;
  const finished = processStartOfCombatBatch(G, c);
  if (!finished) return { ok: true };
  advanceStartOfCombatAfterSideDone(G, c, batchSide);
  return { ok: true };
}

/** "Ready For Action" leader pick. `leaderId` = the leader to take from
 *  pool and place in combat; tracked in c.flags.readyForActionReturn so
 *  endCombat returns it to the pool. */
export function resolveReadyForActionLeaderPick(
  G: GameState, leaderId: LeaderId
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'ReadyForActionLeaderPick') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
  M.placeLeader(G, pc.side, leaderId, c.systemId);
  c.flags = c.flags ?? {};
  (c.flags.readyForActionReturn ??= []).push(leaderId);
  const ldr = G.catalog.leaders[leaderId];
  c.report.addedLeaders.push({ side: pc.side, leaderId, tacticValue: (ldr?.tacticValues.space ?? 0) + (ldr?.tacticValues.ground ?? 0) });
  log(G, { kind: 'combat-action-card-effect', side: pc.side, payload: {
    card: 'ready-for-action', placedLeader: leaderId,
  }});
  G.pendingChoice = undefined;
  const batchSide = c.startOfCombatBatch?.side ?? pc.side;
  const finished = processStartOfCombatBatch(G, c);
  if (!finished) return { ok: true };
  advanceStartOfCombatAfterSideDone(G, c, batchSide);
  return { ok: true };
}

/** Resolve the Combat-step-1 "may add a leader from pool" choice.
 *  `leaderId` = pick a pool leader (must be in candidates), or `null` to
 *  decline. Pass through and continue runCombat to advance the step. */
export function resolveCombatAddLeaderPick(
  G: GameState, leaderId: LeaderId | null
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'CombatAddLeaderPick') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (leaderId !== null && !pc.candidates.includes(leaderId)) {
    return { ok: false, reason: 'bad-leader' };
  }
  G.pendingChoice = undefined;
  if (leaderId !== null) {
    M.placeLeader(G, pc.side, leaderId, c.systemId);
    const ldr = G.catalog.leaders[leaderId];
    const v = (ldr?.tacticValues.space ?? 0) + (ldr?.tacticValues.ground ?? 0);
    log(G, { kind: 'combat-add-leader', side: pc.side, payload: { leaderId, tacticValue: v } });
    c.report.addedLeaders.push({ side: pc.side, leaderId, tacticValue: v });
  } else {
    log(G, { kind: 'combat-add-leader-declined', side: pc.side, payload: {} });
  }
  // Re-enter runCombat — it'll either offer the other side this same choice
  // or advance to DrawTactics.
  runCombat(G);
  return { ok: true };
}

/** Compute the legal retreat destinations for `side`. RAW:
 *  - The attacker may only retreat to the system they moved from.
 *  - The defender may retreat to any adjacent system (and not into
 *    the attacker's source if the attacker still controls it — they
 *    might, since attacker just left there). The RR text we have is
 *    "any adjacent system." We don't filter by attacker source for the
 *    defender (we leave that to expansion / FAQ if needed). */
function legalRetreatDestinations(G: GameState, c: CombatState, side: Side): SystemId[] {
  // Rebel Base space is a special abstract system — can't retreat to it
  // unless the base is hidden and the side is Rebel.
  const adj = G.catalog.adjacency[c.systemId] ?? [];
  if (side === c.attackerSide) {
    // Attacker may retreat to source — if it's still adjacent (which it
    // always is by construction) AND not destroyed.
    const src = c.attackerSourceSystemId;
    if (!src) return [];
    const ss = G.map.systems[src];
    if (!ss || ss.destroyed) return [];
    // RAW: can't retreat into a system the opponent has units in.
    const opp = other(side);
    if (ss.units.some((u) => u.side === opp)) return [];
    return [src];
  }
  // Defender may retreat to any adjacent system without enemy units.
  const opp = other(side);
  return adj.filter((sid) => {
    if (sid === c.attackerSourceSystemId) return false; // can't retreat through attacker's source
    const ss = G.map.systems[sid];
    if (!ss || ss.destroyed) return false;
    if (ss.units.some((u) => u.side === opp)) return false;
    if (G.catalog.systems[sid]?.isRemote) return false;
    return true;
  });
}

/** Resolve the retreat decision. `destSystemId === null` means decline to
 *  retreat. `unitInstanceIds` is the list of units to take (or null /
 *  empty for "take all"). Enforces transport capacity per RR p.5-6 unless
 *  the side has the `retreatIgnoresTransport` flag set (Escape Plan tactic
 *  card). Units left behind are destroyed per RAW. */
export function resolveRetreatDecision(
  G: GameState, destSystemId: SystemId | null, unitInstanceIds: string[] | null,
  leaderId?: LeaderId | null
): { ok: boolean; reason?: string } {
  if (!G.pendingCombat) return { ok: false, reason: 'no-pending-combat' };
  const c = G.pendingCombat;
  if (!G.pendingChoice || G.pendingChoice.kind !== 'RetreatDecision') {
    return { ok: false, reason: 'no-choice' };
  }
  const ch = G.pendingChoice;
  const side = ch.side;

  if (destSystemId === null) {
    // Decline — log, mark side decided so the runCombat loop doesn't re-post.
    log(G, { kind: 'combat-retreat-decline', side, payload: { systemId: c.systemId } });
    c.retreatDecidedThisRound = c.retreatDecidedThisRound ?? [];
    if (!c.retreatDecidedThisRound.includes(side)) c.retreatDecidedThisRound.push(side);
    G.pendingChoice = undefined;
    runCombat(G);
    return { ok: true };
  }
  if (!ch.legalDestinations.includes(destSystemId)) {
    return { ok: false, reason: `illegal-dest:${destSystemId}` };
  }
  const requested = (unitInstanceIds ?? ch.availableUnits).filter((uid) =>
    ch.availableUnits.includes(uid)
  );
  // Transport-capacity check per RR p.5-6. Retreats are a kind of move;
  // unless an effect explicitly ignores transport (Escape Plan tactic card
  // → retreatIgnoresTransport flag), restriction-icon fighters and ground
  // units need capacity-providing ships in the retreat group.
  const ignoresTransport = !!c.flags?.retreatIgnoresTransport?.[side];
  const ss = c.systemId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[c.systemId];
  let toMove: string[] = requested;
  let capacityDropped: string[] = [];
  if (!ignoresTransport && ss) {
    let capAvail = 0;
    let capProviders = 0;
    let restrictionNeed = 0;
    let groundNeed = 0;
    const restrictionUids: string[] = [];
    const groundUids: string[] = [];
    for (const uid of requested) {
      const u = ss.units.find((x) => x.instanceId === uid);
      if (!u) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      if (t.transport.immobile) continue; // immobile can't retreat
      if (t.transport.capacity > 0) {
        capAvail += t.transport.capacity;
        capProviders++;
      }
      if (t.transport.restriction) { restrictionNeed++; restrictionUids.push(uid); }
      if (t.theater === 'ground' && t.class !== 'structure') {
        groundNeed++;
        groundUids.push(uid);
      }
    }
    const needed = restrictionNeed + groundNeed;
    if (needed > 0 && capProviders === 0) {
      // No transport ship in the group — all restriction/ground must stay.
      const stayBehind = new Set([...restrictionUids, ...groundUids]);
      toMove = requested.filter((uid) => !stayBehind.has(uid));
      capacityDropped = [...stayBehind];
    } else if (needed > capAvail) {
      // Some restriction/ground units exceed capacity. Drop them greedily,
      // ground first (typically more replaceable than fighters in a retreat
      // scenario — purely a policy call when the player overpacks).
      let surplus = needed - capAvail;
      const dropOrder = [...groundUids, ...restrictionUids];
      const stayBehind = new Set<string>();
      for (const uid of dropOrder) {
        if (surplus <= 0) break;
        stayBehind.add(uid);
        surplus--;
      }
      toMove = requested.filter((uid) => !stayBehind.has(uid));
      capacityDropped = [...stayBehind];
    }
  }
  // Destroy units left behind by capacity (RR p.5-6: "units not moved are
  // destroyed"). Same rule applies to immobile units in the system.
  // Capture typeIds BEFORE destroying for the combat report — destroyUnit
  // splices the instances out, so post-destroy we can't recover the type.
  const retreatLostTypeIds: string[] = [];
  if (ss) {
    for (const uid of capacityDropped) {
      const u = ss.units.find((x) => x.instanceId === uid);
      if (u) retreatLostTypeIds.push(u.typeId);
    }
  }
  for (const uid of capacityDropped) {
    M.destroyUnit(G, uid, 'retreat-no-transport');
  }
  // Also destroy ANY unit at the combat system not in toMove and not just
  // dropped above — RAW: "all of your units not moved are destroyed." This
  // includes units the player explicitly chose to leave (e.g. damaged
  // structures, immobile units).
  if (ss) {
    const movingSet = new Set(toMove);
    const droppedSet = new Set(capacityDropped);
    const leftBehind = ss.units
      .filter((u) => u.side === side && !movingSet.has(u.instanceId) && !droppedSet.has(u.instanceId))
      .map((u) => ({ instanceId: u.instanceId, typeId: u.typeId }));
    for (const u of leftBehind) retreatLostTypeIds.push(u.typeId);
    for (const u of leftBehind) M.destroyUnit(G, u.instanceId, 'retreat-left-behind');
    if (leftBehind.length > 0) {
      log(G, { kind: 'combat-retreat-leftbehind', side, payload: {
        systemId: c.systemId, units: leftBehind.length, instances: leftBehind.map((u) => u.instanceId),
      }});
    }
  }
  // Record in the report so combat-end objective checks (e.g. Crippling Blow,
  // which counts 3+ ground HP destroyed in the combat) include retreat
  // losses. Per RAW: retreat is part of the combat, not separate from it.
  if (retreatLostTypeIds.length > 0) {
    c.report.retreatDestructions.push({ side, typeIds: retreatLostTypeIds });
  }
  // Now move the units that fit.
  for (const uid of toMove) {
    M.moveUnit(G, uid, c.systemId, destSystemId);
  }
  // RAW (rr p.5): one leader leads the retreat — move it to the destination.
  // The player picks which (default: the first present); any OTHER leaders the
  // side has in the system stay behind. The retreat step is only ever posted
  // when ≥1 leader is present, so leadersHere is non-empty here in normal play.
  const retreatingFaction = side === 'Rebel' ? G.rebel : G.empire;
  const leadersHere = retreatingFaction.leadersOnBoard[c.systemId] ?? [];
  const leaderToMove = (leaderId && leadersHere.includes(leaderId)) ? leaderId : leadersHere[0];
  if (leaderToMove) {
    M.relocateLeader(G, side, leaderToMove, c.systemId, destSystemId);
  }
  c.retreated.push(side);
  c.retreatDecidedThisRound = c.retreatDecidedThisRound ?? [];
  if (!c.retreatDecidedThisRound.includes(side)) c.retreatDecidedThisRound.push(side);
  log(G, { kind: 'combat-retreat', side, payload: {
    from: c.systemId, to: destSystemId,
    units: toMove.length,
    droppedByCapacity: capacityDropped.length,
    ignoresTransport,
  }});

  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

function endCombat(G: GameState): void {
  if (!G.pendingCombat) return;
  const c = G.pendingCombat;

  // "Ready For Action" — leaders placed in combat via the card return to
  // the Empire leader pool at end of fight. Done early so they're back in
  // pool before any subsequent same-turn checks. (If the leader was
  // somehow captured/eliminated mid-combat, returnLeader is a no-op since
  // they're no longer on the board — safe.)
  if (c.flags?.readyForActionReturn?.length) {
    for (const lid of c.flags.readyForActionReturn) {
      try {
        M.returnLeader(G, 'Empire', lid);
        log(G, { kind: 'combat-action-card-effect', side: 'Empire', payload: {
          card: 'ready-for-action', returnedLeader: lid,
        }});
      } catch { /* leader already gone — ignore */ }
    }
  }

  // Structure rule (rr p.4 IV): if a side's only remaining ground units are
  // structures and the opponent still has any ground units, those structures
  // are destroyed.
  for (const side of [c.attackerSide, other(c.attackerSide)] as const) {
    const opp = other(side);
    const myGround = unitsOf(G, side, c.systemId, 'ground');
    if (myGround.length === 0) continue;
    const onlyStructures = myGround.every((u) => G.catalog.unitTypes[u.typeId]?.class === 'structure');
    if (!onlyStructures) continue;
    const oppGround = unitsOf(G, opp, c.systemId, 'ground');
    if (oppGround.length === 0) continue;
    const destroyedTypeIds: string[] = [];
    for (const u of [...myGround]) {
      destroyedTypeIds.push(u.typeId);
      M.destroyUnit(G, u.instanceId, 'combat-structure-rule');
    }
    log(G, { kind: 'combat-structure-destroy', side, payload: { systemId: c.systemId } });
    c.report.structureDestructions.push({ side, typeIds: destroyedTypeIds });
  }

  // Discard tactic hands, reshuffle decks (rr p.14).
  if (c.attackerHand.length > 0 || c.defenderHand.length > 0) {
    // Group by deck. Tactic cards are theatre-specific.
    for (const hand of [c.attackerHand, c.defenderHand]) {
      for (const cardId of hand) {
        const card = G.catalog.tactics[cardId];
        if (!card) continue;
        if (card.theater === 'space') G.spaceTacticDiscard.push(cardId);
        else G.groundTacticDiscard.push(cardId);
      }
    }
    c.attackerHand = [];
    c.defenderHand = [];
  }
  // Move discards back into decks and reshuffle.
  if (G.spaceTacticDiscard.length > 0) {
    G.spaceTacticDeck = shuffle(G.rng, [...G.spaceTacticDeck, ...G.spaceTacticDiscard]);
    G.spaceTacticDiscard = [];
  }
  if (G.groundTacticDiscard.length > 0) {
    G.groundTacticDeck = shuffle(G.rng, [...G.groundTacticDeck, ...G.groundTacticDiscard]);
    G.groundTacticDiscard = [];
  }

  // Clear damage on all surviving units in this system.
  const ss = c.systemId === 'rebel-base-space'
    ? G.map.rebelBaseSpace
    : G.map.systems[c.systemId];
  if (ss) for (const u of ss.units) u.damage = 0;

  // Finalise + queue the report for UI display.
  c.report.totalRounds = c.round;
  // Winner: whoever still has units in the contested system. If both, neither;
  // if neither, draw.
  const attackerLeft = unitsOf(G, c.attackerSide, c.systemId).length > 0;
  const defenderLeft = unitsOf(G, other(c.attackerSide), c.systemId).length > 0;
  if (attackerLeft && !defenderLeft) c.report.winner = c.attackerSide;
  else if (defenderLeft && !attackerLeft) c.report.winner = other(c.attackerSide);
  else if (!attackerLeft && !defenderLeft) c.report.winner = 'draw';
  else c.report.winner = null;
  if (!G.combatReports) G.combatReports = [];
  G.combatReports.push(c.report);

  log(G, { kind: 'combat-end', payload: { systemId: c.systemId, rounds: c.round, winner: c.report.winner } });

  // Combat-timed Rebel objectives — RAW ("Objective Cards"): only 1 objective
  // may be played per combat. If exactly one triggered, play it. If 2+, post a
  // PlayObjective choice so the player picks which to score (the rest stay in
  // hand); pendingCombat is left set and the tail runs from
  // resolveCombatObjectivePick(). Done before clearing pendingCombat so the
  // report sees the combat that triggered them.
  const fired = objectives.combatObjectivesTriggered(G, c.report);
  if (fired.length >= 2) {
    objectives.postPlayObjectiveChoice(G, fired, 'combat');
    return; // pendingCombat stays set; resolver continues via finishCombatTail
  }
  if (fired.length === 1) {
    playCombatObjective(G, fired[0]);
  }
  finishCombatTail(G, c);
}

/** Play a single combat-timed objective: grant reputation, remove from hand,
 *  return-to-deck or box per the card, and record it. */
function playCombatObjective(G: GameState, oid: string): void {
  const card = G.catalog.objectives[oid];
  if (!card) return;
  const rep = objectives.objectiveReputationGain(G, oid);
  M.gainReputation(G, rep);
  const hand = G.rebel.objectiveHand ?? [];
  const idx = hand.indexOf(oid);
  if (idx >= 0) hand.splice(idx, 1);
  if (objectives.objectiveReturnsToDeck(G, oid)) {
    (G.rebel.objectiveDeck ??= []).push(oid);
  }
  log(G, { kind: 'objective-played', side: 'Rebel', payload: {
    objectiveId: oid, reputation: rep, timing: 'Combat',
  }});
  (G.objectiveReports ??= []).push({ objectiveId: oid, reputation: rep, via: 'combat' });
}

/** Resolve the player's combat-objective choice (which one to score), then
 *  run the rest of combat cleanup. `objectiveId` must be a posted candidate. */
export function resolveCombatObjectivePick(
  G: GameState, objectiveId: string
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'PlayObjective' || pc.window !== 'combat') {
    return { ok: false, reason: 'no-pending' };
  }
  if (!pc.legal.includes(objectiveId)) return { ok: false, reason: 'illegal' };
  G.pendingChoice = undefined;
  playCombatObjective(G, objectiveId);
  const c = G.pendingCombat;
  if (c) finishCombatTail(G, c);
  else G.pendingCombat = undefined;
  return { ok: true };
}

/** Post-objective combat cleanup: Death Star Plans attempt, clear the
 *  combat, and continue a mission-triggered combat's command hand-off.
 *  Split out so it can run either inline (≤1 objective) or after the
 *  player's PlayObjective choice resolves (2+ objectives). */
function finishCombatTail(G: GameState, c: CombatState): void {
  // Death Star Plans 2/3 — player-discretion attempt. RAW eligibility:
  // (1) Rebel holds the card, (2) at least one Rebel fighter is at the
  // combat system after the space battle step (i.e. now), (3) at least one
  // Death Star is here to destroy. Post the choice; resolver rolls dice.
  if (!G.isGameOver) maybePostDeathStarPlansChoice(G, c);

  G.pendingCombat = undefined;

  // If this combat was triggered from inside a mission's effect handler
  // (ignite-rebellion, wookie-uprising, etc.), the caller's
  // continueRevealAfterSpecialOffer returned early when it saw the
  // pendingChoice that runCombat posted. Now that combat is done and no
  // new choice is pending, finish the mission: discard/return it and
  // advance the command turn. Without this, pendingMission stays set
  // forever and the engine's mid-resolution guards (revealMission /
  // activateSystem / pass) lock the entire game.
  if (!G.isGameOver && !G.pendingChoice && G.pendingMission && G.pendingMission.stage === 'effect') {
    const pm = G.pendingMission;
    const f = pm.resolverSide === 'Rebel' ? G.rebel : G.empire;
    const card = G.catalog.missions[pm.missionId];
    // Mirror discardOrReturnMission's logic to avoid a circular import.
    if (card?.isStarting) {
      f.missionHand.push(pm.missionId);
      log(G, { kind: 'mission-return-to-hand', side: pm.resolverSide, payload: { missionId: pm.missionId } });
    } else {
      f.missionDiscard.push(pm.missionId);
      log(G, { kind: 'mission-discard', side: pm.resolverSide, payload: { missionId: pm.missionId } });
    }
    G.pendingMission = undefined;
    // Advance the Command turn: this mission (plus its combat) was the
    // resolver's ONE command action, so control now passes to the opponent —
    // exactly like a non-combat mission does via resolveOpposeMission. We
    // inline the hand-off instead of importing advanceCommandTurn (circular
    // import with phases.ts). The resolver did NOT pass this action, so the
    // "both passed -> Refresh" case can't apply here; we only flip to the
    // opponent, and if the opponent already passed we (correctly) keep going.
    // BUG HISTORY: omitting this let the resolver take another mission
    // immediately, so combat missions chained ("3 missions in a row" — issue
    // #77 and others). Only fires for mission-triggered combat (pendingMission
    // set); activate-triggered combat advances via activateSystem itself.
    if (G.phase === 'Command') {
      const next: Side = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
      if (!G.passedThisCommand.includes(next)) G.currentPlayer = next;
    }
  }
}

/** Eligibility-check + post for Death Star Plans 2/3.
 *  Idempotent: only posts a choice; the resolver does the actual work. */
function maybePostDeathStarPlansChoice(G: GameState, c: CombatState): void {
  const hand = G.rebel.objectiveHand ?? [];
  const eligibleCardIds = ['death-star-plans-2', 'death-star-plans-3'].filter((id) => hand.includes(id));
  if (eligibleCardIds.length === 0) return;
  const ss = G.map.systems[c.systemId];
  if (!ss) return;
  // Rebel fighter alive at the combat system.
  const hasRebelFighter = ss.units.some((u) => {
    if (u.side !== 'Rebel') return false;
    const t = G.catalog.unitTypes[u.typeId];
    return t?.class === 'fighter';
  });
  if (!hasRebelFighter) return;
  // Death Star(s) at the system. RAW says "a Death Star" — destroying one
  // requires the player to pick if multiple are present (edge case).
  const deathStarInstanceIds = ss.units
    .filter((u) => u.side === 'Empire' && (u.typeId === 'death-star' || u.typeId === 'death-star-under-construction'))
    .map((u) => u.instanceId);
  if (deathStarInstanceIds.length === 0) return;
  // Post the choice for the first eligible card. (If both are in hand,
  // the second will become eligible on the next combat — they don't stack
  // in a single combat per RAW.)
  G.pendingChoice = {
    kind: 'DeathStarPlansAttempt',
    side: 'Rebel',
    objectiveId: eligibleCardIds[0],
    systemId: c.systemId,
    deathStarInstanceIds,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'DeathStarPlansAttempt',
    objectiveId: eligibleCardIds[0],
    systemId: c.systemId,
    deathStars: deathStarInstanceIds.length,
  }});
}

/** Resolve a Death Star Plans 2/3 attempt. `attempt === true` means the
 *  Rebel reveals the card and rolls 3 dice; on direct-hit, destroy a
 *  Death Star + gain reputation + discard the card. On no hit, the card
 *  returns to the Rebel's hand (effectively a no-op since it's already
 *  there). `attempt === false` means decline — card stays in hand. */
export function resolveDeathStarPlansAttempt(
  G: GameState, attempt: boolean, deathStarInstanceId?: UnitInstanceId
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'DeathStarPlansAttempt') return { ok: false, reason: 'no-pending' };
  G.pendingChoice = undefined;
  if (!attempt) {
    log(G, { kind: 'death-star-plans-declined', side: 'Rebel', payload: {
      objectiveId: pc.objectiveId, systemId: pc.systemId,
    }});
    return { ok: true };
  }
  // RAW: roll 3 dice. Color doesn't matter for mission-style rolls; pick red.
  const faces: string[] = [];
  for (let i = 0; i < 3; i++) faces.push(rollDie(G.rng, 'red').face);
  const directHit = faces.some((f) => f === 'direct-hit');
  if (directHit) {
    // Pick which Death Star to destroy. Default to the first if the caller
    // didn't pass one (or if the passed id is no longer at the system).
    let targetId = deathStarInstanceId;
    if (!targetId || !pc.deathStarInstanceIds.includes(targetId)) targetId = pc.deathStarInstanceIds[0];
    // Death Star can't be damaged by normal attacks (health.color === null),
    // but RAW explicitly says "destroy" — bypass damage and just remove.
    M.destroyUnit(G, targetId, 'death-star-plans');
    const rep = G.catalog.objectives[pc.objectiveId]?.reputation ?? 2;
    M.gainReputation(G, rep);
    const i = (G.rebel.objectiveHand ?? []).indexOf(pc.objectiveId);
    if (i >= 0) G.rebel.objectiveHand!.splice(i, 1);
    log(G, { kind: 'death-star-plans-success', side: 'Rebel', payload: {
      objectiveId: pc.objectiveId, systemId: pc.systemId, destroyed: targetId,
      faces, reputation: rep,
    }});
    (G.objectiveReports ??= []).push({ objectiveId: pc.objectiveId, reputation: rep, via: 'death-star-plans' });
  } else {
    // No direct hit — RAW: "Otherwise return this card to your hand." It's
    // already in hand (we don't remove it on reveal); just log.
    log(G, { kind: 'death-star-plans-miss', side: 'Rebel', payload: {
      objectiveId: pc.objectiveId, systemId: pc.systemId, faces,
    }});
  }
  return { ok: true };
}
