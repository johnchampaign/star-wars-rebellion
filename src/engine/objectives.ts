// Objective-card condition evaluators.
//
// Each Rebel objective card has a top-left reputation number and a "timing"
// (Combat / StartOfRefresh / Special). When the timing fires AND the card's
// condition is met, the Rebel may play the card to gain its reputation.
//
// Currently wires up only StartOfRefresh objectives — Combat-timed ones
// need per-combat state tracking (was the Rebel the attacker, what was
// destroyed) which is a separate piece of infra.

import type { GameState, SystemId, Side } from './types';
import { log } from './log';

/** Post a player-facing "which objective do you want to score?" choice.
 *  RAW caps objective play at one per Refresh phase and one per combat, so
 *  when 2+ are eligible the player picks which to claim (the rest stay in
 *  hand). `legal` is the eligible objective-card ids; `window` tells the
 *  resolver/UI whether this is the refresh or combat slot; `logStart` is
 *  carried through so the refresh phase can resume where it paused. */
export function postPlayObjectiveChoice(
  G: GameState, legal: string[], window: 'combat' | 'refresh', logStart?: number,
  allowDecline?: boolean,
): void {
  G.pendingChoice = { kind: 'PlayObjective', side: 'Rebel', legal, window, logStart, allowDecline };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: { kind: 'PlayObjective', window, legal, allowDecline } });
}

/** Objectives whose play carries a real COST to the Rebel, so they must NOT be
 *  auto-played — the player decides whether the benefit is worth it, and the AI
 *  declines rather than pay blindly. The Long War discards 2 of your OTHER
 *  objectives (#183); A Time for Peace destroys 2 triangle + 1 circle + 1 square
 *  units off your OWN build queue (a disarmament cost — #341, correcting #325's
 *  belief that it hit the Imperial queue). */
export const COST_OBJECTIVES = new Set<string>(['the-long-war-1', 'a-time-for-peace-2']);

/** Objectives that are free to the Rebel but make a big, IRREVERSIBLE board
 *  change when scored, so auto-playing them robs the player of the RR p.10 "you
 *  MAY play an objective" decision. Routed through the play-objective prompt
 *  with a decline option, like cost objectives. (Currently empty.) */
export const OPT_IN_OBJECTIVES = new Set<string>([]);

/** For count-threshold objectives the Rebel can deliberately BUILD toward,
 *  return how many qualifying systems/units exist now (`have`) and the threshold
 *  (`need`); null for objectives without a simple monotone count (combat/special).
 *  The AI uses this to STEER loyalty/positioning toward objectives it is near,
 *  instead of scattering loyalty and completing none (playtester report: "gained
 *  quite a few loyalty but didn't complete a single objective"). Mirrors the
 *  counts in objectiveConditionMet — keep the two in sync. */
export function objectiveProgress(G: GameState, objectiveId: string): { have: number; need: number } | null {
  const countRebelLoyal = (filter?: (id: SystemId) => boolean): number => {
    let c = 0;
    for (const id of Object.keys(G.map.systems)) {
      if (G.map.systems[id].loyalty === 'rebel' && (!filter || filter(id as SystemId))) c++;
    }
    return c;
  };
  switch (objectiveId) {
    case 'popular-support-2': return { have: countRebelLoyal(), need: 6 };
    case 'uprising-3': return { have: countRebelLoyal(), need: 9 };
    case 'support-of-the-hutts-1': {
      const region = G.catalog.systems['nal-hutta']?.region;
      if (region === undefined) return null;
      return { have: countRebelLoyal((id) => G.catalog.systems[id]?.region === region), need: 3 };
    }
    case 'defend-the-people-1': {
      let c = 0;
      for (const ss of Object.values(G.map.systems)) {
        if (ss.loyalty === 'rebel' && ss.units.some((u) => u.side === 'Rebel')) c++;
      }
      return { have: c, need: 4 };
    }
    case 'establish-outposts-3': {
      let c = 0;
      for (const ss of Object.values(G.map.systems)) if (ss.units.some((u) => u.side === 'Rebel')) c++;
      return { have: c, need: 5 };
    }
    case 'cut-supply-lines-1': {
      let c = 0;
      for (const [id, ss] of Object.entries(G.map.systems)) {
        const isImperial = ss.loyalty === 'imperial' || ss.subjugated || G.catalog.systems[id]?.isCoruscant;
        if (isImperial && (!!ss.sabotage || ss.units.some((u) => u.side === 'Rebel'))) c++;
      }
      return { have: c, need: 3 };
    }
    default: return null;
  }
}

