// Bundle of card-effect handler registrations. Import once at engine boot.
// Each handler is small; complex multi-stage cards live in their own files
// under handlers/ as the scope grows.

import type { GameState, Side } from '../types';
import * as M from '../mechanics';
import { register, type EffectHandler } from './registry';
import { beginCombat, runCombat } from '../combat';
import { notImplemented, log, pushNotice } from '../log';
import { shuffle, nextInt, rollDie } from '../rng';
import { leaderRecruitable } from '../phases';

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
/** Queue a DestroyUpToHealth ChoiceRequest if there are valid candidates.
 *  Returns true if a choice was queued. RAW: player picks which units to
 *  destroy (up to budget); the prior auto-pick has been demoted to the AI
 *  heuristic in randomAI.ts. */
function queueDestroyUpToHealth(
  G: GameState,
  resolvingSide: 'Rebel' | 'Empire',
  opponentSide: 'Rebel' | 'Empire',
  sysId: string,
  healthBudget: number,
  cardName: string,
  theater?: 'space' | 'ground',
): boolean {
  const ss = sysId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[sysId];
  if (!ss) return false;
  const candidates = ss.units
    .filter((u) => u.side === opponentSide)
    .filter((u) => !theater || G.catalog.unitTypes[u.typeId]?.theater === theater)
    // RAW: units with health.color === null (Death Star) can ONLY be destroyed
    // by Death Star Plans. Exclude them from Hit And Run / Hunt Them Down /
    // Wookie Uprising candidate sets. Their health.value is 0, so the budget
    // gate `spent + 0 > budget` would otherwise let them die for free.
    .filter((u) => G.catalog.unitTypes[u.typeId]?.health.color !== null)
    .map((u) => u.instanceId);
  if (candidates.length === 0) return false;
  G.pendingChoice = {
    kind: 'DestroyUpToHealth',
    side: resolvingSide,
    systemId: sysId,
    candidates,
    budget: healthBudget,
    cardName,
  };
  log(G, { kind: 'choice-request', side: resolvingSide, payload: {
    kind: 'DestroyUpToHealth', card: cardName, candidates: candidates.length, budget: healthBudget,
  }});
  return true;
}

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
    // Same RAW guard as the choice-flow path: exclude indestructible-by-normal-
    // means units (Death Star). Their health.value is 0, which would otherwise
    // pass the `spent + h > budget` check and let them die for free.
    .filter((u) => G.catalog.unitTypes[u.typeId]?.health.color !== null)
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

const rapidMobilization: EffectHandler = (G, ctx) => {
  // RAW: "Resolve in the Rebel Base space. At the end of this phase, choose
  // 1 of the following: (a) If base is not revealed, move up to 5 units
  // from 1 system to the Rebel Base space, ignoring adjacency; (b)
  // Establish a new Rebel Base. If 2 leaders are assigned, draw 8 probe
  // cards instead of 4 (for new-base pick)."
  //
  // Implementation note: we fire the choice immediately on reveal rather
  // than at end-of-phase (no deferred-effect infra). This is an acceptable
  // RAW deviation — the Rebel can defer making the pick by leaving the
  // mission resolution open, but in practice firing immediately is more
  // playable.
  // RAW timing: defer the choice until the END of the Command phase (after
  // both players pass). Resolving immediately would let the Rebel use this
  // as a panic-escape mid-phase against incoming Empire activity — a real
  // strategic difference.
  const twoLeaders = (ctx.leaderIds?.length ?? 0) >= 2;
  G.pendingRapidMobilizations = G.pendingRapidMobilizations ?? [];
  G.pendingRapidMobilizations.push({ twoLeaders });
  log(G, { kind: 'rapid-mobilization-deferred', side: 'Rebel', payload: {
    twoLeaders, queueDepth: G.pendingRapidMobilizations.length,
  }});
  // Acknowledge the play immediately — its effect is deferred to the end of
  // the Command phase per the card text ("At the end of this phase, choose…"),
  // so without this it looks like nothing happened (player report).
  pushNotice(
    G,
    `rapid-mobilization-queued-t${G.timeMarker}-${G.pendingRapidMobilizations.length}`,
    'Rapid Mobilization — queued',
    'This resolves at the END of the Command phase, once both players have passed. ' +
      'You\'ll then choose to either move up to 5 units from one system to the Rebel ' +
      'Base (ignoring adjacency) or establish a new Rebel Base.' +
      (twoLeaders ? ' Two leaders were assigned, so a new-base search draws 8 probe cards instead of 4.' : ''),
    'Rebel', // Rebel-only notice — the Empire must not be shown it.
  );
  return true;
};

// ----- Imperial starting -----

const captureRebelOperative: EffectHandler = (G, ctx) => {
  // RAW: "Capture a Rebel leader in a system that contains an Imperial
  // unit." Empire chose a specific leader at reveal time (ctx.targetLeaderId
  // — the reveal-mission target picker enforces a valid Rebel leader).
  // Honor that choice ABOVE all else: the mission-target validation
  // already confirmed the leader is at a system with an Imperial unit,
  // and captureLeader() finds them whether they're in leaderPool,
  // leadersOnBoard, or leadersOnMissions.
  //
  // The previous version required the target to be in leadersOnBoard
  // [targetSystemId], which silently failed when the leader was on a
  // mission (in leadersOnMissions instead of leadersOnBoard). In that
  // case it fell through and captured whichever leader WAS on the board
  // at the target system — which could be the opposing leader the Rebel
  // had just sent to defend, NOT the target the Empire chose. (User
  // report #41: Vader targeted Mon Mothma, Rebel opposed with Han Solo,
  // Han got captured instead of Mon Mothma.)
  const sysId = ctx.targetSystemId;
  if (ctx.targetLeaderId) {
    // Defensive: ensure the leader is still a Rebel leader (not already
    // captured / eliminated). If they vanished mid-resolution somehow,
    // fall through to the system-based logic below.
    const stillTargetable = !(G.empire.capturedLeaders ?? [])
      .some((c) => c.leaderId === ctx.targetLeaderId)
      && !G.rebel.eliminatedLeaders.includes(ctx.targetLeaderId);
    if (stillTargetable) {
      M.captureLeader(G, ctx.targetLeaderId, 'captured');
      return true;
    }
  }
  // No specific target provided (legacy code paths) — fall back to the
  // "who's on the board here" picker.
  if (!sysId) return true;
  const here = G.rebel.leadersOnBoard[sysId] ?? [];
  if (here.length === 0) return true;
  if (here.length === 1) {
    M.captureLeader(G, here[0], 'captured');
    return true;
  }
  G.pendingChoice = {
    kind: 'CaptureOperativePick',
    side: 'Empire',
    targetSystemId: sysId,
    candidates: [...here],
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'CaptureOperativePick', count: here.length,
  }});
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
  // RAW: Empire picks between (A) draw 2 project cards, keep 1, bottom 1;
  // and (B) remove sabotage marker from this system + draw 1 project card.
  if (!G.empire.projectDeck) return true;
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const ss = G.map.systems[sysId];
  G.pendingChoice = {
    kind: 'ResearchAndDevelopmentOption',
    side: 'Empire',
    targetSystemId: sysId,
    hasSabotage: !!ss?.sabotage,
    projectDeckSize: G.empire.projectDeck.length,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'ResearchAndDevelopmentOption', hasSabotage: !!ss?.sabotage,
  }});
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

/** Post a BuildFromIconsPick so the player chooses a unit type per resource
 *  icon (RAW: you choose what to build, just like the normal Build step). Used
 *  by effects that "place units on the build queue using this system's resource
 *  icons" — Construct Factory, Address Delays, Establish Trade Relations.
 *  Returns false (no choice posted) if the system can't build right now. */
function queueBuildFromIcons(G: GameState, side: 'Rebel' | 'Empire', sysId: string, label: string): boolean {
  const sysDef = G.catalog.systems[sysId];
  if (!sysDef || !sysDef.buildSlot || sysDef.resources.length === 0) return false;
  G.pendingChoice = {
    kind: 'BuildFromIconsPick',
    side, systemId: sysId, label,
    icons: sysDef.resources.map((r) => ({ theater: r.type, shape: r.shape })),
  };
  log(G, { kind: 'choice-request', side, payload: {
    kind: 'BuildFromIconsPick', systemId: sysId, label, iconCount: sysDef.resources.length,
  }});
  return true;
}

