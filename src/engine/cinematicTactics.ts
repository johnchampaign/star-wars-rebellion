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

import type { GameState, Side, CombatState, Theater, LeaderId } from './types';
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
type PreventEffect = { kind: 'prevent'; red: number; black: number; special: number; extra?: boolean };
// Conditional deal — only deals if the named condition holds.
type CondDealEffect = { kind: 'condDeal'; amount: number; color?: 'red' | 'black'; cond: 'more-fighters' | 'no-shield-generator' };
// Targeted deal — assigns damage to a specific class of enemy unit.
type TargetDealEffect = { kind: 'targetDeal'; amount: number; targetClass: 'capital' | 'at-walker' };
// Destroy 1 enemy unit of a type/tier without rolling dice. `theater` overrides
// which theatre the targets come from — needed for SPACE tactics that destroy a
// GROUND unit (e.g. Intercept: "destroy 1 triangle ground unit"), where the
// targets must NOT be taken from the tactic's own (space) theatre (#373).
type DestroyEffect = { kind: 'destroy'; tier?: 'triangle'; unitClass?: 'structure'; theater?: Theater };
// Gain a unit for the playing side (deployed into the system), optionally
// also preventing the opponent's dice.
// `chooseTriangleGround` (Deployment): the card gains "1 triangle ground unit"
// — the player picks WHICH of their triangle ground unit types (Rebel: Trooper
// or Vanguard). `typeId` is the fallback/default when only one type exists. When
// false the gain is a specific fixed unit (e.g. Reinforcements → TIE Fighter).
type GainEffect = { kind: 'gain'; typeId: string; prevent?: { red: number; black: number; special: number }; chooseTriangleGround?: boolean };
// The OPPONENT resolves their attacks first in this theatre for the rest of
// the combat (rules p.9 "During [theatre] battles this combat, [opp]
// resolves attacks first").
type ResolveFirstEffect = { kind: 'resolveFirst' };
// The opponent can't play a tactic card in this theatre next round.
type LockDeckEffect = { kind: 'lockDeck' };
// Remove up to `amount` accumulated damage from your own units in this
// theatre (Energy Shield / Draw Their Fire primaries). `exceptTypeId` skips a
// unit type (Draw Their Fire excludes Nebulon-B Frigates).
type RemoveDamageEffect = { kind: 'removeDamage'; amount: number; exceptTypeId?: string };
// End-of-round capture (Tractor Beam primary): if you have a Star Destroyer
// and the opponent has no ships, capture 1 enemy leader in the combat.
type CaptureEffect = { kind: 'capture' };
// Cancel the opponent's tactic card this round in this theatre (Entrapment /
// Air Superiority / Outrun Them primaries). Only bites if the canceller plays
// before the opponent (sequential resolution — see combat.ts runTheater).
// `extra`: Entrapment's primary also reads "You may play another card" (#547)
// — it grants an extra tactic play this round on top of the cancel.
type CancelEffect = { kind: 'cancel'; extra?: boolean };
// Shield absorb (Armored Position / Planetary Shield primaries): move up to
// `amount` accumulated damage from your own GROUND units onto one shield
// structure (Shield Bunker / Shield Generator), which soaks it.
type ShieldAbsorbEffect = { kind: 'shieldAbsorb'; amount: number; structureTypeId: string };
// You may play one extra tactic card this round in this theatre (Imposing
// Presence / Confrontation secondaries — standalone).
type ExtraCardEffect = { kind: 'extraCard' };
// Rogue One primary: queued to AFTER the retreat step — if any unit retreated
// this round, the Rebel rescues a captured leader OR removes a target marker.
type RogueOneEffect = { kind: 'rogueOne' };
// Bar the opponent from spending ★ dice to remove damage from its units of
// this card's theatre this round (Intercept / Imposing Presence / Deployment /
// Rogue One secondaries — "[opp] ships/ground units cannot remove damage…").
type SpecialLockEffect = { kind: 'specialLock' };
// Confrontation primary: queued to end of round — if the last Imperial ground
// unit was destroyed this round, mark an Imperial leader in the system for
// elimination at end of the Command phase.
type ConfrontationEffect = { kind: 'confrontation' };
// Escape Plan primary: "You may immediately retreat. If you do, cancel the
// Imperial tactic card." Handled in combat.ts (it posts a mid-tactic retreat
// choice); resolves nothing here.
type EscapePlanEffect = { kind: 'escapePlan' };
type UnwiredEffect = { kind: 'unwired' };
type Ability = DealEffect | PreventEffect | CondDealEffect | TargetDealEffect | DestroyEffect | GainEffect | ResolveFirstEffect | LockDeckEffect | RemoveDamageEffect | CaptureEffect | CancelEffect | ShieldAbsorbEffect | ExtraCardEffect | RogueOneEffect | SpecialLockEffect | ConfrontationEffect | EscapePlanEffect | UnwiredEffect;

const D = (amount: number, color?: 'red' | 'black'): DealEffect => ({ kind: 'deal', amount, color });
const P = (red: number, black: number, special = 0, extra = false): PreventEffect => ({ kind: 'prevent', red, black, special, extra });
const CD = (amount: number, cond: CondDealEffect['cond'], color?: 'red' | 'black'): CondDealEffect => ({ kind: 'condDeal', amount, color, cond });
const TD = (amount: number, targetClass: TargetDealEffect['targetClass']): TargetDealEffect => ({ kind: 'targetDeal', amount, targetClass });
const DESTROY = (opts: { tier?: 'triangle'; unitClass?: 'structure'; theater?: Theater }): DestroyEffect => ({ kind: 'destroy', ...opts });
const GAIN = (typeId: string, prevent?: GainEffect['prevent']): GainEffect => ({ kind: 'gain', typeId, prevent });
// "Gain 1 triangle ground unit" — player chooses the type (Deployment, #497).
const GAINTRI = (defaultTypeId: string): GainEffect => ({ kind: 'gain', typeId: defaultTypeId, chooseTriangleGround: true });
const FIRST: ResolveFirstEffect = { kind: 'resolveFirst' };
const LOCK: LockDeckEffect = { kind: 'lockDeck' };
const REMOVE = (amount: number, exceptTypeId?: string): RemoveDamageEffect => ({ kind: 'removeDamage', amount, exceptTypeId });
const CAPTURE: CaptureEffect = { kind: 'capture' };
const CANCEL: CancelEffect = { kind: 'cancel' };
// Entrapment primary: "Cancel the Rebel tactic card. You may play another card."
const CANCEL_EXTRA: CancelEffect = { kind: 'cancel', extra: true };
const ABSORB = (amount: number, structureTypeId: string): ShieldAbsorbEffect => ({ kind: 'shieldAbsorb', amount, structureTypeId });
const EXTRA: ExtraCardEffect = { kind: 'extraCard' };
const ROGUE: RogueOneEffect = { kind: 'rogueOne' };
const LOCKSPECIAL: SpecialLockEffect = { kind: 'specialLock' };
const CONFRONT: ConfrontationEffect = { kind: 'confrontation' };
const ESCAPE: EscapePlanEffect = { kind: 'escapePlan' };
const U: UnwiredEffect = { kind: 'unwired' };

