// RoE Cinematic Combat — advanced tactic card abilities (Phase 7c-1).
//
// Each combat round, in each theatre, a side may play one of its available
// advanced tactic cards and resolve its TOP (primary) or BOTTOM (secondary)
// ability. The top ability requires >= 1 of the card's primaryUnit in the
// system; the bottom is always available. Played cards go to
// FactionState.cinematicTacticDiscard and are NOT reshuffled (rules p.9).
//
// Phase 7c-1 wires the two mechanically-core ability families:
//   - deal N [colour] damage  → auto-assigned to the cheapest-to-kill
//                               eligible enemy unit in the theatre.
//   - prevent N red/black/special → reduces the opponent's next attack roll
//                               in this theatre (CombatState.cinematicPrevent).
// Exotic abilities (cancel a card, capture a leader, play an extra card,
// destroy-without-rolling, remove-damage-via-special, resolve-attacks-first,
// conditional gains) are tagged 'unwired' and just discard the card with a
// log note — Phase 7c-2.
//
// Card selection here is AUTO (a simple value heuristic). Phase 7d replaces
// it with interactive selection for the human side.

import type { GameState, Side, CombatState, Theater } from './types';
import * as M from './mechanics';
import { log } from './log';

function other(s: Side): Side { return s === 'Rebel' ? 'Empire' : 'Rebel'; }

function unitsOf(G: GameState, side: Side, sysId: string, theater: Theater) {
  const ss = sysId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[sysId];
  return (ss?.units ?? []).filter((u) => {
    if (u.side !== side) return false;
    return G.catalog.unitTypes[u.typeId]?.theater === theater;
  });
}

type DealEffect = { kind: 'deal'; amount: number; color?: 'red' | 'black' };
type PreventEffect = { kind: 'prevent'; red: number; black: number; special: number };
type UnwiredEffect = { kind: 'unwired' };
type Ability = DealEffect | PreventEffect | UnwiredEffect;

const D = (amount: number, color?: 'red' | 'black'): DealEffect => ({ kind: 'deal', amount, color });
const P = (red: number, black: number, special = 0): PreventEffect => ({ kind: 'prevent', red, black, special });
const U: UnwiredEffect = { kind: 'unwired' };