const constructFactory: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  // "Place units on the build queue using this system's resource icons and
  // number." Player chooses the unit type per icon (BuildFromIconsPick).
  const ss = G.map.systems[sysId];
  if (!ss) return true;
  if (ss.sabotage) ss.sabotage = false; // sabotage removed before resolving
  queueBuildFromIcons(G, 'Empire', sysId, 'Construct Factory');
  return true;
};

const constructSuperStarDestroyer: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  M.buildToQueue(G, 'Empire', 'super-star-destroyer', 3);
  return true;
};

const overseeProject: EffectHandler = (G, ctx) => {
  // RAW: "Choose 1 Empire unit on space 1 or 2 of the build queue; deploy
  // it in this system." Player picks; pause for OverseeProjectPick.
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const q = G.empire.buildQueue;
  const candidates: { slot: 1 | 2; queueIndex: number; unitTypeId: string }[] = [];
  for (const slot of [1, 2] as const) {
    q[slot].forEach((tid, i) => candidates.push({ slot, queueIndex: i, unitTypeId: tid }));
  }
  if (candidates.length === 0) return true; // nothing to deploy
  G.pendingChoice = {
    kind: 'OverseeProjectPick',
    side: 'Empire',
    targetSystemId: sysId,
    candidates,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'OverseeProjectPick', count: candidates.length,
  }});
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
  // RAW: "If successful, gain 1 loyalty in 2 systems in this region."
  // Empire picks the 2 systems (may include the target).
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const targetDef = G.catalog.systems[sysId];
  if (!targetDef) return true;
  const candidates = Object.values(G.catalog.systems)
    .filter((s) => s.region === targetDef.region && !s.isCoruscant && !s.isRemote)
    .map((s) => s.id);
  if (candidates.length === 0) return true;
  if (candidates.length <= 2) {
    // Trivial — apply all without asking.
    for (const id of candidates) M.gainLoyalty(G, 'Empire', id, 1);
    return true;
  }
  G.pendingChoice = {
    kind: 'FearWillKeepThemInLinePick',
    side: 'Empire',
    candidates,
    count: 2,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'FearWillKeepThemInLinePick', candidates: candidates.length,
  }});
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
  queueBuildFromIcons(G, 'Empire', sysId, 'Address Delays');
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
 *  this system." Surfaces the yes/no to the Empire via a modal notice, and on
 *  a "no" rules the system out (yellow searched marker). RAW: this does NOT
 *  reveal the base — the Empire just learns the answer. */
const longRangeProbe: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const sysName = G.catalog.systems[sysId]?.name ?? sysId;
  const isBase = G.rebelBaseSystemId === sysId;
  log(G, { kind: 'probe-result', side: 'Empire', payload: {
    systemId: sysId, isBase, source: 'long-range-probe',
  }});
  if (isBase) {
    pushNotice(G, `lrp-${sysId}-t${G.timeMarker}`, 'Long Range Probe',
      `The Rebel base IS at ${sysName}! (Move units there to capture it — it isn't revealed yet.)`);
  } else {
    // Rule it out — same knowledge as a "no" probe card. Shows as a yellow X.
    if (!G.empireSearchedRuledOut) G.empireSearchedRuledOut = [];
    if (!G.empireSearchedRuledOut.includes(sysId)) G.empireSearchedRuledOut.push(sysId);
    pushNotice(G, `lrp-${sysId}-t${G.timeMarker}`, 'Long Range Probe',
      `The Rebel base is NOT at ${sysName}. Marked as ruled out on the map.`);
  }
  return true;
};

/** "Destroy up to 4 health worth of units of your choice on the build queue."
 *  Priority: high-tier (square > circle > triangle), then high-health. */
const rogueSquadronRaid: EffectHandler = (G, _ctx) => {
  // RAW: "destroy up to 4 health worth of units on the build queue."
  // Rebel picks which queue items to destroy.
  const candidates: { slot: 1 | 2 | 3; queueIndex: number; unitTypeId: string; health: number }[] = [];
  for (const slot of [1, 2, 3] as const) {
    G.empire.buildQueue[slot].forEach((typeId, i) => {
      const t = G.catalog.unitTypes[typeId];
      if (!t) return;
      candidates.push({ slot, queueIndex: i, unitTypeId: typeId, health: t.health.value });
    });
  }
  if (candidates.length === 0) return true;
  G.pendingChoice = {
    kind: 'RogueSquadronRaidPick',
    side: 'Rebel',
    candidates,
    budget: 4,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'RogueSquadronRaidPick', candidates: candidates.length,
  }});
  return true;
};

/** "Choose 1 unit on space 2 or 3 of the build queue and move it down 1 space.
 *  If Moff Jerjerrod resolves this mission, you can choose 1 additional unit." */
const doubleOurEfforts: EffectHandler = (G, ctx) => {
  // RAW: "Choose 1 unit on space 2 or 3 of the build queue and move it
  // down 1 space. If Moff Jerjerrod resolves this mission, you can
  // choose 1 additional unit." Empire picks per move.
  const hasJerjerrod = ctx.leaderIds.includes('moff-jerjerrod');
  const candidates: { slot: 2 | 3; queueIndex: number; unitTypeId: string }[] = [];
  for (const slot of [2, 3] as const) {
    G.empire.buildQueue[slot].forEach((typeId, i) => {
      candidates.push({ slot, queueIndex: i, unitTypeId: typeId });
    });
  }
  if (candidates.length === 0) return true;
  G.pendingChoice = {
    kind: 'DoubleOurEffortsPick',
    side: 'Empire',
    candidates,
    picksAllowed: hasJerjerrod ? 2 : 1,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'DoubleOurEffortsPick', candidates: candidates.length, allowed: hasJerjerrod ? 2 : 1,
  }});
  return true;
};

/** "Move up to 1 AT-AT, 1 AT-ST and 2 Stormtroopers from any one system to
 *  this system, ignoring transport restrictions and adjacency. If there are
 *  Rebel ground units in this system, resolve a combat." */
const planetaryConquest: EffectHandler = (G, ctx) => {
  // RAW: "Move up to 1 AT-AT, 1 AT-ST and 2 Stormtroopers from any one
  // system to this system." Empire picks the source system.
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const limits: Record<string, number> = { 'at-at': 1, 'at-st': 1, 'stormtrooper': 2 };
  const sources: { sourceSystemId: string; picks: string[] }[] = [];
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
    if (picks.length > 0) sources.push({ sourceSystemId: otherSysId, picks });
  }
  if (sources.length === 0) {
    triggerCombatAt(G, 'Empire', sysId);
    return true;
  }
  G.pendingChoice = {
    kind: 'PlanetaryConquestSourcePick',
    side: 'Empire',
    targetSystemId: sysId,
    sources,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'PlanetaryConquestSourcePick', sources: sources.length,
  }});
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
 *  closest system that contains an Imperial unit." BFS over adjacency from
 *  the mission system; ties broken by first-discovered order (deterministic
 *  via Object.keys iteration order on the adjacency list). If the mission
 *  system itself has Imperial units, distance=0 and nothing moves. */
