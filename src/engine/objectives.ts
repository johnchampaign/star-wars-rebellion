// Objective-card condition evaluators.
//
// Each Rebel objective card has a top-left reputation number and a "timing"
// (Combat / StartOfRefresh / Special). When the timing fires AND the card's
// condition is met, the Rebel may play the card to gain its reputation.
//
// Currently wires up only StartOfRefresh objectives — Combat-timed ones
// need per-combat state tracking (was the Rebel the attacker, what was
// destroyed) which is a separate piece of infra.

import type { GameState, SystemId } from './types';

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
