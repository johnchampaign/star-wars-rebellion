// Bundle of card-effect handler registrations. Import once at engine boot.
// Each handler is small; complex multi-stage cards live in their own files
// under handlers/ as the scope grows.

import type { GameState } from '../types';
import * as M from '../mechanics';
import { register, type EffectHandler } from './registry';
import { beginCombat, runCombat } from '../combat';
import { notImplemented, log } from '../log';
import { shuffle, nextInt } from '../rng';

/** Resolve a combat at `sysId` initiated by `attackerSide`. Used by mission
 *  effects that spawn units and then "resolve a combat" (Ignite Rebellion,
 *  Public Uprising). No-ops if both sides aren't present. */
function triggerCombatAt(G: GameState, attackerSide: 'Rebel' | 'Empire', sysId: string): void {
  if (G.pendingCombat) return;
  beginCombat(G, attackerSide, sysId, sysId);
  runCombat(G);
}

// ============================================================================
// Helpers (used across handlers)
// ============================================================================

function totalHealthInSystem(G: GameState, side: 'Rebel' | 'Empire', sysId: string, theater?: 'space' | 'ground'): number {
  const ss = sysId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[sysId];
  if (!ss) return 0;
  return ss.units
    .filter((u) => u.side === side)
    .filter((u) => !theater || G.catalog.unitTypes[u.typeId]?.theater === theater)
    .reduce((sum, u) => {
      const t = G.catalog.unitTypes[u.typeId];
      return sum + (t?.health.value ?? 0);
    }, 0);
}

/** Destroy up to N health worth of opponent units in a system. Auto-picks
 *  the cheapest valid combination (smaller units first). Real game lets the
 *  attacker choose — wire a ChoiceRequest later. */
function destroyUpToHealthAuto(G: GameState, opponentSide: 'Rebel' | 'Empire', sysId: string, healthBudget: number, theater?: 'space' | 'ground'): number {
  const ss = sysId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[sysId];
  if (!ss) return 0;
  // Sort high-value first (square > circle > triangle), then high-health (more
  // expensive to replace). This makes Hunt Them Down / Hit And Run actually
  // hurt: kill 1 Star Destroyer instead of 2 TIE Fighters when budget allows.
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  const candidates = ss.units
    .filter((u) => u.side === opponentSide)
    .filter((u) => !theater || G.catalog.unitTypes[u.typeId]?.theater === theater)
    .sort((a, b) => {
      const ta = G.catalog.unitTypes[a.typeId];
      const tb = G.catalog.unitTypes[b.typeId];
      const tierA = tierRank[ta?.tier ?? 'triangle'] ?? 0;
      const tierB = tierRank[tb?.tier ?? 'triangle'] ?? 0;
      if (tierA !== tierB) return tierB - tierA;       // higher tier first
      const ha = ta?.health.value ?? 0;
      const hb = tb?.health.value ?? 0;
      return hb - ha;                                   // higher health first
    });
  let spent = 0;
  for (const u of candidates) {
    const h = G.catalog.unitTypes[u.typeId]?.health.value ?? 0;
    if (spent + h > healthBudget) continue;
    M.destroyUnit(G, u.instanceId, 'mission-effect');
    spent += h;
    if (G.isGameOver) break;
  }
  return spent;
}

/** Sum of skill icons + tactic dice — a rough "value" heuristic for leaders. */
function leaderValue(G: GameState, leaderId: string): number {
  const ld = G.catalog.leaders[leaderId];
  if (!ld) return 0;
  const sk = ld.skills;
  return (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0)
       + ld.tacticValues.space + ld.tacticValues.ground;
}

// ============================================================================
// Mission handlers
// ============================================================================

// ----- Rebel starting -----

const sabotage: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const ss = G.map.systems[sysId];
  if (!ss) return true;
  if (!ss.sabotage) {
    ss.sabotage = true;
  }
  return true;
};

const buildAlliance: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  M.gainLoyalty(G, 'Rebel', sysId, 1);
  return true;
};

const infiltration: EffectHandler = (G, ctx) => {
  // Look at top 2 of objective deck; pause for the Rebel to pick which one
  // stays on top vs goes to the bottom. (Engine paused via G.pendingChoice;
  // resumeMission runs after the player resolves the choice.)
  if (!G.rebel.objectiveDeck || G.rebel.objectiveDeck.length < 2) {
    log(G, { kind: 'objective-peek', side: 'Rebel', payload: {
      kept: null, bottomed: null, note: 'fewer than 2 cards in deck',
    }});
    return true;
  }
  const a = G.rebel.objectiveDeck.shift()!;
  const b = G.rebel.objectiveDeck.shift()!;
  G.pendingChoice = { kind: 'InfiltrationPick', missionId: ctx.card.id, topId: a, bottomId: b };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: { kind: 'InfiltrationPick', candidates: [a, b] } });
  return true;
};

const rapidMobilization: EffectHandler = (G, _ctx) => {
  notImplemented(G, 'mission:rapid-mobilization',
    'Rapid Mobilization not implemented',
    'Should let you choose: move up to 5 units to Rebel Base space, OR establish a new base. ' +
    'Needs end-of-phase choice infrastructure. Mission still discards.');
  return true;
};

// ----- Imperial starting -----