const collectBounty: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const rebelHere = G.rebel.leadersOnBoard[sysId] ?? [];
  // Pick the specific leader the Empire targeted at mission reveal time.
  // Honor it whether they're on the board or on a mission — same bug class
  // as capture-rebel-operative (issue #41): target leaders assigned to a
  // mission aren't in leadersOnBoard but ARE legal capture targets.
  let capturedId: string;
  const targetStillValid = ctx.targetLeaderId
    && !(G.empire.capturedLeaders ?? []).some((c) => c.leaderId === ctx.targetLeaderId)
    && !G.rebel.eliminatedLeaders.includes(ctx.targetLeaderId);
  if (targetStillValid) {
    capturedId = ctx.targetLeaderId!;
  } else if (rebelHere.length === 0) {
    return true;
  } else {
    let best: { lid: string; v: number } | null = null;
    for (const lid of rebelHere) {
      const v = leaderValue(G, lid);
      if (!best || v > best.v) best = { lid, v };
    }
    if (!best) return true;
    capturedId = best.lid;
  }
  M.captureLeader(G, capturedId, 'captured');

  // BFS from sysId for nearest system containing an Imperial unit.
  const hasImperial = (id: string): boolean => {
    const ss = G.map.systems[id];
    return !!ss && ss.units.some((u) => u.side === 'Empire');
  };
  let dest: string | null = null;
  const seen = new Set<string>([sysId]);
  const queue: string[] = [sysId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (hasImperial(cur)) { dest = cur; break; }
    const nbrs = G.catalog.adjacency[cur] ?? [];
    for (const n of nbrs) {
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  if (!dest) {
    log(G, { kind: 'collect-bounty-no-imperial-system', side: 'Empire',
      payload: { sourceSystemId: sysId, capturedLeaderId: capturedId } });
    return true;
  }

  // Update captured leader's recorded location.
  if (G.empire.capturedLeaders) {
    const cap = G.empire.capturedLeaders.find((c) => c.leaderId === capturedId);
    if (cap) cap.systemId = dest;
  }

  // Move the bounty-hunter leader(s) (those assigned to the mission) to dest.
  const moved: string[] = [];
  for (const lid of ctx.leaderIds) {
    const fromList = G.empire.leadersOnBoard[sysId];
    if (fromList) {
      const i = fromList.indexOf(lid);
      if (i >= 0) {
        fromList.splice(i, 1);
        if (fromList.length === 0) delete G.empire.leadersOnBoard[sysId];
        if (!G.empire.leadersOnBoard[dest]) G.empire.leadersOnBoard[dest] = [];
        G.empire.leadersOnBoard[dest].push(lid);
        moved.push(lid);
      }
    }
  }
  log(G, { kind: 'collect-bounty-relocate', side: 'Empire', payload: {
    fromSystemId: sysId, toSystemId: dest, capturedLeaderId: capturedId,
    bountyHunters: moved,
  }});
  // Captured leader landing on a system that itself has no Imperial units
  // would auto-rescue — but BFS guarantees `dest` has Imperials, so we're safe.
  return true;
};

// ----- More Rebel handlers ------------------------------------------------

/** "Move units from the 'Rebel Base' space to this system as if they were
 *  adjacent. Leaders in the 'Rebel Base' space do not prevent this."
 *  RAW: bypasses adjacency, but does NOT bypass transport restrictions.
 *  Posts a HiddenFleetUnitPick choice so the Rebel can pick which units
 *  to move (subject to transport rules validated on submit). */
const hiddenFleet: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const candidateUnitIds = G.map.rebelBaseSpace.units
    .filter((u) => {
      if (u.side !== 'Rebel') return false;
      const t = G.catalog.unitTypes[u.typeId];
      return !!t && !t.transport.immobile;
    })
    .map((u) => u.instanceId);
  if (candidateUnitIds.length === 0) {
    log(G, { kind: 'hidden-fleet-noop', side: 'Rebel', payload: { targetSystemId: sysId, reason: 'no-candidates' } });
    return true;
  }
  G.pendingChoice = {
    kind: 'HiddenFleetUnitPick',
    side: 'Rebel',
    targetSystemId: sysId,
    candidateUnitIds,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'HiddenFleetUnitPick', targetSystemId: sysId, candidates: candidateUnitIds.length,
  }});
  return true;
};

/** "Move up to 4 ground units from the 'Rebel Base' space to this system,
 *  ignoring transport restriction and adjacency. If there are Imperial ground
 *  units in this system, resolve a combat." */
const leadTheStrikeTeam: EffectHandler = (G, ctx) => {
  // RAW: "move UP TO 4 ground units of your choice from the Rebel Base space
  // to this system, ignoring transport restriction and adjacency." The player
  // chooses which (and how many, 0-4) — the old code auto-grabbed the first 4
  // (player report #65). Queue a unit-selection choice; the resolver moves the
  // picks and kicks off combat.
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  // RR p.11: once the Rebel Base is revealed, cards that apply to the "Rebel
  // Base" space apply to the base's SYSTEM instead — the staged units have all
  // moved out of the base space and into that system (player report #142: after
  // reveal, Lead the Strike Team found no units in the now-empty base space).
  const baseSourceId = G.rebelBaseRevealed ? G.rebelBaseSystemId : 'rebel-base-space';
  const baseContainer = baseSourceId === 'rebel-base-space'
    ? G.map.rebelBaseSpace : G.map.systems[baseSourceId];
  const baseGround = (baseContainer?.units ?? [])
    .filter((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')
    .map((u) => u.instanceId);
  if (baseGround.length === 0) {
    // No ground units to send — still resolve combat in case the Rebel
    // already has units at the target (mirrors the original behavior).
    triggerCombatAt(G, 'Rebel', sysId);
    return true;
  }
  G.pendingChoice = {
    kind: 'LeadStrikeTeamUnits',
    side: 'Rebel',
    targetSystemId: sysId,
    availableUnitIds: baseGround,
    sourceSystemId: baseSourceId,
    max: 4,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'LeadStrikeTeamUnits', targetSystemId: sysId, available: baseGround.length, max: 4,
  }});
  return true;
};

/** "Attempt in the Kashyyyk system. Gain 1 loyalty in this system and destroy
 *  up to 4 health worth of units of your choice in this system." */
const wookieUprising: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  M.gainLoyalty(G, 'Rebel', sysId, 1);
  queueDestroyUpToHealth(G, 'Rebel', 'Empire', sysId, 4, 'Wookie Uprising');
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
  // RAW: a sabotage marker prevents building OR deploying units at this
  // system. Skip the build step here if sabotaged — loyalty gain still applies.
  if (ss.sabotage) {
    log(G, { kind: 'establish-trade-relations-built', side: 'Rebel', payload: {
      systemId: sysId, slot: sysDef.buildSlot ?? 1, added: [],
      note: 'Sabotage marker present — no units added to the build queue.',
    }});
    return true;
  }
  // Player chooses the unit type per resource icon (BuildFromIconsPick) —
  // matching the normal Build step and Temporary Alliance, instead of forcing
  // a fixed default (which also never built airspeeders for the Rebel).
  queueBuildFromIcons(G, 'Rebel', sysId, 'Establish Trade Relations');
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

/** RAW: "Rescue 1 captured leader. The Rebel player must place this leader
 *  in any system in the Rebel base's region." Empire picks WHICH leader to
 *  rescue (counter-intuitive but the card is an Empire mission — Empire
 *  benefits because the placement reveals the base's region) AND picks the
 *  system. Both stages handled in one HomingBeaconPlace choice. */
const homingBeacon: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!G.empire.capturedLeaders || G.empire.capturedLeaders.length === 0) return true;
  const leaderCandidates = G.empire.capturedLeaders
    .filter((c) => !sysId || c.systemId === sysId)
    .map((c) => c.leaderId);
  if (leaderCandidates.length === 0) return true;
  const baseDef = G.catalog.systems[G.rebelBaseSystemId];
  if (!baseDef) return true;
  const systemCandidates = Object.values(G.catalog.systems)
    .filter((s) => s.region === baseDef.region && !s.isCoruscant)
    .map((s) => s.id);
  if (systemCandidates.length === 0) return true;
  // RAW: "the Rebel player must place this leader in any system in the Rebel
  // base's region." The Empire benefits from the region reveal, but the REBEL
  // chooses the system. (Was wrongly assigned to Empire.)
  G.pendingChoice = {
    kind: 'HomingBeaconPlace',
    side: 'Rebel',
    leaderCandidates,
    systemCandidates,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'HomingBeaconPlace', leaders: leaderCandidates.length, systems: systemCandidates.length,
  }});
  return true;
};

