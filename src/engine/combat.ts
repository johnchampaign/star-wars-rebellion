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
import { log, logState, pushNotice } from './log';
import { registerChoice, requestChoice } from './choices';
import { takeCinematicPrevent, cinematicSelectOptions, applyCinematicAbility, resolveCinematicEndOfRound, resolveCinematicRetreatTriggers, isCancelCard, isEscapePlanAbility, restageTheater, applyDeferredCinematicHeals, applyDeferredHealAllocation, targetDealAbilityFor, cinematicTargetDealCandidates, applyChosenTargetDeal, effectiveDealAbilityFor, cinematicDealCandidates, destroyAbilityFor, cinematicDestroyCandidates, applyChosenDestroy, gainTriangleAbilityFor, cinematicTriangleGroundGainTypes } from './cinematicTactics';

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

/** Suggested ★-heal allocation for a cinematic "removing damage" window (#571).
 *  A ★ removes 1 damage, but pouring it into a unit that still dies (damage stays
 *  >= health after the heal) wastes it — the reporter watched three 1-health TIEs
 *  die while the ★ "healed" the one carrying 2 damage (2→1, still dead). So per
 *  colour we greedily fully-heal the wounded units we can bring back below their
 *  health, cheapest-to-save first (fewest ★ needed), maximising the count of
 *  ships/troops saved; only if ★ remain do we spill onto the most-damaged unit
 *  (harmless carry-over relief). The AI takes this default verbatim; the human
 *  sees it pre-filled and may reassign. Exported for direct testing. */
export function suggestHealAllocation(
  candidates: { instanceId: string; color: 'red' | 'black'; damage: number; health: number }[],
  budget: { red: number; black: number },
): { instanceId: string; amount: number }[] {
  const suggested: { instanceId: string; amount: number }[] = [];
  for (const color of ['red', 'black'] as const) {
    let b = budget[color];
    const pool = candidates.filter((x) => x.color === color).map((x) => ({
      instanceId: x.instanceId,
      remaining: x.damage,
      toSave: x.damage - (x.health - 1), // ★ needed to drop below health
    }));
    // Phase 1: save units, cheapest-to-save first, only when affordable.
    for (const u of [...pool].sort((a, z) => a.toSave - z.toSave)) {
      if (u.toSave >= 1 && u.toSave <= b) {
        suggested.push({ instanceId: u.instanceId, amount: u.toSave });
        u.remaining -= u.toSave; b -= u.toSave;
      }
    }
    // Phase 2: spill leftover ★ onto the most-damaged remaining unit.
    while (b > 0 && pool.some((w) => w.remaining > 0)) {
      const w = [...pool].filter((w) => w.remaining > 0).sort((a, z) => z.remaining - a.remaining)[0];
      const ex = suggested.find((s) => s.instanceId === w.instanceId);
      if (ex) ex.amount += 1; else suggested.push({ instanceId: w.instanceId, amount: 1 });
      w.remaining -= 1; b -= 1;
    }
  }
  return suggested;
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
        return t ? (t.attack.red + t.attack.black + t.attack.green) > 0 : false;
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
    // Stamp chronological order at combat START, not end. A combat is multi-step
    // (dice, tactics, the opponent's responses), and a mission that resolves
    // WHILE it's still going would otherwise get a lower end-of-combat seq and
    // jump ahead of it in the report queue — so a combat the player initiated
    // first showed AFTER a mission that happened during it (player report #331,
    // "results out of order"). Start-stamping keeps "combat shows before a
    // mission that followed it" (the documented intent of #178).
    seq: G.turnLog.length,
  };
  const state: CombatState = {
    systemId, attackerSide, attackerSourceSystemId,
    step: 'AddLeader', round: 1,
    attackerHand: [], defenderHand: [],
    retreated: [], report: initialReport,
    cinematic: !!G.expansion?.cinematicCombat,
  };
  G.pendingCombat = state;
  log(G, { kind: 'combat-begin', payload: { systemId, attackerSide, cinematic: state.cinematic } });
  // Keyframe (#539): snapshot the board at the moment of every base assault, so
  // analyzers can measure the exact force delivered without replaying events.
  // (logState strips pendingCombat — the snapshot reads "both armies present,
  // battle about to start", which is precisely the delivered-force picture.)
  if (G.rebelBaseRevealed && systemId === G.rebelBaseSystemId) logState(G, 'base-assault');
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
  // where both sides have units. CINEMATIC COMBAT (RoE p.9): leaders enable
  // dice rerolls instead, and the tactic subsystem is the side-specific
  // advanced deck (Phase 7c). In Phase 7b no cinematic tactic cards are
  // drawn — the hands stay empty, so the standard attacker/defender tactics
  // windows below are skipped (they no-op on empty hands).
  if (c.step === 'DrawTactics') {
    if (!c.cinematic) {
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
    }
    log(G, { kind: 'combat-draw-tactics', payload: { attackerHand: c.attackerHand.length, defenderHand: c.defenderHand.length, cinematic: !!c.cinematic } });
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

    // Death Star Plans 2/3 window — RAW: "If there is at least 1 fighter AFTER
    // the space battle step, reveal this card to roll 3 dice." Offer it here,
    // once per round the instant the space step resolves — NOT only at combat
    // end. Players survived a round in the Death Star's system with X-Wings
    // left but never got the window because the engine waited until combat was
    // over (by which point their fighters were dead). (Reports #139, #146.)
    if (c.roundTheatersDone.includes('space') && !c.dsPlansOfferedThisRound) {
      c.dsPlansOfferedThisRound = true;
      maybePostDeathStarPlansChoice(G, c);
      if (G.pendingChoice) return; // paused for the Rebel's attempt/decline
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

    // RoE Cinematic end-of-round effects (Tractor Beam capture). Both theatres'
    // attacks have resolved by here; run once per round.
    if (c.cinematic && c.cinematicEndOfRoundDoneRound !== c.round) {
      c.cinematicEndOfRoundDoneRound = c.round;
      // May PAUSE for the Confrontation leader-pick (Rebel chooses which
      // Imperial leader to mark); resolveConfrontationLeaderPick re-enters.
      if (resolveCinematicEndOfRound(G, c)) return;
    }

    // Structure rule (rr p.4 IV) — checked at the END of each combat round,
    // not only when combat naturally terminates. If a side's only remaining
    // ground units are structures and the opponent still has ground units,
    // those structures are destroyed immediately (player report #136: a Shield
    // Generator + Ion Cannon with 0 attack just sat taking damage for 8 rounds
    // instead of being destroyed the moment they were the last Rebel ground).
    applyStructureRule(G, c);

    // DSUC sole-ship rule (rr p.6) — must run BEFORE the stalemate guard below,
    // otherwise an unkillable Death Star Under Construction is wrongly called a
    // stalemate instead of being destroyed outright (player report #442).
    applyDsucSoleShipRule(G, c);

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
      // Retreat order: base game is DEFENDER-first (rr pp.5-6); RoE Cinematic
      // Combat is CURRENT-PLAYER (attacker)-first ("Retreat: Starting with the
      // current player…", rulebook p.9).
      const retreatOrder: Side[] = c.cinematic
        ? [c.attackerSide, other(c.attackerSide)]
        : [other(c.attackerSide), c.attackerSide];
      for (const side of retreatOrder) {
        if (c.retreated.includes(side)) continue; // already retreated this combat
        if (c.retreatDecidedThisRound.includes(side)) continue; // already decided this round (declined or retreated)
        if (c.flags?.cannotRetreatThisRound?.[side]) continue; // No Escape (single-round)
        if (c.flags?.opponentCannotRetreat?.includes(side)) continue; // Keep Them From Escaping (whole combat)
        if (postRetreatChoice(G, c, side)) return; // wait for resolveRetreatDecision
      }
      c.retreatStepDoneThisRound = true;
    }

    // RoE Cinematic post-retreat trigger (Rogue One). Runs after the retreat
    // step; may PAUSE for the rescue/remove-marker choice.
    if (c.cinematic && resolveCinematicRetreatTriggers(G, c)) return;

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
        c.dsPlansOfferedThisRound = false; // fresh Death Star Plans window next round
        c.retreatStepDoneThisRound = false;
        c.retreatHappenedThisRound = false; // reset Rogue One trigger for next round
        c.retreatDecidedThisRound = []; // each round each side gets a fresh retreat decision
        // "Resolve attacks first" (cinematic) only lasts the round it was played (#486).
        c.cinematicResolveFirst = undefined;
        // The Master Yoda ring reroll is once per GAME round (mission card text),
        // NOT once per combat round (#521). A single combat can span many combat
        // rounds; the global flag (G.yodaRerollUsedThisRound) is spent for the whole
        // game round on first use and only resets in the Refresh phase — do NOT
        // clear it here. (An earlier read of #481 wrongly reset it each combat round,
        // re-offering the reroll every round of a long fight.)
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

/** Build + post a RetreatDecision for `side` if it can legally retreat from the
 *  combat system. Returns true if a choice was posted (caller pauses), false if
 *  the side can't retreat. Used by the retreat step and by Escape Plan's
 *  immediate-retreat. The Death Star block and leader/mobility requirements are
 *  applied here; `retreatIgnoresTransport` (Escape Plan) waives the carrier
 *  requirement. */
function postRetreatChoice(G: GameState, c: CombatState, side: Side): boolean {
  // RR p.6: the Imperial player cannot retreat ANY units if a Death Star or
  // Death Star Under Construction is in the combat.
  if (side === 'Empire' && unitsOf(G, 'Empire', c.systemId).some((u) =>
    u.typeId === 'death-star' || u.typeId === 'death-star-under-construction')) return false;
  const dests = legalRetreatDestinations(G, c, side);
  const here = unitsOf(G, side, c.systemId);
  const leadersHere = (side === 'Rebel' ? G.rebel : G.empire).leadersOnBoard[c.systemId] ?? [];
  const ignoresT = !!c.flags?.retreatIgnoresTransport?.[side];
  const hasMovable = here.some((u) => {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.transport.immobile) return false;
    if (ignoresT) return true;
    return t.theater === 'space' && !t.transport.restriction;
  });
  if (dests.length === 0 || here.length === 0 || !hasMovable || leadersHere.length === 0) return false;
  G.pendingChoice = {
    kind: 'RetreatDecision',
    side, systemId: c.systemId,
    legalDestinations: dests,
    availableUnits: here.map((u) => u.instanceId),
    leadersInSystem: [...leadersHere],
  };
  log(G, { kind: 'choice-request', side, payload: {
    kind: 'RetreatDecision', destinations: dests.length,
  }});
  return true;
}

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

  // Tactic plays start with the current player (the combat's attacker).
  const tacticOrder: Side[] = [c.attackerSide, other(c.attackerSide)];

  // CINEMATIC COMBAT tactic sub-step (RoE p.9): before the dice attacks, each
  // side (current player first) selects one advanced tactic card to play and
  // resolves its primary/secondary ability — deal-damage hits land now,
  // prevent effects accumulate for the upcoming rolls. Each side gets a
  // CinematicTacticSelect choice (the human picks via a modal; the AI auto-
  // picks). Sides with no available cards (locked, or all spent) are skipped
  // without a pause. Tracked per (side, theatre, round) so a damage-
  // assignment resume doesn't replay it.
  if (c.cinematic) {
    c.cinematicTacticDoneThisRound ??= [];
    c.cinematicSelections ??= {};
    const attacker = c.attackerSide;
    const defender = other(attacker);
    const keyOf = (s: Side) => `${s}:${theater}:${c.round}`;

    // SELECT phase (RoE p.9 "simultaneously"): collect each side's first-card
    // choice WITHOUT resolving — the resolver stores it. The current player is
    // prompted first, but neither effect lands until both have chosen.
    //   "Good Intel" (Empire) overrides the order: the Rebel must choose AND
    // reveal first, then the Empire picks knowing the Rebel's card. So when the
    // flag is set we prompt Rebel-first regardless of who's attacking, and hand
    // the Empire's choice the Rebel's already-stored selection to display.
    const selectOrder: Side[] = c.flags?.goodIntelActive ? ['Rebel', 'Empire'] : tacticOrder;
    for (const side of selectOrder) {
      const key = keyOf(side);
      if (c.cinematicTacticDoneThisRound.includes(key)) continue; // fully resolved
      if (key in c.cinematicSelections) continue;                  // already chose
      const options = cinematicSelectOptions(G, c, side, theater);
      if (options.length === 0) {
        c.cinematicSelections[key] = null; // nothing available — auto-skip
        continue;
      }
      // Good Intel: when prompting the Empire, surface the Rebel's revealed pick.
      let revealedOpponentTactic: { cardId: string; name: string } | null | undefined;
      if (c.flags?.goodIntelActive && side === 'Empire') {
        const rebelSel = c.cinematicSelections[keyOf('Rebel')];
        revealedOpponentTactic = rebelSel
          ? { cardId: rebelSel.cardId, name: G.catalog.tactics[rebelSel.cardId]?.name ?? rebelSel.cardId }
          : null;
      }
      G.pendingChoice = {
        kind: 'CinematicTacticSelect', side, theater, round: c.round, options,
        ...(revealedOpponentTactic !== undefined ? { revealedOpponentTactic } : {}),
      };
      log(G, { kind: 'choice-request', side, payload: {
        kind: 'CinematicTacticSelect', theater, round: c.round, options: options.length,
        ...(revealedOpponentTactic ? { revealedRebelTactic: revealedOpponentTactic.cardId } : {}),
      }});
      return; // paused — resolveCinematicTacticSelect STORES the selection
    }

    // RESOLVE phase: both sides have chosen. Resolution order is the current
    // player first UNLESS the defender's card uses "cancel" — then the defender
    // resolves first (rulebook "Canceling cards"). A cancel that resolves first
    // skips the opponent's card via cinematicCancel.
    const defSel = c.cinematicSelections[keyOf(defender)];
    const defenderCancels = !!defSel && isCancelCard(defSel.cardId, defSel.useTop);
    const resolveOrder: Side[] = defenderCancels ? [defender, attacker] : [attacker, defender];
    for (const side of resolveOrder) {
      const key = keyOf(side);
      if (c.cinematicTacticDoneThisRound.includes(key)) continue; // already resolved
      if (c.cinematicCancel?.[key]) {
        // The card was still played (revealed), it just resolves no abilities —
        // discard it without applying.
        const cancelledSel = c.cinematicSelections[key];
        if (cancelledSel) {
          const f = side === 'Rebel' ? G.rebel : G.empire;
          (f.cinematicTacticDiscard ??= []).push(cancelledSel.cardId);
        }
        c.cinematicTacticDoneThisRound.push(key);
        log(G, { kind: 'cinematic-tactic-cancelled', side, payload: { theater, round: c.round, card: cancelledSel?.cardId } });
        continue;
      }
      const sel = c.cinematicSelections[key];
      // Must-play with no ability (RoE p.8): the card is still played (discarded)
      // but resolves none of its abilities. Checked before the escape-plan path
      // so a no-ability play of Escape Plan doesn't trigger its retreat.
      if (sel?.noAbility) {
        const f = side === 'Rebel' ? G.rebel : G.empire;
        (f.cinematicTacticDiscard ??= []).push(sel.cardId);
        c.cinematicTacticDoneThisRound.push(key);
        log(G, { kind: 'cinematic-tactic-no-ability', side, payload: { theater, round: c.round, card: sel.cardId } });
        continue;
      }
      // Escape Plan primary: "You may immediately retreat. If you do, cancel the
      // Imperial tactic card." Discard the card, waive transport, mark this side
      // done, and post a mid-tactic retreat choice. resolveRetreatDecision sets
      // the cancel if a retreat actually happens, then resumes here.
      if (sel && isEscapePlanAbility(sel.cardId, sel.useTop)) {
        const f = side === 'Rebel' ? G.rebel : G.empire;
        (f.cinematicTacticDiscard ??= []).push(sel.cardId);
        c.flags = c.flags ?? {};
        (c.flags.retreatIgnoresTransport ??= {})[side] = true;
        c.cinematicTacticDoneThisRound.push(key);
        log(G, { kind: 'cinematic-escape-plan', side, payload: { theater, round: c.round } });
        c.flags.escapePlanCancel = { cancelKey: `${other(side)}:${theater}:${c.round}` };
        if (postRetreatChoice(G, c, side)) return; // paused for the retreat decision
        // Can't actually retreat (no destination/leader) — no cancel.
        c.flags.escapePlanCancel = undefined;
        continue;
      }
      // Interactive targeted-deal pick (RoE p.9, #290): cards like Tow Cables
      // ("Deal 4 to 1 AT-AT or AT-ST") let the playing side choose the target
      // when 2+ are legal. Discard the card now, post the pick, and apply the
      // damage in resolveCinematicTargetPick. With 0–1 candidates there's no
      // choice — fall through to the auto-resolving applyCinematicAbility.
      if (sel && !sel.noAbility) {
        // A targeted-deal (Tow Cables / Ion Blast) OR a plain deal (Bombing Run,
        // Rogue Squadron Support, …) both let the playing side choose which
        // enemy unit eats the damage when 2+ are legal (#290/#312). A conditional
        // deal (Swarm Tactics, Bombardment) whose condition currently holds is
        // treated exactly like a plain deal so it prompts too, instead of
        // auto-assigning to the cheapest-to-kill enemy (#570). Compute the
        // amount + candidates from whichever applies and post one CinematicTargetPick.
        const td = targetDealAbilityFor(sel.cardId, sel.useTop);
        const dl = td ? null : effectiveDealAbilityFor(G, c, side, theater, sel.cardId, sel.useTop);
        const amount = td ? td.amount : (dl ? dl.amount : 0);
        const cands = td ? cinematicTargetDealCandidates(G, c, side, theater, td)
          : (dl ? cinematicDealCandidates(G, c, side, theater, dl) : []);
        if ((td || dl) && cands.length >= 2) {
          const f = side === 'Rebel' ? G.rebel : G.empire;
          (f.cinematicTacticDiscard ??= []).push(sel.cardId);
          c.cinematicTacticDoneThisRound.push(key);
          c.flags = c.flags ?? {};
          c.flags.cinematicTargetPick = { side, theater, cardId: sel.cardId, useTop: sel.useTop, amount };
          G.pendingChoice = {
            kind: 'CinematicTargetPick', side, theater, systemId: c.systemId,
            amount, candidates: cands,
          };
          log(G, { kind: 'choice-request', side, payload: {
            kind: 'CinematicTargetPick', theater, amount, candidates: cands.length,
          }});
          return; // paused — resolveCinematicTargetPick applies the damage
        }
        // Interactive destroy-without-rolling pick (#316 audit): cards like
        // Intercept / Hold Them Back / Support of the 501st / cinematic Target
        // the Generator ("destroy 1 triangle ground unit / 1 structure") let the
        // playing side choose which eligible enemy unit is removed when 2+ are
        // legal — fall through to the auto-resolver when 0–1.
        const de = destroyAbilityFor(sel.cardId, sel.useTop);
        const dcands = de ? cinematicDestroyCandidates(G, c, side, theater, de) : [];
        if (de && dcands.length >= 2) {
          const f = side === 'Rebel' ? G.rebel : G.empire;
          (f.cinematicTacticDiscard ??= []).push(sel.cardId);
          c.cinematicTacticDoneThisRound.push(key);
          G.pendingChoice = {
            kind: 'CinematicDestroyPick', side, theater, systemId: c.systemId, candidates: dcands,
            cardId: sel.cardId, useTop: sel.useTop,
          };
          log(G, { kind: 'choice-request', side, payload: {
            kind: 'CinematicDestroyPick', theater, candidates: dcands.length, cardId: sel.cardId,
          }});
          return; // paused — resolveCinematicDestroyPick removes the chosen unit
        }
        // Interactive "gain a triangle ground unit" pick (Deployment, #497): the
        // card gains 1 triangle ground unit and the player chooses the TYPE
        // (Rebel: Trooper or Vanguard). With 2+ types, post the pick; with ≤1,
        // fall through to the auto-resolver (which deploys the default type).
        const ga = gainTriangleAbilityFor(sel.cardId, sel.useTop);
        const gtypes = ga ? cinematicTriangleGroundGainTypes(G, side) : [];
        if (ga && gtypes.length >= 2) {
          const f = side === 'Rebel' ? G.rebel : G.empire;
          (f.cinematicTacticDiscard ??= []).push(sel.cardId);
          c.cinematicTacticDoneThisRound.push(key);
          // Deployment's gain has no prevent; its secondary (LOCKSPECIAL) is a
          // separate ability the player didn't choose, so nothing else to apply.
          requestChoice(G, {
            tag: 'cinematic-gain',
            side,
            domain: 'unit',
            prompt: 'Deployment — gain a triangle ground unit',
            detail: 'Choose which triangle ground unit to deploy into the system.',
            candidates: gtypes.map((id) => ({ id, label: G.catalog.unitTypes[id]?.name ?? id })),
            min: 1,
            max: 1,
            submitLabel: 'Deploy',
            context: { systemId: c.systemId, side, cardId: sel.cardId, theater },
          });
          log(G, { kind: 'choice-request', side, payload: { kind: 'Choice', tag: 'cinematic-gain', theater } });
          return; // paused — the 'cinematic-gain' resolver deploys + resumes
        }
      }
      if (sel) applyCinematicAbility(G, c, side, theater, sel.cardId, sel.useTop);
      else log(G, { kind: 'cinematic-tactic-skip', side, payload: { theater, round: c.round } });
      c.cinematicTacticDoneThisRound.push(key);
      // "You may play an extra card" — re-offer this side immediately (outside
      // the simultaneous ordering); the resolver applies extras at once.
      if (sel && (c.cinematicExtraPlays?.[key] ?? 0) > 0) {
        const extraOpts = cinematicSelectOptions(G, c, side, theater);
        if (extraOpts.length > 0) {
          c.cinematicExtraPlays![key] -= 1;
          G.pendingChoice = {
            kind: 'CinematicTacticSelect', side, theater, round: c.round, extra: true, options: extraOpts,
          };
          log(G, { kind: 'choice-request', side, payload: {
            kind: 'CinematicTacticSelect', theater, round: c.round, options: extraOpts.length, extra: true,
          }});
          return; // paused — resolver applies the extra immediately
        }
      }
    }
  }

  // Attack order: the combat's attacker attacks first by default. CINEMATIC
  // "resolve attacks first" (RoE p.9) can override per theatre — read AFTER
  // the tactic step so a card just played this theatre takes effect now.
  let order: Side[] = [c.attackerSide, other(c.attackerSide)];
  const first = c.cinematic ? c.cinematicResolveFirst?.[theater] : undefined;
  if (first) order = [first, other(first)];

  for (const attacker of order) {
    if (G.isGameOver) break;
    if (c.theaterAttackersDone!.includes(attacker)) continue;
    beginAttack(G, c, attacker, theater);
    if (G.pendingChoice) return; // paused for a choice; resume on next call
    // beginAttack with no choice means side had no units — skip.
  }

  // Reactive cinematic heals ("remove damage after the opponent assigns
  // damage" — Draw Their Fire / Energy Shield) resolve now: after this
  // theatre's attacks, before destruction, so they can save a just-damaged
  // ship from being destroyed below (#225).
  if (c.cinematic && applyDeferredCinematicHeals(G, c, theater)) return; // paused for a heal pick

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