const captureRebelOperative: EffectHandler = (G, ctx) => {
  // "Capture a Rebel leader in a system that contains an Imperial unit."
  // Target system contains the Rebel leader; capture the highest-value one
  // at that system. (captureLeader records where the leader was — required
  // for the captured-leader-stays-at-a-system model.)
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const here = G.rebel.leadersOnBoard[sysId] ?? [];
  if (here.length === 0) return true;
  let best = here[0];
  let bestV = leaderValue(G, best);
  for (const lid of here.slice(1)) {
    const v = leaderValue(G, lid);
    if (v > bestV) { best = lid; bestV = v; }
  }
  M.captureLeader(G, best, 'captured');
  return true;
};

const gatherIntel: EffectHandler = (G, ctx) => {
  // Draw 1 probe card per 4 Rebel units at the Rebel base (min 1).
  const base = G.rebelBaseRevealed ? G.map.systems[G.rebelBaseSystemId] : G.map.rebelBaseSpace;
  const rebelUnits = base?.units.filter((u) => u.side === 'Rebel').length ?? 0;
  const n = Math.max(1, Math.floor(rebelUnits / 4));
  M.drawProbe(G, n);
  return true;
};

const researchAndDevelopment: EffectHandler = (G, ctx) => {
  // Two options: (a) Draw 2 project cards, keep 1, bottom the other.
  //              (b) Remove sabotage marker from this system and draw 1.
  // Auto: take (b) if THIS system has a sabotage marker (high-value cleanup);
  // otherwise (a).
  if (!G.empire.projectDeck) return true;
  const sysId = ctx.targetSystemId;
  const ss = sysId ? G.map.systems[sysId] : null;
  if (ss?.sabotage) {
    ss.sabotage = false;
    const drawn = G.empire.projectDeck.shift();
    if (drawn) G.empire.missionHand.push(drawn);
    return true;
  }
  const a = G.empire.projectDeck.shift();
  const b = G.empire.projectDeck.shift();
  if (a) G.empire.missionHand.push(a);
  if (b) G.empire.projectDeck.push(b);
  return true;
};

const ruleByFear: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  M.gainLoyalty(G, 'Empire', sysId, 1);
  return true;
};

// ----- Imperial projects -----

const constructDeathStar: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  // Place DSUC in the system, Death Star on space 3 of build queue.
  M.deployUnit(G, 'Empire', 'death-star-under-construction', sysId);
  M.buildToQueue(G, 'Empire', 'death-star', 3);
  return true;
};

const constructFactory: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  // "Place units on the build queue using this system's resource icons and number."
  const sysDef = G.catalog.systems[sysId];
  const ss = G.map.systems[sysId];
  if (!sysDef || !ss) return true;
  if (ss.sabotage) ss.sabotage = false; // sabotage removed before resolving
  const slot = (sysDef.buildSlot ?? 1) as 1 | 2 | 3;
  for (const icon of sysDef.resources) {
    const choice = defaultUnitForIcon('Empire', icon.type, icon.shape);
    if (choice) M.buildToQueue(G, 'Empire', choice, slot);
  }
  return true;
};

const constructSuperStarDestroyer: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  M.buildToQueue(G, 'Empire', 'super-star-destroyer', 3);
  return true;
};

const overseeProject: EffectHandler = (G, ctx) => {
  // Choose 1 Empire unit on space 1 or 2 of the build queue; deploy here.
  // Auto: pick the *most valuable* unit available (square > circle > triangle),
  // preferring earlier slots (slot 1 then slot 2) so we don't leave a built
  // unit sitting if we have a less-developed one in slot 2.
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const q = G.empire.buildQueue;
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  for (const slot of [1, 2] as const) {
    if (q[slot].length === 0) continue;
    let bestIdx = 0;
    let bestRank = -1;
    for (let i = 0; i < q[slot].length; i++) {
      const t = G.catalog.unitTypes[q[slot][i]];
      const r = tierRank[t?.tier ?? 'triangle'] ?? 0;
      if (r > bestRank) { bestRank = r; bestIdx = i; }
    }
    const typeId = q[slot].splice(bestIdx, 1)[0];
    M.deployUnit(G, 'Empire', typeId, sysId);
    return true;
  }
  return true;
};

const superlaserOnline: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  M.destroySystem(G, sysId);
  if (G.isGameOver) return true;
  // Gain 1 loyalty in 1 populous system in this region.
  const sysDef = G.catalog.systems[sysId];
  if (!sysDef) return true;
  for (const other of Object.values(G.catalog.systems)) {
    if (other.region === sysDef.region && !other.isRemote && !other.isCoruscant && other.id !== sysId) {
      M.gainLoyalty(G, 'Empire', other.id, 1);
      break;
    }
  }
  return true;
};

// ----- Common Imperial -----

const tradeNegotiations: EffectHandler = (G, ctx) => {
  if (!ctx.targetSystemId) return true;
  M.gainLoyalty(G, 'Empire', ctx.targetSystemId, 1);
  return true;
};

const fearWillKeepThemInLine: EffectHandler = (G, ctx) => {
  // "If successful, gain 1 loyalty in 2 systems in this region."
  // The 2 systems CAN include the target system itself (rules clarification).
  // Auto: prefer systems where gain-loyalty actually does something —
  // non-Imperial-loyal, non-subjugated, non-Coruscant, non-remote — in the
  // same region as the target.
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const targetDef = G.catalog.systems[sysId];
  if (!targetDef) return true;
  const region = targetDef.region;
  const candidates = Object.values(G.catalog.systems)
    .filter((s) => s.region === region)
    .filter((s) => !s.isCoruscant && !s.isRemote)
    .map((s) => s.id);
  // Score: useful (non-Imperial-loyal) systems first.
  const useful = candidates.filter((id) => {
    const ss = G.map.systems[id];
    return ss && ss.loyalty !== 'imperial' && !ss.subjugated;
  });
  const fallback = candidates.filter((id) => !useful.includes(id));
  const picks = [...useful, ...fallback].slice(0, 2);
  for (const id of picks) M.gainLoyalty(G, 'Empire', id, 1);
  return true;
};