/** "Take 4 random probe cards. Place on top and/or bottom of the deck." Auto:
 *  take 4 random, all to the bottom (worst for Empire). */
const plantFalseLead: EffectHandler = (G, _ctx) => {
  // RAW: "Randomly take 4 of the Imperial player's probe cards [from their
  // HAND] and place them on the top and/or bottom of the deck." The point is
  // to return the Empire's drawn probes (its ruled-out-system intel) to the
  // deck, undoing that narrowing. The old code operated on the DECK instead
  // of the hand, so the Empire's hand cards were never returned (issue #64).
  const hand = G.empire.probeHand ?? [];
  if (hand.length === 0) return true;
  const n = Math.min(4, hand.length);
  const taken: string[] = [];
  for (let k = 0; k < n; k++) {
    const i = nextInt(G.rng, hand.length);
    taken.push(hand.splice(i, 1)[0]);
  }
  // RAW: the Rebel places each taken card on the top and/or bottom of the
  // deck, in any order, hidden from the Empire. Pause for that choice; the
  // resolver places them and resumes the mission. (The cards are already
  // removed from the Empire's hand and held on the choice.)
  G.pendingChoice = { kind: 'PlantFalseLeadPlacement', side: 'Rebel', cards: taken };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: { kind: 'PlantFalseLeadPlacement', cards: taken } });
  return true;
};

// ----- Hard / leader-attachment / hidden-info — stubs ---------------------

const carbonFreezing: EffectHandler = (G, ctx) => {
  // RAW: attach the carbonite ring to a captured Rebel leader. Empire picks
  // which one when multiple captured-state leaders are available.
  const sysId = ctx.targetSystemId;
  if (!G.empire.capturedLeaders || G.empire.capturedLeaders.length === 0) {
    M.loseReputation(G, 1);
    return true;
  }
  const candidates = G.empire.capturedLeaders
    .filter((c) => (!sysId || c.systemId === sysId) && c.ring === 'captured')
    .map((c) => c.leaderId);
  if (candidates.length === 0) {
    M.loseReputation(G, 1);
    return true;
  }
  if (candidates.length === 1) {
    // Single candidate — apply directly, no pause needed.
    const lid = candidates[0];
    const entry = G.empire.capturedLeaders.find((c) => c.leaderId === lid);
    if (entry) {
      entry.ring = 'carbonite';
      log(G, { kind: 'carbonite-applied', payload: { leaderId: lid, systemId: entry.systemId } });
    }
    M.loseReputation(G, 1);
    return true;
  }
  G.pendingChoice = {
    kind: 'CarbonFreezingPick',
    side: 'Empire',
    candidates,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'CarbonFreezingPick', count: candidates.length,
  }});
  // Reputation loss is applied after the resolve fires (it's part of
  // the card's effect either way — see resolver).
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
  // RAW: target a captured Rebel leader and flip them with the Dark Side
  // ring. Empire picks WHICH captured leader (when multiple available).
  // Bonus reputation loss if Luke is flipped.
  const sysId = ctx.targetSystemId;
  if (!G.empire.capturedLeaders || G.empire.capturedLeaders.length === 0) return true;
  const candidates = G.empire.capturedLeaders
    .filter((c) => (!sysId || c.systemId === sysId) && !M.hasAttachment(G, c.leaderId, 'dark-side'))
    .map((c) => c.leaderId);
  if (candidates.length === 0) return true;
  if (candidates.length === 1) {
    const lid = candidates[0];
    const ok = M.flipLeaderToImperial(G, lid);
    if (ok && lid === 'luke-skywalker') M.loseReputation(G, 1);
    return true;
  }
  G.pendingChoice = {
    kind: 'LureOfTheDarkSidePick',
    side: 'Empire',
    targetSystemId: sysId ?? '',
    candidates,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'LureOfTheDarkSidePick', count: candidates.length,
  }});
  return true;
};

const interrogationDroid: EffectHandler = (G) => {
  // RAW: "Attempt against a captured leader. Count all skill icons during
  // this attempt. If successful, the Rebel player must name 3 systems. One
  // of these systems must contain the Rebel base." (skill-counting variant
  // handled by missionCountsAllSkills; effect side is just the naming step.)
  // We let the Rebel pick 2 decoy systems; the engine then logs all 3 (the
  // 2 decoys + the actual base) so the Empire sees the same info they'd see
  // at a physical table.
  const allSystems = Object.keys(G.map.systems).filter((sid) => sid !== G.rebelBaseSystemId);
  if (allSystems.length < 2) {
    log(G, { kind: 'interrogation-droid-noop', side: 'Empire', payload: { reason: 'too-few-decoy-candidates' } });
    return true;
  }
  G.pendingChoice = {
    kind: 'InterrogationDroidDecoyPick',
    side: 'Rebel',
    candidates: allSystems,
    count: 2,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'InterrogationDroidDecoyPick', candidates: allSystems.length, count: 2,
  }});
  return true;
};

const retrieveThePlans: EffectHandler = (G) => {
  // RAW: "Attempt against a captured leader. If successful, Rebel reveals
  // hand of objective cards. Empire picks 1 to put on the bottom of the
  // objective deck."
  const hand = G.rebel.objectiveHand ?? [];
  if (hand.length === 0) {
    log(G, { kind: 'retrieve-plans-noop', side: 'Empire', payload: { reason: 'empty-rebel-objective-hand' } });
    return true;
  }
  G.pendingChoice = {
    kind: 'RetrieveThePlansPick',
    side: 'Empire',
    candidates: [...hand],
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'RetrieveThePlansPick', candidates: hand.length,
  }});
  return true;
};

const contingencyPlan: EffectHandler = (G, ctx) => {
  // RAW: "Assign this leader to a starting mission from your hand, even one
  // that was already attempted or resolved this round. If Lando Calrissian
  // was assigned to this mission, he gains 2 additional successes when he
  // attempts a mission later this round."
  //
  // Lando bonus: if Lando was assigned here, set a flag consumed on his
  // next mission attempt. Re-assign step: post a ChoiceRequest listing the
  // Rebel's starting missions in hand; resolver then attaches the leader.
  if (ctx.leaderIds.includes('lando-calrissian')) {
    G.actionCardFlags = G.actionCardFlags ?? {};
    G.actionCardFlags.landoContingencyBonus = true;
    log(G, { kind: 'lando-contingency-bonus-armed', side: 'Rebel', payload: {} });
  }
  // Determine which leader to reassign. RAW: "this leader" — the leader
  // resolving Contingency Plan. If multiple, pick the first.
  const reassignLeader = ctx.leaderIds[0];
  if (!reassignLeader) return true;
  const candidates = G.rebel.missionHand.filter((mid) => {
    const m = G.catalog.missions[mid];
    return m && m.isStarting && mid !== 'contingency-plan';
  });
  if (candidates.length === 0) {
    log(G, { kind: 'contingency-plan-no-candidates', side: 'Rebel', payload: {} });
    return true;
  }
  G.pendingChoice = {
    kind: 'ContingencyPlanPick',
    side: 'Rebel',
    leaderId: reassignLeader,
    candidates,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'ContingencyPlanPick', leaderId: reassignLeader, count: candidates.length,
  }});
  return true;
};

const misdirection: EffectHandler = (G, _ctx) => {
  // RAW: "Choose 1 of your leaders. Imperial leaders in the leader pool
  // cannot be sent to oppose that leader's missions this round."
  // Rebel picks ANY of their leaders (not just the resolver).
  const allRebelLeaders = [
    ...G.rebel.leaderPool,
    ...Object.values(G.rebel.leadersOnBoard).flat(),
  ];
  // Dedupe while preserving order.
  const candidates = Array.from(new Set(allRebelLeaders));
  if (candidates.length === 0) return true;
  G.pendingChoice = {
    kind: 'MisdirectionPick',
    side: 'Rebel',
    candidates,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'MisdirectionPick', candidates: candidates.length,
  }});
  return true;
};

const huntThemDown: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  queueDestroyUpToHealth(G, 'Empire', 'Rebel', sysId, 2, 'Hunt Them Down');
  return true;
};