/** Apply a cinematic "Prevent N red/black/special" against an already-rolled
 *  set of dice. RAW (RotE rulebook, "PREVENTING HITS"): remove up to N dice
 *  that show a matching red/black HIT (or direct hit), and up to `special`
 *  dice that show a ★. Only dice that actually rolled the prevented symbol can
 *  be removed — if fewer rolled than the prevent count, only those are taken.
 *  Returns the surviving dice plus the counts actually removed. Pure. */
export function applyCinematicPrevent(
  dice: DieResult[],
  want: { red: number; black: number; special: number },
): { kept: DieResult[]; removed: { red: number; black: number; special: number } } {
  let needRed = want.red, needBlack = want.black, needSpecial = want.special;
  const removed = { red: 0, black: 0, special: 0 };
  const kept: DieResult[] = [];
  for (const d of dice) {
    const isHit = d.face === 'hit' || d.face === 'direct-hit';
    if (needRed > 0 && d.color === 'red' && isHit) { needRed--; removed.red++; continue; }
    if (needBlack > 0 && d.color === 'black' && isHit) { needBlack--; removed.black++; continue; }
    if (needSpecial > 0 && d.face === 'special') { needSpecial--; removed.special++; continue; }
    kept.push(d);
  }
  return { kept, removed };
}

/** Roll dice for `side`, queue the attacker-tactics choice if appropriate.
 *  If no units to roll, marks the side done and returns. */