// Per-card [top, bottom] abilities, keyed by the card id slug from
// scripts/add-cinematic-tactics.mjs.
const ABILITIES: Record<string, [Ability, Ability]> = {
  // ---- Imperial Space ----
  // Card scan (images/Swarm Tactics_s.png): "If there are more Imperial
  // fighters than Rebel fighters, deal 2 damage." — was mis-entered as 1 (#570).
  'cin-empire-space-swarm-tactics':          [CD(2, 'more-fighters'), D(1, 'black')],
  'cin-empire-space-reinforcements':         [GAIN('tie-fighter', { red: 0, black: 2, special: 0 }), P(0, 2)],
  'cin-empire-space-tractor-beam':           [CAPTURE, D(1, 'red')],
  'cin-empire-space-overwhelming-presence':  [P(2, 0, 1), P(2, 0)],
  'cin-empire-space-superlaser-blast':       [TD(5, 'capital'), D(1)],
  'cin-empire-space-entrapment':             [CANCEL_EXTRA, LOCK],
  'cin-empire-space-energy-shield':          [REMOVE(2), FIRST],
  'cin-empire-space-intercept':              [DESTROY({ tier: 'triangle', theater: 'ground' }), LOCKSPECIAL],
  // ---- Imperial Ground ----
  'cin-empire-ground-support-of-the-501st':  [DESTROY({ tier: 'triangle' }), D(1, 'black')],
  'cin-empire-ground-armored-patrol':        [P(2, 2), P(1, 1)],
  'cin-empire-ground-overrun':               [D(2), D(1)],
  'cin-empire-ground-target-the-generator':  [DESTROY({ unitClass: 'structure' }), D(1, 'red')],
  'cin-empire-ground-air-superiority':       [CANCEL, LOCK],
  'cin-empire-ground-armored-position':      [ABSORB(3, 'shield-bunker'), FIRST],
  'cin-empire-ground-bombardment':           [CD(2, 'no-shield-generator', 'black'), D(1)],
  'cin-empire-ground-imposing-presence':     [LOCKSPECIAL, EXTRA],
  // ---- Rebel Space ----
  'cin-rebel-space-rogue-squadron-support':  [D(2, 'black'), D(1, 'black')],
  'cin-rebel-space-bombing-run':             [D(2, 'red'), D(1, 'red')],
  'cin-rebel-space-deployment':              [GAINTRI('rebel-trooper'), LOCKSPECIAL],
  'cin-rebel-space-fleet-logistics':         [P(2, 0, 0, true), P(2, 0)],
  'cin-rebel-space-ion-blast':               [TD(1, 'capital'), D(1)],
  'cin-rebel-space-outrun-them':             [CANCEL, LOCK],
  'cin-rebel-space-draw-their-fire':         [REMOVE(2, 'nebulon-b-frigate'), FIRST],
  'cin-rebel-space-escort':                  [P(1, 1, 1), P(0, 2)],
  // ---- Rebel Ground ----
  'cin-rebel-ground-hold-them-back':         [DESTROY({ tier: 'triangle' }), D(1, 'black')],
  'cin-rebel-ground-take-it-down':           [D(2, 'red'), D(1, 'red')],
  'cin-rebel-ground-tow-cables':             [TD(4, 'at-walker'), D(1)],
  'cin-rebel-ground-take-cover':             [P(2, 2), P(1, 1)],
  'cin-rebel-ground-planetary-shield':       [ABSORB(3, 'shield-generator'), FIRST],
  'cin-rebel-ground-rogue-one':              [ROGUE, LOCKSPECIAL],
  'cin-rebel-ground-escape-plan':            [ESCAPE, LOCK],
  'cin-rebel-ground-confrontation':          [CONFRONT, EXTRA],
};

/** Does a condDeal's condition currently hold? */
function condHolds(G: GameState, c: CombatState, side: Side, theater: Theater, cond: CondDealEffect['cond']): boolean {
  if (cond === 'more-fighters') {
    const myFighters = unitsOf(G, side, c.systemId, theater)
      .filter((u) => G.catalog.unitTypes[u.typeId]?.class === 'fighter').length;
    const oppFighters = unitsOf(G, other(side), c.systemId, theater)
      .filter((u) => G.catalog.unitTypes[u.typeId]?.class === 'fighter').length;
    return myFighters > oppFighters;
  }
  if (cond === 'no-shield-generator') {
    return !(G.map.systems[c.systemId]?.units ?? []).some((u) => u.typeId === 'shield-generator');
  }
  return false;
}

/** Enemy units matching a targeted-deal target class. */
function targetClassUnits(G: GameState, c: CombatState, side: Side, theater: Theater, tc: TargetDealEffect['targetClass']) {
  return unitsOf(G, other(side), c.systemId, theater).filter((u) => {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.health.color === null) return false;
    if (tc === 'capital') return t.class === 'capital' || t.class === 'station';
    if (tc === 'at-walker') return u.typeId === 'at-at' || u.typeId === 'at-st';
    return false;
  });
}

/** Enemy units a destroy effect can remove. */
function destroyTargets(G: GameState, c: CombatState, side: Side, theater: Theater, eff: DestroyEffect) {
  // A destroy may name its own target theatre (Intercept hits GROUND from a
  // SPACE tactic) — otherwise the targets come from the tactic's theatre (#373).
  return unitsOf(G, other(side), c.systemId, eff.theater ?? theater).filter((u) => {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.health.color === null) return false;
    if (eff.tier && t.tier !== eff.tier) return false;
    if (eff.unitClass && t.class !== eff.unitClass) return false;
    return true;
  });
}