// Per-card [top, bottom] abilities, keyed by the card id slug from
// scripts/add-cinematic-tactics.mjs.
const ABILITIES: Record<string, [Ability, Ability]> = {
  // ---- Imperial Space ----
  'cin-empire-space-swarm-tactics':          [U /* conditional fighter-count deal */, D(1, 'black')],
  'cin-empire-space-reinforcements':         [U /* gain TIE + prevent */, P(0, 2)],
  'cin-empire-space-tractor-beam':           [U /* capture leader */, D(1, 'red')],
  'cin-empire-space-overwhelming-presence':  [P(2, 0, 1), P(2, 0)],
  'cin-empire-space-superlaser-blast':       [U /* 5 dmg to capital ship */, D(1)],
  'cin-empire-space-entrapment':             [U /* cancel card */, U /* lock space tactics */],
  'cin-empire-space-energy-shield':          [U /* remove damage */, U /* resolve first */],
  'cin-empire-space-intercept':              [U /* destroy triangle */, U /* special lock */],
  // ---- Imperial Ground ----
  'cin-empire-ground-support-of-the-501st':  [U /* destroy triangle */, D(1, 'black')],
  'cin-empire-ground-armored-patrol':        [P(2, 2), P(1, 1)],
  'cin-empire-ground-overrun':               [D(2), D(1)],
  'cin-empire-ground-target-the-generator':  [U /* destroy structure */, D(1, 'red')],
  'cin-empire-ground-air-superiority':       [U /* cancel card */, U /* lock ground tactics */],
  'cin-empire-ground-armored-position':      [U /* redirect damage */, U /* resolve first */],
  'cin-empire-ground-bombardment':           [U /* conditional 2 black */, D(1)],
  'cin-empire-ground-imposing-presence':     [U /* special lock */, U /* extra card */],
  // ---- Rebel Space ----
  'cin-rebel-space-rogue-squadron-support':  [D(2, 'black'), D(1, 'black')],
  'cin-rebel-space-bombing-run':             [D(2, 'red'), D(1, 'red')],
  'cin-rebel-space-deployment':              [U /* gain ground + battle */, U /* special lock */],
  'cin-rebel-space-fleet-logistics':         [U /* prevent + extra card */, P(2, 0)],
  'cin-rebel-space-ion-blast':               [U /* damage + no-remove */, D(1)],
  'cin-rebel-space-outrun-them':             [U /* cancel card */, U /* lock space tactics */],
  'cin-rebel-space-draw-their-fire':         [U /* remove damage */, U /* resolve first */],
  'cin-rebel-space-escort':                  [P(1, 1, 1), P(0, 2)],
  // ---- Rebel Ground ----
  'cin-rebel-ground-hold-them-back':         [U /* destroy triangle */, D(1, 'black')],
  'cin-rebel-ground-take-it-down':           [D(2, 'red'), D(1, 'red')],
  'cin-rebel-ground-tow-cables':             [U /* 4 dmg to AT-AT/AT-ST */, D(1)],
  'cin-rebel-ground-take-cover':             [P(2, 2), P(1, 1)],
  'cin-rebel-ground-planetary-shield':       [U /* redirect damage */, U /* resolve first */],
  'cin-rebel-ground-rogue-one':              [U /* rescue/remove marker */, U /* special lock */],
  'cin-rebel-ground-escape-plan':            [U /* retreat + cancel */, U /* lock ground tactics */],
  'cin-rebel-ground-confrontation':          [U /* mark leader */, U /* extra card */],
};

/** A rough "how good is this ability right now" score for the auto-picker. */
function abilityValue(G: GameState, c: CombatState, side: Side, theater: Theater, ab: Ability): number {
  if (ab.kind === 'deal') {
    const targets = unitsOf(G, other(side), c.systemId, theater)
      .filter((u) => G.catalog.unitTypes[u.typeId]?.health.color !== null);
    return targets.length > 0 ? ab.amount : 0;
  }
  if (ab.kind === 'prevent') {
    // Only valuable if the opponent has attacking units in this theatre.
    const oppAttacks = unitsOf(G, other(side), c.systemId, theater).some((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      return t && (t.attack.red + t.attack.black + t.attack.green) > 0;
    });
    return oppAttacks ? (ab.red + ab.black + ab.special) : 0;
  }
  return 0; // unwired
}

/** Resolve a deal-damage ability: assign `amount` damage one-at-a-time to the
 *  cheapest-to-kill eligible enemy unit (colour-matched; uncoloured hits any
 *  red/black-health unit). Destroys units that reach lethal immediately. */
function resolveDeal(G: GameState, c: CombatState, side: Side, theater: Theater, eff: DealEffect): number {
  let dealt = 0;
  for (let i = 0; i < eff.amount; i++) {
    const candidates = unitsOf(G, other(side), c.systemId, theater).filter((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t || t.health.color === null) return false; // invulnerable (Death Star)
      if (eff.color && t.health.color !== eff.color) return false;
      return true;
    });
    if (candidates.length === 0) break;
    // Cheapest to kill: smallest (health - current damage) remaining.
    candidates.sort((a, b) => {
      const ra = (G.catalog.unitTypes[a.typeId]?.health.value ?? 0) - a.damage;
      const rb = (G.catalog.unitTypes[b.typeId]?.health.value ?? 0) - b.damage;
      return ra - rb;
    });
    const target = candidates[0];
    const dead = M.damageUnit(G, target.instanceId, 1);
    dealt++;
    if (dead) M.destroyUnit(G, target.instanceId, 'cinematic-tactic-damage');
  }
  return dealt;
}

