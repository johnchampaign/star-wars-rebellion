// Combat sub-machine — held in G.pendingCombat, driven by runCombat().
// Triggered from phases.activateSystem when both sides end up in the same
// theater of a system. See docs/engine.md §9.
//
// Current scope: dice rolls, damage assignment (auto), unit destruction (with
// the "still attacks this round" rule), retreat, end-of-combat cleanup.
// Deferred to #18 (effect handlers): tactic-card draw/play, action-card
// Start-of-Combat triggers, structure-destruction-on-no-ground-attacker rule.

import type {
  GameState, Side, SystemId, UnitInstance, Theater, DieColor, DieResult,
  CombatState, CombatReport, CombatAttackReport,
} from './types';
import * as M from './mechanics';
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

function bothSidesPresent(G: GameState, sysId: SystemId): boolean {
  return bothSidesHaveTheater(G, sysId, 'space') || bothSidesHaveTheater(G, sysId, 'ground');
}

/** Yoda ring reroll in combat (RR Seek Yoda). Once per game round, the Yoda
 *  holder rerolls 1 die when in a system with a mission or combat. Returns
 *  the (possibly modified) dice array. Picks the first blank to reroll. */
function tryYodaRerollCombat(G: GameState, side: Side, sysId: SystemId, dice: DieResult[]): DieResult[] {
  if (side !== 'Rebel') return dice;
  if (G.yodaRerollUsedThisRound) return dice;
  if (!G.leaderAttachments) return dice;
  let yoda: string | null = null;
  for (const lid of Object.keys(G.leaderAttachments)) {
    if (G.leaderAttachments[lid].includes('yoda')) { yoda = lid; break; }
  }
  if (!yoda) return dice;
  const here = G.rebel.leadersOnBoard[sysId] ?? [];
  if (!here.includes(yoda)) return dice;
  const idx = dice.findIndex((d) => d.face === 'blank');
  if (idx < 0) return dice;
  const fresh = rollDie(G.rng, dice[idx].color);
  log(G, { kind: 'yoda-reroll', side: 'Rebel', payload: {
    holder: yoda, systemId: sysId, color: dice[idx].color, oldFace: 'blank', newFace: fresh.face,
  }});
  const out = [...dice];
  out[idx] = fresh;
  G.yodaRerollUsedThisRound = true;
  return out;
}

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
    addedLeaders: [],
    drawnTactics: { side: attackerSide, spaceCount: 0, groundCount: 0 },
    rounds: [], structureDestructions: [],
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

  // Step 1: Add Leader (rr p.5 step 1) — each side may add one leader from
  // their pool to the combat. Auto: if no leader is here yet, add the
  // highest-tactic-value one from the pool. Skip Start-of-Combat action-card
  // triggers (deferred).
  if (c.step === 'AddLeader') {
    for (const side of [c.attackerSide, other(c.attackerSide)] as const) {
      const f = side === 'Rebel' ? G.rebel : G.empire;
      const here = f.leadersOnBoard[c.systemId] ?? [];
      // Per RR p.4 Combat step 1: "If a player does not have a leader **with
      // tactic values** in the system, he may take one leader from his leader
      // pool and place it in the system." A skill-only leader (no tactic
      // values) doesn't disqualify adding a combat-capable one.
      const hasTacticLeaderHere = here.some((lid) => {
        const ldr = G.catalog.leaders[lid];
        return ldr && (ldr.tacticValues.space + ldr.tacticValues.ground) > 0;
      });
      if (hasTacticLeaderHere) continue;
      // Pick the best pool leader by combined tactic value.
      let best: { id: string; v: number } | null = null;
      for (const lid of f.leaderPool) {
        const ldr = G.catalog.leaders[lid];
        if (!ldr) continue;
        const v = ldr.tacticValues.space + ldr.tacticValues.ground;
        if (v <= 0) continue; // skip leaders with no tactic dice (skill-only leaders)
        if (!best || v > best.v) best = { id: lid, v };
      }
      if (best) {
        M.placeLeader(G, side, best.id, c.systemId);
        log(G, { kind: 'combat-add-leader', side, payload: { leaderId: best.id, tacticValue: best.v } });
        c.report.addedLeaders.push({ side, leaderId: best.id, tacticValue: best.v });
      }
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

    // Retreat decision (auto: defender retreats if outnumbered in any theater)
    // Skip for v1; both sides stay in.

    // End check: do both sides still have units in some shared theater?
    const continues =
      bothSidesHaveTheater(G, c.systemId, 'space') ||
      bothSidesHaveTheater(G, c.systemId, 'ground');
    if (!continues) {
      c.step = 'Ended';
    } else {
      c.round++;
      c.roundTheatersDone = undefined; // reset for next round
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

  // Roll dice.
  let dice: DieResult[] = [];
  for (let i = 0; i < red; i++) dice.push(rollDie(G.rng, 'red' as DieColor));
  for (let i = 0; i < black; i++) dice.push(rollDie(G.rng, 'black' as DieColor));

  // Yoda ring auto-applies (once per round, can't be human-chosen — RR text).
  dice = tryYodaRerollCombat(G, side, c.systemId, dice);

  // Stash the in-flight attack and queue the attacker-tactics choice.
  c.pendingAttack = {
    side, theater,
    phase: 'awaitingAttackerTactics',
    dice,
    attackerUnits: myUnits.length,
    bonusDamage: 0,
    tacticsPlayed: [],
  };
  const hand = (side === c.attackerSide ? c.attackerHand : c.defenderHand)
    .filter((cid) => G.catalog.tactics[cid]?.theater === theater);
  G.pendingChoice = {
    kind: 'CombatAttackerTactics',
    side, theater, dice,
    hand,
    attackerUnits: myUnits.length,
    systemId: c.systemId,
  };
  log(G, { kind: 'choice-request', side, payload: {
    kind: 'CombatAttackerTactics', theater, dice: dice.length, hits: dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length, hand: hand.length,
  }});
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

  // Damage boosts: each plays for its tabulated bonus.
  for (const cid of plays.damageBoostCardIds ?? []) {
    if (!hand.includes(cid)) continue;
    const amount = cid.includes('take-it-down') ? 2
                : cid.includes('onslaught')   ? 2
                : cid.includes('critical-hit') ? 1
                : 0;
    if (amount === 0) continue;
    discardCard(G, hand, cid);
    pa.bonusDamage += amount;
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
  if (incomingHits === 0 || liveTargets.length === 0) {
    // Skip defender-tactics window; finalise this attack with zero damage.
    finalizeAttack(G, c, /*blocks*/0);
    G.pendingChoice = undefined;
    // Continue the combat loop.
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
  finalizeAttack(G, c, blocks);
  G.pendingChoice = undefined;
  runCombat(G);
  return { ok: true };
}

/** Apply damage from the in-flight attack, write the attack report, mark
 *  the attacker done, clear pendingAttack. */
function finalizeAttack(G: GameState, c: CombatState, blocksApplied: number): void {
  const pa = c.pendingAttack!;
  const stagedSet = new Set(c.theaterStaged ?? []);
  const targets = unitsOf(G, other(pa.side), c.systemId, pa.theater)
    .filter((u) => !stagedSet.has(u.instanceId));

  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  const sorted = [...targets].sort((a, b) => {
    const ta = G.catalog.unitTypes[a.typeId];
    const tb = G.catalog.unitTypes[b.typeId];
    const ha = ta?.health.value ?? 99;
    const hb = tb?.health.value ?? 99;
    if (ha !== hb) return ha - hb;
    return (tierRank[ta?.tier ?? 'square'] ?? 9) - (tierRank[tb?.tier ?? 'square'] ?? 9);
  });

  // Build hit queue.
  const hits: { d: DieResult }[] = pa.dice
    .filter((d) => d.face === 'hit' || d.face === 'direct-hit')
    .map((d) => ({ d }));
  for (let i = 0; i < pa.bonusDamage; i++) {
    hits.push({ d: { color: 'black', face: 'direct-hit' } });
  }

  // Apply hits, skipping `blocksApplied` of them (defender's blocks).
  let blocksRemaining = blocksApplied;
  let damageApplied = 0;
  const stagedMap = new Map<string, true>();
  for (const sid of stagedSet) stagedMap.set(sid, true);
  for (const h of hits) {
    if (G.isGameOver) break;
    if (blocksRemaining > 0) { blocksRemaining--; continue; }
    const t = pickTarget(G, h.d, sorted, stagedMap);
    if (!t) continue;
    const dead = M.damageUnit(G, t.instanceId, 1);
    damageApplied++;
    if (dead) {
      stagedMap.set(t.instanceId, true);
      (c.theaterStaged ??= []).push(t.instanceId);
    }
  }

  // Record the attack report.
  const report: CombatAttackReport = {
    side: pa.side, theater: pa.theater,
    attackerUnits: pa.attackerUnits,
    dice: pa.dice.map((d) => ({ color: d.color, face: d.face })),
    tacticsPlayed: pa.tacticsPlayed,
    hitsRolled: pa.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length,
    bonusDamage: pa.bonusDamage,
    blockedDamage: Math.min(blocksApplied, hits.length),
    damageApplied,
    destroyed: [],
  };
  const bucketIdx = c.currentRoundReportIdx;
  if (bucketIdx !== undefined && c.report.rounds[bucketIdx]) {
    c.report.rounds[bucketIdx].attacks.push(report);
  }
  c.theaterAttackersDone!.push(pa.side);
  c.pendingAttack = undefined;
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

function pickTarget(
  G: GameState, d: DieResult, sorted: UnitInstance[], staged: Map<string, true>
): UnitInstance | null {
  for (const u of sorted) {
    if (staged.has(u.instanceId)) continue;
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    if (t.health.color === null) continue; // Death Star — undamageable
    if (d.face === 'hit') {
      if (t.health.color === d.color) return u;
    } else if (d.face === 'direct-hit') {
      return u;
    }
  }
  return null;
}

// ============================================================================
// End of combat
// ============================================================================

function endCombat(G: GameState): void {
  if (!G.pendingCombat) return;
  const c = G.pendingCombat;

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
  G.pendingCombat = undefined;
}