const displayOfPower: EffectHandler = (G, ctx) => {
  if (!ctx.targetSystemId) return true;
  M.gainLoyalty(G, 'Empire', ctx.targetSystemId, 2);
  return true;
};

// ----- More Imperial handlers --------------------------------------------

/** "Resolve in any Imperial system. Place units on the build queue using this
 *  system's resource icons and number." (Same pattern as Construct Factory.) */
const addressDelays: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const sysDef = G.catalog.systems[sysId];
  const ss = G.map.systems[sysId];
  if (!sysDef || !ss) return true;
  const slot = (sysDef.buildSlot ?? 1) as 1 | 2 | 3;
  for (const icon of sysDef.resources) {
    const choice = defaultUnitForIcon('Empire', icon.type, icon.shape);
    if (choice) M.buildToQueue(G, 'Empire', choice, slot);
  }
  return true;
};

/** Draw 2 project cards. */
const secretWeaponsResearch: EffectHandler = (G, _ctx) => {
  for (let i = 0; i < 2; i++) {
    const card = G.empire.projectDeck?.shift();
    if (card) G.empire.missionHand.push(card);
  }
  return true;
};

/** "Draw 2 cards from the probe deck. If Admiral Ozzel resolves this mission,
 *  draw 2 additional cards." */
const probeDroidInitiative: EffectHandler = (G, ctx) => {
  const hasOzzel = ctx.leaderIds.includes('admiral-ozzel');
  M.drawProbe(G, hasOzzel ? 4 : 2);
  return true;
};

/** "Each system in this region that has Rebel loyalty becomes neutral." */
const imperialPropaganda: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const targetDef = G.catalog.systems[sysId];
  if (!targetDef) return true;
  for (const other of Object.values(G.catalog.systems)) {
    if (other.region !== targetDef.region) continue;
    const ss = G.map.systems[other.id];
    if (ss && ss.loyalty === 'rebel') {
      ss.loyalty = 'neutral';
      log(G, { kind: 'remove-loyalty', side: 'Empire', payload: { systemId: other.id, via: 'imperial-propaganda' } });
    }
  }
  return true;
};

/** "If successful, the Rebel player must tell you if the Rebel base is in
 *  this system." Logs the answer (hidden-info gap is acceptable in hot-seat). */
const longRangeProbe: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const isBase = G.rebelBaseSystemId === sysId;
  log(G, { kind: 'probe-result', side: 'Empire', payload: {
    systemId: sysId, isBase, source: 'long-range-probe',
  }});
  return true;
};

/** "Destroy up to 4 health worth of units of your choice on the build queue."
 *  Priority: high-tier (square > circle > triangle), then high-health. */
const rogueSquadronRaid: EffectHandler = (G, _ctx) => {
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  type Item = { slot: 1 | 2 | 3; idx: number; typeId: string; health: number; tier: number };
  const items: Item[] = [];
  for (const slot of [1, 2, 3] as const) {
    for (let i = 0; i < G.empire.buildQueue[slot].length; i++) {
      const t = G.catalog.unitTypes[G.empire.buildQueue[slot][i]];
      if (!t) continue;
      items.push({ slot, idx: i, typeId: G.empire.buildQueue[slot][i], health: t.health.value, tier: tierRank[t.tier] ?? 0 });
    }
  }
  items.sort((a, b) => b.tier - a.tier || b.health - a.health);
  let spent = 0;
  const toRemove: Item[] = [];
  for (const it of items) {
    if (spent + it.health > 4) continue;
    toRemove.push(it);
    spent += it.health;
  }
  // Splice in reverse index per slot to keep indices stable.
  toRemove.sort((a, b) => a.slot - b.slot || b.idx - a.idx);
  for (const it of toRemove) {
    G.empire.buildQueue[it.slot].splice(it.idx, 1);
    log(G, { kind: 'build-queue-destroy', side: 'Rebel', payload: { slot: it.slot, typeId: it.typeId, via: 'rogue-squadron-raid' } });
  }
  return true;
};

/** "Choose 1 unit on space 2 or 3 of the build queue and move it down 1 space.
 *  If Moff Jerjerrod resolves this mission, you can choose 1 additional unit." */
