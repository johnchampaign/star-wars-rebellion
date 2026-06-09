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
  G: GameState, legal: string[], window: 'combat' | 'refresh', logStart?: number
): void {
  G.pendingChoice = { kind: 'PlayObjective', side: 'Rebel', legal, window, logStart };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: { kind: 'PlayObjective', window, legal } });
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
  }
  return false;
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
    const groundFought = report.rounds.some((r) =>
      r.attacks.some((a) => a.theater === 'ground' && a.damageApplied > 0)
    );
    if (wasSubjugated && groundFought) fired.push('liberation-2');
  }
  // major-victory-3 — 3+ health of Imperial SHIPS destroyed in a combat
  // you initiated.
  if (has('major-victory-3') && rebelInitiated && empShipsHpLost >= 3) {
    fired.push('major-victory-3');
  }
  // return-of-the-jedi-3 — After winning a battle in Vader's or
  // Palpatine's system. (Luke-Jedi sub-effect skipped — needs Jedi
  // flag we don't track yet.)
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

  // Per-theater "a battle was fought" = at least one damage-dealing attack in
  // that theater this combat (mirrors the liberation-2 groundFought test).
  const foughtIn = (theater: import('./types').Theater) =>
    report.rounds.some((r) =>
      r.attacks.some((a) => a.theater === theater && a.damageApplied > 0),
    );

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
  // in a system that has a resource icon.
  if (
    has('raid-imperial-factory-3') && rebelInitiated && rebelWonOverall &&
    (G.catalog.systems[report.systemId]?.resources?.length ?? 0) > 0
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