/** A rough "how good is this ability right now" score for the auto-picker. */
function abilityValue(G: GameState, c: CombatState, side: Side, theater: Theater, ab: Ability): number {
  if (ab.kind === 'deal') {
    const targets = unitsOf(G, other(side), c.systemId, theater)
      .filter((u) => G.catalog.unitTypes[u.typeId]?.health.color !== null);
    return targets.length > 0 ? ab.amount : 0;
  }
  if (ab.kind === 'prevent') {
    const oppAttacks = unitsOf(G, other(side), c.systemId, theater).some((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      return t && (t.attack.red + t.attack.black + t.attack.green) > 0;
    });
    return oppAttacks ? (ab.red + ab.black + ab.special) : 0;
  }
  if (ab.kind === 'condDeal') {
    if (!condHolds(G, c, side, theater, ab.cond)) return 0;
    const targets = unitsOf(G, other(side), c.systemId, theater)
      .filter((u) => G.catalog.unitTypes[u.typeId]?.health.color !== null);
    return targets.length > 0 ? ab.amount + 0.5 : 0; // slight bonus — conditional but free
  }
  if (ab.kind === 'targetDeal') {
    const targets = targetClassUnits(G, c, side, theater, ab.targetClass);
    // High value: targeted big-damage burst onto exactly the unit we want.
    return targets.length > 0 ? ab.amount + 1 : 0;
  }
  if (ab.kind === 'destroy') {
    return destroyTargets(G, c, side, theater, ab).length > 0 ? 3 : 0;
  }
  if (ab.kind === 'gain') {
    // Gaining a unit is always worthwhile; prevent part adds a little.
    return 1.5 + (ab.prevent ? (ab.prevent.red + ab.prevent.black) * 0.25 : 0);
  }
  if (ab.kind === 'lockDeck') {
    // Denying the opponent a card next round — modest, only if they still
    // have units in this theatre to fight on with.
    return unitsOf(G, other(side), c.systemId, theater).length > 0 ? 0.8 : 0;
  }
  if (ab.kind === 'resolveFirst') {
    // Situational (changes attack order for the rest of combat). Low value
    // so it's a last resort, but wired.
    return bothHaveTheater(G, c, theater) ? 0.4 : 0;
  }
  if (ab.kind === 'removeDamage') {
    // Worth it only if our own units in this theatre actually carry damage.
    const repairable = unitsOf(G, side, c.systemId, theater)
      .filter((u) => u.typeId !== ab.exceptTypeId)
      .reduce((s, u) => s + Math.min(u.damage, ab.amount), 0);
    return repairable > 0 ? Math.min(repairable, ab.amount) + 0.5 : 0;
  }
  if (ab.kind === 'capture') {
    // High value when the end-of-round condition is close: we have a Star
    // Destroyer here and there's an enemy leader to grab.
    const haveSD = unitsOf(G, side, c.systemId, 'space').some((u) => u.typeId === 'star-destroyer');
    const enemyLeaders = ((other(side) === 'Rebel' ? G.rebel : G.empire).leadersOnBoard[c.systemId] ?? []).length;
    return haveSD && enemyLeaders > 0 ? 3 : 0;
  }
  if (ab.kind === 'cancel') {
    // Cancelling the opponent's play is valuable, but only if they actually
    // have a card to play here and haven't resolved yet.
    const opp = other(side);
    const oppKey = `${opp}:${theater}:${c.round}`;
    const tooLate = (c.cinematicTacticDoneThisRound ?? []).includes(oppKey);
    if (tooLate) return 0;
    const base = availableCards(G, opp, theater).length > 0 ? 1.2 : 0.2;
    return base + (ab.extra ? 0.5 : 0); // Entrapment also grants an extra play (#547)
  }
  if (ab.kind === 'shieldAbsorb') {
    // Worth it only if we have the shield structure AND wounded ground units.
    const ss = G.map.systems[c.systemId];
    const hasStructure = (ss?.units ?? []).some((u) => u.side === side && u.typeId === ab.structureTypeId);
    if (!hasStructure) return 0;
    const healable = (ss?.units ?? [])
      .filter((u) => u.side === side && u.typeId !== ab.structureTypeId
        && G.catalog.unitTypes[u.typeId]?.theater === 'ground')
      .reduce((s, u) => s + u.damage, 0);
    return healable > 0 ? Math.min(healable, ab.amount) + 0.5 : 0;
  }
  if (ab.kind === 'extraCard') {
    // Only worth playing if there's at least one OTHER card to chain into.
    return availableCards(G, side, theater).length > 1 ? 0.6 : 0;
  }
  if (ab.kind === 'rogueOne') {
    // Conditional on a retreat happening this round (unknown now). Worth a
    // little if there's something to gain: a captured leader to rescue or a
    // target marker on the system to remove.
    const haveRescue = (G.empire.capturedLeaders ?? []).length > 0;
    const haveMarker = (G.map.systems[c.systemId]?.targetMarkers ?? []).length > 0;
    return haveRescue || haveMarker ? 1 : 0.2;
  }
  if (ab.kind === 'specialLock') {
    // Worth a little if the opponent has wounded units of this theatre that
    // they might otherwise heal with ★ dice.
    const oppWounded = unitsOf(G, other(side), c.systemId, theater).some((u) => u.damage > 0);
    return oppWounded ? 0.7 : 0.2;
  }
  if (ab.kind === 'confrontation') {
    // Worth more when the Empire's ground force here is small (likely to be
    // wiped this round) and there's an Imperial leader to mark.
    const empGround = unitsOf(G, 'Empire', c.systemId, 'ground').length;
    const empLeaderHere = (G.empire.leadersOnBoard[c.systemId] ?? []).length > 0;
    if (empGround === 0 || !empLeaderHere) return 0.2;
    return empGround <= 2 ? 1.5 : 0.6;
  }
  if (ab.kind === 'escapePlan') {
    // Situational — the AI rarely wants to flee a fight it chose. Low value so
    // it's a last resort, but available.
    return 0.3;
  }
  return 0; // unwired
}

function bothHaveTheater(G: GameState, c: CombatState, theater: Theater): boolean {
  return unitsOf(G, 'Rebel', c.systemId, theater).length > 0
      && unitsOf(G, 'Empire', c.systemId, theater).length > 0;
}

/** Resolve a deal-damage ability: assign `amount` damage one-at-a-time to the
 *  cheapest-to-kill eligible enemy unit (colour-matched; uncoloured hits any
 *  red/black-health unit). Per RoE cinematic rules (p.8) the damage is only
 *  lethal at the END of the theatre round, so a unit that reaches lethal is
 *  STAGED (added to c.theaterStaged), not destroyed now — the owner may save it
 *  with a Remove-Damage action this round, and finalizeTheaterDestructions
 *  re-checks before destroying. Already-staged units are skipped so the damage
 *  spreads to the next target ("a card that deals more than 1 damage can be
 *  split among multiple units"). */