const doubleOurEfforts: EffectHandler = (G, ctx) => {
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  const hasJerjerrod = ctx.leaderIds.includes('moff-jerjerrod');
  const moves = hasJerjerrod ? 2 : 1;
  const q = G.empire.buildQueue;
  for (let m = 0; m < moves; m++) {
    let moved = false;
    for (const fromSlot of [2, 3] as const) {
      if (q[fromSlot].length === 0) continue;
      let bestIdx = 0;
      let bestRank = -1;
      for (let i = 0; i < q[fromSlot].length; i++) {
        const t = G.catalog.unitTypes[q[fromSlot][i]];
        const r = tierRank[t?.tier ?? 'triangle'] ?? 0;
        if (r > bestRank) { bestRank = r; bestIdx = i; }
      }
      const typeId = q[fromSlot].splice(bestIdx, 1)[0];
      const toSlot = (fromSlot - 1) as 1 | 2;
      q[toSlot].push(typeId);
      log(G, { kind: 'build-queue-advance', side: 'Empire', payload: { typeId, fromSlot, toSlot, via: 'double-our-efforts' } });
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return true;
};

/** "Move up to 1 AT-AT, 1 AT-ST and 2 Stormtroopers from any one system to
 *  this system, ignoring transport restrictions and adjacency. If there are
 *  Rebel ground units in this system, resolve a combat." */
const planetaryConquest: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const limits: Record<string, number> = { 'at-at': 1, 'at-st': 1, 'stormtrooper': 2 };
  let best: { srcId: string; picks: string[] } | null = null;
  for (const [otherSysId, ss] of Object.entries(G.map.systems)) {
    if (otherSysId === sysId) continue;
    const counts: Record<string, number> = {};
    const picks: string[] = [];
    for (const u of ss.units) {
      if (u.side !== 'Empire') continue;
      if (!(u.typeId in limits)) continue;
      const c = counts[u.typeId] ?? 0;
      if (c >= limits[u.typeId]) continue;
      picks.push(u.instanceId);
      counts[u.typeId] = c + 1;
    }
    if (!best || picks.length > best.picks.length) best = { srcId: otherSysId, picks };
  }
  if (best && best.picks.length > 0) {
    for (const uid of best.picks) M.moveUnit(G, uid, best.srcId, sysId);
  }
  triggerCombatAt(G, 'Empire', sysId);
  return true;
};

/** "Hidden-info: Empire learns Rebel's hand of objective cards." In our hot-seat
 *  model the hands aren't truly hidden — we just log them. */
const interrogation: EffectHandler = (G, _ctx) => {
  const hand = G.rebel.objectiveHand ?? [];
  log(G, { kind: 'interrogation-reveal', side: 'Empire', payload: { objectives: [...hand] } });
  return true;
};

/** "Capture that leader. Then move both that leader and this leader to the
 *  closest system that contains an Imperial unit." Auto: capture; move skipped
 *  (closest-system + leader-relocation needs more infra). */
const collectBounty: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const rebelHere = G.rebel.leadersOnBoard[sysId] ?? [];
  if (rebelHere.length === 0) return true;
  // Capture the most valuable Rebel leader here.
  let best: { lid: string; v: number } | null = null;
  for (const lid of rebelHere) {
    const v = leaderValue(G, lid);
    if (!best || v > best.v) best = { lid, v };
  }
  if (best) M.captureLeader(G, best.lid, 'captured');
  notImplemented(G, 'mission:collect-bounty-move',
    'Collect Bounty — relocation skipped',
    'Captured the leader. Relocation of attacker+captive to the closest Imperial-occupied system is not implemented yet.');
  return true;
};

// ----- More Rebel handlers ------------------------------------------------

/** "Move units from the 'Rebel Base' space to this system as if they were
 *  adjacent. Leaders in the 'Rebel Base' space do not prevent this." */
const hiddenFleet: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const units = [...G.map.rebelBaseSpace.units];
  for (const u of units) M.moveUnit(G, u.instanceId, 'rebel-base-space', sysId);
  return true;
};

/** "Move up to 4 ground units from the 'Rebel Base' space to this system,
 *  ignoring transport restriction and adjacency. If there are Imperial ground
 *  units in this system, resolve a combat." */
const leadTheStrikeTeam: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const baseGround = G.map.rebelBaseSpace.units
    .filter((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')
    .slice(0, 4);
  for (const u of baseGround) M.moveUnit(G, u.instanceId, 'rebel-base-space', sysId);
  triggerCombatAt(G, 'Rebel', sysId);
  return true;
};

/** "Attempt in the Kashyyyk system. Gain 1 loyalty in this system and destroy
 *  up to 4 health worth of units of your choice in this system." */
const wookieUprising: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  M.gainLoyalty(G, 'Rebel', sysId, 1);
  destroyUpToHealthAuto(G, 'Empire', sysId, 4);
  return true;
};

/** "If successful, gain 1 loyalty in the system and place units on the build
 *  queue using this system's resource icons and number." */
const establishTradeRelations: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  M.gainLoyalty(G, 'Rebel', sysId, 1);
  const sysDef = G.catalog.systems[sysId];
  const ss = G.map.systems[sysId];
  if (!sysDef || !ss) return true;
  const slot = (sysDef.buildSlot ?? 1) as 1 | 2 | 3;
  for (const icon of sysDef.resources) {
    const choice = defaultUnitForIcon('Rebel', icon.type, icon.shape);
    if (choice) M.buildToQueue(G, 'Rebel', choice, slot);
  }
  return true;
};

/** "Rescue that leader and draw 1 objective card. The leader(s) assigned to
 *  this mission remain in this system." */
const forTheGreaterGood: EffectHandler = (G, ctx) => {
  // Target = captured leader's system. Rescue that leader + draw 1 objective.
  const sysId = ctx.targetSystemId;
  const cap = (G.empire.capturedLeaders ?? []).find((c) => !sysId || c.systemId === sysId);
  if (cap) M.rescueLeader(G, cap.leaderId, 'for-the-greater-good');
  M.drawObjective(G, 1);
  return true;
};

/** "Rebel player draws 8 from probe deck. He gives you all cards belonging to
 *  systems that contain an Imperial unit. Then he shuffles the rest back." */