export function beginAttack(G: GameState, c: CombatState, side: Side, theater: Theater): void {
  const myUnits = unitsOf(G, side, c.systemId, theater);
  if (myUnits.length === 0) {
    c.theaterAttackersDone!.push(side);
    return;
  }

  // Sum attack values, capped at 5R + 5B per attack (rr p.4). RoE adds a
  // third die colour (green); the cap is 3 green per attack (RoE rules p.8:
  // "A player cannot roll more than 3 green dice when attempting a mission
  // or rolling dice in combat. These dice can be used in addition to the
  // maximum of 5 red dice and 5 black dice."). Base-game units have
  // attack.green === 0 so this is a no-op outside the expansion.
  let red = 0, black = 0, green = 0;
  for (const u of myUnits) {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    red += t.attack.red;
    black += t.attack.black;
    green += t.attack.green;
  }
  // RoE p.9: "An ability that reduces the number of dice rolled applies BEFORE
  // the limit of 5 dice is applied." So apply the dice-reduction abilities
  // (Prevent, According To My Design) to the RAW sums first; the 5/5/3 cap is
  // applied AFTER them, just before rolling.

  // CINEMATIC COMBAT "Prevent N red/black/special" tactic effects. RAW (RotE
  // rulebook, "PREVENTING HITS"): these do NOT reduce the number of dice the
  // opponent rolls. The opponent rolls ALL of its dice; at the start of the
  // Assign Damage step the matching results — red/black HITS, or ★ special
  // symbols — are removed. So we stash the prevention here (consuming the
  // accumulator) and apply it to the ROLLED dice in advanceAttackToTactics,
  // after the reroll window. We must NOT under-roll (the old behaviour, which
  // also silently dropped potential ★ symbols the roller could heal/spend with
  // — #401, #408).
  let cinPrevent: { red: number; black: number; special: number } | undefined;
  if (c.cinematic) {
    const prev = takeCinematicPrevent(c, side);
    if (prev.red || prev.black || prev.special) cinPrevent = prev;
  }

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

  // Per-attack cap: 5 red, 5 black, 3 green (rr p.4; RoE green per p.8). Applied
  // AFTER the reductions above, per RoE p.9.
  red = Math.min(5, red);
  black = Math.min(5, black);
  green = Math.min(3, green);

  // Roll dice.
  const dice: DieResult[] = [];
  for (let i = 0; i < red; i++) dice.push(rollDie(G.rng, 'red' as DieColor));
  for (let i = 0; i < black; i++) dice.push(rollDie(G.rng, 'black' as DieColor));
  for (let i = 0; i < green; i++) dice.push(rollDie(G.rng, 'green' as DieColor));

  // CINEMATIC COMBAT reroll (RoE p.9, "Once per attack, reroll up to your
  // leader's tactic value of dice") and the "Removing damage" ★-spend
  // (rulebook p.8) are now INTERACTIVE pause points in advanceAttackToTactics
  // (#15) — the side chooses which dice to reroll and how to spend its ★, with
  // a near-optimal default pre-selected. The AI takes the default.

  // Stash the in-flight attack. The phase will be set by advanceAttackToTactics
  // based on which pre-tactic pause point (Yoda / Special) applies first.
  c.pendingAttack = {
    side, theater,
    phase: 'awaitingYodaReroll', // placeholder; advanceAttackToTactics may change it
    dice,
    attackerUnits: myUnits.length,
    bonusDamage: 0,
    tacticsPlayed: [],
    cinematicPrevent: cinPrevent,
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

  // 0a) CINEMATIC reroll (RoE p.9) — the rolling side may reroll up to its
  //     leader's tactic value of its own dice. Interactive (#15): default =
  //     blanks first, up to the allowance; the player may pick any dice (or
  //     none). The AI takes the suggested default.
  if (c.cinematic && !pa.cinematicRerollResolved) {
    const allowance = leaderTacticValueIn(G, pa.side, c.systemId, pa.theater);
    if (allowance > 0 && pa.dice.length > 0) {
      const suggested = pa.dice
        .map((d, i) => (d.face === 'blank' ? i : -1))
        .filter((i) => i >= 0)
        .slice(0, allowance);
      pa.phase = 'awaitingCinematicReroll';
      G.pendingChoice = {
        kind: 'CinematicReroll',
        side: pa.side, theater: pa.theater, systemId: c.systemId,
        allowance,
        faces: pa.dice.map((d) => d.face),
        colors: pa.dice.map((d) => d.color),
        suggested,
      };
      log(G, { kind: 'choice-request', side: pa.side, payload: {
        kind: 'CinematicReroll', allowance, dice: pa.dice.length,
      }});
      return;
    }
    pa.cinematicRerollResolved = true;
  }

  // 0a¾) YODA reroll (#549) — must run with the other reroll windows, BEFORE
  //     the ★-spend heal and the opponent's prevent, so the rolling side's
  //     dice are final before any are used/removed (reporter: the reroll was
  //     happening after the heal spent ★ dice). Rebel only, once per game
  //     round, requires the Yoda holder at the system. Ring text: "you may
  //     reroll 1 of your dice" — no blank restriction (#540); only a
  //     direct-hit is excluded (strictly-best face, rerolling it is a misclick).
  if (canQueueYodaReroll(G, c, pa.side)) {
    const rerollable = pa.dice
      .map((d, i) => d.face !== 'direct-hit' ? i : -1)
      .filter((i) => i >= 0);
    if (rerollable.length > 0) {
      const yodaHolder = findYodaHolder(G);
      if (yodaHolder) {
        pa.phase = 'awaitingYodaReroll';
        G.pendingChoice = {
          kind: 'YodaReroll',
          side: 'Rebel', context: 'combat',
          theater: pa.theater, systemId: c.systemId,
          blankIndices: rerollable, holderLeaderId: yodaHolder,
        };
        log(G, { kind: 'choice-request', side: 'Rebel', payload: {
          kind: 'YodaReroll',
          candidates: rerollable.length,
          blanks: pa.dice.filter((d) => d.face === 'blank').length,
        }});
        return;
      }
    }
  }

  // 0a½) CINEMATIC "Prevent N red/black/special" — the opponent's tactic card
  //      removes, from this side's now-final (rolled + rerolled) attack, up to
  //      N dice that show a matching red/black HIT or a ★ special. RAW (RotE
  //      rulebook, "PREVENTING HITS"): all dice are ROLLED; matching results
  //      are removed before damage is assigned — the roll is never reduced
  //      (#401, #408). Done before the ★-heal so a prevented ★ can't also be
  //      spent on healing.
  if (c.cinematic && pa.cinematicRerollResolved && pa.cinematicPrevent && !pa.cinematicPreventApplied) {
    const { kept, removed } = applyCinematicPrevent(pa.dice, pa.cinematicPrevent);
    pa.dice = kept;
    pa.cinematicPreventApplied = true;
    if (removed.red || removed.black || removed.special) {
      log(G, { kind: 'cinematic-prevent-applied', side: pa.side, payload: {
        theater: pa.theater, round: c.round,
        red: removed.red, black: removed.black, special: removed.special,
      }});
    }
  }

  // 0b) CINEMATIC "Removing damage" ★-spend (rulebook p.8) — after the (post-
  //     reroll) roll is final, the side may discard each ★ to remove 1 damage
  //     from a matching-colour own unit in this theatre. Interactive (#15):
  //     default = most-damaged first; the player may reassign or skip. Skipped
  //     when special-locked here this round. The AI takes the suggested default.
  if (c.cinematic && pa.cinematicRerollResolved && !pa.cinematicHealResolved) {
    const locked = !!c.cinematicSpecialLock?.[`${pa.side}:${pa.theater}:${c.round}`];
    const budget = {
      red: locked ? 0 : pa.dice.filter((d) => d.face === 'special' && d.color === 'red').length,
      black: locked ? 0 : pa.dice.filter((d) => d.face === 'special' && d.color === 'black').length,
    };
    if (budget.red + budget.black > 0) {
      const candidates = unitsOf(G, pa.side, c.systemId, pa.theater)
        .filter((u) => u.damage > 0)
        .map((u) => ({ u, color: G.catalog.unitTypes[u.typeId]?.health.color as 'red' | 'black' | undefined }))
        .filter((x) => x.color === 'red' || x.color === 'black')
        .map((x) => ({ instanceId: x.u.instanceId, typeId: x.u.typeId, color: x.color as 'red' | 'black', damage: x.u.damage }));
      if (candidates.length > 0) {
        const suggested = suggestHealAllocation(
          candidates.map((x) => ({ ...x, health: G.catalog.unitTypes[x.typeId]?.health.value ?? 1 })),
          budget,
        );
        pa.phase = 'awaitingCinematicHeal';
        G.pendingChoice = {
          kind: 'CinematicHeal',
          side: pa.side, theater: pa.theater, systemId: c.systemId,
          budget, candidates, suggested,
        };
        log(G, { kind: 'choice-request', side: pa.side, payload: {
          kind: 'CinematicHeal', redStars: budget.red, blackStars: budget.black, wounded: candidates.length,
        }});
        return;
      }
    }
    pa.cinematicHealResolved = true;
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
    if (oimLeaderAt(G, c.systemId) && pa.dice.length > 0) {
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

  // 2) Special-die spend (BASE GAME only) — draw/play base tactic cards with ★.
  //     In CINEMATIC combat the base tactic deck is off entirely: ★ dice are
  //     consumed by the cinematic reroll/heal windows above, so this window must
  //     NOT fire — otherwise a side could draw and play base tactic cards mid-
  //     cinematic-combat (player report #244: AI using base tactics with
  //     cinematic enabled).
  const specials = pa.dice.filter((d) => d.face === 'special').length;
  if (specials > 0 && !pa.specialsResolved && !c.cinematic) {
    const hand = pa.side === c.attackerSide ? c.attackerHand : c.defenderHand;
    const specialCards = hand.filter((cid) => {
      const card = G.catalog.tactics[cid];
      if (!card) return false;
      if (card.theater !== pa.theater) return false;
      // Use the card's requiresSpecial flag — NOT a rulesText keyword search.
      // Cards like Unstoppable Assault / Onslaught / Take It Down / Brilliant
      // Strategy need a ★ but never say "special" in their text, so the old
      // regex hid them from the special-spend choice (player reports #116/#117).
      return card.requiresSpecial === true;
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
    // Ring text allows rerolling ANY of your dice (#540) — only a direct-hit
    // is refused (strictly-best face; a "reroll" of it is always a misclick).
    if (pa.dice[rerollIndex].face === 'direct-hit') return { ok: false, reason: 'direct-hit-not-rerollable' };
    const oldFace = pa.dice[rerollIndex].face;
    const fresh = rollDie(G.rng, pa.dice[rerollIndex].color);
    log(G, { kind: 'yoda-reroll', side: 'Rebel', payload: {
      holder: G.pendingChoice.holderLeaderId, systemId: c.systemId,
      color: pa.dice[rerollIndex].color, oldFace, newFace: fresh.face,
    }});
    pa.dice[rerollIndex] = fresh;
    // An actual reroll spends the once-per-GAME-round power.
    G.yodaRerollUsedThisRound = true;
  } else {
    // SKIP does NOT spend the ring (#540): the card says "you may reroll" —
    // declining isn't using, and players deliberately save it for the Death
    // Star Plans roll later in the same combat. The combat-round flag below
    // still prevents the #305 re-queue loop (this prompt won't re-post this
    // combat round), but the game-round power stays available for the DSP
    // window, a later combat round, or a mission.
    log(G, { kind: 'yoda-skipped', side: 'Rebel', payload: { context: 'combat', systemId: c.systemId } });
  }
  c.yodaRerollUsedRound = c.round;
  G.pendingChoice = undefined;
  advanceAttackToTactics(G, c);
  return { ok: true };
}

/** Resolve the RoE Cinematic once-per-attack reroll (#15). `indices` = the
 *  dice positions to reroll (≤ the leader's tactic-value allowance); an empty
 *  array keeps the roll. The dice reroll in place (same colour). */
export function resolveCinematicReroll(
  G: GameState, indices: number[]
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingCinematicReroll') return { ok: false, reason: 'no-reroll-phase' };
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'CinematicReroll') return { ok: false, reason: 'no-choice' };
  const uniq = [...new Set(indices)];
  if (uniq.length > pc.allowance) return { ok: false, reason: 'over-allowance' };
  for (const i of uniq) {
    if (i < 0 || i >= pa.dice.length) return { ok: false, reason: `bad-index:${i}` };
  }
  for (const i of uniq) pa.dice[i] = rollDie(G.rng, pa.dice[i].color);
  if (uniq.length > 0) {
    log(G, { kind: 'cinematic-reroll', side: pa.side, payload: {
      theater: pa.theater, round: c.round, rerolled: uniq.length, allowance: pc.allowance,
    }});
  }
  pa.cinematicRerollResolved = true;
  G.pendingChoice = undefined;
  advanceAttackToTactics(G, c);
  return { ok: true };
}

/** Resolve the RoE Cinematic "Removing damage" ★-spend (#15). `allocation`
 *  maps own wounded matching-colour units to the damage to remove (the sum
 *  per colour must not exceed the ★ budget; each amount ≤ that unit's damage).
 *  An empty allocation spends no ★. */
export function resolveCinematicHeal(
  G: GameState, allocation: { instanceId: string; amount: number }[]
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingCinematicHeal') return { ok: false, reason: 'no-heal-phase' };
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'CinematicHeal') return { ok: false, reason: 'no-choice' };
  const spent = { red: 0, black: 0 };
  // Validate before applying (atomic): every target is a listed candidate, the
  // amount fits the unit's current damage, and per-colour totals fit the budget.
  for (const a of allocation) {
    if (a.amount <= 0) continue;
    const cand = pc.candidates.find((x) => x.instanceId === a.instanceId);
    if (!cand) return { ok: false, reason: `not-a-candidate:${a.instanceId}` };
    if (a.amount > cand.damage) return { ok: false, reason: `over-damage:${a.instanceId}` };
    spent[cand.color] += a.amount;
  }
  if (spent.red > pc.budget.red || spent.black > pc.budget.black) {
    return { ok: false, reason: 'over-budget' };
  }
  let healed = 0;
  for (const a of allocation) {
    if (a.amount <= 0) continue;
    const u = unitsOf(G, pa.side, c.systemId, pa.theater).find((x) => x.instanceId === a.instanceId);
    if (u) { u.damage = Math.max(0, u.damage - a.amount); healed += a.amount; }
  }
  if (healed > 0) {
    log(G, { kind: 'cinematic-remove-damage', side: pa.side, payload: {
      theater: pa.theater, round: c.round, removed: healed,
    }});
    restageTheater(G, c); // un-stage units healed back below lethal (player #256)
  }
  pa.cinematicHealResolved = true;
  G.pendingChoice = undefined;
  advanceAttackToTactics(G, c);
  return { ok: true };
}

/** Resolve a Draw Their Fire / Energy Shield heal allocation (#322). `allocation`
 *  is the chosen damage-removal per unit; it's validated and clamped, then the
 *  consumed deferred-heal entry is dropped and combat resumes (the theatre's
 *  destruction step and any later theatre continue). */
export function resolveCinematicDeferredHeal(
  G: GameState, allocation: { instanceId: string; amount: number }[]
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'CinematicDeferredHeal') return { ok: false, reason: 'no-choice' };
  // Validate: every target is a listed candidate and within its damage; the
  // total fits the heal budget.
  let total = 0;
  for (const a of allocation) {
    if (a.amount <= 0) continue;
    const cand = pc.candidates.find((x) => x.instanceId === a.instanceId);
    if (!cand) return { ok: false, reason: `not-a-candidate:${a.instanceId}` };
    if (a.amount > cand.damage) return { ok: false, reason: `over-damage:${a.instanceId}` };
    total += a.amount;
  }
  if (total > pc.amount) return { ok: false, reason: 'over-budget' };
  G.pendingChoice = undefined;
  applyDeferredHealAllocation(G, c, pc.theater, pc.side, allocation);
  runCombat(G); // resume: finalize this theatre's destructions and continue
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
  plays: { concentrateFireCardId?: string | null; damageBoostCardIds?: string[]; noEscapeCardId?: string | null },
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
    // A tactic card with a ★ requirement (Onslaught, Take It Down) may ONLY be
    // played by spending a rolled special die — that path is resolveSpecialDie
    // Spend(), which charges 1 special per card. This regular-tactics path must
    // NOT also play them, or a player could play them with no special rolled
    // (player report #204). Critical Hit (requiresSpecial:false) stays free here.
    if (G.catalog.tactics[cid]?.requiresSpecial === true) continue;
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

  // No Escape (free space tactic): "your opponent cannot retreat this round."
  // The attacker plays it to trap the defending fleet. The effect persists
  // through the round's retreat step (combat.ts retreat loop honours the flag)
  // and is cleared at end-of-round. Base combat only (cinematic has its own deck).
  if (plays.noEscapeCardId) {
    const cid = plays.noEscapeCardId;
    if (hand.includes(cid) && cid.includes('no-escape') && !c.cinematic
        && G.catalog.tactics[cid]?.theater === pa.theater) {
      discardCard(G, hand, cid);
      const opp = other(pa.side);
      c.flags ??= {};
      c.flags.cannotRetreatThisRound ??= {};
      c.flags.cannotRetreatThisRound[opp] = true;
      pa.tacticsPlayed.push({ card: cid, detail: 'No Escape: opponent cannot retreat this round' });
      log(G, { kind: 'combat-tactic', side: pa.side, payload: { card: cid, suppressesRetreat: true } });
    }
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
  plays: { blockCardIds: string[]; sacrificeCardIds: string[]; noEscapeCardId?: string | null },
): { ok: boolean; reason?: string } {
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  const pa = c.pendingAttack;
  if (!pa || pa.phase !== 'awaitingDefenderTactics') return { ok: false, reason: 'no-pending-attack' };
  if (!G.pendingChoice || G.pendingChoice.kind !== 'CombatDefenderTactics') return { ok: false, reason: 'no-defender-choice' };

  const defenderSide = other(pa.side);
  const defHand = defenderSide === c.attackerSide ? c.attackerHand : c.defenderHand;

  // No Escape (free space tactic): the defender plays it so the attacking
  // fleet cannot retreat this round. opp here is the attacker (pa.side).
  if (plays.noEscapeCardId) {
    const cid = plays.noEscapeCardId;
    if (defHand.includes(cid) && cid.includes('no-escape') && !c.cinematic
        && G.catalog.tactics[cid]?.theater === pa.theater) {
      discardCard(G, defHand, cid);
      c.flags ??= {};
      c.flags.cannotRetreatThisRound ??= {};
      c.flags.cannotRetreatThisRound[pa.side] = true;
      pa.tacticsPlayed.push({ card: cid, detail: 'No Escape: opponent cannot retreat this round' });
      log(G, { kind: 'combat-tactic', side: defenderSide, payload: { card: cid, suppressesRetreat: true } });
    }
  }

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
      // RAW: "Discard 1 [ground/space] tactic card from your hand to block up
      // to 2 damage." Playing the card requires sacrificing one OTHER tactic
      // card, and it blocks up to 2 (not 1 — that was the bug). finalizeAttack
      // caps blocks at the actual incoming hits, so overshooting is harmless.
      const sacrifice = plays.sacrificeCardIds[sacrificeIdx++];
      if (!sacrifice || !defHand.includes(cid)) continue;
      // The sacrifice may be ANOTHER COPY of the same card — two Dig In cards
      // share the id 'ground-dig-in', so the old `sacrifice === cid` reject
      // wrongly blocked playing one and discarding the other (#565). Verify by
      // COPY COUNT: need 2 of `cid` when self-sacrificing, else 1 of each.
      const cidCount = defHand.filter((x) => x === cid).length;
      if (sacrifice === cid ? cidCount < 2 : !defHand.includes(sacrifice)) continue;
      discardCard(G, defHand, cid);
      discardCard(G, defHand, sacrifice);
      blocks += 2;
      pa.tacticsPlayed.push({ card: cid, detail: `blocked up to 2 (discarded ${sacrifice})` });
      log(G, { kind: 'combat-tactic', side: defenderSide, payload: { card: cid, blocked: 2, discarded: sacrifice } });
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
  type Hit = { color: 'red' | 'black' | null; face: 'hit' | 'direct-hit'; source?: string; convertible?: boolean };
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

  // "Target the Star Destroyers" (Wedge) — Rebel space attack. RAW: the
  // player MAY treat up to 2 of their black hits as red. We previously
  // force-converted the max, which wasted black hits the player wanted to
  // keep on black-health ships (e.g. finishing a TIE after the Star
  // Destroyer was already dead — player report #171). Instead, mark up to
  // 2 black hits as `convertible`: isLegalTarget (below) lets a convertible
  // black hit strike a red-health unit OR a black-health unit, so the
  // attacker's per-hit damage-assignment picks BECOME the conversion
  // choice. Capping the marks at 2 enforces the "up to 2" limit.
  if (c.flags?.targetTheStarDestroyersActive && pa.side === 'Rebel' && pa.theater === 'space') {
    let marked = 0;
    for (const h of rawHits) {
      if (marked >= 2) break;
      if (h.color === 'black' && h.face === 'hit') { h.convertible = true; marked++; }
    }
    if (marked > 0) {
      pa.tacticsPlayed.push({
        card: 'target-the-star-destroyers',
        detail: `Rebel: up to ${marked} black hit${marked === 1 ? '' : 's'} may strike red-health ships (your damage choice).`,
      });
      log(G, { kind: 'combat-action-card-applied', side: 'Rebel', payload: {
        card: 'target-the-star-destroyers', convertibleBlackHits: marked, theater: pa.theater, round: c.round,
      }});
    }
  }

  // RR p.5 puts blocks AFTER assignment: step 3 is "Assign Damage" ("Players
  // must assign all dice that they are able to assign"), step 4 is "Block
  // Damage" — "for each damage blocked, remove one damage that was assigned to
  // one of his units." We used to pre-slice the first N hits off the roll,
  // which both hid hits the attacker was entitled to assign (#622) and ate
  // whichever hit happened to be first in the list — usually a Take It Down
  // bonus hit, making the card look like it only dealt 1 damage (#623).
  // So: offer every hit for assignment, and cancel `blocksApplied` of the
  // ASSIGNED damage afterwards (see resolveCombatAssignDamage).
  const applicableHits = rawHits;

  // Compute eligible targets (color-matched, skip Death Star which has
  // health.color === null).
  // In BASE combat a unit that reached lethal damage this theatre step is
  // "staged" (destroyed at end of step) and must not be re-targeted. In
  // CINEMATIC combat, lethally-damaged units stay on the board until the end of
  // the round and a heal can still save them — so the attacker is allowed to
  // pile extra damage onto an already-damaged unit ("overdamage") to insure the
  // kill against a heal. RAW permits assigning hits to it, so don't exclude
  // staged units from targeting in cinematic (#274).
  const stagedSet = new Set(c.theaterStaged ?? []);
  const liveTargets = unitsOf(G, other(pa.side), c.systemId, pa.theater)
    .filter((u) => c.cinematic || !stagedSet.has(u.instanceId));

  // RoE Shield Bunker (rules p.8): "Death Stars and DSUC cannot be destroyed
  // or be assigned damage when a Shield Bunker is in the system." Filter the
  // Death Star and DSUC out of the eligible-targets list while a Shield
  // Bunker survives in the system. Death Star itself has health.color===null
  // and is already excluded by the line below, but for DSUC (red 4 health,
  // damageable in base game) the Shield Bunker protection is decisive.
  // Symmetric: Rebels don't have Shield Bunkers, so this only protects
  // Imperial Death Stars / DSUC. The shield-bunker plans-block (DS Plans
  // objective) is enforced separately in the DSP path. As soon as all
  // Shield Bunkers are destroyed in the system, protection lapses naturally
  // because this reads live `c.systemId` ground units.
  const shieldBunkerProtects = (typeId: string): boolean => {
    if (!G.expansion?.enabled) return false;
    if (typeId !== 'death-star' && typeId !== 'death-star-under-construction') return false;
    const ss = G.map.systems[c.systemId];
    return (ss?.units ?? []).some(
      (u) => u.side === 'Empire' && u.typeId === 'shield-bunker',
    );
  };

  const isLegalTarget = (h: Hit, u: UnitInstance): boolean => {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.health.color === null) return false; // undamageable
    if (shieldBunkerProtects(u.typeId)) return false; // RoE Shield Bunker
    if (h.face === 'direct-hit') return true;
    // Target the Star Destroyers: a convertible black hit may strike a
    // red-health unit as if it were red (in addition to black-health units).
    if (h.convertible && t.health.color === 'red') return true;
    return h.color !== null && t.health.color === h.color;
  };

  const targetsByHit: string[][] = applicableHits.map(
    (h) => liveTargets.filter((u) => isLegalTarget(h, u)).map((u) => u.instanceId)
  );

  // No work to do → record report and finish. Blocks that meet or exceed the
  // whole hit list wipe it out however the attacker assigns, so skip the
  // pointless prompt rather than making them assign damage that all evaporates.
  if (applicableHits.length === 0 || targetsByHit.every((t) => t.length === 0)
      || blocksApplied >= applicableHits.length) {
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
    blocksApplied,
  };
  log(G, { kind: 'choice-request', side: pa.side, payload: {
    kind: 'CombatAssignDamage', theater: pa.theater, hits: applicableHits.length, blocksApplied,
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

  // Validate every pick before anything is cancelled or applied.
  for (let i = 0; i < assignments.length; i++) {
    const target = assignments[i];
    if (target === null) continue;
    if (!choice.targetsByHit[i].includes(target)) {
      return { ok: false, reason: `illegal-target-at-hit-${i}:${target}` };
    }
  }

  // RR p.5 step 4 (Block Damage): the DEFENDER now removes one assigned damage
  // per block from his own units. He'd obviously spend them where they save a
  // unit, so cancel greedily: cheapest rescue first, tie-broken toward the
  // beefier unit, then dump any leftover blocks on the most-damaged survivors.
  const cancelsLeft = new Map<string, number>();
  const blocks = pa.pendingAssignment.blocksApplied;
  if (blocks > 0) {
    const assignedCount = new Map<string, number>();
    for (const t of assignments) {
      if (t !== null) assignedCount.set(t, (assignedCount.get(t) ?? 0) + 1);
    }
    const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
    type Cand = { id: string; cost: number; value: number; assigned: number };
    const rescues: Cand[] = [];
    const others: Cand[] = [];
    for (const [id, assigned] of assignedCount) {
      const u = ss.units.find((x) => x.instanceId === id);
      const hp = u ? G.catalog.unitTypes[u.typeId]?.health.value : undefined;
      if (!u || hp === undefined) continue;
      const value = G.catalog.unitTypes[u.typeId]?.buildResource ?? 1;
      // Damage needed to remove so the unit ends below lethal.
      const cost = u.damage + assigned - hp + 1;
      if (cost > 0 && cost <= assigned) rescues.push({ id, cost, value, assigned });
      else others.push({ id, cost: 0, value, assigned });
    }
    rescues.sort((a, b) => a.cost - b.cost || b.value - a.value || (a.id < b.id ? -1 : 1));
    let budget = blocks;
    for (const r of rescues) {
      if (r.cost > budget) continue;
      budget -= r.cost;
      cancelsLeft.set(r.id, r.cost);
    }
    // Leftover blocks still remove real damage markers — spend them on the
    // units that will survive, biggest first.
    others.sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : 1));
    for (const o of [...rescues, ...others]) {
      if (budget <= 0) break;
      const already = cancelsLeft.get(o.id) ?? 0;
      const room = Math.min(o.assigned - already, budget);
      if (room <= 0) continue;
      cancelsLeft.set(o.id, already + room);
      budget -= room;
    }
    log(G, { kind: 'combat-blocks-removed', side: other(pa.side), payload: {
      theater: pa.theater, blocks, removed: blocks - budget,
      perUnit: Object.fromEntries(cancelsLeft),
    }});
  }

  let damageApplied = 0;
  const stagedSet = new Set(c.theaterStaged ?? []);
  for (let i = 0; i < assignments.length; i++) {
    const target = assignments[i];
    if (target === null) continue;
    const cancels = cancelsLeft.get(target) ?? 0;
    if (cancels > 0) {
      // Blocked: this assigned damage is removed before it lands.
      cancelsLeft.set(target, cancels - 1);
      continue;
    }
    if (!c.cinematic && stagedSet.has(target)) {
      // BASE combat: target is already dead from an earlier hit this same
      // assignment. Skip the hit (the engine doesn't auto-redirect — that's the
      // attacker's responsibility in RAW; we don't pick for them). In CINEMATIC
      // combat the attacker may deliberately pile extra damage on a lethally-
      // damaged unit (overdamage) to beat a heal, so we DON'T skip it (#274).
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
export function finalizeTheaterDestructions(G: GameState, c: CombatState, theater: Theater): void {
  const staged = c.theaterStaged ?? [];
  if (staged.length === 0) return;
  const bucketIdx = c.currentRoundReportIdx;
  const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
  for (const unitId of staged) {
    if (G.isGameOver) break;
    const u = ss.units.find((x) => x.instanceId === unitId);
    if (!u) continue; // already gone (e.g. retreated)
    // RoE cinematic (rulebook p.8): a unit is only destroyed at the end of the
    // theatre's combat round if its damage STILL equals/exceeds its health — a
    // Remove-Damage combat action or a heal tactic (Energy Shield / Draw Their
    // Fire / shield-absorb) earlier this round can pull it back below lethal and
    // save it. Re-check here rather than trusting the at-staging-time snapshot.
    // (In standard combat there are no in-round heals, so this is equivalent.)
    const maxHp = G.catalog.unitTypes[u.typeId]?.health.value;
    if (maxHp !== undefined && u.damage < maxHp) continue; // healed below lethal — survives
    const typeId = u.typeId;
    const side = u.side;
    M.destroyUnit(G, unitId, 'combat');
    const lastAttack = bucketIdx !== undefined && c.report.rounds[bucketIdx]
      ? c.report.rounds[bucketIdx].attacks.filter((a) => a.theater === theater).slice(-1)[0]
      : undefined;
    if (lastAttack) lastAttack.destroyed.push({ typeId, instanceId: unitId });
    // No dice attack in this theatre to attribute the kill to (the unit died
    // purely from cinematic tactic damage) — record it as a card destruction so
    // it still counts toward combat objectives (#383).
    else (c.report.cardDestructions ??= []).push({ side, typeId });
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
    // "Draw 2 tactic cards from either deck, or 1 from each." When combat is
    // happening in only ONE theater, the other deck's cards can't be played
    // here — so take BOTH from the active deck instead of wasting a draw on a
    // card that's dead for this fight. When both theaters are live, keep the
    // 1-from-each split. (Player request.)
    const hand = side === c.attackerSide ? c.attackerHand : c.defenderHand;
    const spaceActive = bothSidesHaveTheater(G, c.systemId, 'space');
    const groundActive = bothSidesHaveTheater(G, c.systemId, 'ground');
    const drawn: string[] = [];
    const drawFrom = (deck: string[]) => { const d = deck.shift(); if (d) drawn.push(d); };
    if (spaceActive && !groundActive) {
      drawFrom(G.spaceTacticDeck); drawFrom(G.spaceTacticDeck);
    } else if (groundActive && !spaceActive) {
      drawFrom(G.groundTacticDeck); drawFrom(G.groundTacticDeck);
    } else {
      drawFrom(G.spaceTacticDeck); drawFrom(G.groundTacticDeck);
    }
    for (const d of drawn) hand.push(d);
    pa.tacticsPlayed.push({ card: cardId, detail: `Brilliant Strategy: +${drawn.length} cards` });
    log(G, { kind: 'combat-tactic', side, payload: { card: cardId, drew: drawn } });
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
  // Damage-boost cards (Onslaught / Take It Down / Critical Hit). These need a
  // ★ to play, so they reach combat via THIS special-spend path — but the
  // bonus-damage logic also lives in resolveAttackerTactics' damageBoostCardIds
  // branch. Mirror it here so they actually resolve instead of logging "effect
  // not yet wired" (player report #156: Onslaught did nothing). bonusDamage +
  // bonusDamageSources feed the per-card target constraint in assignDamage
  // (Onslaught spreads to different targets; Take It Down concentrates).
  const boost = cardId.includes('take-it-down') ? 2
              : cardId.includes('onslaught')    ? 2
              : cardId.includes('critical-hit') ? 1
              : 0;
  if (boost > 0) {
    pa.bonusDamage += boost;
    (pa.bonusDamageSources ??= []).push({ source: cardId, amount: boost });
    pa.tacticsPlayed.push({ card: cardId, detail: `+${boost} damage` });
    log(G, { kind: 'combat-tactic', side, payload: { card: cardId, bonusDamage: boost } });
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
      // RAW base clause: "Rebel player must keep tactic cards faceup." The
      // engine has perfect info, but the COMBAT BOARD doesn't — it hides the
      // opponent's hand, so the Empire used to pay for this card and see
      // nothing change (#621). The flag now also un-hides the Rebel hand in
      // TacticHandsBar. The RoE clause ("you do not choose a tactic card until
      // after the Rebel's card has been revealed each round") keeps its teeth
      // in cinematic combat: the SELECT step forces the Rebel to choose first
      // and shows the Empire the Rebel's card (#352).
      c.flags = c.flags ?? {};
      c.flags.goodIntelActive = true;
      log(G, { kind: 'combat-action-card-effect', side, payload: {
        card: cardId,
        applied: c.cinematic
          ? 'rebel-tactics-faceup + empire-chooses-tactic-after-rebel-reveals'
          : 'rebel-tactics-faceup',
      } });
      return;
    }
    case 'its-a-trap': {
      // RAW: During round 1, opponent cannot play space tactic cards. Record
      // WHICH side is locked (the opponent of the player) so isCinematicLocked
      // can enforce it — the flag was previously set but never read (#272).
      c.flags = c.flags ?? {};
      c.flags.opponentNoSpaceTacticsRound = 1;
      c.flags.noSpaceTacticsRound1Side = other(side);
      log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, applied: `${other(side).toLowerCase()}-no-space-tactics-round-1` } });
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
    case 'baze-s-loyalty': {
      // RoE (Chirrut): "Destroy 2 health-worth of units." The playing side
      // chooses which enemy units to destroy, one at a time, within a 2-health
      // budget (player report #316 — the choice was being auto-resolved).
      if (!postBazesLoyaltyTarget(G, c, side, 2)) {
        log(G, { kind: 'combat-action-card-effect', side, payload: {
          card: cardId, applied: 'no-effect (no affordable target)',
        }});
      }
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
    // RAW (Rules Reference, "Action Cards"): a combat/mission action card needs
    // one of its named leaders already in the system — EXCEPT cards that move a
    // leader into the system. Ready For Action places a leader from the pool
    // into the combat, so its leaderRequirement is the card-art association, not
    // a presence gate; offer it whenever the pool can supply a leader (#441).
    const movesLeaderIn = cid === 'ready-for-action';
    if (!movesLeaderIn && req.length > 0 && !req.some((lid) => leadersHere.has(lid))) return false;
    // Some Start-of-Combat cards do nothing unless a legal target exists in the
    // system. Offering them with no valid target lets a player waste the card
    // (player report: "Target the Generator offered where there are no
    // structures"). Gate those on target availability — RAW: their effect text
    // names a specific target that must be present.
    if (!hasStartOfCombatLegalTarget(G, c, cid, side)) return false;
    return true;
  });
}

/** Whether `cardId`'s Start-of-Combat effect has at least one legal target in
 *  the combat system. Cards without a hard target requirement return true.
 *  `side` is the side that would play the card (used for enemy-relative checks). */
function hasStartOfCombatLegalTarget(G: GameState, c: CombatState, cardId: string, side: Side): boolean {
  const ss = G.map.systems[c.systemId];
  const units = ss?.units ?? [];
  switch (cardId) {
    case 'point-blank-assault': {
      // "All units in the system have -1 health, to a minimum of 1." Only worth
      // playing if an ENEMY unit has health > 1 — a 1-health unit (e.g. a lone
      // TIE Fighter) can't be reduced, so the card weakens nothing the opponent
      // fields and just risks your own units (player report #386).
      const enemy = side === 'Rebel' ? 'Empire' : 'Rebel';
      return units.some((u) => {
        const t = G.catalog.unitTypes[u.typeId];
        return u.side === enemy && t?.health.color !== null && (t?.health.value ?? 0) > 1;
      });
    }
    case 'target-the-generator':
      // "Destroy 1 structure in the system." — needs a structure present.
      return units.some((u) => G.catalog.unitTypes[u.typeId]?.class === 'structure');
    case 'fully-operational': {
      // "If either a Death Star or DSUC is in this system, destroy 1 Rebel ship
      // of your choice in the system." — needs the trigger AND a Rebel ship.
      const hasDeathStar = units.some((u) =>
        u.typeId === 'death-star' || u.typeId === 'death-star-under-construction');
      const hasRebelShip = units.some((u) =>
        u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'space');
      return hasDeathStar && hasRebelShip;
    }
    case 'baze-s-loyalty': {
      // RoE: "Destroy 2 health-worth of units." Needs an enemy (Imperial) unit
      // whose whole health fits the 2-health budget — a lone 3+-health ship
      // can't be destroyed, so the card would do nothing.
      return units.some((u) => {
        if (u.side !== 'Empire') return false;
        const t = G.catalog.unitTypes[u.typeId];
        const h = t?.health.value ?? 0;
        return t?.health.color !== null && h > 0 && h <= 2;
      });
    }
    case 'its-a-trap':
      // "During the first round of combat, your opponent cannot play space
      // tactic cards." Only meaningful when there's actually a space battle —
      // otherwise it's a wasted card (player report #160).
      return bothSidesHaveTheater(G, c.systemId, 'space');
    case 'ready-for-action':
      // Places a leader from the pool into the combat — nothing to place when
      // the side's leader pool is empty (#441).
      return (side === 'Rebel' ? G.rebel : G.empire).leaderPool.length > 0;
    default:
      return true;
  }
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

  // CINEMATIC combat (#449): RoE rulebook — "if an ability lets a player draw
  // tactic cards, he retrieves that many cards OF HIS CHOICE from his discard
  // pile and returns them to his deck." So MDTYR here means: pick up to 3 of
  // the chosen theater's cards from your cinematic discard; they become
  // selectable again (the cinematic "deck" is all cards minus discard minus
  // eliminated). With 3 or fewer retrievable, take them all; with more, pause
  // for the player to pick which 3.
  if (c.cinematic) {
    const f = side === 'Rebel' ? G.rebel : G.empire;
    const eliminated = new Set(f.cinematicTacticEliminated ?? []);
    const pool = (f.cinematicTacticDiscard ?? []).filter((cid) =>
      G.catalog.tactics[cid]?.theater === theater && !eliminated.has(cid));
    if (pool.length > 3) {
      G.pendingChoice = {
        kind: 'MoreDangerousRetrievePick', side, cardId, theater, candidates: pool, count: 3,
      };
      log(G, { kind: 'choice-request', side, payload: {
        kind: 'MoreDangerousRetrievePick', theater, candidates: pool.length,
      }});
      return { ok: true }; // start-of-combat batch stays paused
    }
    retrieveCinematicDiscards(G, side, pool);
    log(G, { kind: 'combat-action-card-effect', side, payload: { card: cardId, retrieved: pool, theater } });
    G.pendingChoice = undefined;
    const batchSide0 = c.startOfCombatBatch?.side ?? side;
    if (!processStartOfCombatBatch(G, c)) return { ok: true };
    advanceStartOfCombatAfterSideDone(G, c, batchSide0);
    return { ok: true };
  }

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

/** Remove the given card ids (one instance each) from `side`'s cinematic
 *  tactic discard — RoE "returns them to his deck" (the deck is derived as
 *  all-cards minus discard minus eliminated, so leaving the discard IS
 *  returning to the deck). */
function retrieveCinematicDiscards(G: GameState, side: Side, cardIds: string[]): void {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const disc = f.cinematicTacticDiscard ?? [];
  for (const cid of cardIds) {
    const i = disc.indexOf(cid);
    if (i >= 0) disc.splice(i, 1);
  }
}

/** Resolve the cinematic MDTYR retrieval pick (#449): return the chosen
 *  discard cards to the deck, then resume the start-of-combat batch exactly
 *  like resolveMoreDangerousTheaterPick. */
export function resolveMoreDangerousRetrievePick(
  G: GameState, cardIds: string[]
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'MoreDangerousRetrievePick') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (cardIds.length !== pc.count) return { ok: false, reason: `expected-${pc.count}-cards` };
  // Validate by count (the discard can hold duplicates of a card id).
  const avail = new Map<string, number>();
  for (const id of pc.candidates) avail.set(id, (avail.get(id) ?? 0) + 1);
  const used = new Map<string, number>();
  for (const id of cardIds) {
    const u = (used.get(id) ?? 0) + 1;
    used.set(id, u);
    if (u > (avail.get(id) ?? 0)) return { ok: false, reason: `not-retrievable:${id}` };
  }
  const side = pc.side;
  retrieveCinematicDiscards(G, side, cardIds);
  log(G, { kind: 'combat-action-card-effect', side, payload: {
    card: pc.cardId, retrieved: cardIds, theater: pc.theater,
  }});
  G.pendingChoice = undefined;
  const batchSide = c.startOfCombatBatch?.side ?? side;
  if (!processStartOfCombatBatch(G, c)) return { ok: true };
  advanceStartOfCombatAfterSideDone(G, c, batchSide);
  return { ok: true };
}

/** "Fully Operational" target pick. `instanceId` = the Rebel ship to
 *  destroy. Continues the start-of-combat batch. */
/** Destroy a unit during an active combat via a CARD effect (not dice),
 *  recording it in the report so it counts toward combat objectives such as
 *  Crippling Blow (player report #317). */
function destroyViaCombatCard(G: GameState, c: CombatState, instanceId: string, cause: string): void {
  const ss = G.map.systems[c.systemId];
  const u = ss?.units.find((x) => x.instanceId === instanceId);
  if (u) (c.report.cardDestructions ??= []).push({ side: u.side, typeId: u.typeId });
  M.destroyUnit(G, instanceId, cause);
}

export function resolveFullyOperationalTargetPick(
  G: GameState, instanceId: string
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'FullyOperationalTargetPick') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (!pc.candidates.includes(instanceId)) return { ok: false, reason: 'bad-target' };
  destroyViaCombatCard(G, c, instanceId, 'fully-operational');
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
  destroyViaCombatCard(G, c, instanceId, 'target-the-generator');
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

/** Post a Baze's Loyalty target pick if any enemy unit in the combat system is
 *  affordable within `budget` health-worth. Returns false (posts nothing) when
 *  no affordable target remains, so the caller can continue the combat batch. */
function postBazesLoyaltyTarget(
  G: GameState, c: CombatState, side: Side, budget: number
): boolean {
  if (budget <= 0) return false;
  const opp: Side = side === 'Rebel' ? 'Empire' : 'Rebel';
  const ss = G.map.systems[c.systemId];
  const candidates = (ss?.units ?? [])
    .filter((u) => {
      if (u.side !== opp) return false;
      const t = G.catalog.unitTypes[u.typeId];
      const h = t?.health.value ?? 0;
      // Destroyable (has a health bar) and the whole unit fits the budget —
      // you can't partially destroy a unit, so a 3-health ship is untouchable
      // by a 2-health budget.
      return t?.health.color !== null && h > 0 && h <= budget;
    })
    .map((u) => u.instanceId);
  if (candidates.length === 0) return false;
  G.pendingChoice = {
    kind: 'BazesLoyaltyTarget', side, systemId: c.systemId, candidates, budget,
  };
  log(G, { kind: 'choice-request', side, payload: {
    kind: 'BazesLoyaltyTarget', cardId: 'baze-s-loyalty', candidates: candidates.length, budget,
  }});
  return true;
}

/** Resolve one Baze's Loyalty pick: destroy `instanceId`, decrement the budget
 *  by its health, then re-post for the next pick or continue combat (#316). */
export function resolveBazesLoyaltyTarget(
  G: GameState, instanceId: string
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'BazesLoyaltyTarget') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (!pc.candidates.includes(instanceId)) return { ok: false, reason: 'bad-target' };
  const ss = G.map.systems[pc.systemId];
  const u = ss?.units.find((x) => x.instanceId === instanceId);
  const h = u ? (G.catalog.unitTypes[u.typeId]?.health.value ?? 0) : 0;
  destroyViaCombatCard(G, c, instanceId, 'bazes-loyalty');
  log(G, { kind: 'combat-action-card-effect', side: pc.side, payload: {
    card: 'baze-s-loyalty', destroyed: instanceId,
  }});
  G.pendingChoice = undefined;
  // More budget AND an affordable target left → keep picking before resuming.
  if (postBazesLoyaltyTarget(G, c, pc.side, pc.budget - h)) return { ok: true };
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

/** Resolve a CINEMATIC tactic-card selection (RoE p.9). `cardId === null`
 *  skips (play no card this theatre this round). Otherwise the chosen card's
 *  primary (useTop) or secondary ability resolves and the card is discarded.
 *  Marks the (side, theatre, round) sub-step done and re-enters runCombat,
 *  which moves to the next side or the dice attacks. */
export function resolveCinematicTacticSelect(
  G: GameState, cardId: string | null, useTop: boolean
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'CinematicTacticSelect') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (cardId !== null) {
    const opt = pc.options.find((o) => o.cardId === cardId);
    if (!opt) return { ok: false, reason: `not-an-option:${cardId}` };
    if (useTop && !opt.primaryUsable) return { ok: false, reason: 'primary-not-usable' };
  }
  const key = `${pc.side}:${pc.theater}:${pc.round}`;

  if (pc.extra) {
    // EXTRA play — apply immediately (outside the simultaneous ordering). May
    // itself grant another extra, so chain while grants and cards remain. Played
    // as a second card via an extra-card effect, so its cancel ability is void
    // and it's inherently uncancellable (it resolves now, not via the cancel
    // loop) — RoE #328.
    if (cardId !== null) applyCinematicAbility(G, c, pc.side, pc.theater, cardId, useTop, true);
    else log(G, { kind: 'cinematic-tactic-skip', side: pc.side, payload: { theater: pc.theater, round: pc.round } });
    const extras = c.cinematicExtraPlays?.[key] ?? 0;
    if (cardId !== null && extras > 0) {
      const extraOpts = cinematicSelectOptions(G, c, pc.side, pc.theater);
      if (extraOpts.length > 0) {
        c.cinematicExtraPlays![key] = extras - 1;
        G.pendingChoice = {
          kind: 'CinematicTacticSelect', side: pc.side, theater: pc.theater, round: pc.round, extra: true, options: extraOpts,
        };
        return { ok: true }; // pause for the next extra
      }
    }
    G.pendingChoice = undefined;
    runCombat(G);
    return { ok: true };
  }

  // BASE selection — STORE it; do NOT apply yet. runCombat re-enters runTheater,
  // which collects the other side's choice and then resolves both in order.
  // RoE p.8: each player MUST play (discard) a card each round; you may decline
  // its abilities. So a "decline" (null cardId) when cards are available becomes
  // a no-ability discard of one of the offered cards (auto-picked — the first
  // option; the discard recycles later anyway, so which one barely matters).
  let selection: { cardId: string; useTop: boolean; noAbility?: boolean } | null;
  if (cardId !== null) {
    selection = { cardId, useTop };
  } else if (pc.options.length > 0) {
    selection = { cardId: pc.options[0].cardId, useTop: false, noAbility: true };
  } else {
    selection = null; // genuinely no card available even after recycle
  }
  (c.cinematicSelections ??= {})[key] = selection;
  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

/** Resolve a cinematic targeted-deal pick (#290): apply the card's burst to the
 *  enemy unit the player chose, staging it if killed, then re-enter runCombat.
 *  The card was already discarded when the choice was posted. */
export function resolveCinematicTargetPick(
  G: GameState, instanceId: string
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'CinematicTargetPick') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (!pc.candidates.includes(instanceId as UnitInstanceId)) return { ok: false, reason: 'not-a-candidate' };
  const ctx = c.flags?.cinematicTargetPick;
  // A TARGETED deal ("deal 4 to 1 AT-AT") dumps the whole amount on one unit.
  // A PLAIN deal ("deal 2 damage") is SPLITTABLE — the player assigns it one
  // point at a time and may spread it across different units (player report
  // #391: Overrun's 2 damage was being forced entirely onto a single target).
  const plainDeal = ctx && !targetDealAbilityFor(ctx.cardId, ctx.useTop)
    ? effectiveDealAbilityFor(G, c, pc.side, pc.theater, ctx.cardId, ctx.useTop) : null;
  if (plainDeal) {
    // Apply ONE point to the chosen unit; stage it if that's lethal.
    const dead = M.damageUnit(G, instanceId, 1);
    if (dead) (c.theaterStaged ??= []).push(instanceId);
    const remaining = pc.amount - 1;
    log(G, { kind: 'cinematic-tactic-play', side: pc.side, payload: {
      cardId: ctx?.cardId, ability: ctx?.useTop ? 'primary' : 'secondary',
      theater: pc.theater, targetDealt: 1, target: instanceId,
    }});
    if (remaining > 0) {
      // Recompute targets, excluding now-doomed units (more damage on a staged
      // unit is wasted), and re-prompt while there's still a real choice.
      const staged = new Set(c.theaterStaged ?? []);
      const next = cinematicDealCandidates(G, c, pc.side, pc.theater, plainDeal)
        .filter((id) => !staged.has(id as UnitInstanceId));
      if (next.length >= 2) {
        if (c.flags?.cinematicTargetPick) c.flags.cinematicTargetPick.amount = remaining;
        G.pendingChoice = {
          kind: 'CinematicTargetPick', side: pc.side, theater: pc.theater,
          systemId: pc.systemId, amount: remaining, candidates: next,
        };
        log(G, { kind: 'choice-request', side: pc.side, payload: {
          kind: 'CinematicTargetPick', theater: pc.theater, amount: remaining, candidates: next.length,
        }});
        return { ok: true }; // paused — player assigns the next point
      }
      // 0–1 targets left → no further choice; auto-assign the remainder.
      for (let k = 0; k < remaining; k++) {
        const live = cinematicDealCandidates(G, c, pc.side, pc.theater, plainDeal)
          .filter((id) => !(c.theaterStaged ?? []).includes(id as UnitInstanceId));
        if (live.length === 0) break;
        const d = M.damageUnit(G, live[0], 1);
        if (d) (c.theaterStaged ??= []).push(live[0]);
      }
    }
  } else {
    applyChosenTargetDeal(G, c, instanceId, pc.amount);
    log(G, { kind: 'cinematic-tactic-play', side: pc.side, payload: {
      cardId: ctx?.cardId, ability: ctx?.useTop ? 'primary' : 'secondary',
      theater: pc.theater, targetDealt: pc.amount, target: instanceId,
    }});
  }
  if (c.flags) c.flags.cinematicTargetPick = undefined;
  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

/** Resolve a Tractor Beam capture pick (#316 audit): the Empire captures the
 *  chosen Rebel leader, then combat resumes (any queued Confrontation runs). */
export function resolveTractorBeamCapturePick(
  G: GameState, leaderId: LeaderId
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'TractorBeamCapturePick') return { ok: false, reason: 'no-pending' };
  if (!G.pendingCombat) return { ok: false, reason: 'no-pending-combat' };
  if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'not-a-candidate' };
  M.captureLeader(G, leaderId);
  log(G, { kind: 'cinematic-tractor-beam-capture', side: 'Empire', payload: { leaderId, systemId: pc.systemId } });
  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

/** Resolve a cinematic destroy-without-rolling pick (#316 audit): remove the
 *  enemy unit the player chose, then re-enter runCombat. The card was already
 *  discarded when the choice was posted. */
export function resolveCinematicDestroyPick(
  G: GameState, instanceId: string
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'CinematicDestroyPick') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (!pc.candidates.includes(instanceId as UnitInstanceId)) return { ok: false, reason: 'not-a-candidate' };
  applyChosenDestroy(G, c, instanceId);
  // Name the card, matching the auto-resolve path's logPlay. Without cardId a
  // reader (or a problem report) sees only "a unit was destroyed" with no way
  // to tell which card did it.
  log(G, { kind: 'cinematic-tactic-play', side: pc.side, payload: {
    cardId: pc.cardId, ability: pc.useTop ? 'primary' : 'secondary',
    theater: pc.theater, destroyed: instanceId,
  }});
  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

/** Resolve Rogue One's post-retreat choice: rescue a captured leader OR remove
 *  a target marker from the combat system. `action` is `rescue:<leaderId>` or
 *  `marker:<source>`. */
export function resolveRogueOneChoice(
  G: GameState, action: string
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'RogueOneChoice') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (action.startsWith('rescue:')) {
    const leaderId = action.slice('rescue:'.length) as LeaderId;
    if (!pc.rescuable.includes(leaderId)) return { ok: false, reason: 'not-rescuable' };
    M.rescueLeader(G, leaderId, 'cinematic-rogue-one');
    log(G, { kind: 'cinematic-rogue-one-rescue', side: 'Rebel', payload: { leaderId } });
  } else if (action.startsWith('marker:')) {
    const source = action.slice('marker:'.length);
    if (!pc.markerSources.includes(source)) return { ok: false, reason: 'no-such-marker' };
    M.removeTargetMarker(G, pc.systemId, source, 'Rebel');
    log(G, { kind: 'cinematic-rogue-one-remove-marker', side: 'Rebel', payload: { systemId: pc.systemId, source } });
  } else {
    return { ok: false, reason: `bad-action:${action}` };
  }
  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

/** Resolve the RoE Cinematic Confrontation leader pick — the Rebel chooses
 *  which Imperial leader (in the combat system) to mark for elimination at the
 *  end of the Command phase. Marks the chosen leader, eliminates the card from
 *  the recyclable discard (RAW "…and eliminate this card." #14), and re-enters
 *  combat. */
export function resolveConfrontationLeaderPick(
  G: GameState, leaderId: LeaderId
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'ConfrontationLeaderPick') return { ok: false, reason: 'no-pending' };
  if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'not-a-candidate' };
  (G.cinematicMarkedForElimination ??= []).push(leaderId);
  log(G, { kind: 'cinematic-confrontation-mark', side: 'Rebel', payload: { leaderId, systemId: pc.systemId } });
  // RAW "…and eliminate this card." (#4/#14): the card is GONE for the game.
  // It stays in the discard (so it's never "available") AND is recorded as
  // eliminated so recycleCinematicDeck never returns it to the deck. (The old
  // code spliced it OUT of the discard, which made it available again — the
  // opposite of eliminating it.)
  (G.rebel.cinematicTacticEliminated ??= []).push('cin-rebel-ground-confrontation');
  if (!(G.rebel.cinematicTacticDiscard ?? []).includes('cin-rebel-ground-confrontation')) {
    (G.rebel.cinematicTacticDiscard ??= []).push('cin-rebel-ground-confrontation');
  }
  G.pendingChoice = undefined;
  runCombat(G);
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

/** Track Them (Empire/RoE Special): Empire picks one of their leaders at
 *  the combat system to return to the leader pool — or declines (leaderId
 *  === null), in which case the card stays in hand. Posted from the retreat
 *  resolver after a Rebel retreat. Either way we resume combat via
 *  runCombat so the post-retreat flow continues unbroken. */
export function resolveTrackThemOffer(
  G: GameState, leaderId: LeaderId | null,
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'TrackThemOffer') return { ok: false, reason: 'no-pending' };
  if (leaderId !== null) {
    if (!pc.candidates.includes(leaderId)) return { ok: false, reason: 'bad-leader' };
    const i = G.empire.actionHand.indexOf('track-them');
    if (i < 0) return { ok: false, reason: 'card-not-in-hand' };
    G.empire.actionHand.splice(i, 1);
    G.empire.actionDiscard.push('track-them');
    M.returnLeader(G, 'Empire', leaderId);
    log(G, { kind: 'track-them-applied', side: 'Empire', payload: {
      leaderId, systemId: pc.systemId,
    }});
  } else {
    log(G, { kind: 'track-them-skipped', side: 'Empire', payload: { systemId: pc.systemId } });
  }
  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

/** Something to Fight For (Rebel/Jyn/RoE Special): Rebel picks one
 *  discarded objective card to move to the top of the deck — or declines
 *  (objectiveId === null), in which case the card stays in hand. Posted
 *  from endCombat after a Rebel battle win. After resolving, call
 *  finishCombatTail so the suspended end-of-combat flow continues. */
export function resolveSomethingToFightForOffer(
  G: GameState, objectiveId: string | null,
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'SomethingToFightForOffer') return { ok: false, reason: 'no-pending' };
  const c = G.pendingCombat;
  if (!c) return { ok: false, reason: 'no-pending-combat' };
  if (objectiveId !== null) {
    if (!pc.candidates.includes(objectiveId)) return { ok: false, reason: 'bad-objective' };
    const handIdx = G.rebel.actionHand.indexOf('something-to-fight-for');
    if (handIdx < 0) return { ok: false, reason: 'card-not-in-hand' };
    // The objective lives in EITHER the discard pile or the scored-objectives
    // list (RoE FAQ: scored objectives are discarded and retrievable — #344).
    // Pull it from wherever it is so the same card can't be retrieved twice.
    const discard = G.rebel.objectiveDiscard ?? [];
    const di = discard.indexOf(objectiveId);
    const scored = G.rebel.scoredObjectives ?? [];
    const si = scored.findIndex((s) => s.objectiveId === objectiveId);
    if (di < 0 && si < 0) return { ok: false, reason: 'objective-not-retrievable' };
    // Discard the action card.
    G.rebel.actionHand.splice(handIdx, 1);
    G.rebel.actionDiscard.push('something-to-fight-for');
    // Remove the objective from its current pile and put it on top of the deck.
    if (di >= 0) discard.splice(di, 1);
    else scored.splice(si, 1); // a previously-scored objective leaves the scored pile
    G.rebel.objectiveDeck?.unshift(objectiveId);
    log(G, { kind: 'something-to-fight-for-applied', side: 'Rebel', payload: {
      objectiveId,
    }});
  } else {
    log(G, { kind: 'something-to-fight-for-skipped', side: 'Rebel', payload: {} });
  }
  G.pendingChoice = undefined;
  finishCombatTail(G, c);
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
  // RoE unit ability — Interdictor (rules p.8): "Rebel units in this system
  // cannot retreat from a system containing an Interdictor." One-directional
  // — Interdictors are Imperial, so only Rebel retreat is blocked. The
  // ability fires whenever ANY Interdictor is in the combat system; "as soon
  // as all Interdictors are destroyed, the ability no longer applies", which
  // is naturally true because this function reads live `ss.units` and
  // already-destroyed units are gone. Phase 6 unit-abilities module.
  if (G.expansion?.enabled && side === 'Rebel') {
    const ss = G.map.systems[c.systemId];
    const hasInterdictor = (ss?.units ?? []).some(
      (u) => u.side === 'Empire' && u.typeId === 'interdictor',
    );
    if (hasInterdictor) return [];
  }
  // RR p.5 "RETREATING" — the destination rule is the SAME for attacker and
  // defender (the old code locked the attacker to its single source system,
  // which is not RAW — and mission-triggered combats like Plan the Assault have
  // NO source, so the attacker could never retreat at all; player report #456:
  // no retreat option offered after a round against a Death Star):
  //   1. Adjacent, not destroyed, and NEVER into a system with opponent units.
  //   2. "A player cannot retreat to a system that his opponent moved units
  //      from to initiate the combat" — bans the attacker's source for the
  //      DEFENDER only (the attacker retreating back to its own source is fine).
  //   3. MUST pick a system containing his units or his loyalty marker, if able.
  //   4. Only if no such system exists: "any adjacent system that does not
  //      contain units" (empty of ALL units, RR's exact fallback wording).
  //   (Rebel Base space is never a destination — it's not in the adjacency map.)
  const opp = other(side);
  const adj = G.catalog.adjacency[c.systemId] ?? [];
  const oppInitiatedFrom = side !== c.attackerSide ? c.attackerSourceSystemId : undefined;
  const candidates = adj.filter((sid) => {
    if (sid === oppInitiatedFrom) return false;
    const ss = G.map.systems[sid];
    if (!ss || ss.destroyed) return false;
    if (ss.units.some((u) => u.side === opp)) return false;
    return true;
  });
  const myLoyalty = side === 'Rebel' ? 'rebel' : 'imperial';
  const preferred = candidates.filter((sid) => {
    const ss = G.map.systems[sid];
    return ss!.units.some((u) => u.side === side) || ss!.loyalty === myLoyalty;
  });
  if (preferred.length > 0) return preferred;
  return candidates.filter((sid) => (G.map.systems[sid]?.units.length ?? 0) === 0);
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
    // Escape Plan: declined the immediate retreat → no cancel.
    if (c.flags?.escapePlanCancel) c.flags.escapePlanCancel = undefined;
    G.pendingChoice = undefined;
    runCombat(G);
    return { ok: true };
  }
  if (!ch.legalDestinations.includes(destSystemId)) {
    return { ok: false, reason: `illegal-dest:${destSystemId}` };
  }
  // RAW (rr p.5): "When a player retreats, he must move all of his ships out
  // of the system. The player can choose to leave ground units and TIE
  // Fighters behind in the system." Plus: "any of his immobile units cannot
  // move; they stay in the system," and "If a player leaves units in the
  // system and his opponent has units the same theater, they resolve another
  // combat round."
  //
  // So on retreat:
  //   - Self-mobile ships — anything in the space theater WITHOUT the
  //     transport-restriction icon — MUST all move out, regardless of what the
  //     player selected. This is capital ships, transports, AND the Rebel
  //     fighters (X-/Y-Wings have no restriction icon and move on their own).
  //   - Restriction-icon units (TIE Fighters) and ground units MAY be left
  //     behind; they move only if the player chose to bring them AND transport
  //     capacity allows. Anything left behind STAYS IN THE SYSTEM ALIVE — it is
  //     NOT destroyed. If a contested theater remains, combat continues next
  //     round. This matches the printed "leave ground units and TIE Fighters
  //     behind" exactly: TIEs carry the restriction icon, X-/Y-Wings do not.
  //   - Immobile units can never move; they stay (alive).
  //
  // `unitInstanceIds` = the units the player wants to BRING (self-mobile ships
  // are force-included). Escape Plan (retreatIgnoresTransport) waives capacity.
  const ignoresTransport = !!c.flags?.retreatIgnoresTransport?.[side];
  const ss = c.systemId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[c.systemId];
  const requested = new Set(
    (unitInstanceIds ?? ch.availableUnits).filter((uid) => ch.availableUnits.includes(uid))
  );
  const toMove: string[] = [];
  const stayBehind: string[] = [];
  const carriers: string[] = [];
  let capAvail = 0;
  if (ss) {
    const leaveableSelected: string[] = [];
    for (const u of ss.units) {
      if (u.side !== side) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t || t.transport.immobile) { stayBehind.push(u.instanceId); continue; } // can't move
      if (t.theater === 'space' && !t.transport.restriction) {
        carriers.push(u.instanceId); // capital ship / transport: must move out
        capAvail += t.transport.capacity;
      } else if (requested.has(u.instanceId)) {
        leaveableSelected.push(u.instanceId); // fighter/ground the player wants to bring
      } else {
        stayBehind.push(u.instanceId); // fighter/ground the player leaves behind (alive)
      }
    }
    toMove.push(...carriers);
    // Bring selected fighters/ground up to transport capacity; overflow stays.
    let cap = capAvail;
    for (const uid of leaveableSelected) {
      if (ignoresTransport || cap > 0) {
        toMove.push(uid);
        if (!ignoresTransport) cap--;
      } else {
        stayBehind.push(uid);
      }
    }
  }
  // A leader can retreat only if the player is also retreating units (rr p.5).
  // If nothing can actually move (e.g. only fighters/ground with no carrier),
  // the retreat is illegal — the player must stay and fight.
  if (toMove.length === 0) return { ok: false, reason: 'no-movable-units' };

  // Move the units (carriers + any fighters/ground that fit). Nothing left
  // behind is destroyed — those units remain in the system.
  for (const uid of toMove) {
    // Damage is mid-combat only. endCombat clears it on units still in the
    // system, but retreating units leave first — clear it here so they don't
    // carry stale damage into their NEXT battle (player report #164: a Star
    // Destroyer that retreated showed up to the rematch already at 3 damage).
    const inst = c.systemId === 'rebel-base-space'
      ? G.map.rebelBaseSpace?.units.find((u) => u.instanceId === uid)
      : G.map.systems[c.systemId]?.units.find((u) => u.instanceId === uid);
    if (inst) inst.damage = 0;
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
  c.retreatHappenedThisRound = true; // Rogue One end-of-round trigger
  // Escape Plan: the retreat happened → cancel the opponent's tactic card.
  if (c.flags?.escapePlanCancel) {
    (c.cinematicCancel ??= {})[c.flags.escapePlanCancel.cancelKey] = true;
    log(G, { kind: 'cinematic-escape-plan-cancel', side, payload: { cancelKey: c.flags.escapePlanCancel.cancelKey } });
    c.flags.escapePlanCancel = undefined;
  }
  (c.report.retreats ??= []).push({ side, toSystemId: destSystemId, leaderId: leaderToMove });
  c.retreatDecidedThisRound = c.retreatDecidedThisRound ?? [];
  if (!c.retreatDecidedThisRound.includes(side)) c.retreatDecidedThisRound.push(side);
  log(G, { kind: 'combat-retreat', side, payload: {
    from: c.systemId, to: destSystemId,
    units: toMove.length,
    leaderId: leaderToMove,
    stayedBehind: stayBehind.length,
    ignoresTransport,
  }});

  // RoE "Track Them" (Empire Special): after a Rebel unit retreats from
  // combat, Empire may discard Track Them to return one of their leaders
  // at the combat system to the leader pool. The offer only fires when the
  // card is in Empire's hand AND there's an eligible leader to return.
  // Posting the offer pauses combat; the resolver consumes the card (or
  // declines) and then resumes via runCombat.
  if (side === 'Rebel'
      && G.expansion?.enabled
      && G.empire.actionHand.includes('track-them')) {
    const empireLeadersHere = G.empire.leadersOnBoard[c.systemId] ?? [];
    if (empireLeadersHere.length > 0) {
      G.pendingChoice = {
        kind: 'TrackThemOffer',
        side: 'Empire',
        systemId: c.systemId,
        candidates: [...empireLeadersHere] as LeaderId[],
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'TrackThemOffer', systemId: c.systemId, candidates: empireLeadersHere.length,
      }});
      return { ok: true };
    }
  }

  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