/** Return true if the given objective's condition is satisfied in the
 *  current state. Caller should already have verified the timing matches. */
export function objectiveConditionMet(G: GameState, objectiveId: string): boolean {
  switch (objectiveId) {
    case 'cut-supply-lines-1': {
      // At least 3 Imperial systems have sabotage marker OR a Rebel unit.
      let count = 0;
      for (const [id, ss] of Object.entries(G.map.systems)) {
        const isImperial = ss.loyalty === 'imperial' || ss.subjugated
          || G.catalog.systems[id]?.isCoruscant;
        if (!isImperial) continue;
        const hasSab = !!ss.sabotage;
        const hasRebel = ss.units.some((u) => u.side === 'Rebel');
        if (hasSab || hasRebel) count++;
      }
      return count >= 3;
    }

    case 'defend-the-people-1': {
      // At least 4 Rebel-loyalty systems contain a Rebel unit.
      let count = 0;
      for (const ss of Object.values(G.map.systems)) {
        if (ss.loyalty !== 'rebel') continue;
        if (ss.units.some((u) => u.side === 'Rebel')) count++;
      }
      return count >= 4;
    }

    case 'regional-support-1': {
      // All populous systems in at least 1 region have Rebel loyalty.
      const byRegion = new Map<number, SystemId[]>();
      for (const s of Object.values(G.catalog.systems)) {
        if (s.isRemote || s.isCoruscant) continue;
        const list = byRegion.get(s.region) ?? [];
        list.push(s.id);
        byRegion.set(s.region, list);
      }
      for (const ids of byRegion.values()) {
        if (ids.length === 0) continue;
        const allRebel = ids.every((id) => G.map.systems[id]?.loyalty === 'rebel');
        if (allRebel) return true;
      }
      return false;
    }

    case 'heart-of-the-empire-2': {
      // Coruscant has a Rebel unit and no Imperial units.
      const cor = G.map.systems['coruscant'];
      if (!cor) return false;
      const hasRebel = cor.units.some((u) => u.side === 'Rebel');
      const hasEmpire = cor.units.some((u) => u.side === 'Empire');
      return hasRebel && !hasEmpire;
    }

    case 'leave-no-one-behind-2': {
      // No captured Rebel leaders.
      return (G.empire.capturedLeaders?.length ?? 0) === 0;
    }

    case 'popular-support-2': {
      // At least 6 systems have Rebel loyalty.
      let count = 0;
      for (const ss of Object.values(G.map.systems)) {
        if (ss.loyalty === 'rebel') count++;
      }
      return count >= 6;
    }

    case 'establish-outposts-3': {
      // At least 5 systems contain a Rebel unit.
      let count = 0;
      for (const ss of Object.values(G.map.systems)) {
        if (ss.units.some((u) => u.side === 'Rebel')) count++;
      }
      return count >= 5;
    }

    case 'inspire-sympathy-3': {
      // Variable reputation: gain 1 per destroyed system. The condition is
      // simply "at least 1 destroyed system exists." Card's reputation is
      // computed dynamically by callers via inspireSympathyReputation.
      let destroyed = 0;
      for (const ss of Object.values(G.map.systems)) {
        if (ss.destroyed) destroyed++;
      }
      return destroyed >= 1;
    }

    // ----- Rise of the Empire objectives (Refresh-timed conditions) -----

    case 'defensive-position-1': {
      // A single on-board system (other than the off-board Rebel Base space,
      // which is not in G.map.systems) contains 3+ Rebel structures.
      for (const ss of Object.values(G.map.systems)) {
        let structures = 0;
        for (const u of ss.units) {
          if (u.side !== 'Rebel') continue;
          if (G.catalog.unitTypes[u.typeId]?.class === 'structure') structures++;
        }
        if (structures >= 3) return true;
      }
      return false;
    }

    case 'support-of-the-hutts-1': {
      // 3+ systems in Nal Hutta's region have Rebel loyalty.
      const region = G.catalog.systems['nal-hutta']?.region;
      if (region === undefined) return false;
      let count = 0;
      for (const [id, ss] of Object.entries(G.map.systems)) {
        if (G.catalog.systems[id]?.region !== region) continue;
        if (ss.loyalty === 'rebel') count++;
      }
      return count >= 3;
    }

    case 'threaten-the-core-1': {
      // 5+ Rebel units in and/or adjacent to Coruscant.
      const scope = new Set<SystemId>(['coruscant', ...(G.catalog.adjacency['coruscant'] ?? [])]);
      let units = 0;
      for (const sid of scope) {
        const ss = G.map.systems[sid];
        if (!ss) continue;
        units += ss.units.filter((u) => u.side === 'Rebel').length;
      }
      return units >= 5;
    }

    case 'uprising-3': {
      // 9+ systems have Rebel loyalty.
      let count = 0;
      for (const ss of Object.values(G.map.systems)) {
        if (ss.loyalty === 'rebel') count++;
      }
      return count >= 9;
    }

    case 'the-long-war-1': {
      // Playable if the Rebel can discard 2 OTHER objective cards from hand.
      const others = (G.rebel.objectiveHand ?? []).filter((id) => id !== 'the-long-war-1');
      return others.length >= 2;
    }

    case 'a-time-for-peace-2': {
      // Playable only if the REBEL build queue holds 2 triangle + 1 circle +
      // 1 square unit to pay as the disarmament cost (#341). All-or-nothing.
      return timeForPeaceQueueTargets(G) !== null;
    }
  }
  return false;
}

