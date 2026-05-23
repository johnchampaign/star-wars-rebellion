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
  return true;
};

// ----- Imperial starting -----

const captureRebelOperative: EffectHandler = (G, ctx) => {
  // RAW: "Capture a Rebel leader in a system that contains an Imperial
  // unit." When multiple Rebel leaders are at the target, Empire chooses.
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const here = G.rebel.leadersOnBoard[sysId] ?? [];
  if (here.length === 0) return true;
  // Honor explicit leader pick from reveal-step UI; else fall through.
  if (ctx.targetLeaderId && here.includes(ctx.targetLeaderId)) {
    M.captureLeader(G, ctx.targetLeaderId, 'captured');
    return true;
  }
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
  if (rebelHere.length === 0) return true;
  // Pick the specific leader the Empire targeted at mission reveal time.
  // Fall back to highest-value if no explicit pick (legacy / AI without
  // leader-aware picker).
  let capturedId: string;
  if (ctx.targetLeaderId && rebelHere.includes(ctx.targetLeaderId)) {
    capturedId = ctx.targetLeaderId;
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
 *  We greedy-pack: take all transport-capacity ships, then fit fighters/
 *  ground into available capacity (capital ships first, then fighters in
 *  order, then ground). Units that don't fit stay at the Rebel Base. */
const hiddenFleet: EffectHandler = (G, ctx) => {
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const baseUnits = [...G.map.rebelBaseSpace.units].filter((u) => u.side === 'Rebel');
  const T = (uid: string) => {
    const u = baseUnits.find((x) => x.instanceId === uid);
    return u ? G.catalog.unitTypes[u.typeId] : null;
  };
  // Always-mobile capacity ships first.
  const capacityShipUids: string[] = [];
  const restrictionUids: string[] = []; // fighters
  const groundUids: string[] = [];
  for (const u of baseUnits) {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.transport.immobile) continue;
    if (t.transport.capacity > 0) capacityShipUids.push(u.instanceId);
    else if (t.transport.restriction) restrictionUids.push(u.instanceId);
    else if (t.theater === 'ground' && t.class !== 'structure') groundUids.push(u.instanceId);
  }
  let capacity = capacityShipUids.reduce((sum, uid) => sum + (T(uid)?.transport.capacity ?? 0), 0);
  const toMove: string[] = [...capacityShipUids];
  // Fighters next, then ground — each consumes 1 capacity. Stop when full.
  for (const uid of [...restrictionUids, ...groundUids]) {
    if (capacity <= 0) break;
    toMove.push(uid);
    capacity--;
  }
  for (const uid of toMove) M.moveUnit(G, uid, 'rebel-base-space', sysId);
  log(G, { kind: 'hidden-fleet-move', side: 'Rebel', payload: {
    targetSystemId: sysId,
    moved: toMove.length,
    leftBehind: baseUnits.length - toMove.length,
    note: 'Adjacency bypassed; transport restrictions still enforced.',
  }});
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
  const slot = (sysDef.buildSlot ?? 1) as 1 | 2 | 3;
  const added: string[] = [];
  for (const icon of sysDef.resources) {
    const choice = defaultUnitForIcon('Rebel', icon.type, icon.shape);
    if (choice) {
      // Pass sourceSystemId so the build-queue log entry is searchable
      // back to this mission (and the refresh-report can show "built X
      // from Y" attribution).
      M.buildToQueue(G, 'Rebel', choice, slot, sysId);
      added.push(choice);
    }
  }
  // Loud summary event the UI/log can surface — RAW outcome: "place units
  // on the build queue using this system's resource icons and number."
  log(G, { kind: 'establish-trade-relations-built', side: 'Rebel', payload: {
    systemId: sysId, slot, added,
    note: added.length === 0
      ? 'System has no resource icons; no units added to the queue.'
      : `Added ${added.length} unit(s) to build queue slot ${slot} (from ${sysDef.name}'s resource icons).`,
  }});
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
  G.pendingChoice = {
    kind: 'HomingBeaconPlace',
    side: 'Empire',
    leaderCandidates,
    systemCandidates,
  };
  log(G, { kind: 'choice-request', side: 'Empire', payload: {
    kind: 'HomingBeaconPlace', leaders: leaderCandidates.length, systems: systemCandidates.length,
  }});
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
  const sysId = ctx.targetSystemId;
  if (!sysId) return true;
  const here = G.rebel.leadersOnBoard[sysId] ?? [];
  if (here.length === 0) {
    log(G, { kind: 'detained-noop', side: 'Empire', payload: { systemId: sysId, reason: 'no-rebel-leaders-at-target' } });
    return true;
  }
  // Honor explicit leader pick from reveal-step UI; else fall through to
  // single-or-modal path.
  if (ctx.targetLeaderId && here.includes(ctx.targetLeaderId)) {
    markDetained(G, ctx.targetLeaderId);
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

  // Tactic cards (stubs)
  // No tactic-card registrations: those effects live inline in combat.ts.
  // See the comment block in this file for the per-card index.
}