/** Resolve a prevent ability: reduce the OPPONENT's next attack in this
 *  theatre by the listed dice. */
function resolvePrevent(c: CombatState, side: Side, eff: PreventEffect): void {
  const opp = other(side);
  if (!c.cinematicPrevent) c.cinematicPrevent = {};
  const cur = c.cinematicPrevent[opp] ?? { red: 0, black: 0, special: 0 };
  cur.red += eff.red; cur.black += eff.black; cur.special += eff.special;
  c.cinematicPrevent[opp] = cur;
}

/** Cards available to `side` for `theater` — all their advanced cards of that
 *  side+theatre not already in their cinematic discard pile. */
function availableCards(G: GameState, side: Side, theater: Theater): string[] {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const discard = new Set(f.cinematicTacticDiscard ?? []);
  return Object.values(G.catalog.tactics)
    .filter((t) => t.cinematic && t.side === side && t.theater === theater && !discard.has(t.id))
    .map((t) => t.id);
}

/** Auto-play one advanced tactic card for `side` in `theater` this round (or
 *  skip if nothing useful). Picks the highest-value resolvable ability,
 *  prefers the top ability when its unit prerequisite is met. Moves the
 *  played card to the side's cinematic discard. */
export function autoPlayCinematicTactic(G: GameState, c: CombatState, side: Side, theater: Theater): void {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  let best: { cardId: string; useTop: boolean; ab: Ability; value: number } | null = null;
  for (const cardId of availableCards(G, side, theater)) {
    const abilities = ABILITIES[cardId];
    if (!abilities) continue;
    const card = G.catalog.tactics[cardId];
    const [top, bottom] = abilities;
    // Top ability needs the primary unit present in the system.
    const topOk = !card?.primaryUnit
      || unitsOf(G, side, c.systemId, theater).some((u) => u.typeId === card.primaryUnit)
      || (G.map.systems[c.systemId]?.units ?? []).some((u) => u.side === side && u.typeId === card.primaryUnit);
    const options: { useTop: boolean; ab: Ability }[] = [];
    if (topOk) options.push({ useTop: true, ab: top });
    options.push({ useTop: false, ab: bottom });
    for (const opt of options) {
      const v = abilityValue(G, c, side, theater, opt.ab);
      if (v > 0 && (!best || v > best.value)) {
        best = { cardId, useTop: opt.useTop, ab: opt.ab, value: v };
      }
    }
  }
  if (!best) return; // nothing worth playing — keep cards (they don't reshuffle)

  // Resolve the chosen ability.
  if (best.ab.kind === 'deal') {
    const dealt = resolveDeal(G, c, side, theater, best.ab);
    log(G, { kind: 'cinematic-tactic-play', side, payload: {
      cardId: best.cardId, ability: best.useTop ? 'primary' : 'secondary', theater, dealt,
    }});
  } else if (best.ab.kind === 'prevent') {
    resolvePrevent(c, side, best.ab);
    log(G, { kind: 'cinematic-tactic-play', side, payload: {
      cardId: best.cardId, ability: best.useTop ? 'primary' : 'secondary', theater,
      prevent: { red: best.ab.red, black: best.ab.black, special: best.ab.special },
    }});
  }
  // Discard the played card (does NOT reshuffle — gone for the game).
  (f.cinematicTacticDiscard ??= []).push(best.cardId);
}

/** Consume the cinematic dice-prevention for `side` in this theatre, returning
 *  the reduction to apply to their roll. Zeroes the accumulator so it only
 *  applies once. */
export function takeCinematicPrevent(c: CombatState, side: Side): { red: number; black: number; special: number } {
  const v = c.cinematicPrevent?.[side];
  if (!v) return { red: 0, black: 0, special: 0 };
  c.cinematicPrevent![side] = { red: 0, black: 0, special: 0 };
  return v;
}