const detained: EffectHandler = (G, ctx) => {
  // RAW: "Attempt against a Rebel leader that is in any system. If successful,
  // that leader does not return to the leader pool during the next refresh."
  // The mission target is a system; we look for Rebel leaders there.
  // Honor an explicit ctx.targetLeaderId whether they're on the board or on
  // a mission (same bug class as capture-rebel-operative #41).
  const sysId = ctx.targetSystemId;
  const targetStillValid = ctx.targetLeaderId
    && !(G.empire.capturedLeaders ?? []).some((c) => c.leaderId === ctx.targetLeaderId)
    && !G.rebel.eliminatedLeaders.includes(ctx.targetLeaderId);
  if (targetStillValid) {
    markDetained(G, ctx.targetLeaderId!);
    return true;
  }
  if (!sysId) return true;
  const here = G.rebel.leadersOnBoard[sysId] ?? [];
  if (here.length === 0) {
    log(G, { kind: 'detained-noop', side: 'Empire', payload: { systemId: sysId, reason: 'no-rebel-leaders-at-target' } });
    return true;
  }
  if (here.length === 1) {
    markDetained(G, here[0]);
    return true;
  }
  // Empire picks among multiple.
  G.pendingChoice = {
    kind: 'DetainedTargetPick',
    side: 'Empire',
    candidates: [...here],
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'DetainedTargetPick', candidates: here.length, systemId: sysId,
  }});
  return true;
};

/** Shared mutator: tag a Rebel leader to skip the next refresh retrieve. */
function markDetained(G: GameState, leaderId: string): void {
  G.detainedLeadersNextRefresh = G.detainedLeadersNextRefresh ?? [];
  if (!G.detainedLeadersNextRefresh.some((d) => d.leaderId === leaderId)) {
    G.detainedLeadersNextRefresh.push({ side: 'Rebel', leaderId });
  }
  log(G, { kind: 'detained-applied', side: 'Empire', payload: { leaderId } });
}

// ----- Common Rebel -----

const hitAndRun: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  queueDestroyUpToHealth(G, 'Rebel', 'Empire', sysId, 2, 'Hit And Run');
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
  // RAW: "Either gain 2 loyalty in this system OR place 1 Mon Calamari
  // Cruiser on space 3 of the build queue." Rebel picks.
  const monCala = G.map.systems['mon-calamari'];
  G.pendingChoice = {
    kind: 'SupportOfMonCalamariPick',
    side: 'Rebel',
    monCalaLoyalty: (monCala?.loyalty as 'rebel' | 'imperial' | 'neutral') ?? 'neutral',
    monCalaSubjugated: !!monCala?.subjugated,
    cruiserAvailable: M.unitsAvailableInSupply(G, 'mon-cala-cruiser') > 0,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'SupportOfMonCalamariPick',
  }});
  return true;
};

const publicUprising: EffectHandler = (G, ctx) => {
  // RAW: "gain 1 circle and 2 triangle units (ships and/or ground units)."
  // Rebel picks ship-vs-ground for each unit.
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  G.pendingChoice = {
    kind: 'PublicUprisingPick',
    side: 'Rebel',
    systemId: sysId,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'PublicUprisingPick', systemId: sysId,
  }});
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
  // RR p.11: after the base is revealed, the "Rebel Base" space becomes the
  // base's system — source the ships from wherever they actually are.
  const baseSourceId = G.rebelBaseRevealed ? G.rebelBaseSystemId : 'rebel-base-space';
  const baseContainer = baseSourceId === 'rebel-base-space'
    ? G.map.rebelBaseSpace : G.map.systems[baseSourceId];
  const baseUnits = baseContainer?.units ?? [];
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
    sourceSystemId: baseSourceId,
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
// Rise of the Empire — Wave A handlers (data-only -> wired effects)
// ============================================================================
//
// Phase 5b first batch: 12 RoE mission handlers whose effects either reuse
// base-game mechanics or are simple combinations of them. Source text is in
// assets/missions.json (transcribed from MissionReference_RotE_Final.pdf in
// Phase 5a). Choice-heavy missions (per-card pick UIs) are deferred to
// Wave B/C.

/** Recruit the first eligible leader from `candidates` and place them at
 *  `sysId`. Returns true if a leader was placed, false if no candidate was
 *  recruitable (every leader already in pool, on board, on mission, or
 *  eliminated). Mirrors the "Recruit X, place in this system" mission
 *  phrasing used across Hire Mercenaries / Promotion / My Only Hope. */
function recruitAndPlace(
  G: GameState, side: Side, candidates: readonly string[], sysId: string, cause: string,
): boolean {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const eligible = candidates.find((lid) => leaderRecruitable(G, side, lid));
  if (!eligible) {
    log(G, { kind: 'recruit-no-candidate', side, payload: { cause, candidates: [...candidates] } });
    return false;
  }
  f.leaderPool.push(eligible);
  log(G, { kind: 'recruit-leader', side, payload: { leaderId: eligible, via: cause } });
  M.placeLeader(G, side, eligible, sysId);
  return true;
}

/** All catalog leaders for `side` that satisfy a predicate AND are
 *  recruitable RIGHT NOW. Used by Hire Mercenaries (no-tactic-values) and
 *  Imperial Promotion (has-tactic-values). */
function catalogRecruitable(
  G: GameState, side: Side, pred: (id: string) => boolean,
): string[] {
  return Object.values(G.catalog.leaders)
    .filter((l) => l.side === side && pred(l.id) && leaderRecruitable(G, side, l.id))
    .map((l) => l.id);
}

const hasTacticValues = (G: GameState, lid: string): boolean => {
  const l = G.catalog.leaders[lid];
  return !!l && (l.tacticValues.space > 0 || l.tacticValues.ground > 0);
};

// ----- Imperial Wave A -----

/** Deployment: "Attempt on a system with no Rebel units or loyalty. Gain 1
 *  triangle ground unit." Auto-deploys 1 Stormtrooper at the target. */
const deployment: EffectHandler = (G, ctx) => {
  if (!ctx.targetSystemId) return true;
  M.gainUnit(G, 'Empire', 'stormtrooper', ctx.targetSystemId);
  return true;
};

/** Message From High Command: "Gain 1 loyalty. Return all assigned leaders
 *  to the leader pool." */
const messageFromHighCommand: EffectHandler = (G, ctx) => {
  if (!ctx.targetSystemId) return true;
  M.gainLoyalty(G, 'Empire', ctx.targetSystemId, 1);
  for (const lid of ctx.leaderIds) M.returnLeader(G, 'Empire', lid);
  return true;
};

/** Stolen Intel: "Draw a probe card. Look at the Rebel hand of missions and
 *  discard one (not a starter)." Auto-picks the first non-starter Rebel
 *  mission in hand. Empire-side. */
const stolenIntel: EffectHandler = (G, _ctx) => {
  M.drawProbe(G, 1);
  const hand = G.rebel.missionHand;
  const idx = hand.findIndex((mid) => {
    const m = G.catalog.missions[mid];
    return m && !m.isStarting;
  });
  if (idx < 0) {
    log(G, { kind: 'stolen-intel-no-target', side: 'Empire', payload: {} });
    return true;
  }
  const [discarded] = hand.splice(idx, 1);
  G.rebel.missionDiscard.push(discarded);
  log(G, { kind: 'stolen-intel-discard', side: 'Empire', payload: { missionId: discarded } });
  return true;
};

/** Hire Mercenaries: "Resolve in a remote system. Recruit 1 Imperial leader
 *  without tactic values and place them in this system." */
const hireMercenaries: EffectHandler = (G, ctx) => {
  if (!ctx.targetSystemId) return true;
  const noTactic = catalogRecruitable(G, 'Empire', (lid) => !hasTacticValues(G, lid));
  recruitAndPlace(G, 'Empire', noTactic, ctx.targetSystemId, 'hire-mercenaries');
  return true;
};

/** Imperial Promotion: "Resolve in any Imperial system. Recruit 1 Imperial
 *  leader with tactic values and place them in this system." */