/** Structure rule (rr p.4 IV): if a side's only remaining ground units are
 *  structures and the opponent still has any ground units in the system, those
 *  structures are destroyed. Idempotent — safe to call every round end and
 *  again at combat end. */
function applyStructureRule(G: GameState, c: NonNullable<GameState['pendingCombat']>): void {
  // RoE rules p.8 — "Destroying and moving structures": with the expansion
  // on, if a player rolled at least 1 die in the ground theater THIS round,
  // their structures survive even when they're the only ground units left,
  // and combat continues into another round. Models the case where a
  // non-structure ground unit attacked (rolled), then died — its structures
  // get to fight on. Base game has no such reprieve and destroys structures
  // immediately. Same applies symmetrically to space, though base-game has
  // no space structures and RoE doesn't add any either.
  for (const side of [c.attackerSide, other(c.attackerSide)] as const) {
    const opp = other(side);
    const myGround = unitsOf(G, side, c.systemId, 'ground');
    if (myGround.length === 0) continue;
    const onlyStructures = myGround.every((u) => G.catalog.unitTypes[u.typeId]?.class === 'structure');
    if (!onlyStructures) continue;
    const oppGround = unitsOf(G, opp, c.systemId, 'ground');
    if (oppGround.length === 0) continue;
    if (G.expansion?.enabled) {
      const thisRound = c.report.rounds.find((r) => r.round === c.round);
      const rolledGroundThisRound = (thisRound?.attacks ?? []).some(
        (a) => a.side === side && a.theater === 'ground' && a.dice.length > 0,
      );
      if (rolledGroundThisRound) {
        log(G, { kind: 'combat-structure-survive', side, payload: { systemId: c.systemId, round: c.round } });
        continue;
      }
    }
    const destroyedTypeIds: string[] = [];
    for (const u of [...myGround]) {
      destroyedTypeIds.push(u.typeId);
      M.destroyUnit(G, u.instanceId, 'combat-structure-rule');
    }
    log(G, { kind: 'combat-structure-destroy', side, payload: { systemId: c.systemId } });
    c.report.structureDestructions.push({ side, typeIds: destroyedTypeIds });
  }
}

