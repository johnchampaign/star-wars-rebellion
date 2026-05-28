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
    const sys = G.map.systems[report.systemId];
    const groundFought = report.rounds.some((r) =>
      r.attacks.some((a) => a.theater === 'ground' && a.damageApplied > 0)
    );
    if (sys?.subjugated && groundFought) fired.push('liberation-2');
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

/** Some objectives return to the deck instead of the box on resolution. */
export function objectiveReturnsToDeck(_G: GameState, objectiveId: string): boolean {
  // Heart of the Empire explicitly says "Then return this card to the deck."
  return objectiveId === 'heart-of-the-empire-2';
}