function resolveDeal(G: GameState, c: CombatState, side: Side, theater: Theater, eff: DealEffect): number {
  let dealt = 0;
  const staged = (c.theaterStaged ??= []);
  for (let i = 0; i < eff.amount; i++) {
    const candidates = unitsOf(G, other(side), c.systemId, theater).filter((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t || t.health.color === null) return false; // invulnerable (Death Star)
      if (eff.color && t.health.color !== eff.color) return false;
      if (staged.includes(u.instanceId)) return false; // already doomed this theatre
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
    if (dead) staged.push(target.instanceId); // destroyed at end of round, not now
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
  const eliminated = new Set(f.cinematicTacticEliminated ?? []);
  return Object.values(G.catalog.tactics)
    .filter((t) => t.cinematic && t.side === side && t.theater === theater
      && !discard.has(t.id) && !eliminated.has(t.id))
    .map((t) => t.id);
}

/** Auto-play one advanced tactic card for `side` in `theater` this round (or
 *  skip if nothing useful). Picks the highest-value resolvable ability,
 *  prefers the top ability when its unit prerequisite is met. Moves the
 *  played card to the side's cinematic discard. */
/** Is `side` locked out of playing a tactic card in `theater` this round?
 *  (Entrapment / Air Superiority / Outrun Them / Escape Plan secondaries.) */
export function isCinematicLocked(c: CombatState, side: Side, theater: Theater): boolean {
  // It's a Trap (#272): the named side cannot play SPACE tactic cards in round 1.
  if (theater === 'space' && c.round === 1 && c.flags?.noSpaceTacticsRound1Side === side) {
    return true;
  }
  const lockedThrough = c.cinematicDeckLock?.[`${side}:${theater}`];
  return lockedThrough != null && c.round <= lockedThrough;
}

/** Does the given card+ability use "cancel"? Per the rulebook, if the DEFENDER
 *  plays a cancel card, the defender resolves before the attacker. Used by
 *  combat.ts to order the simultaneous tactic selections. */
export function isCancelCard(cardId: string, useTop: boolean): boolean {
  const ab = ABILITIES[cardId];
  if (!ab) return false;
  const k = (useTop ? ab[0] : ab[1]).kind;
  // Escape Plan also resolves before the attacker (its retreat-then-cancel is
  // a cancel for ordering purposes).
  return k === 'cancel' || k === 'escapePlan';
}

/** Is the card+ability Escape Plan's primary (handled by combat.ts's mid-tactic
 *  retreat flow rather than applyCinematicAbility)? */
export function isEscapePlanAbility(cardId: string, useTop: boolean): boolean {
  const ab = ABILITIES[cardId];
  return !!ab && (useTop ? ab[0] : ab[1]).kind === 'escapePlan';
}

/** Is a card's TOP (primary) ability resolvable — its primaryUnit present? */
function topUsable(G: GameState, c: CombatState, side: Side, theater: Theater, cardId: string): boolean {
  // A conditional top ability (e.g. Swarm Tactics: "If you have more Imperial
  // fighters than Rebel fighters, deal 1 damage") is only USABLE while its
  // condition holds — otherwise it would resolve to nothing, so we don't offer
  // it as a top play (reporter #400). The bottom ability stays available.
  const top = ABILITIES[cardId]?.[0];
  if (top?.kind === 'condDeal' && !condHolds(G, c, side, theater, top.cond)) return false;
  const card = G.catalog.tactics[cardId];
  if (!card?.primaryUnit) return true;
  return unitsOf(G, side, c.systemId, theater).some((u) => u.typeId === card.primaryUnit)
    || (G.map.systems[c.systemId]?.units ?? []).some((u) => u.side === side && u.typeId === card.primaryUnit);
}

/** Advanced-card play options to offer `side` for the interactive modal:
 *  all available cards for this theatre, each flagged with whether its top
 *  ability is usable. Empty when locked or nothing available. */
/** RoE p.8: "after you use the last tactic card from your deck, return all
 *  cards from its discard pile to your deck (except the card you just
 *  resolved)." When a side's advanced deck for this theatre is empty (every
 *  card discarded), recycle the discard back into the deck, keeping only the
 *  most-recently-resolved card in the discard. Idempotent — a no-op unless the
 *  deck is genuinely empty. */
export function recycleCinematicDeck(G: GameState, side: Side, theater: Theater): void {
  if (availableCards(G, side, theater).length > 0) return; // deck not empty
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const disc = f.cinematicTacticDiscard ?? [];
  const eliminated = new Set(f.cinematicTacticEliminated ?? []);
  // Eliminated cards ("eliminate this card") never recycle — they stay in the
  // discard forever and are excluded from the recyclable set.
  const theaterCards = disc.filter((id) => {
    const t = G.catalog.tactics[id];
    return t?.cinematic && t.side === side && t.theater === theater && !eliminated.has(id);
  });
  if (theaterCards.length <= 1) return; // nothing meaningful to recycle
  const keep = theaterCards[theaterCards.length - 1]; // the just-resolved card stays
  f.cinematicTacticDiscard = disc.filter((id) => {
    const t = G.catalog.tactics[id];
    const thisTheater = t?.cinematic && t.side === side && t.theater === theater;
    return !thisTheater || id === keep || eliminated.has(id);
  });
  log(G, { kind: 'cinematic-deck-recycle', side, payload: {
    theater, kept: keep, recycled: theaterCards.length - 1,
  }});
}

export function cinematicSelectOptions(G: GameState, c: CombatState, side: Side, theater: Theater) {
  if (isCinematicLocked(c, side, theater)) return [];
  recycleCinematicDeck(G, side, theater); // refill the deck if it just emptied
  return availableCards(G, side, theater)
    .filter((cardId) => ABILITIES[cardId])
    .map((cardId) => {
      const card = G.catalog.tactics[cardId];
      return {
        cardId,
        name: card?.name ?? cardId,
        primaryText: card?.primaryText ?? '',
        secondaryText: card?.secondaryText ?? '',
        primaryUsable: topUsable(G, c, side, theater, cardId),
      };
    });
}

/** The AI's best play (highest-value resolvable ability) for `side`, or null
 *  to skip. Used by the random AI to resolve a CinematicTacticSelect. */
export function pickBestCinematicPlay(
  G: GameState, c: CombatState, side: Side, theater: Theater,
): { cardId: string; useTop: boolean } | null {
  if (isCinematicLocked(c, side, theater)) return null;
  let best: { cardId: string; useTop: boolean; value: number } | null = null;
  for (const cardId of availableCards(G, side, theater)) {
    const abilities = ABILITIES[cardId];
    if (!abilities) continue;
    const [top, bottom] = abilities;
    const opts: { useTop: boolean; ab: Ability }[] = [];
    if (topUsable(G, c, side, theater, cardId)) opts.push({ useTop: true, ab: top });
    opts.push({ useTop: false, ab: bottom });
    for (const opt of opts) {
      const v = abilityValue(G, c, side, theater, opt.ab);
      if (v > 0 && (!best || v > best.value)) best = { cardId, useTop: opt.useTop, value: v };
    }
  }
  return best ? { cardId: best.cardId, useTop: best.useTop } : null;
}

/** Apply a chosen advanced-card ability (top/bottom) and discard the card.
 *  `isExtra` marks a card played as a SECOND card via an "extra card" effect:
 *  per the RoE rulebook such a card can neither contain a cancelling effect nor
 *  be cancelled (#328). Being cancelled is already impossible — extra cards
 *  resolve immediately, outside the cancel loop — so this only voids a cancel
 *  ABILITY on the extra card itself. */
export function applyCinematicAbility(
  G: GameState, c: CombatState, side: Side, theater: Theater, cardId: string, useTop: boolean,
  isExtra = false,
): void {
  const abilities = ABILITIES[cardId];
  if (!abilities) return;
  const ab = useTop ? abilities[0] : abilities[1];
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const logPlay = (extra: Record<string, unknown>) => log(G, { kind: 'cinematic-tactic-play', side, payload: {
    cardId, ability: useTop ? 'primary' : 'secondary', theater, ...extra,
  }});
  if (ab.kind === 'deal') {
    logPlay({ dealt: resolveDeal(G, c, side, theater, ab) });
  } else if (ab.kind === 'prevent') {
    resolvePrevent(c, side, ab);
    if (ab.extra) grantExtraCard(c, side, theater);
    logPlay({ prevent: { red: ab.red, black: ab.black, special: ab.special }, extra: !!ab.extra });
  } else if (ab.kind === 'condDeal') {
    const ok = condHolds(G, c, side, theater, ab.cond);
    logPlay({ condDealt: ok ? resolveDeal(G, c, side, theater, { kind: 'deal', amount: ab.amount, color: ab.color }) : 0, cond: ab.cond, condMet: ok });
  } else if (ab.kind === 'targetDeal') {
    logPlay({ targetDealt: resolveTargetDeal(G, c, side, theater, ab) });
  } else if (ab.kind === 'destroy') {
    logPlay({ destroyed: resolveDestroy(G, c, side, theater, ab) });
  } else if (ab.kind === 'gain') {
    M.deployUnit(G, side, ab.typeId, c.systemId);
    if (ab.prevent) resolvePrevent(c, side, { kind: 'prevent', ...ab.prevent });
    logPlay({ gained: ab.typeId, prevent: ab.prevent });
  } else if (ab.kind === 'resolveFirst') {
    (c.cinematicResolveFirst ??= {})[theater] = other(side);
    logPlay({ resolveFirst: other(side) });
  } else if (ab.kind === 'lockDeck') {
    (c.cinematicDeckLock ??= {})[`${other(side)}:${theater}`] = c.round + 1;
    logPlay({ lockDeck: { side: other(side), theater, throughRound: c.round + 1 } });
  } else if (ab.kind === 'removeDamage') {
    // "After the [opponent] assign damage, remove up to N damage" — reactive.
    // DEFER to after this theatre's attacks (applyDeferredCinematicHeals),
    // before the destruction step, so it can save a just-damaged ship. Applied
    // here at round-start it would heal nothing — there's no damage yet (#225).
    (c.cinematicDeferredHeal ??= []).push({ side, theater, amount: ab.amount, exceptTypeId: ab.exceptTypeId });
    logPlay({ deferredRemoveDamage: ab.amount, except: ab.exceptTypeId });
  } else if (ab.kind === 'capture') {
    // Deferred to end of round — the condition (you have a Star Destroyer, the
    // opponent has no ships) is an end-of-round state. Queue it.
    (c.cinematicEndOfRound ??= []).push({ side, kind: 'capture' });
    logPlay({ queued: 'end-of-round-capture' });
  } else if (ab.kind === 'cancel') {
    // Cancel the opponent's tactic play this round in this theatre. Only bites
    // if they haven't resolved yet (sequential order: attacker plays first).
    // A card played as a SECOND card via an "extra card" effect cannot contain a
    // cancelling effect (RoE; #328) — void it.
    if (isExtra) {
      logPlay({ cancel: { side: other(side), theater, applied: false, note: 'extra card cannot cancel' } });
    } else {
      const opp = other(side);
      const oppKey = `${opp}:${theater}:${c.round}`;
      const tooLate = (c.cinematicTacticDoneThisRound ?? []).includes(oppKey);
      if (!tooLate) (c.cinematicCancel ??= {})[oppKey] = true;
      // Entrapment (#547): the primary also grants "You may play another
      // card" — an extra tactic play this round, unconditional on whether
      // the cancel itself bit (that's how the card is printed).
      if (ab.extra) grantExtraCard(c, side, theater);
      logPlay({ cancel: { side: opp, theater, applied: !tooLate, note: tooLate ? 'opponent already resolved' : undefined }, extra: !!ab.extra });
    }
  } else if (ab.kind === 'shieldAbsorb') {
    // "After the [opponent] assign damage, assign up to N damage to 1 Shield
    // Generator/Bunker, then cancel that damage from ground units" — REACTIVE,
    // same timing as removeDamage. DEFER to after this theatre's attacks
    // (applyDeferredCinematicHeals), before destruction, so it soaks the
    // just-dealt damage and saves the ground units. Applied here at round-start
    // it moved 0 — there is no damage yet (#431).
    (c.cinematicDeferredHeal ??= []).push({ side, theater, amount: ab.amount, structureTypeId: ab.structureTypeId });
    logPlay({ deferredShieldAbsorb: ab.amount, structure: ab.structureTypeId });
  } else if (ab.kind === 'extraCard') {
    grantExtraCard(c, side, theater);
    logPlay({ extra: true });
  } else if (ab.kind === 'rogueOne') {
    // Resolved after the retreat step (resolveCinematicRetreatTriggers).
    (c.cinematicEndOfRound ??= []).push({ side, kind: 'rogueOne' });
    logPlay({ queued: 'rogue-one-post-retreat' });
  } else if (ab.kind === 'specialLock') {
    // Bar the opponent from ★-removing damage from its theatre units this round.
    const opp = other(side);
    (c.cinematicSpecialLock ??= {})[`${opp}:${theater}:${c.round}`] = true;
    logPlay({ specialLock: { side: opp, theater, round: c.round } });
  } else if (ab.kind === 'confrontation') {
    // Resolved at end of round (resolveCinematicEndOfRound).
    (c.cinematicEndOfRound ??= []).push({ side, kind: 'confrontation' });
    logPlay({ queued: 'confrontation-end-of-round' });
  } else if (ab.kind === 'escapePlan') {
    // Handled by combat.ts (posts a mid-tactic retreat choice). If we reach
    // here via the auto path, there's no interactive retreat — just log it.
    logPlay({ escapePlan: 'no-interactive-retreat' });
  } else {
    logPlay({ unwired: true });
  }
  // Discard the played card (does NOT reshuffle — gone for the game).
  (f.cinematicTacticDiscard ??= []).push(cardId);
}

/** Auto-play one advanced tactic card for `side` (non-interactive path:
 *  tests + AI fallback). Picks the AI's best and applies it; skips if
 *  nothing worth playing or the side is locked. */
export function autoPlayCinematicTactic(G: GameState, c: CombatState, side: Side, theater: Theater): void {
  if (isCinematicLocked(c, side, theater)) {
    log(G, { kind: 'cinematic-tactic-locked', side, payload: { theater, round: c.round } });
    return;
  }
  const pick = pickBestCinematicPlay(G, c, side, theater);
  if (!pick) return;
  applyCinematicAbility(G, c, side, theater, pick.cardId, pick.useTop);
}

/** Remove up to `amount` accumulated damage from the playing side's own units
 *  in this theatre (Energy Shield / Draw Their Fire). Spends the budget on the
 *  most-damaged units first; `exceptTypeId` is skipped (Draw Their Fire
 *  excludes Nebulon-B Frigates). Returns the total damage healed. */
function resolveRemoveDamage(
  G: GameState, side: Side, sysId: string, theater: Theater, eff: RemoveDamageEffect,
): number {
  const own = unitsOf(G, side, sysId, theater)
    .filter((u) => u.typeId !== eff.exceptTypeId && u.damage > 0)
    .sort((a, b) => b.damage - a.damage);
  let budget = eff.amount, removed = 0;
  for (const u of own) {
    if (budget <= 0) break;
    const take = Math.min(u.damage, budget);
    u.damage -= take; budget -= take; removed += take;
  }
  return removed;
}

/** Is `u` currently at lethal damage (staged for end-of-theatre destruction)? */
function isLethal(G: GameState, u: { typeId: string; damage: number }): boolean {
  const h = G.catalog.unitTypes[u.typeId]?.health.value ?? 0;
  return h > 0 && u.damage >= h;
}

/** Build the suggested heal allocation: spend the budget saving lethally-damaged
 *  ships first (cheapest-to-save first, so the most ships survive), then pour any
 *  remainder onto the most-damaged survivors. This is both the AI's play and the
 *  human's pre-filled default. */
function suggestHealAllocation(
  G: GameState, units: { instanceId: string; typeId: string; damage: number }[], amount: number,
): { instanceId: string; amount: number }[] {
  const out: { instanceId: string; amount: number }[] = [];
  let budget = amount;
  const bump = (id: string, n: number) => {
    const ex = out.find((s) => s.instanceId === id);
    if (ex) ex.amount += n; else out.push({ instanceId: id, amount: n });
  };
  const remaining = new Map(units.map((u) => [u.instanceId, u.damage]));
  // 1) Save staged ships we can actually afford to save, cheapest first.
  const staged = units
    .filter((u) => isLethal(G, u))
    .map((u) => ({ id: u.instanceId, cost: u.damage - (G.catalog.unitTypes[u.typeId]?.health.value ?? 0) + 1 }))
    .sort((a, b) => a.cost - b.cost);
  for (const s of staged) {
    if (s.cost <= budget) { bump(s.id, s.cost); budget -= s.cost; remaining.set(s.id, (remaining.get(s.id) ?? 0) - s.cost); }
  }
  // 2) Remaining budget on the most-damaged, one point at a time.
  while (budget > 0) {
    let best: string | null = null, bestDmg = 0;
    for (const [id, dmg] of remaining) { if (dmg > bestDmg) { best = id; bestDmg = dmg; } }
    if (!best) break;
    bump(best, 1); budget -= 1; remaining.set(best, bestDmg - 1);
  }
  return out;
}

/** Apply any deferred "remove damage after the opponent attacks" heals (Draw
 *  Their Fire / Energy Shield) for `theater`. Called by combat.ts AFTER the
 *  theatre's attacks resolve and BEFORE finalizeTheaterDestructions, so a heal
 *  can pull a just-damaged ship back below lethal and save it (#225).
 *
 *  Returns true if it posted an interactive choice (the playing side has a
 *  meaningful allocation decision — more total damage than the heal budget) and
 *  the caller must pause; the resolver (resolveCinematicDeferredHeal) finishes
 *  the entry and re-enters combat. Forced cases (heal everything / nothing
 *  wounded) auto-apply with no pause (player report #322). */
export function applyDeferredCinematicHeals(G: GameState, c: CombatState, theater: Theater): boolean {
  const queue = c.cinematicDeferredHeal;
  if (!queue?.length) return false;
  // Process entries for this theatre in order; pause on the first that needs a
  // real choice (leaving it queued for the resolver to consume).
  while (true) {
    const idx = queue.findIndex((h) => h.theater === theater);
    if (idx < 0) return false;
    const h = queue[idx];
    // Shield-absorb entry (Planetary Shield / Armored Position): move up to
    // `amount` of the just-dealt damage onto the structure, cancelling it from
    // ground units. Auto-resolves (no allocation choice) — always maximises
    // ground healing — so it never pauses (#431).
    if (h.structureTypeId) {
      const absorbed = resolveShieldAbsorb(G, h.side, c.systemId,
        { kind: 'shieldAbsorb', amount: h.amount, structureTypeId: h.structureTypeId });
      restageTheater(G, c);
      log(G, { kind: 'cinematic-shield-absorb', side: h.side, payload: {
        theater, round: c.round, absorbed, structure: h.structureTypeId,
      }});
      queue.splice(idx, 1);
      continue;
    }
    const wounded = unitsOf(G, h.side, c.systemId, theater)
      .filter((u) => u.typeId !== h.exceptTypeId && u.damage > 0)
      .map((u) => ({ instanceId: u.instanceId, typeId: u.typeId, damage: u.damage }));
    const totalDamage = wounded.reduce((s, u) => s + u.damage, 0);
    // A prompt is only worth showing when the budget must be SPLIT between
    // ships. With a single wounded ship there is nothing to allocate — the only
    // remaining "choice" is to heal less than you could, which is never better
    // (removing damage has no cost or downside). Prompting there was a modal
    // with one button, and it also stalled the reactive save this heal exists
    // for: a lone lethally-damaged ship sat staged waiting on an answer instead
    // of being pulled back from destruction (#225, after #322 added the
    // allocation prompt). Same principle as the shield-absorb branch above,
    // which always auto-maximises.
    if (wounded.length <= 1 || h.amount <= 0 || totalDamage <= h.amount) {
      // Forced (or empty): remove all the damage we can, no decision to make.
      const removed = resolveRemoveDamage(G, h.side, c.systemId, theater,
        { kind: 'removeDamage', amount: h.amount, exceptTypeId: h.exceptTypeId });
      restageTheater(G, c);
      log(G, { kind: 'cinematic-remove-damage', side: h.side, payload: {
        theater, round: c.round, removed, except: h.exceptTypeId,
      }});
      queue.splice(idx, 1);
      continue;
    }
    // Meaningful allocation → hand it to the playing side (human modal / AI).
    G.pendingChoice = {
      kind: 'CinematicDeferredHeal',
      side: h.side, theater, systemId: c.systemId, amount: h.amount,
      candidates: wounded.map((u) => ({ ...u, staged: isLethal(G, u) })),
      suggested: suggestHealAllocation(G, wounded, h.amount),
    };
    log(G, { kind: 'choice-request', side: h.side, payload: {
      kind: 'CinematicDeferredHeal', theater, amount: h.amount, wounded: wounded.length,
    }});
    return true;
  }
}

/** Apply a chosen Draw Their Fire / Energy Shield heal allocation and drop the
 *  consumed queue entry. `alloc` is clamped to each unit's damage and to the
 *  entry's total budget. Returns the damage actually removed. */
export function applyDeferredHealAllocation(
  G: GameState, c: CombatState, theater: Theater, side: Side,
  alloc: { instanceId: string; amount: number }[],
): number {
  const queue = c.cinematicDeferredHeal ?? [];
  const idx = queue.findIndex((h) => h.theater === theater && h.side === side);
  const budget = idx >= 0 ? queue[idx].amount : 0;
  let spent = 0, removed = 0;
  const units = unitsOf(G, side, c.systemId, theater);
  for (const a of alloc) {
    if (spent >= budget) break;
    const u = units.find((x) => x.instanceId === a.instanceId);
    if (!u) continue;
    const take = Math.max(0, Math.min(a.amount, u.damage, budget - spent));
    u.damage -= take; spent += take; removed += take;
  }
  if (idx >= 0) queue.splice(idx, 1);
  restageTheater(G, c);
  log(G, { kind: 'cinematic-remove-damage', side, payload: {
    theater, round: c.round, removed, chosen: true,
  }});
  return removed;
}

/** Re-sync c.theaterStaged to units that are CURRENTLY at lethal damage. Call
 *  after ANY cinematic damage-removal: a unit dealt lethal damage by a tactic
 *  is staged (pending end-of-round destruction) and excluded from targeting,
 *  but if it's then healed below lethal it must be un-staged so it can be hit
 *  again and counted as a live target (player #256: a healed AT-ST stayed
 *  un-targetable, so the next hit was unassignable). */
export function restageTheater(G: GameState, c: CombatState): void {
  if (!c.theaterStaged?.length) return;
  const units = G.map.systems[c.systemId]?.units ?? [];
  c.theaterStaged = c.theaterStaged.filter((id) => {
    const u = units.find((x) => x.instanceId === id);
    const t = u && G.catalog.unitTypes[u.typeId];
    return !!(u && t && u.damage >= t.health.value); // still lethal → keep staged
  });
}

/** RoE "Removing damage" combat action (rulebook p.8): after a side rolls its
 *  attack dice in cinematic combat, it may discard each ★ (special) die to
 *  remove 1 damage from one of its units whose health colour matches the die's
 *  colour. In cinematic combat ★ has no other use (no special-spend tactic
 *  cards), so we auto-spend: heal the most-damaged matching-colour unit in this
 *  theatre first. Skips if that side is special-locked here this round
 *  (Intercept / Imposing Presence / Deployment / Rogue One). Returns the damage
 *  removed. Green ★ cannot match a unit's health colour, so only red/black
 *  count. Exported for combat.ts. */
export function applyCinematicSpecialHeal(
  G: GameState, c: CombatState, side: Side, theater: Theater,
  specials: { red: number; black: number },
): number {
  if (c.cinematicSpecialLock?.[`${side}:${theater}:${c.round}`]) return 0;
  let healed = 0;
  for (const color of ['red', 'black'] as const) {
    let budget = specials[color];
    if (budget <= 0) continue;
    // Most-damaged matching-colour own units in this theatre, closest-to-death
    // first (greatest benefit from saving them).
    const wounded = unitsOf(G, side, c.systemId, theater)
      .filter((u) => u.damage > 0 && G.catalog.unitTypes[u.typeId]?.health.color === color)
      .sort((a, b) => b.damage - a.damage);
    for (const u of wounded) {
      while (budget > 0 && u.damage > 0) { u.damage -= 1; budget -= 1; healed += 1; }
      if (budget <= 0) break;
    }
  }
  if (healed > 0) {
    log(G, { kind: 'cinematic-remove-damage', side, payload: { theater, round: c.round, removed: healed } });
    restageTheater(G, c); // un-stage units healed back below lethal
  }
  return healed;
}

/** Grant the side one extra tactic play this round in this theatre (Imposing
 *  Presence / Fleet Logistics / Confrontation). The combat tactic loop reads
 *  cinematicExtraPlays and re-offers the side. */
function grantExtraCard(c: CombatState, side: Side, theater: Theater): void {
  const key = `${side}:${theater}:${c.round}`;
  (c.cinematicExtraPlays ??= {})[key] = (c.cinematicExtraPlays[key] ?? 0) + 1;
}

/** Shield absorb (Armored Position / Planetary Shield): move up to `amount`
 *  accumulated damage from the side's OTHER ground units onto its shield
 *  structure, healing the units. The structure soaks it (and is destroyed if
 *  the damage reaches its health). Auto-resolves to maximise ground healing.
 *  Returns the damage moved. */
function resolveShieldAbsorb(
  G: GameState, side: Side, sysId: string, eff: ShieldAbsorbEffect,
): number {
  const ss = G.map.systems[sysId];
  if (!ss) return 0;
  const structure = ss.units.find((u) => u.side === side && u.typeId === eff.structureTypeId);
  if (!structure) return 0;
  const wounded = ss.units
    .filter((u) => u.side === side && u.instanceId !== structure.instanceId
      && G.catalog.unitTypes[u.typeId]?.theater === 'ground' && u.damage > 0)
    .sort((a, b) => b.damage - a.damage);
  let budget = eff.amount, moved = 0;
  for (const u of wounded) {
    if (budget <= 0) break;
    const take = Math.min(u.damage, budget);
    u.damage -= take; budget -= take; moved += take;
  }
  if (moved > 0) {
    structure.damage += moved;
    const maxHp = G.catalog.unitTypes[eff.structureTypeId]?.health.value ?? Infinity;
    // (Self-inflicted: the side's own shield structure soaks lethal damage. Not
    // an enemy kill, so it isn't recorded toward enemy-destruction objectives.)
    if (structure.damage >= maxHp) M.destroyUnit(G, structure.instanceId, 'cinematic-shield-absorb');
  }
  return moved;
}

/** Resolve queued end-of-round CAPTURE effects (Tractor Beam, deterministic)
 *  and CONFRONTATION (which PAUSES for the Rebel to pick the leader to mark).
 *  Called by combat.ts after both theatres' attacks, before retreat. Captures
 *  resolve first; then Confrontation, which may post a `ConfrontationLeaderPick`
 *  choice and return `true` (paused). Leaves non-capture/non-confrontation
 *  entries (Rogue One) in the queue for the post-retreat pass. Returns `true`
 *  iff it posted a choice (caller must pause). */
export function resolveCinematicEndOfRound(G: GameState, c: CombatState): boolean {
  const queue = c.cinematicEndOfRound;
  if (!queue || queue.length === 0) return false;
  for (const e of queue) {
    if (e.kind !== 'capture') continue;
    // Only the Empire captures (capturedLeaders is Empire-only; Tractor Beam is
    // an Imperial card). Condition: the player has a Star Destroyer in space and
    // the opponent has no ships left in the system.
    if (e.side !== 'Empire') continue;
    const haveSD = unitsOf(G, e.side, c.systemId, 'space').some((u) => u.typeId === 'star-destroyer');
    const oppShips = unitsOf(G, other(e.side), c.systemId, 'space').length;
    if (!haveSD || oppShips > 0) continue;
    const leaders = G.rebel.leadersOnBoard[c.systemId] ?? [];
    if (leaders.length === 0) continue;
    if (leaders.length >= 2) {
      // RAW: the Empire CHOOSES which leader to capture. Pause for the pick;
      // clear the capture entries now so they don't re-fire on resume (#316).
      c.cinematicEndOfRound = queue.filter((q) => q.kind !== 'capture');
      G.pendingChoice = { kind: 'TractorBeamCapturePick', side: e.side, systemId: c.systemId, candidates: [...leaders] };
      log(G, { kind: 'choice-request', side: e.side, payload: {
        kind: 'TractorBeamCapturePick', systemId: c.systemId, candidates: leaders.length,
      }});
      return true;
    }
    const leaderId = leaders[0];
    M.captureLeader(G, leaderId);
    log(G, { kind: 'cinematic-tractor-beam-capture', side: e.side, payload: { leaderId, systemId: c.systemId } });
  }
  for (const e of queue) {
    if (e.kind !== 'confrontation') continue;
    // "If the last Imperial ground unit is destroyed this round, mark 1 Imperial
    // leader for elimination at the end of this Command phase." Condition:
    // Empire now has 0 ground units here AND ≥1 Imperial ground unit was
    // destroyed in this round's combat.
    if (unitsOf(G, 'Empire', c.systemId, 'ground').length > 0) continue;
    const roundReport = c.report.rounds.find((r) => r.round === c.round);
    const destroyedImpGround = (roundReport?.attacks ?? []).some((a) =>
      a.destroyed.some((d) => {
        const t = G.catalog.unitTypes[d.typeId];
        return t?.side === 'Empire' && t.theater === 'ground';
      }),
    );
    if (!destroyedImpGround) continue;
    // Mark the highest-tactic-value Imperial leader in the system (auto-select;
    // most impactful elimination). If none present, nothing to mark.
    const here = G.empire.leadersOnBoard[c.systemId] ?? [];
    if (here.length === 0) {
      log(G, { kind: 'cinematic-confrontation-no-leader', side: e.side, payload: { systemId: c.systemId } });
      continue;
    }
    // RAW: the Rebel CHOOSES which Imperial leader to mark. Pause for the pick
    // (candidates listed strongest-first as a suggestion). Clear the resolved
    // capture/confrontation entries from the queue NOW (before the early
    // return) so they don't re-fire next round; the resolver
    // (`resolveConfrontationLeaderPick`) marks the chosen leader, eliminates
    // the card from the recyclable discard, and re-enters combat.
    const candidates = [...here].sort((a, b) => {
      const va = (G.catalog.leaders[a]?.tacticValues.space ?? 0) + (G.catalog.leaders[a]?.tacticValues.ground ?? 0);
      const vb = (G.catalog.leaders[b]?.tacticValues.space ?? 0) + (G.catalog.leaders[b]?.tacticValues.ground ?? 0);
      return vb - va;
    });
    c.cinematicEndOfRound = queue.filter((q) => q.kind !== 'capture' && q.kind !== 'confrontation');
    G.pendingChoice = { kind: 'ConfrontationLeaderPick', side: 'Rebel', systemId: c.systemId, candidates };
    log(G, { kind: 'cinematic-confrontation-choose', side: e.side, payload: { systemId: c.systemId, candidates } });
    return true;
  }
  c.cinematicEndOfRound = queue.filter((e) => e.kind !== 'capture' && e.kind !== 'confrontation');
  return false;
}

/** Resolve queued post-retreat cinematic triggers (Rogue One). Called by
 *  combat.ts AFTER the retreat step. If a Rogue One is queued and a retreat
 *  actually happened this round, post a RogueOneChoice and PAUSE (returns true);
 *  the resolver (resolveRogueOneChoice) applies it and re-enters. Returns false
 *  if nothing to do (entries with no retreat are dropped). */
export function resolveCinematicRetreatTriggers(G: GameState, c: CombatState): boolean {
  const queue = c.cinematicEndOfRound;
  if (!queue || queue.length === 0) return false;
  const rogue = queue.find((e) => e.kind === 'rogueOne');
  if (!rogue) return false;
  // Resolve this entry exactly once whether or not it fires.
  c.cinematicEndOfRound = queue.filter((e) => e !== rogue);
  if (!c.retreatHappenedThisRound) {
    log(G, { kind: 'cinematic-rogue-one-no-retreat', side: rogue.side, payload: { systemId: c.systemId } });
    return false;
  }
  const rescuable = (G.empire.capturedLeaders ?? []).map((cl) => cl.leaderId);
  const markerSources = [...new Set((G.map.systems[c.systemId]?.targetMarkers ?? []).map((m) => m.source))];
  if (rescuable.length === 0 && markerSources.length === 0) {
    log(G, { kind: 'cinematic-rogue-one-no-target', side: rogue.side, payload: { systemId: c.systemId } });
    return false;
  }
  G.pendingChoice = {
    kind: 'RogueOneChoice', side: 'Rebel', systemId: c.systemId, rescuable, markerSources,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'RogueOneChoice', systemId: c.systemId, rescuable: rescuable.length, markers: markerSources.length,
  }});
  return true;
}