/** Persistent "place a target marker, then score each Refresh" objectives.
 *  Handled outside the one-shot StartOfRefresh play flow (they stay in hand).
 *  show-no-fear-3 is wired (processPersistentObjectives); rebel-cell-2 and
 *  raid-outposts-2 are recognized here so the one-shot dispatcher skips them,
 *  but their placement/scoring is the 5d-iii follow-up. */
export const PERSISTENT_OBJECTIVES = new Set<string>([
  'show-no-fear-3', 'rebel-cell-2', 'raid-outposts-2',
]);

/** For a-time-for-peace-2: locate 2 triangle + 1 circle + 1 square Imperial
 *  units across the build queue. Returns the queue coordinates to destroy, or
 *  null if the queue can't satisfy the requirement. Used both as the play
 *  condition (non-null) and to perform the destruction. */
export function timeForPeaceQueueTargets(
  G: GameState,
): { slot: 1 | 2 | 3; index: number; typeId: string }[] | null {
  const need: Record<'triangle' | 'circle' | 'square', number> = { triangle: 2, circle: 1, square: 1 };
  const picked: { slot: 1 | 2 | 3; index: number; typeId: string }[] = [];
  for (const slot of [1, 2, 3] as const) {
    // RAW (card art): "Destroy the following units on the REBEL build queue to
    // play this card." It's the Rebel's OWN units — a disarmament COST, not an
    // attack on the Empire (player report #341 correcting #325).
    const q = G.rebel.buildQueue[slot] ?? [];
    for (let index = 0; index < q.length; index++) {
      const typeId = q[index];
      const tier = G.catalog.unitTypes[typeId]?.tier as 'triangle' | 'circle' | 'square' | undefined;
      if (!tier || need[tier] <= 0) continue;
      need[tier]--;
      picked.push({ slot, index, typeId });
    }
  }
  return need.triangle === 0 && need.circle === 0 && need.square === 0 ? picked : null;
}

/** Evaluate combat-timed Rebel objectives against a just-finished combat.
 *  Returns the IDs of objectives in the Rebel's hand whose triggers fire,
 *  in priority order. Caller (combat.endCombat) auto-plays each in turn
 *  and grants the rep. */