const interceptTransmissions: EffectHandler = (G, _ctx) => {
  const drawn = G.probeDeck.splice(0, 8);
  const givenToEmpire: string[] = [];
  const reshuffle: string[] = [];
  for (const probeId of drawn) {
    const probe = G.catalog.probes[probeId];
    if (!probe) { reshuffle.push(probeId); continue; }
    const ss = G.map.systems[probe.systemId];
    if (ss?.units.some((u) => u.side === 'Empire')) givenToEmpire.push(probeId);
    else reshuffle.push(probeId);
  }
  log(G, { kind: 'intercept-transmissions', side: 'Rebel', payload: {
    drawn: drawn.length, givenToEmpire: [...givenToEmpire], reshuffled: reshuffle.length,
  }});
  G.probeDeck.push(...reshuffle);
  shuffle(G.rng, G.probeDeck);
  // Empire keeps the "given" probes (effectively removed from play; Empire
  // knows those systems don't contain the base).
  return true;
};

/** "Rescue captured leader. Rebel must place leader in any system in Rebel
 *  base's region." Auto: random in-region non-Coruscant system. */
const homingBeacon: EffectHandler = (G, ctx) => {
  // Target = the captured leader's system. Rescue that leader; Rebel must
  // place them in any system in the Rebel base's region (auto-picked).
  const sysId = ctx.targetSystemId;
  if (!G.empire.capturedLeaders || G.empire.capturedLeaders.length === 0) return true;
  const candidates = G.empire.capturedLeaders.filter((c) => !sysId || c.systemId === sysId);
  if (candidates.length === 0) return true;
  let best = candidates[0];
  let bestV = leaderValue(G, best.leaderId);
  for (const c of candidates.slice(1)) {
    const v = leaderValue(G, c.leaderId);
    if (v > bestV) { best = c; bestV = v; }
  }
  M.rescueLeader(G, best.leaderId, 'homing-beacon');
  const baseDef = G.catalog.systems[G.rebelBaseSystemId];
  if (!baseDef) return true;
  const inRegion = Object.values(G.catalog.systems)
    .filter((s) => s.region === baseDef.region && !s.isCoruscant)
    .map((s) => s.id);
  if (inRegion.length > 0) {
    const place = inRegion[nextInt(G.rng, inRegion.length)];
    M.placeLeader(G, 'Rebel', best.leaderId, place);
    log(G, { kind: 'note', payload: { msg: `homing-beacon: revealed Rebel base region (${baseDef.region}) by placing ${best.leaderId} at ${place}` } });
  }
  return true;
};

/** "Take 4 random probe cards. Place on top and/or bottom of the deck." Auto:
 *  take 4 random, all to the bottom (worst for Empire). */
const plantFalseLead: EffectHandler = (G, _ctx) => {
  if (G.probeDeck.length === 0) return true;
  const n = Math.min(4, G.probeDeck.length);
  const taken: string[] = [];
  for (let k = 0; k < n; k++) {
    const i = nextInt(G.rng, G.probeDeck.length);
    taken.push(G.probeDeck.splice(i, 1)[0]);
  }
  G.probeDeck.push(...taken);
  log(G, { kind: 'plant-false-lead', side: 'Rebel', payload: { moved: n, placed: 'bottom' } });
  return true;
};

// ----- Hard / leader-attachment / hidden-info — stubs ---------------------

const carbonFreezing: EffectHandler = (G, ctx) => {
  // Per RR: attach the carbonite ring to a captured leader (replacing their
  // normal captured ring). The freed 'captured' ring slot lets Empire capture
  // another leader in the future. Rebel loses 1 reputation.
  const sysId = ctx.targetSystemId;
  if (!G.empire.capturedLeaders || G.empire.capturedLeaders.length === 0) return true;
  const candidates = G.empire.capturedLeaders.filter((c) =>
    (!sysId || c.systemId === sysId) && c.ring === 'captured');
  if (candidates.length > 0) {
    let best = candidates[0];
    let bestV = leaderValue(G, best.leaderId);
    for (const c of candidates.slice(1)) {
      const v = leaderValue(G, c.leaderId);
      if (v > bestV) { best = c; bestV = v; }
    }
    best.ring = 'carbonite';
    log(G, { kind: 'carbonite-applied', payload: { leaderId: best.leaderId, systemId: best.systemId } });
  }
  M.loseReputation(G, 1);
  return true;
};

const seekYoda: EffectHandler = (G, ctx) => {
  // Attach the Master Yoda ring to the leader resolving this mission. If Luke
  // Skywalker resolved it, also replace him with Luke Skywalker (Jedi).
  const sysId = ctx.targetSystemId;
  // Pick the leader to attach the ring to: the first assigned leader.
  const ringHolder = ctx.leaderIds[0];
  if (ringHolder) M.attachRing(G, ringHolder, 'yoda');
  // Luke → Luke-Jedi swap.
  if (ctx.leaderIds.includes('luke-skywalker')) {
    // Remove plain Luke from wherever he is, add Luke-Jedi to the same place.
    // We just placed him at the target system on reveal.
    const here = G.rebel.leadersOnBoard[sysId ?? ''] ?? [];
    const i = here.indexOf('luke-skywalker');
    if (i >= 0) {
      here.splice(i, 1);
      here.push('luke-skywalker-jedi');
      // Transfer the Yoda ring from Luke to Luke-Jedi for consistency.
      if (M.hasAttachment(G, 'luke-skywalker', 'yoda')) {
        M.removeAttachment(G, 'luke-skywalker', 'yoda');
        M.attachRing(G, 'luke-skywalker-jedi', 'yoda');
      }
      log(G, { kind: 'leader-replaced', side: 'Rebel', payload: { from: 'luke-skywalker', to: 'luke-skywalker-jedi' } });
    }
  }
  return true;
};