/** Targeted deal — assign `amount` damage to the cheapest-to-kill enemy unit
 *  of the target class. Concentrates all damage on a single best target
 *  (RAW: "deal N damage to A capital ship" / "to 1 AT-AT or AT-ST"). */
function resolveTargetDeal(G: GameState, c: CombatState, side: Side, theater: Theater, eff: TargetDealEffect): number {
  const candidates = targetClassUnits(G, c, side, theater, eff.targetClass);
  if (candidates.length === 0) return 0;
  candidates.sort((a, b) => {
    const ra = (G.catalog.unitTypes[a.typeId]?.health.value ?? 0) - a.damage;
    const rb = (G.catalog.unitTypes[b.typeId]?.health.value ?? 0) - b.damage;
    return ra - rb; // most-damaged first → likeliest kill
  });
  const target = candidates[0];
  const dead = M.damageUnit(G, target.instanceId, eff.amount);
  // RoE cinematic: stage for end-of-round destruction rather than destroying
  // now (finalizeTheaterDestructions re-checks, so a heal this round can save).
  if (dead) (c.theaterStaged ??= []).push(target.instanceId);
  return eff.amount;
}

/** Is the chosen ability a targeted-deal (Tow Cables / Ion Blast)? Returns the
 *  effect if so — used by the interactive target-pick path (#290). */