/** RAW (rr p.6 "Building a Death Star", LTP combat steps): "If the Imperial
 *  player's only remaining ship is the Death Star Under Construction and the
 *  Rebel player still has ships in the system, the Death Star Under
 *  Construction is destroyed." Without this the DSUC — which under construction
 *  may be unable to land lethal hits — sits forever and the fight is wrongly
 *  declared an inconclusive stalemate (player report #442). Checked at each
 *  round end (before the stalemate guard) and at combat end. Destroying the
 *  DSUC also cancels the Death Star on the build queue (handled by
 *  destroyUnit). Idempotent. */
function applyDsucSoleShipRule(G: GameState, c: NonNullable<GameState['pendingCombat']>): void {
  const empSpace = unitsOf(G, 'Empire', c.systemId, 'space');
  if (empSpace.length !== 1) return;
  const dsuc = empSpace[0];
  if (dsuc.typeId !== 'death-star-under-construction') return;
  // Rebel must still have at least one ship in the space theater.
  if (unitsOf(G, 'Rebel', c.systemId, 'space').length === 0) return;
  destroyViaCombatCard(G, c, dsuc.instanceId, 'dsuc-sole-ship');
  log(G, { kind: 'combat-dsuc-destroyed', side: 'Empire', payload: {
    systemId: c.systemId, round: c.round,
    reason: 'only remaining Imperial ship was the Death Star Under Construction',
  }});
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

  // Structure rule — also run at end-of-combat as a safety net for paths that
  // reach Ended without a normal round boundary (it's idempotent: no-op once
  // the structures are already gone).
  applyStructureRule(G, c);
  // DSUC sole-ship rule — same safety-net rationale (idempotent: no-op once the
  // DSUC is gone or other Imperial ships remain).
  applyDsucSoleShipRule(G, c);

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
  // seq was stamped at combat START (see beginCombat) so this report orders by
  // when the fight began, not when it finished — #331. Don't overwrite it here.
  G.combatReports.push(c.report);

  log(G, { kind: 'combat-end', payload: { systemId: c.systemId, rounds: c.round, winner: c.report.winner } });

  // Combat-timed Rebel objectives — RAW ("Objective Cards"): only 1 objective
  // may be played per combat. If exactly one triggered, play it. If 2+, post a
  // PlayObjective choice so the player picks which to score (the rest stay in
  // hand); pendingCombat is left set and the tail runs from
  // resolveCombatObjectivePick(). Done before clearing pendingCombat so the
  // report sees the combat that triggered them.
  // RAW: only one objective may be played per combat. If Death Star Plans
  // already scored during a space-battle step this combat, no combat-end
  // objective can also be played (#487) — skip the trigger entirely.
  const fired = c.objectivePlayedThisCombat ? [] : objectives.combatObjectivesTriggered(G, c.report);
  if (fired.length >= 2) {
    objectives.postPlayObjectiveChoice(G, fired, 'combat');
    return; // pendingCombat stays set; resolver continues via finishCombatTail
  }
  if (fired.length === 1) {
    playCombatObjective(G, fired[0]);
  }

  // RoE "Something to Fight For" (Rebel/Jyn Special): after winning a
  // BATTLE, may discard this card to pick a discarded objective card and put
  // it on top of the deck. Per the FFG FAQ/errata (p.6) the trigger is "win a
  // battle" — winning either the space OR the ground battle — NOT winning the
  // whole combat. So fire when the Rebel cleared the enemy from any theater a
  // battle was actually fought in, even if the other theater is unresolved or
  // the overall combat is a draw (player report #327). Requires Jyn in the
  // Rebel pool (RAW leader requirement), the card in hand, and a discard.
  const foughtIn = (th: Theater) => c.report.rounds.some(
    (r) => r.attacks.some((a) => a.theater === th && a.damageApplied > 0));
  const rebelWonABattle = (['space', 'ground'] as const).some((th) =>
    foughtIn(th)
    && unitsOf(G, 'Rebel', c.systemId, th).length > 0
    && unitsOf(G, 'Empire', c.systemId, th).length === 0);
  // RoE FAQ (sw03 FAQ v2.1 p.6): in the expansion "all objective cards are
  // discarded after use" — a SCORED objective goes to the discard pile, not the
  // box, so "Something to Fight For" can retrieve it too (player report #344).
  // We keep `scoredObjectives` as the UI history and treat its entries as part
  // of the retrievable discard pile. (The engine never adds scored objectives
  // to `objectiveDiscard`, so we union them here.)
  const stffCandidates = [
    ...new Set([
      ...(G.rebel.objectiveDiscard ?? []),
      ...(G.rebel.scoredObjectives ?? []).map((s) => s.objectiveId),
    ]),
  ];
  // RoE rulebook (p.8 exception list): an action card requires its matching
  // leader to be IN THE SYSTEM to resolve (only Sweep the Area / Secret Facility
  // are exempt). "Something to Fight For" fires off winning a battle, so Jyn
  // must be at the combat system — NOT merely in the pool (the old gate, which
  // meant the card never fired when Jyn was the one fighting — player #342/#344).
  const jynAtBattle = (G.rebel.leadersOnBoard[c.systemId] ?? []).includes('jyn-erso');
  if (!G.pendingChoice
      && G.expansion?.enabled
      && (c.report.winner === 'Rebel' || rebelWonABattle)
      && G.rebel.actionHand.includes('something-to-fight-for')
      && jynAtBattle
      && stffCandidates.length > 0) {
    G.pendingChoice = {
      kind: 'SomethingToFightForOffer',
      side: 'Rebel',
      candidates: stffCandidates,
    };
    log(G, { kind: 'choice-request', side: 'Rebel', payload: {
      kind: 'SomethingToFightForOffer', candidates: stffCandidates.length,
    }});
    return; // pendingCombat stays set; resolver calls finishCombatTail
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
  M.recordObjectiveScored(G, oid, rep, 'combat', G.turnLog.length);
  // RAW: one objective per combat — mark it so the Death Star Plans window
  // (finishCombatTail) won't also let a second objective score (#487).
  if (G.pendingCombat) G.pendingCombat.objectivePlayedThisCombat = true;

  // Seize Control (RoE objective): "Win a space or ground battle in a system
  // with a sabotage marker. You may then remove the marker." The removal clause
  // was first dropped entirely (#414/#452: marker stayed), then auto-applied —
  // but RAW is a "may" and players gave real reasons to keep it (system about
  // to be retaken; won only the ground while the Empire holds space) (#505/#496).
  // We flag it so finishCombatTail raises the optional choice after the combat
  // report is acknowledged (the combat tail is a suspended flow; playCombatObjective
  // runs mid-tail and can't safely pause here).
  if (oid === 'seize-control-2') {
    const sysId = G.pendingCombat?.systemId;
    const ss = sysId ? G.map.systems[sysId] : undefined;
    if (ss?.sabotage && G.pendingCombat) G.pendingCombat.seizeControlMarkerPending = true;
  }

  // Return of the Jedi (objective): "...If Luke Skywalker (Jedi) is in this
  // system, eliminate 1 Imperial leader in this system." The reputation half
  // scored above; this applies the elimination clause, which was previously
  // dropped. FAQ: a leader that retreated is no longer in the system and can't
  // be eliminated; Luke counts even if captured or wearing an Imperial ring.
  // The Rebel chooses which leader — we auto-pick the highest-value Imperial
  // leader present (virtually always Vader or Palpatine, which is what the
  // player wants); a pick modal is a future nicety.
  if (oid === 'return-of-the-jedi-3') {
    const sysId = G.pendingCombat?.systemId;
    if (sysId && lukeJediInSystem(G, sysId)) {
      const impHere = [...(G.empire.leadersOnBoard[sysId] ?? [])];
      if (impHere.length > 0) {
        const valueOf = (lid: string) => {
          const ld = G.catalog.leaders[lid];
          if (!ld) return 0;
          const s = ld.skills;
          return (s.diplomacy ?? 0) + (s.intel ?? 0) + (s.specOps ?? 0) + (s.logistics ?? 0)
               + ld.tacticValues.space + ld.tacticValues.ground;
        };
        const victim = impHere.sort((a, b) => valueOf(b) - valueOf(a))[0];
        M.eliminateLeader(G, 'Empire', victim);
        log(G, { kind: 'return-of-the-jedi-eliminate', side: 'Rebel', payload: {
          systemId: sysId, leaderId: victim,
        }});
      }
    }
  }
}

/** True if Luke Skywalker (Jedi) is "in" `sysId` for the Return of the Jedi
 *  objective — on either side's board there (he may have flipped Imperial via
 *  Lure of the Dark Side) or held captive there (FAQ: still counts). */
function lukeJediInSystem(G: GameState, sysId: string): boolean {
  const lid = 'luke-skywalker-jedi';
  if ((G.rebel.leadersOnBoard[sysId] ?? []).includes(lid)) return true;
  if ((G.empire.leadersOnBoard[sysId] ?? []).includes(lid)) return true;
  return (G.empire.capturedLeaders ?? []).some((c) => c.leaderId === lid && c.systemId === sysId);
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
  // Seize Control (RoE) — RAW is "you MAY remove the sabotage marker" (#505/#496).
  // Raise the optional choice; its resolver re-enters finishCombatTail (the flag
  // is cleared first, so it won't loop). Runs before the Death Star Plans window
  // so the marker decision is made against the just-won system. pendingCombat
  // stays set so the resolver can resume the tail.
  if (c.seizeControlMarkerPending) {
    c.seizeControlMarkerPending = undefined;
    const ss = G.map.systems[c.systemId];
    if (ss?.sabotage) {
      requestChoice(G, {
        tag: 'seize-control-marker',
        side: 'Rebel',
        domain: 'system',
        prompt: 'Seize Control — remove the sabotage marker?',
        detail: 'You won a battle here. You may remove the sabotage marker, or keep it (e.g. if the Empire is about to retake the system).',
        candidates: [{ id: c.systemId }],
        min: 0,
        max: 1,
        submitLabel: 'Confirm',
        context: { systemId: c.systemId },
      });
      log(G, { kind: 'choice-request', side: 'Rebel', payload: { kind: 'Choice', tag: 'seize-control-marker' } });
      return; // pendingCombat stays set; the resolver calls finishCombatTail again.
    }
  }

  // Death Star Plans 2/3 — combat-end catch for the edge where combat ends in
  // a round whose space step never offered the window (e.g. a ground-only
  // finish). The per-round window inside the loop is the primary path now;
  // skip here if it already fired this round so the Rebel isn't asked twice.
  if (!G.isGameOver && !c.dsPlansOfferedThisRound && !c.objectivePlayedThisCombat) maybePostDeathStarPlansChoice(G, c);

  G.pendingCombat = undefined;

  // Target-marker removal is held off while a combat is mid-resolution (the
  // pendingCombat guard in processTargetMarkerRemovals), so transient ground
  // counts can't strip a marker before the battle is decided. Now that combat
  // is fully over and pendingCombat is cleared, re-run invariants on the combat
  // system so a side that conquered it on the ground immediately strips the
  // loser's target marker and banks any reputation (Raid Outposts) or ends the
  // opponent's immediate objective — RAW, and what #363 expected. (#358 was
  // misdiagnosed as "processed at next Refresh"; there is no Refresh sweep.)
  M.postCombatInvariants(G, c.systemId);

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
  } else if (!G.isGameOver && !G.pendingChoice && !G.pendingMission && G.phase === 'Command') {
    // Activate-triggered combat (#268): the activation was the current player's
    // ONE command action, so once combat fully resolves the turn passes to the
    // opponent — mirroring the mission-combat hand-off above. activateSystem no
    // longer advances while combat is pending (it would flip mid-combat, or an
    // immediate-card flush could short-circuit and leave the turn un-advanced).
    // The activator never passed to reach here, so "both passed -> Refresh"
    // can't apply; we only flip to the opponent (skipping them if they passed).
    const next: Side = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
    if (!G.passedThisCommand.includes(next)) G.currentPlayer = next;
  }
}