const imperialPromotion: EffectHandler = (G, ctx) => {
  if (!ctx.targetSystemId) return true;
  const withTactic = catalogRecruitable(G, 'Empire', (lid) => hasTacticValues(G, lid));
  recruitAndPlace(G, 'Empire', withTactic, ctx.targetSystemId, 'imperial-promotion');
  return true;
};

/** Discredit Rebellion: "Resolve on a sabotaged system. Rebel must remove
 *  all sabotage markers on the board, or roll 1 die — on any success,
 *  Rebels lose 1 reputation. If Motti is assigned, Rebels roll 2 dice
 *  instead." Rebel almost always prefers to roll (sabotage markers are
 *  valuable), so we auto-roll. */
const discreditRebellion: EffectHandler = (G, ctx) => {
  // Rebel chooses: remove ALL sabotage markers on the board (avoids the
  // reputation risk but loses the markers' ongoing pressure), or roll
  // dice — 2 with Motti assigned, 1 otherwise. Any success costs 1 rep.
  const diceCount = ctx.leaderIds.includes('motti') ? 2 : 1;
  const sabotageSystemIds = Object.entries(G.map.systems)
    .filter(([_sid, ss]) => ss.sabotage)
    .map(([sid]) => sid);
  // If there are no sabotage markers, the "remove" branch is a no-op and
  // the player has nothing to weigh — just roll directly.
  if (sabotageSystemIds.length === 0) {
    const faces: string[] = [];
    for (let i = 0; i < diceCount; i++) faces.push(rollDie(G.rng, 'red').face);
    const hit = faces.some((f) => f === 'hit' || f === 'direct-hit');
    log(G, { kind: 'discredit-rebellion-roll', side: 'Empire', payload: { faces, hit, diceCount } });
    if (hit) M.loseReputation(G, 1);
    return true;
  }
  G.pendingChoice = {
    kind: 'DiscreditRebellionChoice',
    side: 'Rebel',
    diceCount,
    sabotageSystemIds,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'DiscreditRebellionChoice', diceCount, sabotageCount: sabotageSystemIds.length,
  }});
  return false; // paused for Rebel choice
};

// ----- Rebel Wave A -----

/** Regional Aid: "Gain 1 loyalty here, and 1 loyalty elsewhere in the same
 *  region." Auto-picks the first eligible other system in the region. */
const regionalAid: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  M.gainLoyalty(G, 'Rebel', sysId, 1);
  const def = G.catalog.systems[sysId];
  if (!def) return true;
  const other = Object.values(G.catalog.systems).find(
    (s) => s.id !== sysId && s.region === def.region && !s.isRemote && !s.isCoruscant,
  );
  if (other) M.gainLoyalty(G, 'Rebel', other.id, 1);
  return true;
};

/** Reconnaissance: "Attempt on an Imperial system. Choose a discarded
 *  mission and return it to your hand." Auto-picks the first mission in
 *  the Rebel discard pile. */
const reconnaissance: EffectHandler = (G, _ctx) => {
  const pile = G.rebel.missionDiscard;
  if (!pile.length) return true;
  const recovered = pile.shift()!;
  G.rebel.missionHand.push(recovered);
  log(G, { kind: 'reconnaissance-recover', side: 'Rebel', payload: { missionId: recovered } });
  return true;
};

/** Critical Rescue: "Attempt on a captured leader. Rescue the leader. If
 *  the mission fails, return this card to your hand." Mission-flow handles
 *  the failure case (return-to-hand); the success handler just rescues. */
const criticalRescue: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const cap = (G.empire.capturedLeaders ?? []).find((c) => c.systemId === sysId);
  if (cap) M.rescueLeader(G, cap.leaderId, 'critical-rescue');
  return true;
};

const REBEL_PROMOTION_POOL = [
  'admiral-ackbar', 'wedge-antilles', 'general-madine',
  'cassian-andor', 'saw-gerrera',
] as const;

const MY_ONLY_HOPE_POOL = [
  'luke-skywalker', 'obi-wan-kenobi', 'jyn-erso',
  'han-solo', 'chirrut-imwe',
] as const;

/** Rebel Promotion: "Resolve in a Rebel system. Recruit Ackbar, Wedge,
 *  Madine, Cassian Andor, or Saw Gerrera and place them here." */
const rebelPromotion: EffectHandler = (G, ctx) => {
  if (!ctx.targetSystemId) return true;
  recruitAndPlace(G, 'Rebel', REBEL_PROMOTION_POOL, ctx.targetSystemId, 'rebel-promotion');
  return true;
};

/** My Only Hope: "Resolve in a remote system. Recruit Luke, Obi-Wan, Jyn
 *  Erso, Han Solo, or Chirrut Imwe and place them here." */
const myOnlyHope: EffectHandler = (G, ctx) => {
  if (!ctx.targetSystemId) return true;
  recruitAndPlace(G, 'Rebel', MY_ONLY_HOPE_POOL, ctx.targetSystemId, 'my-only-hope');
  return true;
};

// ============================================================================
// Rise of the Empire — Wave B handlers (Phase 5b)
// ============================================================================
//
// Missions using the target-marker primitive (placed in Phase 6) and
// medium-complexity effects (build-queue moves, hand inspection, ground-
// unit pulls). Break Their Will is deferred to Wave C — it needs a real
// "name a system" choice and the same yes/no probe modal as Long Range
// Probe.

// ----- Imperial Wave B -----

/** Secure the Plans (Krennic): place a target marker. Phase 6 already
 *  wires this into the Death Star Plans path — while the marker remains,
 *  Rebels can't play DSP on the marker's system. */
const secureThePlans: EffectHandler = (G, ctx) => {
  if (!ctx.targetSystemId) return true;
  M.placeTargetMarker(G, ctx.targetSystemId, 'secure-the-plans', 'Empire');
  return true;
};

/** Make an Example (Jabba): "Captured leader is eliminated." */
const makeAnExample: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const cap = (G.empire.capturedLeaders ?? []).find((c) => c.systemId === sysId);
  if (cap) {
    M.eliminateLeader(G, 'Rebel', cap.leaderId);
    log(G, { kind: 'make-an-example-eliminate', side: 'Empire', payload: { leaderId: cap.leaderId, systemId: sysId } });
  }
  return true;
};

/** Imperial Might: "Take 4 Imperial units from space 1 of the build queue
 *  and place them in this system. If 2 leaders assigned, move those leaders
 *  to Coruscant." Auto-picks the first 4 units off slot 1. */
const imperialMight: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const q = G.empire.buildQueue[1];
  const taken: string[] = [];
  for (let i = 0; i < 4 && q.length > 0; i++) taken.push(q.shift()!);
  for (const typeId of taken) M.deployUnit(G, 'Empire', typeId, sysId);
  log(G, { kind: 'imperial-might-deploy', side: 'Empire', payload: { systemId: sysId, unitTypes: taken } });
  if (ctx.leaderIds.length >= 2) {
    for (const lid of ctx.leaderIds) {
      M.returnLeader(G, 'Empire', lid);
      M.placeLeader(G, 'Empire', lid, 'coruscant');
    }
    log(G, { kind: 'imperial-might-move-leaders', side: 'Empire', payload: { leaderIds: ctx.leaderIds } });
  }
  return true;
};

/** We're the Bait: "Take 4-health of ground units from the Rebel Base and
 *  place them here. Resolve combat." Auto-picks ground units up to a
 *  4-health budget (smallest first so we use the budget efficiently). */