export function targetDealAbilityFor(cardId: string, useTop: boolean): TargetDealEffect | null {
  const abilities = ABILITIES[cardId];
  if (!abilities) return null;
  const ab = useTop ? abilities[0] : abilities[1];
  return ab && ab.kind === 'targetDeal' ? ab : null;
}

/** Is the chosen ability a plain deal-damage (Bombing Run, Rogue Squadron
 *  Support, …)? Returns the effect so the player can choose which enemy unit
 *  takes the hit instead of an auto-pick (#312). */
export function dealAbilityFor(cardId: string, useTop: boolean): DealEffect | null {
  const abilities = ABILITIES[cardId];
  if (!abilities) return null;
  const ab = useTop ? abilities[0] : abilities[1];
  return ab && ab.kind === 'deal' ? ab : null;
}

/** The EFFECTIVE plain-deal for interactive targeting (#570): a plain `deal`
 *  ability, OR a `condDeal` (Swarm Tactics, Bombardment) whose condition
 *  currently holds — both let the playing side choose which enemy unit eats the
 *  damage, just like a plain deal. A condDeal whose condition is NOT met deals
 *  nothing, so it returns null and the auto-resolver logs the 0. Needs the game
 *  context to evaluate the condition, unlike the static dealAbilityFor. */
export function effectiveDealAbilityFor(
  G: GameState, c: CombatState, side: Side, theater: Theater, cardId: string, useTop: boolean,
): DealEffect | null {
  const abilities = ABILITIES[cardId];
  if (!abilities) return null;
  const ab = useTop ? abilities[0] : abilities[1];
  if (!ab) return null;
  if (ab.kind === 'deal') return ab;
  if (ab.kind === 'condDeal' && condHolds(G, c, side, theater, ab.cond)) {
    return { kind: 'deal', amount: ab.amount, color: ab.color };
  }
  return null;
}