/** Eligibility-check + post for Death Star Plans 2/3.
 *  Idempotent: only posts a choice; the resolver does the actual work. */
function maybePostDeathStarPlansChoice(G: GameState, c: CombatState): void {
  const hand = G.rebel.objectiveHand ?? [];
  const eligibleCardIds = ['death-star-plans-2', 'death-star-plans-3'].filter((id) => hand.includes(id));
  if (eligibleCardIds.length === 0) return;
  // RoE Secure the Plans: "While the marker remains, Rebels cannot play Death
  // Star Plans." Block the attempt while any secure-the-plans marker is on the
  // board (#323).
  const securePlansActive = Object.values(G.map.systems).some(
    (s) => (s.targetMarkers ?? []).some((m) => m.source === 'secure-the-plans'));
  if (securePlansActive) return;
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

/** After a Death Star Plans attempt resolves, resume the combat loop if the
 *  window was offered mid-combat (the per-round path). At the combat-end
 *  window, pendingCombat is already cleared, so this is a no-op there. */
function resumeAfterDsPlans(G: GameState): { ok: boolean } {
  if (G.pendingCombat && G.pendingCombat.step !== 'Ended') runCombat(G);
  return { ok: true };
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
    return resumeAfterDsPlans(G);
  }
  // RAW: roll 3 dice. Color doesn't matter for mission-style rolls; pick red.
  const faces: string[] = [];
  for (let i = 0; i < 3; i++) faces.push(rollDie(G.rng, 'red').face);
  // Stash the roll and offer the reroll/manipulation cards that explicitly
  // work on the DSP roll — One-in-a-Million ("automatic success with the Death
  // Star Plans objective", rr) and the Yoda ring ("reroll one die per round").
  // dsPlansOfferRerollsOrFinalize posts the next applicable choice, or scores
  // the attempt when none remain (#186).
  G.dsPlansAttempt = {
    objectiveId: pc.objectiveId, systemId: pc.systemId,
    deathStarInstanceIds: pc.deathStarInstanceIds,
    deathStarInstanceId, faces,
  };
  return dsPlansOfferRerollsOrFinalize(G);
}

