// Minimal random AI for development. Makes valid, mostly-random choices in
// every phase so a solo human can play through end-to-end. Intentionally dumb:
// no heuristics, no lookahead. Replace with a real controller later.
//
// Contract: stepOnce(G, side) performs exactly one engine call when it's `side`'s
// turn. The caller is expected to call it in a loop (with refresh in between)
// until G.currentPlayer flips back to the human, the game ends, or we're in a
// state with no valid AI action.

import type { GameState, Side, LeaderId } from '../engine/types';
import * as phases from '../engine/phases';
import * as combat from '../engine/combat';

function pick<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Run one AI action for `side`. Returns true if something happened (caller
 *  should re-render and may call again), false if nothing left to do. */
export function stepOnce(G: GameState, side: Side): boolean {
  if (G.isGameOver) return false;

  // Pending-choice handlers run REGARDLESS of whose turn it is: an opponent
  // can owe a choice (e.g. OpposeMission during the other side's turn,
  // CombatAttackerTactics/CombatDefenderTactics mid-combat).
  if (G.pendingChoice && G.pendingChoice.kind === 'OpposeMission' && G.pendingChoice.opposerSide === side) {
    console.log('[ai] handleOpposeMission', { side, choice: G.pendingChoice });
    const ok = handleOpposeMission(G, side);
    console.log('[ai] handleOpposeMission done', { ok, newChoice: G.pendingChoice?.kind });
    return ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatAttackerTactics' && G.pendingChoice.side === side) {
    return handleCombatAttackerTactics(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatDefenderTactics' && G.pendingChoice.side === side) {
    return handleCombatDefenderTactics(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'BuildPick' && G.pendingChoice.side === side) {
    return handleBuildPick(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatAssignDamage' && G.pendingChoice.side === side) {
    return handleCombatAssignDamage(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'YodaReroll' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    if (c.context === 'mission') {
      // AI: always reroll the first blank (it's a free upgrade — same
      // policy as the auto-apply we replaced).
      const idx = c.blankIndices[0] ?? null;
      return phases.resolveYodaMissionReroll(G, idx).ok;
    }
    return handleYodaReroll(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'R2D2Flip' && G.pendingChoice.side === side) {
    // AI Rebel: flip the most valuable Empire die.
    const c = G.pendingChoice;
    const score = (face: string) =>
      face === 'direct-hit' ? 4 : face === 'hit' ? 3 : face === 'special' ? 2 : 0;
    let bestIdx = -1;
    let bestScore = -1;
    // Source the faces from the appropriate context.
    let faces: string[] = [];
    if (c.context === 'combat') {
      const dice = G.pendingCombat?.pendingAttack?.dice ?? [];
      faces = dice.map((d) => d.face);
    } else {
      faces = c.missionFaces ?? [];
    }
    for (const i of c.flippableDieIndices) {
      const s = score(faces[i] ?? 'blank');
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    // AI policy: only spend the once-per-game card if the target is at least
    // a hit (worth 3+). Otherwise save it.
    const flipIndex = bestScore >= 3 ? bestIdx : null;
    if (c.context === 'mission') return phases.resolveR2D2MissionFlip(G, flipIndex).ok;
    return combat.resolveR2D2Flip(G, flipIndex).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'SpecialDieSpend' && G.pendingChoice.side === side) {
    return handleSpecialDieSpend(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatStartActionCards' && G.pendingChoice.side === side) {
    return handleCombatStartActionCards(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RetreatDecision' && G.pendingChoice.side === side) {
    return handleRetreatDecision(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DeathStarPlansAttempt' && G.pendingChoice.side === side) {
    // AI: always attempt — it's a free shot at destroying the Death Star.
    return combat.resolveDeathStarPlansAttempt(G, true).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'MoreDangerousTheaterPick' && G.pendingChoice.side === side) {
    // AI: pick the deck with more remaining cards (avoid drawing 0 of 0).
    const theater: 'space' | 'ground' = G.groundTacticDeck.length >= G.spaceTacticDeck.length ? 'ground' : 'space';
    return combat.resolveMoreDangerousTheaterPick(G, theater).ok;
  }
  // Assignment-timed action card play: the AI never proactively opens this
  // modal (random Assignment branch just assigns or skips). But if for some
  // reason the choice is posted, cancel out / pick a random candidate-system
  // so we don't deadlock.
  if (G.pendingChoice && G.pendingChoice.kind === 'PlayAssignmentActionCard' && G.pendingChoice.side === side) {
    return phases.cancelAssignmentActionCardPlay(G).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ActionCardSystemPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const sysId = pick(c.candidates);
    if (!sysId) return false;
    return phases.resolveActionCardSystemPick(G, sysId).ok;
  }

  // RecruitActionCardPick fires during the Refresh phase where
  // G.currentPlayer doesn't match the side that owes the choice (refresh
  // is bilateral). Handle it before the "my turn only" gate so the AI
  // doesn't deadlock when its own recruit pick is queued during Rebel's
  // refresh turn (or vice versa).
  if (G.pendingChoice && G.pendingChoice.kind === 'RecruitActionCardPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const f = side === 'Rebel' ? G.rebel : G.empire;
    const canRecruit = (cid: string) => {
      const card = G.catalog.actions[cid];
      if (!card?.leaderRequirement?.length) return false;
      const lid = card.leaderRequirement[0];
      return !!G.catalog.leaders[lid] && !f.leaderPool.includes(lid) && !f.eliminatedLeaders.includes(lid);
    };
    const [a, b] = c.drawnIds;
    const keep = canRecruit(a) ? a : canRecruit(b) ? b : a;
    return phases.resolveRecruitActionCardPick(G, keep).ok;
  }
  // BuildPick is also bilateral during refresh — same fix.
  if (G.pendingChoice && G.pendingChoice.kind === 'BuildPick' && G.pendingChoice.side === side) {
    return handleBuildPick(G);
  }
  // DeployUnitPick is also a bilateral refresh-phase pause.
  if (G.pendingChoice && G.pendingChoice.kind === 'DeployUnitPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const sysId = c.candidates[0]; // first legal target — dumb but deterministic
    return phases.resolveDeployUnitPick(G, sysId).ok;
  }
  // Detained: Empire picks any Rebel leader at the target.
  if (G.pendingChoice && G.pendingChoice.kind === 'DetainedTargetPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveDetainedTargetPick(G, c.candidates[0]).ok;
  }
  // Retrieve The Plans: Empire bottoms the highest-rep Rebel objective.
  if (G.pendingChoice && G.pendingChoice.kind === 'RetrieveThePlansPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestRep = G.catalog.objectives[best]?.reputation ?? 0;
    for (const oid of c.candidates.slice(1)) {
      const r = G.catalog.objectives[oid]?.reputation ?? 0;
      if (r > bestRep) { best = oid; bestRep = r; }
    }
    return phases.resolveRetrieveThePlansPick(G, best).ok;
  }
  // Our Most Desperate Hour: pick a random mission from the deck.
  if (G.pendingChoice && G.pendingChoice.kind === 'OurMostDesperateHourPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveOurMostDesperateHourPick(G, c.candidates[0]).ok;
  }
  // Proceeding As Planned: pick a random project from the deck.
  if (G.pendingChoice && G.pendingChoice.kind === 'ProceedingAsPlannedPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveProceedingAsPlannedPick(G, c.candidates[0]).ok;
  }
  // Start The Evacuation: pick the first non-Imperial system, move all
  // mobile Rebel Base units that fit.
  if (G.pendingChoice && G.pendingChoice.kind === 'StartEvacuationPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const target = c.candidateSystemIds[0];
    if (!target) return phases.resolveStartEvacuationPick(G, '', []).ok;
    // Greedy pack like Hidden Fleet.
    const baseUnits = G.map.rebelBaseSpace.units.filter((u) => c.candidateUnitIds.includes(u.instanceId));
    const capShipIds: string[] = [];
    const fighterIds: string[] = [];
    const groundIds: string[] = [];
    for (const u of baseUnits) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      if (t.transport.capacity > 0) capShipIds.push(u.instanceId);
      else if (t.transport.restriction) fighterIds.push(u.instanceId);
      else if (t.theater === 'ground' && t.class !== 'structure') groundIds.push(u.instanceId);
    }
    let cap = capShipIds.reduce((s, uid) => {
      const u = baseUnits.find((x) => x.instanceId === uid);
      return s + (u ? (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) : 0);
    }, 0);
    const picks = [...capShipIds];
    for (const uid of [...fighterIds, ...groundIds]) {
      if (cap <= 0) break;
      picks.push(uid); cap--;
    }
    return phases.resolveStartEvacuationPick(G, target, picks).ok;
  }
  // Independent Operation: Empire picks first Imperial system to retreat to.
  if (G.pendingChoice && G.pendingChoice.kind === 'IndependentOperationEvacPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveIndependentOperationEvacPick(G, c.candidateSystemIds[0]).ok;
  }
  // Hidden Fleet: greedy-pack capital ships first, then fighters/ground
  // up to capacity. Mirrors the old engine auto-pick heuristic.
  if (G.pendingChoice && G.pendingChoice.kind === 'HiddenFleetUnitPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const baseUnits = G.map.rebelBaseSpace.units.filter((u) => c.candidateUnitIds.includes(u.instanceId));
    const capShipIds: string[] = [];
    const fighterIds: string[] = [];
    const groundIds: string[] = [];
    for (const u of baseUnits) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      if (t.transport.capacity > 0) capShipIds.push(u.instanceId);
      else if (t.transport.restriction) fighterIds.push(u.instanceId);
      else if (t.theater === 'ground' && t.class !== 'structure') groundIds.push(u.instanceId);
    }
    let capacity = capShipIds.reduce((s, uid) => {
      const u = baseUnits.find((x) => x.instanceId === uid);
      return s + (u ? (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) : 0);
    }, 0);
    const picks = [...capShipIds];
    for (const uid of [...fighterIds, ...groundIds]) {
      if (capacity <= 0) break;
      picks.push(uid); capacity--;
    }
    return phases.resolveHiddenFleetUnitPick(G, picks).ok;
  }
  // Temporary Alliance: default unit per icon (lowest-tier matching).
  if (G.pendingChoice && G.pendingChoice.kind === 'TemporaryAllianceBuildPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const pickDefault = (icon: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }): string | null => {
      if (icon.theater === 'space') {
        if (icon.shape === 'triangle') return 'x-wing';
        if (icon.shape === 'circle') return 'corellian-corvette';
        return 'mc-cruiser';
      }
      if (icon.shape === 'triangle') return 'rebel-trooper';
      // No square ground unit for Rebel — fall back to airspeeder.
      return 'airspeeder';
    };
    const picks = c.icons.map(pickDefault);
    return phases.resolveTemporaryAllianceBuildPick(G, picks).ok;
  }
  // Contingency Plan: pick a random starting mission from the candidates.
  if (G.pendingChoice && G.pendingChoice.kind === 'ContingencyPlanPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveContingencyPlanPick(G, c.candidates[0]).ok;
  }
  // Rapid Mobilization: prefer establish-base (always-available) over
  // move-units; AI doesn't have great unit-selection heuristics for the
  // move branch.
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationBranch' && G.pendingChoice.side === side) {
    return phases.resolveRapidMobilizationBranch(G, 'establish-base').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationMovePick' && G.pendingChoice.side === side) {
    // Find any Rebel-occupied system and move up to 5 units to base.
    let srcSys: string | null = null;
    let picks: string[] = [];
    for (const sysId of Object.keys(G.map.systems)) {
      const rebels = G.map.systems[sysId].units.filter((u) => u.side === 'Rebel');
      if (rebels.length > 0) { srcSys = sysId; picks = rebels.slice(0, 5).map((u) => u.instanceId); break; }
    }
    if (!srcSys) {
      // Nothing to move — bail without picks.
      return phases.resolveRapidMobilizationMove(G, Object.keys(G.map.systems)[0], []).ok;
    }
    return phases.resolveRapidMobilizationMove(G, srcSys, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationBasePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const candidates = c.baseRevealed
      ? Object.keys(G.map.systems)
      : (c.probeSystemIds ?? []);
    if (candidates.length === 0) {
      // No legal target — just clear the choice via no-op (pick current base
      // — engine will accept any valid system in revealed case).
      const fallback = Object.keys(G.map.systems)[0];
      return phases.resolveRapidMobilizationBasePick(G, fallback).ok;
    }
    return phases.resolveRapidMobilizationBasePick(G, candidates[0]).ok;
  }
  // Interrogation Droid: Rebel picks 2 decoy systems that AREN'T the base.
  if (G.pendingChoice && G.pendingChoice.kind === 'InterrogationDroidDecoyPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const decoys = c.candidates.filter((sid) => sid !== G.rebelBaseSystemId).slice(0, c.count);
    return phases.resolveInterrogationDroidDecoyPick(G, decoys).ok;
  }

  // From here on, only act on our own turn.
  if (G.currentPlayer !== side) return false;

  // If a player choice is pending and this side owns it, resolve it first.
  if (G.pendingChoice && G.pendingChoice.kind === 'StolenPlansReorder' && side === 'Rebel') {
    const c = G.pendingChoice;
    // Pick the highest-rep remaining card to place next on top.
    let best = c.remaining[0];
    let bestRep = G.catalog.objectives[best]?.reputation ?? 0;
    for (const cid of c.remaining.slice(1)) {
      const rep = G.catalog.objectives[cid]?.reputation ?? 0;
      if (rep > bestRep) { best = cid; bestRep = rep; }
    }
    const r = phases.resolveStolenPlansPick(G, best);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PlanTheAssaultShips' && side === 'Rebel') {
    // AI: send every available ship.
    const c = G.pendingChoice;
    const r = phases.resolvePlanTheAssaultShips(G, c.availableShipIds);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DestroyUpToHealth' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const sorted = c.candidates
      .map((uid) => {
        const u = ss?.units.find((x) => x.instanceId === uid);
        const t = u ? G.catalog.unitTypes[u.typeId] : null;
        return { uid, hp: t?.health.value ?? 0, tier: tierRank[t?.tier ?? 'triangle'] ?? 0 };
      })
      .sort((a, b) => b.tier - a.tier || b.hp - a.hp);
    let spent = 0;
    const picks: string[] = [];
    for (const x of sorted) {
      if (spent + x.hp > c.budget) continue;
      picks.push(x.uid); spent += x.hp;
    }
    return phases.resolveDestroyUpToHealth(G, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RogueSquadronRaidPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const sorted = [...c.candidates].sort((a, b) => b.health - a.health);
    let spent = 0;
    const picks: { slot: 1 | 2 | 3; queueIndex: number }[] = [];
    for (const x of sorted) {
      if (spent + x.health > c.budget) continue;
      picks.push({ slot: x.slot, queueIndex: x.queueIndex });
      spent += x.health;
    }
    return phases.resolveRogueSquadronRaidPick(G, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DoubleOurEffortsPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const sorted = [...c.candidates].sort((a, b) => {
      const tA = tierRank[G.catalog.unitTypes[a.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      const tB = tierRank[G.catalog.unitTypes[b.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      return tB - tA || a.slot - b.slot;
    });
    return phases.resolveDoubleOurEffortsPick(G, sorted.slice(0, c.picksAllowed).map((x) => ({ slot: x.slot, queueIndex: x.queueIndex }))).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PlanetaryConquestSourcePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const best = c.sources.reduce((a, b) => (b.picks.length > a.picks.length ? b : a));
    return phases.resolvePlanetaryConquestSourcePick(G, best.sourceSystemId).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'FearWillKeepThemInLinePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Prefer non-Imperial systems first.
    const ranked = [...c.candidates].sort((a, b) => {
      const aRebel = G.map.systems[a]?.loyalty !== 'imperial' ? 1 : 0;
      const bRebel = G.map.systems[b]?.loyalty !== 'imperial' ? 1 : 0;
      return bRebel - aRebel;
    });
    return phases.resolveFearWillKeepThemInLinePick(G, ranked.slice(0, c.count)).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PublicUprisingPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId];
    let empireSpace = 0, empireGround = 0;
    if (ss) for (const u of ss.units) {
      if (u.side !== 'Empire') continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (t?.theater === 'space') empireSpace++; else empireGround++;
    }
    const circle = empireGround > empireSpace ? 'airspeeder' : 'corellian-corvette';
    const triangle = (empireSpace > 0 && empireGround === 0) ? 'x-wing' : 'rebel-trooper';
    return phases.resolvePublicUprisingPick(G, { circle, triangles: [triangle, triangle] }).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'SupportOfMonCalamariPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const alreadyRebel = c.monCalaLoyalty === 'rebel' && !c.monCalaSubjugated;
    return phases.resolveSupportOfMonCalamariPick(G, alreadyRebel ? 'cruiser' : 'loyalty').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'MisdirectionPick' && G.pendingChoice.side === side) {
    // AI: protect the highest-value Rebel leader.
    const c = G.pendingChoice;
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics + l.tacticValues.space + l.tacticValues.ground) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveMisdirectionPick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ResearchAndDevelopmentOption' && side === 'Empire') {
    // AI: cleanse sabotage if available (B), else peek-and-keep (A).
    const c = G.pendingChoice;
    return phases.resolveResearchAndDevelopmentOption(G, c.hasSabotage ? 'B' : 'A').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ResearchAndDevelopmentProjectPick' && side === 'Empire') {
    // AI: keep the first card (heuristic — both project cards are valuable).
    const c = G.pendingChoice;
    return phases.resolveResearchAndDevelopmentProjectPick(G, c.drawnIds[0]).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'OverseeProjectPick' && side === 'Empire') {
    const c = G.pendingChoice;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    let best = c.candidates[0];
    for (const cand of c.candidates.slice(1)) {
      const r = tierRank[G.catalog.unitTypes[cand.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      const rBest = tierRank[G.catalog.unitTypes[best.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      if (r > rBest || (r === rBest && cand.slot < best.slot)) best = cand;
    }
    return phases.resolveOverseeProjectPick(G, best.queueIndex, best.slot).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CaptureOperativePick' && side === 'Empire') {
    const c = G.pendingChoice;
    // Pick highest-value Rebel leader (catalog skills sum).
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics + l.tacticValues.space + l.tacticValues.ground) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveCaptureOperativePick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CarbonFreezingPick' && side === 'Empire') {
    const c = G.pendingChoice;
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveCarbonFreezingPick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'LureOfTheDarkSidePick' && side === 'Empire') {
    const c = G.pendingChoice;
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveLureOfTheDarkSidePick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'HomingBeaconPlace' && side === 'Empire') {
    const c = G.pendingChoice;
    // AI: rescue highest-value leader; place at first system in region.
    let best = c.leaderCandidates[0]; let bestV = -1;
    for (const lid of c.leaderCandidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveHomingBeaconPlace(G, best, c.systemCandidates[0]).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CovertOperationPick' && side === 'Rebel') {
    // AI: keep the higher-rep card.
    const c = G.pendingChoice;
    const [a, b] = c.drawnIds;
    const repA = G.catalog.objectives[a]?.reputation ?? 0;
    const repB = G.catalog.objectives[b]?.reputation ?? 0;
    const keep = repA >= repB ? a : b;
    const r = phases.resolveCovertOperationPick(G, keep);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'InfiltrationPick' && side === 'Rebel') {
    const c = G.pendingChoice;
    const repTop = G.catalog.objectives[c.topId]?.reputation ?? 0;
    const repBottom = G.catalog.objectives[c.bottomId]?.reputation ?? 0;
    const keep = repTop >= repBottom ? c.topId : c.bottomId;
    const r = phases.resolveInfiltrationPick(G, keep);
    return r.ok;
  }
  switch (G.phase) {
    case 'Setup': {
      // If we're the Rebel and a base pick is pending, pick first.
      if (side === 'Rebel' && G.pendingRebelBasePick && G.pendingRebelBasePick.length > 0) {
        const picked = pick(G.pendingRebelBasePick)!;
        const r = phases.pickRebelBase(G, picked);
        if (r.ok) return true;
      }
      // Auto-fill all remaining units for this side.
      const r = phases.setupAutoFill(G, side);
      return r.ok;
    }
    case 'Assignment': {
      // 50/50: try assigning one random leader to one random mission, else skip.
      const f = side === 'Rebel' ? G.rebel : G.empire;
      if (Math.random() < 0.5 && f.missionHand.length > 0 && f.leaderPool.length > 0) {
        const missionId = pick(f.missionHand)!;
        const leaderId = pick(f.leaderPool)! as LeaderId;
        const r = phases.assignLeader(G, side, missionId, [leaderId]);
        if (r.ok) return true;
        // fall through to skip if invalid
      }
      const r = phases.skipAssignment(G, side);
      return r.ok;
    }
    case 'Command': {
      // Priority 1: if any assigned mission has enough skill, reveal it
      // (random target system). This keeps assigned missions from sitting
      // unresolved forever.
      const f = side === 'Rebel' ? G.rebel : G.empire;
      const revealable = f.leadersOnMissions.filter((am) => {
        const card = G.catalog.missions[am.missionId];
        if (!card || !card.skill) return false;
        let total = 0;
        for (const lid of am.leaderIds) {
          const ld = G.catalog.leaders[lid];
          if (ld) total += ld.skills[card.skill as keyof typeof ld.skills] ?? 0;
        }
        return total >= card.skillCost;
      });
      if (revealable.length > 0 && Math.random() < 0.6) {
        const am = pick(revealable)!;
        const sysIds = Object.keys(G.map.systems);
        for (let attempt = 0; attempt < 5; attempt++) {
          const targetSystemId = pick(sysIds)!;
          const r = phases.revealMission(G, side, am.missionId, targetSystemId);
          if (r.ok) return true;
        }
      }
      // 70%: try to activate a system with a random eligible leader + random
      // target. 30%: pass. If activation fails (no eligible leader / engine
      // rejection), fall through to pass so we don't get stuck.
      const eligible = f.leaderPool.filter((lid) => {
        const l = G.catalog.leaders[lid];
        return l && (l.tacticValues.space + l.tacticValues.ground) > 0;
      });
      if (eligible.length > 0 && Math.random() < 0.70) {
        const leaderId = pick(eligible)!;
        const sysIds = Object.keys(G.map.systems);
        // Try up to 5 random targets in case the first hits a friendly-leader
        // block or other engine reject.
        for (let attempt = 0; attempt < 5; attempt++) {
          const targetSystemId = pick(sysIds)!;
          // Maybe pull some units from one random adjacent friendly system.
          const orders: phases.MoveOrder[] = [];
          if (Math.random() < 0.5) {
            const adj = G.catalog.adjacency[targetSystemId] ?? [];
            const candidates = adj.filter((sysId) => {
              if ((f.leadersOnBoard[sysId] ?? []).length > 0) return false;
              const ss = G.map.systems[sysId];
              return ss && ss.units.some((u) => u.side === side);
            });
            const fromId = pick(candidates);
            if (fromId) {
              const ss = G.map.systems[fromId];
              const mine = ss.units.filter((u) => u.side === side);
              // Move 1-3 random units.
              const n = Math.min(mine.length, 1 + Math.floor(Math.random() * 3));
              const shuffled = [...mine].sort(() => Math.random() - 0.5).slice(0, n);
              orders.push({ fromSystemId: fromId, unitInstanceIds: shuffled.map((u) => u.instanceId) });
            }
          }
          const r = phases.activateSystem(G, side, leaderId, targetSystemId, orders);
          if (r.ok) return true;
        }
      }
      const r = phases.pass(G, side);
      return r.ok;
    }
    default:
      return false;
  }
}

function handleOpposeMission(G: GameState, side: Side): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'OpposeMission' }>;
  const skill = c.skill;
  // Pick the best pool leader: max matching-skill icons; ties broken by lowest
  // total leader value (don't burn a strong leader as a 0-skill blocker).
  let best: { lid: LeaderId; m: number; v: number } | null = null;
  for (const lid of c.poolLeaders) {
    const ld = G.catalog.leaders[lid];
    if (!ld) continue;
    const m = (ld.skills as Record<string, number>)[skill] ?? 0;
    const v = ld.skills.diplomacy + ld.skills.intel + ld.skills.specOps + ld.skills.logistics
           + ld.tacticValues.space + ld.tacticValues.ground;
    if (!best || m > best.m || (m === best.m && v < best.v)) best = { lid, m, v };
  }
  let sentLeader: LeaderId | null = null;
  if (best) {
    const haveExisting = c.existingAtTarget.length > 0;
    if (best.m >= 1) sentLeader = best.lid;
    else if (!haveExisting && c.attackerDice <= 1) sentLeader = best.lid;
  }
  const r = phases.resolveOpposition(G, sentLeader);
  return r.ok;
}

// ---------- Combat tactic-card heuristics --------------------------------
// Mirrors the prior auto-play behaviour now that those helpers are gone.

function handleCombatAttackerTactics(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAttackerTactics' }>;
  const hits = c.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
  const blanks = c.dice.filter((d) => d.face === 'blank').length;
  let concentrateFire: string | null = null;
  // Concentrate Fire if hit rate < 50% AND we have blanks to reroll.
  if (c.dice.length > 0 && blanks > 0 && hits < Math.ceil(c.dice.length / 2)) {
    concentrateFire = c.hand.find((cid) => cid.includes('concentrate-fire')) ?? null;
  }
  const damageBoosts: string[] = [];
  for (const sub of ['take-it-down', 'critical-hit', 'onslaught']) {
    const cid = c.hand.find((x) => x.includes(sub));
    if (cid) damageBoosts.push(cid);
  }
  const r = combat.resolveCombatAttackerTactics(G, {
    concentrateFireCardId: concentrateFire,
    damageBoostCardIds: damageBoosts,
  });
  return r.ok;
}

function handleCombatDefenderTactics(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatDefenderTactics' }>;
  const blockCards: string[] = [];
  const sacrifices: string[] = [];
  if (c.incomingHits > 0) {
    // Free block first.
    const free = c.hand.find((cid) => cid.includes('defensive-formation'));
    if (free) blockCards.push(free);
    // Then dig-in / outmaneuver if we have a sacrificial spare.
    const paid = c.hand.find((cid) =>
      (cid.includes('dig-in') && c.theater === 'ground') ||
      (cid.includes('outmaneuver') && c.theater === 'space')
    );
    if (paid && c.hand.length >= 2) {
      const sacrifice = c.hand.find((cid) =>
        cid !== paid && cid !== free && !cid.includes('concentrate-fire') // keep concentrate-fire if we have it for next time
      );
      if (sacrifice) { blockCards.push(paid); sacrifices.push(sacrifice); }
    }
  }
  const r = combat.resolveCombatDefenderTactics(G, { blockCardIds: blockCards, sacrificeCardIds: sacrifices });
  return r.ok;
}

// ---------- Build-pick heuristic --------------------------------
// Picks the first legal unit type for each entry (matches the prior
// auto-behavior). Real game would diversify, but this keeps AI-vs-AI
// games running without a UI prompt.
function handleBuildPick(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'BuildPick' }>;
  const choices = c.picks.map((p) => p.legalUnitTypes[0]);
  const r = phases.resolveBuildPicks(G, choices);
  return r.ok;
}

/** AI damage-assignment heuristic — for each incoming hit, pick the
 *  weakest legal target (lowest current effective HP, ties broken by
 *  smaller tier first). Tracks already-staged targets across hits so we
 *  don't waste damage on the same instance. */
function handleCombatAssignDamage(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAssignDamage' }>;
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  const assigned = new Map<string, number>(); // instanceId → damage already queued
  const assignments: (string | null)[] = [];
  // Track per-source-card targets to respect RAW constraints:
  //   take-it-down: subsequent hits MUST go to the same target as the first
  //   onslaught:    subsequent hits MUST go to a DIFFERENT target
  const sourceFirstTarget = new Map<string, string>();
  const sourceTargets = new Map<string, Set<string>>();

  // Find the live unit instance from catalog data + current map state.
  const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
  for (let i = 0; i < c.hits.length; i++) {
    const targets = c.targetsByHit[i];
    if (targets.length === 0) { assignments.push(null); continue; }
    const src = c.hits[i].source;
    const isTakeItDown = src && src.includes('take-it-down');
    const isOnslaught = src && src.includes('onslaught');
    let best: { id: string; remaining: number; tier: number } | null = null;
    for (const tid of targets) {
      // Per-source constraint filtering.
      if (isTakeItDown && sourceFirstTarget.has(src)) {
        if (tid !== sourceFirstTarget.get(src)) continue;
      }
      if (isOnslaught && sourceTargets.get(src)?.has(tid)) continue;
      const u = ss?.units.find((x) => x.instanceId === tid);
      if (!u) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      const queued = assigned.get(tid) ?? 0;
      const remaining = (t.health.value ?? 1) - (u.damage ?? 0) - queued;
      if (remaining <= 0) continue; // already dead under queued damage
      const tier = tierRank[t.tier ?? 'square'] ?? 9;
      if (!best || remaining < best.remaining || (remaining === best.remaining && tier < best.tier)) {
        best = { id: tid, remaining, tier };
      }
    }
    if (best) {
      assignments.push(best.id);
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1);
      if (src) {
        if (!sourceFirstTarget.has(src)) sourceFirstTarget.set(src, best.id);
        if (!sourceTargets.has(src)) sourceTargets.set(src, new Set());
        sourceTargets.get(src)!.add(best.id);
      }
    } else {
      assignments.push(null);
    }
  }
  const r = combat.resolveCombatAssignDamage(G, assignments);
  return r.ok;
}

/** AI: always take the Yoda reroll if available. Reroll the first blank. */
function handleYodaReroll(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'YodaReroll' }>;
  const idx = c.blankIndices.length > 0 ? c.blankIndices[0] : null;
  const r = combat.resolveYodaReroll(G, idx);
  return r.ok;
}

/** AI: spend every available special on drawing tactic cards. Doesn't play
 *  any special-required cards (we'd need card-by-card logic). */
function handleSpecialDieSpend(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'SpecialDieSpend' }>;
  const r = combat.resolveSpecialDieSpend(G, { draws: c.specialCount, playCardIds: [] });
  return r.ok;
}

/** AI: skip Start-of-Combat action cards (effects aren't wired anyway). */
function handleCombatStartActionCards(G: GameState): boolean {
  const r = combat.resolveCombatStartActionCards(G, []);
  return r.ok;
}

/** AI retreat heuristic: retreat only if outnumbered ≥2:1 in either theater.
 *  Take all units. */
function handleRetreatDecision(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'RetreatDecision' }>;
  const ss = G.map.systems[c.systemId];
  const my = ss?.units.filter((u) => u.side === c.side).length ?? 0;
  const opp = ss?.units.filter((u) => u.side !== c.side).length ?? 0;
  const shouldRetreat = my > 0 && opp >= my * 2 && c.legalDestinations.length > 0;
  if (!shouldRetreat) {
    const r = combat.resolveRetreatDecision(G, null, null);
    return r.ok;
  }
  // Pick the first legal destination.
  const r = combat.resolveRetreatDecision(G, c.legalDestinations[0], null);
  return r.ok;
}