export function combatObjectivesTriggered(
  G: GameState, report: import('./types').CombatReport
): string[] {
  const hand = G.rebel.objectiveHand ?? [];
  if (hand.length === 0) return [];
  const rebelInitiated = report.attackerSide === 'Rebel';
  const rebelWonOverall = report.winner === 'Rebel';

  // Aggregate destruction info from the report. Each round.attacks[].destroyed
  // entries have { typeId, instanceId }; we sum by side via attack.side.
  const empGroundHpLost = sumDestroyedHp(G, report, 'Empire', 'ground');
  const empShipsHpLost = sumDestroyedHp(G, report, 'Empire', 'space');
  const empSDLost = countDestroyed(report, ['star-destroyer', 'super-star-destroyer']);
  const fired: string[] = [];

  const has = (oid: string) => hand.includes(oid);

  // "A battle was fought in theater T" — RAW means combat resolved there. Detect
  // via a damage-dealing DICE attack in T, OR any unit (either side) destroyed in
  // T by ANY means — dice, cinematic tactic cards, structures, or retreat losses
  // (sumDestroyedHp folds all of those in). The old dice-only check missed
  // cinematic-combat kills, so a theater won purely via advanced tactic cards
  // didn't register — Decisive Victory never fired after winning both battles in
  // a cinematic combat (player report #383).
  const foughtIn = (theater: import('./types').Theater) =>
    report.rounds.some((r) => r.attacks.some((a) => a.theater === theater && a.damageApplied > 0))
    || sumDestroyedHp(G, report, 'Empire', theater) > 0
    || sumDestroyedHp(G, report, 'Rebel', theater) > 0;

  // crippling-blow-1 — 3+ health of Imperial GROUND units destroyed in
  // a combat YOU initiated.
  if (has('crippling-blow-1') && rebelInitiated && empGroundHpLost >= 3) {
    fired.push('crippling-blow-1');
  }
  // rebel-assault-1 — Star Destroyer or SSD destroyed in a combat you initiated.
  if (has('rebel-assault-1') && rebelInitiated && empSDLost >= 1) {
    fired.push('rebel-assault-1');
  }
  // liberation-2 — Win a ground battle in a subjugated system.
  if (has('liberation-2') && rebelWonOverall) {
    // Use the at-combat-start subjugation snapshot, NOT the live flag —
    // winning the ground battle liberates the system (clears subjugated)
    // before this check runs, so the live flag is always false here. (#53)
    const wasSubjugated = report.systemSubjugatedAtStart
      ?? G.map.systems[report.systemId]?.subjugated; // fallback for old reports
    if (wasSubjugated && foughtIn('ground')) fired.push('liberation-2');
  }
  // major-victory-3 — 3+ health of Imperial SHIPS destroyed in a combat
  // you initiated.
  if (has('major-victory-3') && rebelInitiated && empShipsHpLost >= 3) {
    fired.push('major-victory-3');
  }
  // return-of-the-jedi-3 — After winning a battle in Vader's or Palpatine's
  // system; scores reputation. The "if Luke (Jedi) is here, eliminate 1 Imperial
  // leader" sub-effect is applied in playCombatObjective (combat.ts) when the
  // objective is actually scored — keyed on the live `luke-skywalker-jedi`
  // leader id, which the engine does track.
  if (has('return-of-the-jedi-3') && rebelWonOverall) {
    const sys = report.systemId;
    const vaderHere = (G.empire.leadersOnBoard[sys] ?? []).includes('darth-vader');
    const empHere = (G.empire.leadersOnBoard[sys] ?? []).includes('emperor-palpatine');
    if (vaderHere || empHere) fired.push('return-of-the-jedi-3');
  }
  // death-star-plans-2 / -3 — "If there is at least 1 fighter after the
  // space battle step, reveal this card to roll 3 dice; on direct-hit
  // play and destroy a Death Star in this system." Stochastic & destructive
  // — leave to a follow-up so we don't surprise players. NOT fired here.

  // ----- Rise of the Empire combat objectives -----

  // decisive-victory-1 — win a space battle AND a ground battle in the same
  // combat. Approximated as: Rebel won overall and both theaters saw a
  // damage-dealing battle (same convention as liberation-2).
  if (has('decisive-victory-1') && rebelWonOverall && foughtIn('space') && foughtIn('ground')) {
    fired.push('decisive-victory-1');
  }

  // seize-control-2 — win a space or ground battle in a system that has a
  // sabotage marker. (The card's optional "you may remove the marker" is a
  // destructive side-effect left out of auto-play; scoring only.)
  if (has('seize-control-2') && rebelWonOverall && !!G.map.systems[report.systemId]?.sabotage) {
    fired.push('seize-control-2');
  }

  // raid-imperial-factory-3 — win a battle in a combat the Rebels INITIATED,
  // in a system that has a SQUARE (■) resource icon. The card art specifies a
  // square icon, not any resource icon — squares mark the highest-value
  // "factory" systems. A triangle/circle resource system does NOT qualify.
  if (
    has('raid-imperial-factory-3') && rebelInitiated && rebelWonOverall &&
    !!G.catalog.systems[report.systemId]?.resources?.some((r) => r.shape === 'square')
  ) {
    fired.push('raid-imperial-factory-3');
  }

  return fired;
}