/** One In A Million names Luke and Wedge (either printing of Luke counts).
 *  RR p.2: the card can only be used if one of them is already in the system
 *  where the mission/combat is happening. */
export function oimLeaderAt(G: GameState, systemId: SystemId): boolean {
  const here = G.rebel.leadersOnBoard[systemId] ?? [];
  return here.some((l) =>
    l === 'luke-skywalker' || l === 'luke-skywalker-jedi' || l === 'wedge-antilles');
}

/** Whether the Yoda ring may reroll a die on the current DSP roll. */
function canQueueDsPlansYoda(G: GameState, d: NonNullable<GameState['dsPlansAttempt']>): boolean {
  if (G.yodaRerollUsedThisRound) return false;
  const holder = findYodaHolder(G);
  if (!holder) return false;
  if (!(G.rebel.leadersOnBoard[d.systemId] ?? []).includes(holder)) return false;
  // Only a direct-hit destroys the Death Star, so on a not-yet-successful roll
  // EVERY die is a dud and rerollable — the ring text ("reroll 1 of your
  // dice") has no blank restriction. The old blanks-only gate wrongly denied
  // the reroll on e.g. hit/special/hit rolls (#540). If a direct-hit is
  // already present the attempt has succeeded — nothing to fix, no offer.
  return d.faces.length > 0 && !d.faces.includes('direct-hit');
}