const lureOfTheDarkSide: EffectHandler = (G, ctx) => {
  // Target must be a captured Rebel leader AT the target system. Flip them.
  // If the target was Luke Skywalker, the Rebel loses 1 reputation.
  const sysId = ctx.targetSystemId;
  if (!G.empire.capturedLeaders || G.empire.capturedLeaders.length === 0) return true;
  const candidates = G.empire.capturedLeaders.filter((c) => (!sysId || c.systemId === sysId)
    && !M.hasAttachment(G, c.leaderId, 'dark-side'));
  if (candidates.length === 0) return true;
  let best = candidates[0];
  let bestV = leaderValue(G, best.leaderId);
  for (const c of candidates.slice(1)) {
    const v = leaderValue(G, c.leaderId);
    if (v > bestV) { best = c; bestV = v; }
  }
  const ok = M.flipLeaderToImperial(G, best.leaderId);
  if (ok && best.leaderId === 'luke-skywalker') M.loseReputation(G, 1);
  return true;
};

const interrogationDroid: EffectHandler = (G, _ctx) => {
  notImplemented(G, 'mission:interrogation-droid',
    'Interrogation Droid not implemented',
    'Should force the Rebel to name 3 systems, one of which contains the base. Needs Rebel-driven choice UI.');
  return true;
};

const retrieveThePlans: EffectHandler = (G, _ctx) => {
  notImplemented(G, 'mission:retrieve-the-plans',
    'Retrieve The Plans not implemented',
    'Should let Empire view the Rebel objective hand and bottom one of those cards. Needs hidden-info + Empire-driven pick UI.');
  return true;
};

const contingencyPlan: EffectHandler = (G, _ctx) => {
  notImplemented(G, 'mission:contingency-plan',
    'Contingency Plan not implemented',
    'Should re-assign this leader to a starting mission from hand, including ones already attempted/resolved this round. Needs intra-phase reassignment infra.');
  return true;
};

const misdirection: EffectHandler = (G, ctx) => {
  // Choose 1 of your leaders. Imperial leaders in the leader pool cannot be
  // sent to oppose that leader's missions this round.
  // Auto: protect the resolving leader (the one who did this mission).
  const target = ctx.leaderIds[0];
  if (!target) return true;
  if (!G.misdirectionProtected) G.misdirectionProtected = [];
  if (!G.misdirectionProtected.includes(target)) G.misdirectionProtected.push(target);
  log(G, { kind: 'misdirection-set', side: 'Rebel', payload: { leaderId: target } });
  // NOTE: today's opposition flow only counts leaders already at the target
  // system; pool-recruit opposition isn't wired. Once it lands, it must
  // honour `misdirectionProtected` and skip pool draws against listed leaders.
  notImplemented(G, 'mission:misdirection-enforcement',
    'Misdirection — protection set, enforcement pending',
    "The 'pool leaders can't oppose' flag is set. Once pool-recruit opposition is wired up, it will honour this flag.");
  return true;
};

const huntThemDown: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  destroyUpToHealthAuto(G, 'Rebel', sysId, 2);
  return true;
};

const detained: EffectHandler = (G, _ctx) => {
  notImplemented(G, 'mission:detained',
    'Detained not implemented',
    'Should prevent the target Rebel leader from returning to pool next refresh. ' +
    'Needs a per-leader "detained" flag.');
  return true;
};

// ----- Common Rebel -----

const hitAndRun: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  destroyUpToHealthAuto(G, 'Empire', sysId, 2);
  return true;
};

const demolition: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const sysDef = G.catalog.systems[sysId];
  if (!sysDef) return true;
  // For each resource icon, destroy 1 matching unit from Empire's build queue.
  for (const icon of sysDef.resources) {
    for (const slot of [1, 2, 3] as const) {
      const idx = G.empire.buildQueue[slot].findIndex((typeId) => {
        const u = G.catalog.unitTypes[typeId];
        return u?.theater === icon.type;
      });
      if (idx >= 0) {
        const removed = G.empire.buildQueue[slot].splice(idx, 1)[0];
        // Log via a generic mechanism would be nice; skip for now.
        break;
      }
    }
  }
  return true;
};

const baseDefenses: EffectHandler = (G, _ctx) => {
  M.deployUnit(G, 'Rebel', 'ion-cannon', 'rebel-base-space');
  M.deployUnit(G, 'Rebel', 'shield-generator', 'rebel-base-space');
  return true;
};

const inciteRebellion: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  // Gain 3 Rebel Troopers and then resolve combat in this system.
  for (let i = 0; i < 3; i++) M.gainUnit(G, 'Rebel', 'rebel-trooper', sysId);
  triggerCombatAt(G, 'Rebel', sysId);
  return true;
};