/** Legal targets for an interactive plain-deal pick: enemy units whose health
 *  colour matches the deal's colour (or any colour when uncoloured), excluding
 *  the indestructible Death Star (#312). Staged units stay eligible so the
 *  player may pile on extra damage to beat a heal (overdamage, #274). */
export function cinematicDealCandidates(
  G: GameState, c: CombatState, side: Side, theater: Theater, eff: DealEffect,
): string[] {
  return unitsOf(G, other(side), c.systemId, theater).filter((u) => {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.health.color === null) return false; // Death Star: invulnerable
    if (eff.color && t.health.color !== eff.color) return false;
    return true;
  }).map((u) => u.instanceId);
}

/** Is the chosen ability a destroy-without-rolling (Intercept / Hold Them Back /
 *  Support of the 501st / cinematic Target the Generator)? Returns the effect so
 *  the playing side can choose which eligible enemy unit is removed when 2+ are
 *  legal, instead of an auto-pick (#316 audit). */
export function destroyAbilityFor(cardId: string, useTop: boolean): DestroyEffect | null {
  const abilities = ABILITIES[cardId];
  if (!abilities) return null;
  const ab = useTop ? abilities[0] : abilities[1];
  return ab && ab.kind === 'destroy' ? ab : null;
}

/** The selected ability if it's a "gain a triangle ground unit (player's choice)"
 *  gain (Deployment, #497) — used to post a type pick when 2+ types are available.
 *  A fixed-unit gain (Reinforcements → TIE Fighter) returns null. */