const weretheBait: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const baseSourceId = G.rebelBaseRevealed ? G.rebelBaseSystemId : 'rebel-base-space';
  const baseContainer = baseSourceId === 'rebel-base-space'
    ? G.map.rebelBaseSpace : G.map.systems[baseSourceId];
  if (!baseContainer) return true;
  // Smallest-health first so the 4-health budget covers the maximum unit count.
  const ground = baseContainer.units
    .filter((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')
    .slice()
    .sort((a, b) => (G.catalog.unitTypes[a.typeId]?.health.value ?? 0) - (G.catalog.unitTypes[b.typeId]?.health.value ?? 0));
  let budget = 4;
  const moved: string[] = [];
  for (const u of ground) {
    const h = G.catalog.unitTypes[u.typeId]?.health.value ?? 0;
    if (h === 0 || h > budget) continue;
    M.moveUnit(G, u.instanceId, baseSourceId, sysId);
    budget -= h;
    moved.push(u.typeId);
    if (budget === 0) break;
  }
  log(G, { kind: 'were-the-bait', side: 'Empire', payload: { systemId: sysId, moved } });
  triggerCombatAt(G, 'Empire', sysId);
  return true;
};

/** Exploit Weakness: "Rebel reveals 1 RANDOM Objective card from hand and
 *  places it on top of the deck." Uses the game RNG so it's deterministic
 *  per seed. */
const exploitWeakness: EffectHandler = (G, _ctx) => {
  const hand = G.rebel.objectiveHand ?? [];
  const deck = G.rebel.objectiveDeck;
  if (hand.length === 0 || !deck) return true;
  const idx = nextInt(G.rng, hand.length);
  const [picked] = hand.splice(idx, 1);
  deck.unshift(picked);
  log(G, { kind: 'exploit-weakness', side: 'Empire', payload: { objectiveId: picked } });
  return true;
};

// ----- Rebel Wave B -----

/** Heist (Jyn): "Remove 1 target marker. If on a Death Star or DSUC, you
 *  may draw the top objective card instead." Auto-picks the more powerful
 *  effect when both apply: draw an objective if a DS/DSUC is here. */
const heist: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const ss = G.map.systems[sysId];
  const hasDsOrDsuc = (ss?.units ?? []).some(
    (u) => u.side === 'Empire' && (u.typeId === 'death-star' || u.typeId === 'death-star-under-construction'),
  );
  if (hasDsOrDsuc) {
    // Strictly the better effect at a DS/DSUC site.
    M.drawObjective(G, 1);
    log(G, { kind: 'heist-draw-objective', side: 'Rebel', payload: { systemId: sysId } });
    return true;
  }
  // Remove any target marker present (RAW says "remove 1"). Take the first.
  const markers = ss?.targetMarkers ?? [];
  if (markers.length > 0) {
    M.removeTargetMarker(G, sysId, markers[0].source, 'Rebel');
  } else {
    log(G, { kind: 'heist-no-marker', side: 'Rebel', payload: { systemId: sysId } });
  }
  return true;
};

/** Plant Explosives: "Destroy up to 3 ground units, combined health up to
 *  the difference in successes." The handler runs only on success; we cap
 *  at 3 health-worth of Imperial ground units. The "difference in
 *  successes" refinement is a future polish pass — the engine doesn't pass
 *  that delta to handlers today. */
const plantExplosives: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  queueDestroyUpToHealth(G, 'Rebel', 'Empire', sysId, 3, 'Plant Explosives', 'ground');
  return true;
};

/** Assault: "Destroy up to 3 Stormtroopers, up to the difference in
 *  successes." Same successes-delta caveat as Plant Explosives; cap at 3
 *  Stormtroopers (each 1 health, so it's also a 3-health cap by side
 *  effect — but type-restricted). */
const assault: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const ss = G.map.systems[sysId];
  if (!ss) return true;
  const stormtroopers = ss.units
    .filter((u) => u.side === 'Empire' && u.typeId === 'stormtrooper')
    .slice(0, 3);
  for (const u of stormtroopers) M.destroyUnit(G, u.instanceId, 'assault');
  log(G, { kind: 'assault-destroy', side: 'Rebel', payload: { systemId: sysId, count: stormtroopers.length } });
  return true;
};

/** Safe Haven: "Take up to 2 units from the build queue and deploy them
 *  here." Pulls 2 unit types from the Rebel build queue (slot 1, then 2,
 *  then 3) and deploys to the target. */
const safeHaven: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const taken: string[] = [];
  for (const slot of [1, 2, 3] as const) {
    const q = G.rebel.buildQueue[slot];
    while (taken.length < 2 && q.length > 0) taken.push(q.shift()!);
    if (taken.length === 2) break;
  }
  for (const typeId of taken) M.deployUnit(G, 'Rebel', typeId, sysId);
  log(G, { kind: 'safe-haven-deploy', side: 'Rebel', payload: { systemId: sysId, unitTypes: taken } });
  return true;
};

// ============================================================================
// Rise of the Empire — Wave C handlers (Phase 5b)
// ============================================================================
//
// The harder missions: a project, the cap-ship-on-DS effect, and a few
// auto-pick stubs for cards whose RAW text needs a real choice UI to
// honour fully. Notes on each handler call out where the auto-pick is
// just a placeholder vs. where the card resolves cleanly.

// ----- Imperial Wave C -----

/** Interdictor Development (project, 2 leaders): "Place 1 Interdictor on
 *  build space 2. If 2 leaders are assigned, place on space 1 and return
 *  the card." The "return the card" clause = card goes back to the
 *  Imperial mission hand instead of the project discard pile. */
const interdictorDevelopment: EffectHandler = (G, ctx) => {
  const twoLeaders = ctx.leaderIds.length >= 2;
  const slot: 1 | 2 = twoLeaders ? 1 : 2;
  M.buildToQueue(G, 'Empire', 'interdictor', slot);
  if (twoLeaders) {
    // Card returns to hand instead of the discard. We can't intercept the
    // discard from here (the mission-resolution path does it), so we flag
    // it and let the mission flow consume the flag. For now log the
    // intent so a follow-up can pick it up.
    log(G, { kind: 'mission-return-to-hand-flag', side: 'Empire', payload: {
      missionId: ctx.card.id, reason: 'interdictor-development-2-leaders',
    }});
  }
  return true;
};

/** Single Reactor Ignition (project): "Resolve on a Death Star (not DSUC).
 *  Rebels must reveal base if in this system. Destroy any Rebel ground
 *  units and remove any target markers in system." */
const singleReactorIgnition: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  if (G.rebelBaseSystemId === sysId && !G.rebelBaseRevealed) {
    M.revealRebelBase(G, 'single-reactor-ignition');
  }
  const ss = G.map.systems[sysId];
  if (ss) {
    const rebelGround = ss.units
      .filter((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')
      .map((u) => u.instanceId);
    for (const id of rebelGround) M.destroyUnit(G, id, 'single-reactor-ignition');
    // Remove every target marker on this system (whoever placed it).
    if (ss.targetMarkers?.length) {
      const sources = ss.targetMarkers.map((m) => m.source);
      for (const src of sources) M.removeTargetMarker(G, sysId, src, 'Empire');
    }
    log(G, { kind: 'single-reactor-ignition', side: 'Empire', payload: {
      systemId: sysId, groundDestroyed: rebelGround.length,
    }});
  }
  return true;
};

/** Break Their Will: "Name a system; Rebel must tell you if their base is
 *  in that system's region." Auto-picks the first populous, non-Coruscant
 *  system that hasn't been ruled out — same heuristic as a fresh probe. */
const breakTheirWill: EffectHandler = (G, ctx) => {
  // Default the region check to the target system's region if no naming UI
  // hooked up. Realistic Empire play would name a system in an UNCHECKED
  // region; we approximate by picking the alphabetically-first populous
  // non-Coruscant system not already in the rule-out list.
  const ruledOut = new Set(G.empireSearchedRuledOut ?? []);
  const candidate = Object.values(G.catalog.systems)
    .filter((s) => !s.isRemote && !s.isCoruscant && !ruledOut.has(s.id))
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!candidate) return true;
  const baseDef = G.catalog.systems[G.rebelBaseSystemId];
  const inRegion = !!baseDef && baseDef.region === candidate.region;
  log(G, { kind: 'break-their-will-probe', side: 'Empire', payload: {
    systemId: candidate.id, region: candidate.region, baseInRegion: inRegion,
  }});
  pushNotice(G, `btw-${candidate.id}-t${G.timeMarker}`, 'Break Their Will',
    inRegion
      ? `The Rebel base IS in ${candidate.name}'s region.`
      : `The Rebel base is NOT in ${candidate.name}'s region.`);
  return true;
};