const supportOfMonCalamari: EffectHandler = (G, _ctx) => {
  // Either gain 2 loyalty in Mon Calamari or place 1 Mon Cala Cruiser on
  // space 3 of the build queue. Auto: gain loyalty if Mon Cala isn't already
  // Rebel-loyal (more useful — flips/locks the system); otherwise build the
  // cruiser (the loyalty option would be a no-op).
  const monCala = G.map.systems['mon-calamari'];
  const alreadyRebel = monCala?.loyalty === 'rebel' && !monCala.subjugated;
  if (!alreadyRebel) {
    M.gainLoyalty(G, 'Rebel', 'mon-calamari', 2);
  } else {
    M.buildToQueue(G, 'Rebel', 'mon-cala-cruiser', 3);
  }
  return true;
};

const publicUprising: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  // "Gain 1 circle and 2 triangle units (ships and/or ground units)."
  // Auto: match the gain to the upcoming combat — if Empire's at this system,
  // pick units that can fight them. If only Empire ships → ships. If only
  // Empire ground → ground. Default mix otherwise.
  const ss = G.map.systems[sysId];
  let empireSpace = 0, empireGround = 0;
  if (ss) {
    for (const u of ss.units) {
      if (u.side !== 'Empire') continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (t?.theater === 'space') empireSpace++;
      else if (t?.theater === 'ground') empireGround++;
    }
  }
  // Circle pick (1):
  //   Mostly-ground threat → airspeeder (circle ground)
  //   Otherwise → corellian-corvette (circle space)
  const circle = empireGround > empireSpace ? 'airspeeder' : 'corellian-corvette';
  // Triangle pick (2):
  //   All-space threat → 2 x-wings (triangle space)
  //   Otherwise → 2 rebel-troopers (triangle ground)
  const triangle = (empireSpace > 0 && empireGround === 0) ? 'x-wing' : 'rebel-trooper';
  M.gainUnit(G, 'Rebel', circle, sysId);
  M.gainUnit(G, 'Rebel', triangle, sysId);
  M.gainUnit(G, 'Rebel', triangle, sysId);
  triggerCombatAt(G, 'Rebel', sysId);
  return true;
};

const dailyRescueGroup: EffectHandler = (G, ctx) => {
  // Daring Rescue: rescue the captured leader at the target system.
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const cap = (G.empire.capturedLeaders ?? []).find((c) => c.systemId === sysId);
  if (cap) M.rescueLeader(G, cap.leaderId, 'daring-rescue');
  return true;
};

const planTheAssault: EffectHandler = (G, ctx) => {
  // "Move ships (but not ground units) from the Rebel Base space to this
  // system as if they were adjacent. Then resolve a combat in this system."
  // We queue a ship-selection choice; the resolver moves the picks then
  // kicks off combat via combat.beginCombat.
  const targetSystemId = ctx.targetSystemId;
  if (!targetSystemId) return true;
  const baseUnits = G.map.rebelBaseSpace.units;
  const availableShips = baseUnits
    .filter((u) => {
      if (u.side !== 'Rebel') return false;
      const t = G.catalog.unitTypes[u.typeId];
      return t?.theater === 'space';
    })
    .map((u) => u.instanceId);
  if (availableShips.length === 0) {
    // No ships to send — mission resolves without combat.
    log(G, { kind: 'plan-the-assault-no-ships', side: 'Rebel', payload: { targetSystemId } });
    return true;
  }
  G.pendingChoice = {
    kind: 'PlanTheAssaultShips',
    side: 'Rebel',
    targetSystemId,
    availableShipIds: availableShips,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'PlanTheAssaultShips', targetSystemId, available: availableShips.length,
  }});
  return true;
};

const stolenPlans: EffectHandler = (G, ctx) => {
  // Look at top 4 objective cards; pause for the Rebel to pick the order
  // they go back on top.
  if (!G.rebel.objectiveDeck || G.rebel.objectiveDeck.length === 0) return true;
  const n = Math.min(4, G.rebel.objectiveDeck.length);
  const drawn = G.rebel.objectiveDeck.splice(0, n);
  if (drawn.length === 1) {
    // No reordering possible; just put back.
    G.rebel.objectiveDeck.unshift(drawn[0]);
    return true;
  }
  G.pendingChoice = {
    kind: 'StolenPlansReorder',
    missionId: ctx.card.id,
    remaining: drawn,
    orderedTop: [],
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'StolenPlansReorder', count: drawn.length,
  }});
  return true;
};

const covertOperation: EffectHandler = (G, ctx) => {
  // Draw 2 objective cards; keep 1 (into hand), place the other on the
  // bottom. The player picks which card to keep — pause for a choice.
  const deck = G.rebel.objectiveDeck;
  if (!deck || deck.length === 0) return true;
  if (deck.length === 1) {
    // Only 1 card left — just take it, no choice possible.
    const only = deck.shift()!;
    G.rebel.objectiveHand!.push(only);
    log(G, { kind: 'objective-draw-only', side: 'Rebel', payload: { cardId: only } });
    return true;
  }
  const a = deck.shift()!;
  const b = deck.shift()!;
  G.pendingChoice = {
    kind: 'CovertOperationPick',
    missionId: ctx.card.id,
    drawnIds: [a, b],
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'CovertOperationPick', candidates: [a, b],
  }});
  return true;
};

// ============================================================================
// Defaults / helpers
// ============================================================================

function defaultUnitForIcon(side: 'Rebel' | 'Empire', type: 'space' | 'ground', shape: 'triangle' | 'circle' | 'square'): string | null {
  if (side === 'Rebel') {
    if (type === 'ground') return 'rebel-trooper';
    if (shape === 'square') return 'mon-cala-cruiser';
    if (shape === 'circle') return 'corellian-corvette';
    return 'x-wing';
  } else {
    if (type === 'ground') {
      if (shape === 'square') return 'at-at';
      if (shape === 'circle') return 'at-st';
      return 'stormtrooper';
    }
    if (shape === 'square') return 'star-destroyer';
    if (shape === 'circle') return 'assault-carrier';
    return 'tie-fighter';
  }
}