export function gainTriangleAbilityFor(cardId: string, useTop: boolean): GainEffect | null {
  const abilities = ABILITIES[cardId];
  if (!abilities) return null;
  const ab = useTop ? abilities[0] : abilities[1];
  return ab && ab.kind === 'gain' && ab.chooseTriangleGround ? ab : null;
}

/** The playing side's triangle ground unit TYPES (Rebel: Trooper, Vanguard) —
 *  the candidates for a "gain 1 triangle ground unit" choice. */
export function cinematicTriangleGroundGainTypes(G: GameState, side: Side): string[] {
  return Object.keys(G.catalog.unitTypes).filter((id) => {
    const t = G.catalog.unitTypes[id];
    return t && t.side === side && t.theater === 'ground' && t.tier === 'triangle';
  });
}

/** Legal targets for an interactive destroy pick (the eligible enemy units). */
export function cinematicDestroyCandidates(
  G: GameState, c: CombatState, side: Side, theater: Theater, eff: DestroyEffect,
): string[] {
  return destroyTargets(G, c, side, theater, eff).map((u) => u.instanceId);
}

/** Record a combat kill made by a cinematic tactic (not dice) into the report's
 *  cardDestructions, so it counts toward destruction-based objectives — Decisive
 *  Victory, Crippling Blow, Liberation, Rebel Assault (player report #383: a
 *  ground battle won purely by a cinematic destroy/deal tactic wasn't registering
 *  as fought). Mirrors combat.ts's destroyViaCombatCard; call BEFORE M.destroyUnit
 *  while the unit is still on the board. */
function recordCinematicKill(G: GameState, c: CombatState, instanceId: string): void {
  const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
  const u = ss?.units.find((x) => x.instanceId === instanceId);
  if (u) (c.report.cardDestructions ??= []).push({ side: u.side, typeId: u.typeId });
}

/** Destroy a player-chosen unit for a cinematic destroy ability. The card has
 *  already been discarded by the caller. */
export function applyChosenDestroy(G: GameState, c: CombatState, instanceId: string): void {
  recordCinematicKill(G, c, instanceId);
  M.destroyUnit(G, instanceId, 'cinematic-destroy');
}

/** Legal targets (enemy AT-AT/AT-ST, capital ship, …) for an interactive
 *  targeted-deal pick — the instanceIds the player may choose among (#290). */
export function cinematicTargetDealCandidates(
  G: GameState, c: CombatState, side: Side, theater: Theater, eff: TargetDealEffect,
): string[] {
  return targetClassUnits(G, c, side, theater, eff.targetClass).map((u) => u.instanceId);
}

/** Apply a player-chosen targeted deal to a specific enemy unit (#290). The
 *  card has already been discarded by the caller. A killed unit is staged for
 *  end-of-round destruction (a heal this round can still save it). */
export function applyChosenTargetDeal(
  G: GameState, c: CombatState, instanceId: string, amount: number,
): void {
  const dead = M.damageUnit(G, instanceId, amount);
  if (dead) (c.theaterStaged ??= []).push(instanceId);
}

/** Destroy-without-rolling — remove 1 eligible enemy unit (smallest health
 *  first, so the card spends its destroy on the cheapest valid target the
 *  AI would otherwise have to roll for). */
function resolveDestroy(G: GameState, c: CombatState, side: Side, theater: Theater, eff: DestroyEffect): string | null {
  const candidates = destroyTargets(G, c, side, theater, eff);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    (G.catalog.unitTypes[a.typeId]?.health.value ?? 0) - (G.catalog.unitTypes[b.typeId]?.health.value ?? 0));
  const target = candidates[0];
  recordCinematicKill(G, c, target.instanceId);
  M.destroyUnit(G, target.instanceId, 'cinematic-destroy');
  return target.typeId;
}

/** Consume the cinematic hit-prevention for `side` in this theatre, returning
 *  the {red,black,special} counts of opponent results to remove at the Assign
 *  Damage step (applied to the rolled dice, NOT a reduction of the roll —
 *  RAW RotE "PREVENTING HITS"). Zeroes the accumulator so it only applies once. */
export function takeCinematicPrevent(c: CombatState, side: Side): { red: number; black: number; special: number } {
  const v = c.cinematicPrevent?.[side];
  if (!v) return { red: 0, black: 0, special: 0 };
  c.cinematicPrevent![side] = { red: 0, black: 0, special: 0 };
  return v;
}