/** Offer the next applicable DSP reroll/manipulation (One-in-a-Million, then
 *  Yoda), or finalize the attempt when none remain. */
function dsPlansOfferRerollsOrFinalize(G: GameState): { ok: boolean; reason?: string } {
  const d = G.dsPlansAttempt;
  if (!d) return { ok: false, reason: 'no-dsplans-attempt' };
  // One-in-a-Million first — it can set a die straight to direct-hit.
  // RR p.2 (Action Cards): "Action cards used during a mission or combat can
  // only be used if one of the leaders shown on the card is already in the
  // system in which the mission or combat is occurring." The Death Star Plans
  // attempt happens inside a combat at d.systemId, so Luke or Wedge must be
  // there — the combat and mission OIAM paths already gate on this, but the
  // DSP path never did and fired off the card alone (#624).
  if (!d.oimOffered && G.rebel.actionHand.includes('one-in-a-million')
      && d.faces.length > 0 && oimLeaderAt(G, d.systemId)) {
    d.oimOffered = true;
    G.pendingChoice = {
      kind: 'OneInAMillionOffer', side: 'Rebel', context: 'dsplans',
      rebelRoleInRoll: 'attacker',
      faces: [...d.faces], colors: d.faces.map(() => 'red' as const),
    };
    log(G, { kind: 'choice-request', side: 'Rebel', payload: {
      kind: 'OneInAMillionOffer', context: 'dsplans', dice: d.faces.length,
    }});
    return { ok: true };
  }
  // Yoda reroll — reroll one die toward the direct-hit the roll needs (once
  // per game round). Every die is a candidate: the gate above guarantees no
  // direct-hit is present, so all faces are duds on this roll (#540).
  if (!d.yodaOffered && canQueueDsPlansYoda(G, d)) {
    d.yodaOffered = true;
    const yoda = findYodaHolder(G)!;
    const candidates = d.faces.map((_, i) => i);
    G.pendingChoice = {
      kind: 'YodaReroll', side: 'Rebel', context: 'dsplans',
      systemId: d.systemId, blankIndices: candidates, holderLeaderId: yoda,
      missionFaces: [...d.faces],
    };
    log(G, { kind: 'choice-request', side: 'Rebel', payload: {
      kind: 'YodaReroll', context: 'dsplans', candidates: candidates.length,
    }});
    return { ok: true };
  }
  // #540 messaging: the ring-holder is HERE but the once-per-game-round
  // reroll was already spent — say so instead of silently offering nothing
  // (the reporter read the silence as "I was not able to use Luke's Yoda
  // ring on Death Star Plans").
  if (!d.yodaOffered && G.yodaRerollUsedThisRound && !d.faces.includes('direct-hit')) {
    const holder = findYodaHolder(G);
    if (holder && (G.rebel.leadersOnBoard[d.systemId] ?? []).includes(holder)) {
      log(G, { kind: 'yoda-reroll-unavailable', side: 'Rebel', payload: {
        context: 'dsplans', reason: 'already-used-this-round', systemId: d.systemId,
      }});
      pushNotice(
        G,
        `yoda-spent-dsp-t${G.timeMarker}`,
        'Yoda ring — no reroll on this Death Star Plans roll',
        'The Yoda ring reroll was already used this game round (it\'s once per game round, and a combat reroll counts). It refreshes next game round — skipping a combat reroll offer does NOT spend it.',
        'Rebel',
      );
    }
  }
  return finalizeDsPlans(G);
}

/** Resolve the One-in-a-Million offer on a DSP roll: set up to 2 dice faces
 *  (empty picks = skip, keep the card), then continue to Yoda / finalize. */
export function resolveDsPlansOneInAMillion(
  G: GameState, picks: { index: number; face: string }[]
): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'OneInAMillionOffer' || pc.context !== 'dsplans') return { ok: false, reason: 'no-pending' };
  const d = G.dsPlansAttempt;
  if (!d) return { ok: false, reason: 'no-dsplans-attempt' };
  const applied = picks.filter((p) => p.index >= 0 && p.index < d.faces.length).slice(0, 2);
  if (applied.length > 0) {
    for (const p of applied) d.faces[p.index] = p.face;
    const i = G.rebel.actionHand.indexOf('one-in-a-million');
    if (i >= 0) { G.rebel.actionHand.splice(i, 1); G.rebel.actionDiscard.push('one-in-a-million'); }
    log(G, { kind: 'one-in-a-million-used', side: 'Rebel', payload: {
      context: 'dsplans', picks: applied, faces: [...d.faces],
    }});
  }
  G.pendingChoice = undefined;
  return dsPlansOfferRerollsOrFinalize(G);
}

/** Resolve the Yoda reroll offer on a DSP roll. `blankIndex >= 0` rerolls that
 *  blank; -1 skips. Then finalize (or any remaining offer). */
export function resolveDsPlansYoda(G: GameState, blankIndex: number): { ok: boolean; reason?: string } {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'YodaReroll' || pc.context !== 'dsplans') return { ok: false, reason: 'no-pending' };
  const d = G.dsPlansAttempt;
  if (!d) return { ok: false, reason: 'no-dsplans-attempt' };
  // Any die of the roll may be rerolled (#540) — only a direct-hit is refused
  // (the gate never offers on a successful roll, so this is belt-and-braces).
  if (blankIndex >= 0 && blankIndex < d.faces.length && d.faces[blankIndex] !== 'direct-hit') {
    const oldFace = d.faces[blankIndex];
    const nf = rollDie(G.rng, 'red').face;
    d.faces[blankIndex] = nf;
    G.yodaRerollUsedThisRound = true;
    log(G, { kind: 'yoda-reroll', side: 'Rebel', payload: {
      holder: pc.holderLeaderId, context: 'dsplans', index: blankIndex, oldFace, newFace: nf, faces: [...d.faces],
    }});
  }
  G.pendingChoice = undefined;
  return dsPlansOfferRerollsOrFinalize(G);
}

/** Score the (possibly reroll-modified) Death Star Plans attempt. */
function finalizeDsPlans(G: GameState): { ok: boolean; reason?: string } {
  const d = G.dsPlansAttempt;
  if (!d) return { ok: false, reason: 'no-dsplans-attempt' };
  const pc = { objectiveId: d.objectiveId, systemId: d.systemId, deathStarInstanceIds: d.deathStarInstanceIds };
  const deathStarInstanceId = d.deathStarInstanceId;
  const faces = d.faces;
  G.dsPlansAttempt = undefined;
  const directHit = faces.some((f) => f === 'direct-hit');
  if (directHit) {
    // Pick which Death Star to destroy. Default to the first if the caller
    // didn't pass one (or if the passed id is no longer at the system).
    let targetId = deathStarInstanceId;
    if (!targetId || !pc.deathStarInstanceIds.includes(targetId)) targetId = pc.deathStarInstanceIds[0];
    // RoE Shield Bunker (rules p.8) makes Death Stars + DSUC "immune to the
    // Death Star Plans objective card." A direct-hit roll that would
    // normally destroy the Death Star is blocked while any Shield Bunker
    // remains in the system; the card returns to hand (effectively a miss).
    const ss = G.map.systems[pc.systemId];
    const shieldBunkerHere = G.expansion?.enabled && (ss?.units ?? []).some(
      (u) => u.side === 'Empire' && u.typeId === 'shield-bunker',
    );
    if (shieldBunkerHere) {
      log(G, { kind: 'death-star-plans-blocked-by-shield-bunker', side: 'Rebel', payload: {
        objectiveId: pc.objectiveId, systemId: pc.systemId, faces,
      }});
      return resumeAfterDsPlans(G);
    }
    // RoE "Secure the Plans" Imperial mission (rules p.8) places a target
    // marker on a remote system; "while the marker remains, Rebels cannot
    // play 'Death Star Plans'." Block here too — same outcome as the Shield
    // Bunker case (effectively a miss; card returns to hand).
    if (G.expansion?.enabled && M.hasTargetMarker(G, pc.systemId, 'secure-the-plans')) {
      log(G, { kind: 'death-star-plans-blocked-by-target-marker', side: 'Rebel', payload: {
        objectiveId: pc.objectiveId, systemId: pc.systemId, source: 'secure-the-plans', faces,
      }});
      return resumeAfterDsPlans(G);
    }
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
    M.recordObjectiveScored(G, pc.objectiveId, rep, 'death-star-plans', G.turnLog.length);
    // RAW: one objective per combat — playing Death Star Plans uses up this
    // combat's objective, so decisive-victory / liberation / etc. cannot also
    // score at combat-end (#487).
    if (G.pendingCombat) G.pendingCombat.objectivePlayedThisCombat = true;
  } else {
    // No direct hit — RAW: "Otherwise return this card to your hand." It's
    // already in hand (we don't remove it on reveal); just log.
    log(G, { kind: 'death-star-plans-miss', side: 'Rebel', payload: {
      objectiveId: pc.objectiveId, systemId: pc.systemId, faces,
    }});
  }
  return resumeAfterDsPlans(G);
}

// Generic-choice resolver for the Seize Control optional marker removal (#505/#496).
// Registered at module load. The selection contains the system id iff the Rebel
// chose to remove the marker (min:0 → empty selection means "keep it"). Either
// way it resumes the suspended combat tail via finishCombatTail.
// Deployment's "gain 1 triangle ground unit" type pick (#497): deploy the chosen
// triangle ground unit, then resume the combat state machine.
registerChoice('cinematic-gain', (G, selection, context) => {
  const side: Side = context.side === 'Empire' ? 'Empire' : 'Rebel';
  const systemId = typeof context.systemId === 'string' ? context.systemId : G.pendingCombat?.systemId;
  const theater = context.theater === 'ground' ? 'ground' : 'space';
  const typeId = selection[0];
  if (typeId && systemId) {
    M.deployUnit(G, side, typeId, systemId);
    log(G, { kind: 'cinematic-tactic-play', side, payload: { theater, gained: typeId } });
  }
  runCombat(G);
});

registerChoice('seize-control-marker', (G, selection, context) => {
  const sysId = typeof context.systemId === 'string' ? context.systemId : G.pendingCombat?.systemId;
  const ss = sysId ? G.map.systems[sysId] : undefined;
  if (ss?.sabotage && sysId && selection.includes(sysId)) {
    ss.sabotage = false;
    log(G, { kind: 'sabotage-removed', side: 'Rebel', payload: { systemId: sysId, via: 'seize-control' } });
  }
  const c = G.pendingCombat;
  if (c) finishCombatTail(G, c);
  else G.pendingCombat = undefined;
});