// ============================================================================
// Tactic card handlers
// ============================================================================

// Most tactic cards have effects that apply during attack resolution or
// damage application. Until the combat sub-machine exposes the necessary
// hooks (ApplyTacticCard mid-attack), these handlers are stubs that get
// looked up but don't yet alter combat math. Real implementation comes
// with the combat-action ChoiceRequest plumbing.

const tacticConcentrateFire: EffectHandler = () => true;        // reroll up to 2 dice
const tacticCriticalHit: EffectHandler = () => true;            // deal 1 damage
const tacticDefensiveFormation: EffectHandler = () => true;     // block 1
const tacticBrilliantStrategy: EffectHandler = () => true;      // draw 2 tactic cards
const tacticOnslaught: EffectHandler = () => true;              // theater-specific
const tacticTakeItDown: EffectHandler = () => true;             // deal 2 damage
const tacticUnstoppableAssault: EffectHandler = () => true;     // opponent cannot block this step
const tacticNoEscape: EffectHandler = () => true;               // opponent cannot retreat (space)
const tacticOutmaneuver: EffectHandler = () => true;            // discard 1 to block 2 (space)
const tacticBombardment: EffectHandler = () => true;            // ship attack value as ground damage (ground)
const tacticDigIn: EffectHandler = () => true;                  // discard 1 to block 2 (ground)
const tacticEscapePlan: EffectHandler = () => true;             // retreat ignoring restrictions (ground)

// ============================================================================
// Registration
// ============================================================================

export function registerAll(): void {
  // Rebel starting missions
  register('sabotage', sabotage);
  register('build-alliance', buildAlliance);
  register('infiltration', infiltration);
  register('rapid-mobilization', rapidMobilization);

  // Imperial starting missions
  register('capture-rebel-operative', captureRebelOperative);
  register('gather-intel', gatherIntel);
  register('research-and-development', researchAndDevelopment);
  register('rule-by-fear', ruleByFear);

  // Imperial projects
  register('construct-death-star', constructDeathStar);
  register('construct-factory', constructFactory);
  register('construct-super-star-destroyer', constructSuperStarDestroyer);
  register('oversee-project', overseeProject);
  register('superlaser-online', superlaserOnline);

  // Common Imperial missions
  register('trade-negotiations', tradeNegotiations);
  register('display-of-power', displayOfPower);
  register('fear-will-keep-them-in-line', fearWillKeepThemInLine);
  register('hunt-them-down', huntThemDown);
  register('detained', detained);
  register('address-delays', addressDelays);
  register('secret-weapons-research', secretWeaponsResearch);
  register('probe-droid-initiative', probeDroidInitiative);
  register('imperial-propaganda', imperialPropaganda);
  register('long-range-probe', longRangeProbe);
  register('rogue-squadron-raid', rogueSquadronRaid);
  register('double-our-efforts', doubleOurEfforts);
  register('planetary-conquest', planetaryConquest);
  register('interrogation', interrogation);
  register('collect-bounty', collectBounty);
  // Hard / not-yet stubs (emit modal notice)
  register('carbon-freezing', carbonFreezing);
  register('seek-yoda', seekYoda);
  register('lure-of-the-dark-side', lureOfTheDarkSide);
  register('interrogation-droid', interrogationDroid);
  register('retrieve-the-plans', retrieveThePlans);
  register('contingency-plan', contingencyPlan);
  register('misdirection', misdirection);

  // Common Rebel missions
  register('hit-and-run', hitAndRun);
  register('demolition', demolition);
  register('base-defenses', baseDefenses);
  register('ignite-rebellion', inciteRebellion);
  register('support-of-mon-calamari', supportOfMonCalamari);
  register('public-uprising', publicUprising);
  register('daring-rescue', dailyRescueGroup);
  register('plan-the-assault', planTheAssault);
  register('stolen-plans', stolenPlans);
  register('covert-operation', covertOperation);
  register('hidden-fleet', hiddenFleet);
  register('lead-the-strike-team', leadTheStrikeTeam);
  register('wookie-uprising', wookieUprising);
  register('establish-trade-relations', establishTradeRelations);
  register('for-the-greater-good', forTheGreaterGood);
  register('intercept-transmissions', interceptTransmissions);
  register('homing-beacon', homingBeacon);
  register('plant-false-lead', plantFalseLead);

  // Tactic cards (stubs)
  register('tactic-concentrate-fire', tacticConcentrateFire);
  register('tactic-critical-hit', tacticCriticalHit);
  register('tactic-defensive-formation', tacticDefensiveFormation);
  register('tactic-brilliant-strategy', tacticBrilliantStrategy);
  register('tactic-onslaught', tacticOnslaught);
  register('tactic-take-it-down', tacticTakeItDown);
  register('tactic-unstoppable-assault', tacticUnstoppableAssault);
  register('tactic-no-escape', tacticNoEscape);
  register('tactic-outmaneuver', tacticOutmaneuver);
  register('tactic-bombardment', tacticBombardment);
  register('tactic-dig-in', tacticDigIn);
  register('tactic-escape-plan', tacticEscapePlan);
}