function sumDestroyedHp(
  G: GameState, report: import('./types').CombatReport,
  destroyedSide: Side, theater: import('./types').Theater
): number {
  // RAW: count every destroyed unit on `destroyedSide` in this theater.
  // We DO NOT filter by attack.side, because finalizeTheaterDestructions
  // attributes all staged kills in a theater step to the last attack of
  // that step — mis-attribution would silently lose kills here. Use the
  // unit catalog to determine each destroyed unit's actual side/theater.
  let hp = 0;
  for (const round of report.rounds) {
    for (const atk of round.attacks) {
      for (const d of atk.destroyed) {
        const t = G.catalog.unitTypes[d.typeId];
        if (!t) continue;
        if (t.side !== destroyedSide) continue;
        if (t.theater !== theater) continue;
        hp += t.health.value ?? 1;
      }
    }
  }
  // Retreat losses ALSO count as "destroyed in this combat" per RAW
  // (RR p.5-6: retreat is part of the combat). Without this, Crippling
  // Blow (≥3 ground HP destroyed in a Rebel-initiated combat) didn't
  // fire when the Empire retreated and lost an AT-AT to no-transport —
  // user issue #37.
  for (const entry of (report.retreatDestructions ?? [])) {
    if (entry.side !== destroyedSide) continue;
    for (const typeId of entry.typeIds) {
      const t = G.catalog.unitTypes[typeId];
      if (!t) continue;
      if (t.theater !== theater) continue;
      hp += t.health.value ?? 1;
    }
  }
  // Units destroyed by a card effect during the combat (Baze's Loyalty, etc.)
  // also count as "destroyed in this combat" toward objectives (#317).
  for (const d of (report.cardDestructions ?? [])) {
    if (d.side !== destroyedSide) continue;
    const t = G.catalog.unitTypes[d.typeId];
    if (!t || t.theater !== theater) continue;
    hp += t.health.value ?? 1;
  }
  return hp;
}

function countDestroyed(report: import('./types').CombatReport, typeIds: string[]): number {
  let n = 0;
  for (const round of report.rounds) {
    for (const atk of round.attacks) {
      for (const d of atk.destroyed) {
        if (typeIds.includes(d.typeId)) n++;
      }
    }
  }
  // Same retreat-counts-as-destroyed rule as sumDestroyedHp.
  for (const entry of (report.retreatDestructions ?? [])) {
    for (const typeId of entry.typeIds) {
      if (typeIds.includes(typeId)) n++;
    }
  }
  for (const d of (report.cardDestructions ?? [])) {
    if (typeIds.includes(d.typeId)) n++;
  }
  return n;
}

/** Effective reputation gain for an objective (handles variable-rep cards). */
export function objectiveReputationGain(G: GameState, objectiveId: string): number {
  const card = G.catalog.objectives[objectiveId];
  if (!card) return 0;
  if (objectiveId === 'inspire-sympathy-3') {
    let destroyed = 0;
    for (const ss of Object.values(G.map.systems)) {
      if (ss.destroyed) destroyed++;
    }
    return destroyed;
  }
  return card.reputation;
}

/** Some objectives return to the deck instead of the box on resolution.
 *  (No base-game objective does this — kept for expansion cards.) */
export function objectiveReturnsToDeck(_G: GameState, _objectiveId: string): boolean {
  return false;
}

/** Some objectives return to the Rebel's HAND instead of the box, so they can
 *  be scored again on a later turn while the condition still holds. Verified
 *  against the printed card art (text-bearing _Clear scans):
 *    - Heart of the Empire: "...Then return this card to your hand." */
export function objectiveReturnsToHand(_G: GameState, objectiveId: string): boolean {
  return objectiveId === 'heart-of-the-empire-2';
}