/** Draw Them Out (Krennic): "Choose a Rebel leader in the leader pool;
 *  place that leader in this system." Auto-picks the first eligible. */
const drawThemOut: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const lid = G.rebel.leaderPool[0];
  if (!lid) return true;
  // Remove from pool and place on the board at the targeted system.
  G.rebel.leaderPool.shift();
  M.placeLeader(G, 'Rebel', lid, sysId);
  log(G, { kind: 'draw-them-out', side: 'Empire', payload: { leaderId: lid, systemId: sysId } });
  return true;
};

// ----- Rebel Wave C -----

/** Aggressive Negotiations (Chirrut): rescue the captured leader at the
 *  target system. RAW also has a fail-only side effect ("destroy 1 triangle
 *  ground unit") — that doesn't fire here because handlers only run on
 *  mission success; the fail path is a future enhancement. */
const aggressiveNegotiations: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const cap = (G.empire.capturedLeaders ?? []).find((c) => c.systemId === sysId);
  if (cap) M.rescueLeader(G, cap.leaderId, 'aggressive-negotiations');
  return true;
};

/** Prepare for Battle (Gerrera): "Return assigned leaders to the pool.
 *  Look at the top 4 cards of any tactic deck and place them top/bottom in
 *  any order, OR return discarded Rebel advanced tactic cards to their
 *  decks." We honour the leader-return part now; the choice between the
 *  two effects + the peek/reorder needs a tactic-deck choice UI that
 *  doesn't exist yet — surface a notice so the player can resolve it by
 *  hand. */
const prepareForBattle: EffectHandler = (G, ctx) => {
  for (const lid of ctx.leaderIds) M.returnLeader(G, 'Rebel', lid);
  pushNotice(G, `pfb-t${G.timeMarker}`, 'Prepare For Battle',
    'Assigned leaders are back in the pool. Now look at the top 4 of any ' +
    'tactic deck and rearrange, or return discarded Rebel advanced tactic ' +
    'cards to their decks. Resolve the choice manually until the tactic-deck ' +
    'UI lands.');
  return true;
};

/** Secret Mission (Andor): "Look at the top 6 mission cards; keep 1 and
 *  shuffle the deck. If Andor is assigned, you may keep 2 cards." Auto-keeps
 *  the first card (and the second when Andor is on the mission), then
 *  shuffles the rest. */
const secretMission: EffectHandler = (G, ctx) => {
  const deck = G.rebel.missionDeck;
  if (!deck || deck.length === 0) return true;
  const keepCount: 1 | 2 = ctx.leaderIds.includes('cassian-andor') ? 2 : 1;
  const n = Math.min(6, deck.length);
  const peek = deck.splice(0, n);
  if (peek.length <= keepCount) {
    // Trivial: everything peeked goes to hand, nothing to shuffle back.
    for (const mid of peek) G.rebel.missionHand.push(mid);
    log(G, { kind: 'secret-mission', side: 'Rebel', payload: {
      kept: peek, andor: keepCount === 2, autoTrivial: true,
    }});
    return true;
  }
  G.pendingChoice = {
    kind: 'SecretMissionPick',
    side: 'Rebel',
    remaining: peek,
    kept: [],
    keepCount,
  };
  log(G, { kind: 'choice-request', side: 'Rebel', payload: {
    kind: 'SecretMissionPick', peekCount: peek.length, keepCount,
  }});
  return false;
};

/** Behind Enemy Lines: "Move 5 units from the Rebel Base, ignoring leaders
 *  and adjacency. Resolve combat." Auto-picks the first 5 units from the
 *  base space (any theatre). Lead the Strike Team's full unit-picker UI is
 *  the right long-term fit; this is the no-choice MVP. */
const behindEnemyLines: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const baseSourceId = G.rebelBaseRevealed ? G.rebelBaseSystemId : 'rebel-base-space';
  const baseContainer = baseSourceId === 'rebel-base-space'
    ? G.map.rebelBaseSpace : G.map.systems[baseSourceId];
  if (!baseContainer) return true;
  const taking = baseContainer.units.filter((u) => u.side === 'Rebel').slice(0, 5);
  for (const u of taking) M.moveUnit(G, u.instanceId, baseSourceId, sysId);
  log(G, { kind: 'behind-enemy-lines', side: 'Rebel', payload: {
    systemId: sysId, moved: taking.length,
  }});
  triggerCombatAt(G, 'Rebel', sysId);
  return true;
};

// ============================================================================
// Defaults / helpers
// ============================================================================

// ============================================================================
// Tactic card handlers — REMOVED (all effects live in src/engine/combat.ts).
// ============================================================================
//
// Historical note: this file previously registered 12 `() => true` stubs for
// every tactic card. They were never actually invoked — the handler registry
// is consulted only by `runMissionEffect` in phases.ts (for mission cards
// and projects), never for tactic cards. Tactic-card effects live inline
// in combat.ts at the appropriate combat-machine pause points:
//   - concentrate-fire    → combat.ts:608  (reroll up to 2 blanks)
//   - take-it-down        → combat.ts:633  (+2 damage, same target)
//   - onslaught           → combat.ts:634  (+1 damage × 2 different targets)
//   - critical-hit        → combat.ts:635  (+1 damage)
//   - defensive-formation → combat.ts:714  (free block 1)
//   - dig-in / outmaneuver→ combat.ts:719  (block 1, discard 1 to sacrifice)
//   - brilliant-strategy  → combat.ts:966  (draw 1 space + 1 ground)
//   - bombardment         → combat.ts:978  (ship attack value as ground dmg)
//   - unstoppable-assault → combat.ts:999  (opponent cannot block step)
//   - no-escape           → combat.ts:1011 (opponent cannot retreat this round)
//   - escape-plan         → combat.ts:1021 (retreat ignores transport)
//
// Deleting the stubs eliminates ~25 lines of misleading dead code and
// removes the risk that someone "fixes" a tactic card by editing a no-op
// here when the real implementation is elsewhere.

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

  // ----- Rise of the Empire — Wave A (Phase 5b) -----
  // Imperial
  register('deployment', deployment);
  register('message-from-high-command', messageFromHighCommand);
  register('stolen-intel', stolenIntel);
  register('hire-mercenaries', hireMercenaries);
  register('imperial-promotion', imperialPromotion);
  register('discredit-rebellion', discreditRebellion);
  // Rebel
  register('regional-aid', regionalAid);
  register('reconnaissance', reconnaissance);
  register('critical-rescue', criticalRescue);
  register('rebel-promotion', rebelPromotion);
  register('my-only-hope', myOnlyHope);
  // RoE "Covert Operations" (plural) has the same effect as the base
  // "Covert Operation" (singular) — reuse the existing handler.
  register('covert-operations', covertOperation);

  // ----- Rise of the Empire — Wave B (Phase 5b) -----
  // Imperial
  register('secure-the-plans', secureThePlans);
  register('make-an-example', makeAnExample);
  register('imperial-might', imperialMight);
  register('were-the-bait', weretheBait);
  register('exploit-weakness', exploitWeakness);
  // Rebel
  register('heist', heist);
  register('plant-explosives', plantExplosives);
  register('assault', assault);
  register('safe-haven', safeHaven);

  // ----- Rise of the Empire — Wave C (Phase 5b) -----
  // Imperial
  register('interdictor-development', interdictorDevelopment);
  register('single-reactor-ignition', singleReactorIgnition);
  register('break-their-will', breakTheirWill);
  register('draw-them-out', drawThemOut);
  // Rebel
  register('aggressive-negotiations', aggressiveNegotiations);
  register('prepare-for-battle', prepareForBattle);
  register('secret-mission', secretMission);
  register('behind-enemy-lines', behindEnemyLines);
  // Subversion (New/Original) intentionally left unbound — those are
  // opposition-only missions and the engine doesn't dispatch them through
  // the normal handler flow yet. They remain data-only.

  // Tactic cards (stubs)
  // No tactic-card registrations: those effects live inline in combat.ts.
  // See the comment block in this file for the per-card index.
}
