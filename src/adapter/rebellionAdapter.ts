// GameAdapter implementation for the Digital Boardgame Framework.
// Bridges Rebellion's existing pure-function engine to the framework's
// four-method contract.
//
// Design notes:
//   - applyAction deep-clones state via structuredClone before dispatching,
//     because the engine functions mutate G. The adapter contract requires
//     purity; the engine doesn't provide it.
//   - currentActor walks pendingChoice → pendingMission → G.currentPlayer.
//     Each pendingChoice variant either carries its own `.side`, or implies
//     a side via opposerSide (OpposeMission) or pendingMission.resolverSide
//     (StolenPlansReorder, CovertOperationPick, InfiltrationPick).
//   - legalActions returns a *representative* legal subset, not an exhaustive
//     enumeration. Choice-resolution actions are fully enumerated from the
//     pendingChoice candidates. Top-level Command actions (activateSystem,
//     revealMission) enumerate (leader, target) pairs with minimal moveOrders;
//     the UI may submit richer payloads which applyAction will validate via
//     the engine's own legality checks. The framework's submit endpoint should
//     trust applyAction's `{ ok: false, reason }` return rather than gating on
//     `action ∈ legalActions` for these combinatorial moves.
//   - viewFor redacts opponent hidden information per RAW: action hand,
//     mission hand (face-down), face-down mission deck order, leadersOnMissions
//     mission IDs (face-down until reveal), probeDeck order, projectDeck
//     contents, Rebel objective deck/hand, and rebelBaseSystemId (Empire only,
//     until revealed).

import type { GameAdapter, GameResult } from 'digital-boardgame-framework';
import type { Side, SystemId } from '../types';
import type { GameState, LeaderId, ChoiceRequest } from '../engine/types';
import * as Phases from '../engine/phases';
import * as Combat from '../engine/combat';
import type { RebellionAction } from './rebellionAction';
import { assertNever } from './rebellionAction';

// ---------------------------------------------------------------------------
// currentActor
// ---------------------------------------------------------------------------

/** Some ChoiceRequest variants don't carry `.side` directly; resolve here. */
function actorForChoice(G: GameState, c: ChoiceRequest): Side | null {
  // Variants with explicit `.side` field.
  if ('side' in c && c.side) return c.side as Side;
  // Opposition has its own field name.
  if (c.kind === 'OpposeMission') return c.opposerSide;
  // The three remaining shapes are owed by the mission resolver.
  if (c.kind === 'StolenPlansReorder'
    || c.kind === 'CovertOperationPick'
    || c.kind === 'InfiltrationPick') {
    return G.pendingMission?.resolverSide ?? null;
  }
  // Generic legacy shapes (ChooseSystem, ChooseLeader, AssignDamage,
  // PlayTacticCard, CombatAction, RetreatTo, DeployTarget,
  // PickProbeForNewBase, PlayObjective, YesNo, ChooseActionCard,
  // AssignLeaders) — not currently emitted by the live engine, but
  // fall through to currentPlayer if they ever are.
  return G.currentPlayer;
}

function currentActor(G: GameState): Side | null {
  if (G.isGameOver || G.phase === 'GameOver') return null;
  if (G.pendingChoice) return actorForChoice(G, G.pendingChoice);
  return G.currentPlayer;
}

// ---------------------------------------------------------------------------
// applyAction
// ---------------------------------------------------------------------------

function applyAction(state: GameState, action: RebellionAction, actor: Side): GameState {
  const G = structuredClone(state);
  // Engine functions take `side` as their first arg in most cases; pull from
  // `actor` consistently rather than embedding side in the Action payload.
  const a = action;
  switch (a.kind) {
    // ---- Setup ----
    case 'pickRebelBase': Phases.pickRebelBase(G, a.systemId); break;
    case 'setupDeployUnit': Phases.setupDeployUnit(G, actor, a.typeId, a.systemId); break;
    case 'setupAutoFill': Phases.setupAutoFill(G, actor); break;

    // ---- Assignment ----
    case 'assignLeader': Phases.assignLeader(G, actor, a.missionId, a.leaderIds); break;
    case 'skipAssignment': Phases.skipAssignment(G, actor); break;
    case 'playAssignmentActionCard': Phases.playAssignmentActionCard(G, a.cardId); break;

    // ---- Command top-level ----
    case 'pass': Phases.pass(G, actor); break;
    case 'activateSystem':
      Phases.activateSystem(G, actor, a.leaderId, a.targetSystemId, a.moveOrders);
      break;
    case 'revealMission':
      Phases.revealMission(G, actor, a.missionId, a.targetSystemId, a.targetLeaderId);
      break;

    // ---- Mission flow ----
    case 'resolveOpposition': Phases.resolveOpposition(G, a.opposerLeaderId); break;
    case 'resolveYodaMissionReroll': Phases.resolveYodaMissionReroll(G, a.rerollIndex); break;
    case 'resolveR2D2MissionFlip': Phases.resolveR2D2MissionFlip(G, a.flipIndex); break;
    case 'resolveStolenPlansPick': Phases.resolveStolenPlansPick(G, a.cardId); break;
    case 'resolveInfiltrationPick': Phases.resolveInfiltrationPick(G, a.keepOnTopId); break;

    // ---- Mission-effect sub-choices ----
    case 'resolvePlanTheAssaultShips': Phases.resolvePlanTheAssaultShips(G, a.shipIds); break;
    case 'resolveOverseeProjectPick': Phases.resolveOverseeProjectPick(G, a.queueIndex, a.slot); break;
    case 'resolveCaptureOperativePick': Phases.resolveCaptureOperativePick(G, a.leaderId); break;
    case 'resolveCarbonFreezingPick': Phases.resolveCarbonFreezingPick(G, a.leaderId); break;
    case 'resolveLureOfTheDarkSidePick': Phases.resolveLureOfTheDarkSidePick(G, a.leaderId); break;
    case 'resolveHomingBeaconPlace': Phases.resolveHomingBeaconPlace(G, a.leaderId, a.systemId); break;
    case 'resolveResearchAndDevelopmentOption': Phases.resolveResearchAndDevelopmentOption(G, a.option); break;
    case 'resolveResearchAndDevelopmentProjectPick':
      Phases.resolveResearchAndDevelopmentProjectPick(G, a.keepInHandId); break;
    case 'resolveDestroyUpToHealth': Phases.resolveDestroyUpToHealth(G, a.instanceIds); break;
    case 'resolveRogueSquadronRaidPick': Phases.resolveRogueSquadronRaidPick(G, a.picks); break;
    case 'resolveDoubleOurEffortsPick': Phases.resolveDoubleOurEffortsPick(G, a.picks); break;
    case 'resolvePlanetaryConquestSourcePick': Phases.resolvePlanetaryConquestSourcePick(G, a.sourceSystemId); break;
    case 'resolveFearWillKeepThemInLinePick': Phases.resolveFearWillKeepThemInLinePick(G, a.systemIds); break;
    case 'resolvePublicUprisingPick': Phases.resolvePublicUprisingPick(G, a.picks); break;
    case 'resolveSupportOfMonCalamariPick': Phases.resolveSupportOfMonCalamariPick(G, a.option); break;
    case 'resolveMisdirectionPick': Phases.resolveMisdirectionPick(G, a.leaderId); break;
    case 'resolveCovertOperationPick': Phases.resolveCovertOperationPick(G, a.keepInHandId); break;
    case 'resolveDetainedTargetPick': Phases.resolveDetainedTargetPick(G, a.leaderId); break;
    case 'resolveOneInAMillionMission': Phases.resolveOneInAMillionMission(G, a.picks); break;
    case 'resolveNobleSacrificeOffer': Phases.resolveNobleSacrificeOffer(G, a.accept); break;
    case 'resolveItIsYourDestinyOffer': Phases.resolveItIsYourDestinyOffer(G, a.leaderId); break;
    case 'resolveUndercoverOffer': Phases.resolveUndercoverOffer(G, a.leaderId); break;
    case 'resolveSonOfSkywalkerOffer': Phases.resolveSonOfSkywalkerOffer(G, a.missionId); break;
    case 'resolveBlindsideOffer': Phases.resolveBlindsideOffer(G, a.accept); break;
    case 'resolveWookieGuardianOffer': Phases.resolveWookieGuardianOffer(G, a.accept); break;
    case 'resolveC3POOffer': Phases.resolveC3POOffer(G, a.accept); break;
    case 'resolveFalconOffer': Phases.resolveFalconOffer(G, a.leaderId); break;
    case 'resolveBrilliantAdministratorBuildPick': Phases.resolveBrilliantAdministratorBuildPick(G, a.typeIds); break;
    case 'resolveCatchThemBySurpriseMovePick':
      Phases.resolveCatchThemBySurpriseMovePick(G, a.sourceSystemId, a.unitInstanceIds); break;
    case 'resolveScoutingMissionTIEPick': Phases.resolveScoutingMissionTIEPick(G, a.unitInstanceIds); break;
    case 'resolveOurMostDesperateHourPick': Phases.resolveOurMostDesperateHourPick(G, a.missionId); break;
    case 'resolveProceedingAsPlannedPick': Phases.resolveProceedingAsPlannedPick(G, a.missionId); break;
    case 'resolveStartEvacuationPick':
      Phases.resolveStartEvacuationPick(G, a.targetSystemId, a.unitInstanceIds); break;
    case 'resolveIndependentOperationEvacPick':
      Phases.resolveIndependentOperationEvacPick(G, a.destinationSystemId); break;
    case 'resolveHiddenFleetUnitPick': Phases.resolveHiddenFleetUnitPick(G, a.unitInstanceIds); break;
    case 'resolveTemporaryAllianceBuildPick': Phases.resolveTemporaryAllianceBuildPick(G, a.typeIds); break;
    case 'resolveContingencyPlanPick': Phases.resolveContingencyPlanPick(G, a.missionId); break;
    case 'resolveRetrieveThePlansPick': Phases.resolveRetrieveThePlansPick(G, a.objectiveId); break;
    case 'resolveInterrogationDroidDecoyPick': Phases.resolveInterrogationDroidDecoyPick(G, a.systemIds); break;
    case 'resolveRecruitActionCardPick': Phases.resolveRecruitActionCardPick(G, a.keepCardId); break;
    case 'resolveBuildPicks': Phases.resolveBuildPicks(G, a.choices); break;
    case 'resolveDeployUnitPick': Phases.resolveDeployUnitPick(G, a.systemId); break;
    case 'resolveActionCardSystemPick': Phases.resolveActionCardSystemPick(G, a.systemId); break;

    // ---- Rapid Mobilization ----
    case 'resolveRapidMobilizationBranch': Phases.resolveRapidMobilizationBranch(G, a.branch); break;
    case 'resolveRapidMobilizationMove':
      Phases.resolveRapidMobilizationMove(G, a.sourceSystemId, a.unitInstanceIds); break;
    case 'resolveRapidMobilizationBasePick': Phases.resolveRapidMobilizationBasePick(G, a.systemId); break;

    // ---- Combat ----
    case 'resolveCombatStartActionCards': Combat.resolveCombatStartActionCards(G, a.cardIds); break;
    case 'resolveCombatAddLeaderPick': Combat.resolveCombatAddLeaderPick(G, a.leaderId); break;
    case 'resolveCombatAttackerTactics': Combat.resolveCombatAttackerTactics(G, a.plays); break;
    case 'resolveCombatDefenderTactics': Combat.resolveCombatDefenderTactics(G, a.plays); break;
    case 'resolveYodaReroll': Combat.resolveYodaReroll(G, a.rerollIndex); break;
    case 'resolveR2D2Flip': Combat.resolveR2D2Flip(G, a.flipIndex); break;
    case 'resolveSpecialDieSpend': Combat.resolveSpecialDieSpend(G, a.plays); break;
    case 'resolveCombatAssignDamage': Combat.resolveCombatAssignDamage(G, a.assignments); break;
    case 'resolveOneInAMillionCombat': Combat.resolveOneInAMillionCombat(G, a.picks); break;
    case 'resolveMoreDangerousTheaterPick': Combat.resolveMoreDangerousTheaterPick(G, a.theater); break;
    case 'resolveFullyOperationalTargetPick': Combat.resolveFullyOperationalTargetPick(G, a.instanceId); break;
    case 'resolveTargetTheGeneratorPick': Combat.resolveTargetTheGeneratorPick(G, a.instanceId); break;
    case 'resolveReadyForActionLeaderPick': Combat.resolveReadyForActionLeaderPick(G, a.leaderId); break;
    case 'resolveRetreatDecision': Combat.resolveRetreatDecision(G, a.destSystemId, a.unitInstanceIds); break;
    case 'resolveDeathStarPlansAttempt':
      Combat.resolveDeathStarPlansAttempt(G, a.attempt, a.deathStarInstanceId); break;

    default: return assertNever(a);
  }
  return G;
}

// ---------------------------------------------------------------------------
// legalActions  (representative subset — see top-of-file note)
// ---------------------------------------------------------------------------

function legalActions(state: GameState, actor: Side): RebellionAction[] {
  const G = state;
  if (currentActor(G) !== actor) return [];

  // pendingChoice — enumerate fully from candidates.
  if (G.pendingChoice) return choiceActions(G, G.pendingChoice);

  // Setup
  if (G.phase === 'Setup') {
    const out: RebellionAction[] = [];
    if (G.pendingRebelBasePick && actor === 'Rebel') {
      for (const sid of G.pendingRebelBasePick) out.push({ kind: 'pickRebelBase', systemId: sid });
    }
    if (G.pendingDeployment && G.pendingDeployment[actor].length > 0) {
      // Always offer auto-fill as a guaranteed-legal completion. Per-unit
      // placement variants would need per-side legal-system filtering; the
      // UI handles that interactively, and AI/rollouts prefer auto-fill.
      out.push({ kind: 'setupAutoFill' });
    }
    return out;
  }

  // Assignment
  if (G.phase === 'Assignment') {
    const out: RebellionAction[] = [{ kind: 'skipAssignment' }];
    const f = actor === 'Rebel' ? G.rebel : G.empire;
    for (const mid of f.missionHand) {
      for (const lid of f.leaderPool) {
        out.push({ kind: 'assignLeader', missionId: mid, leaderIds: [lid] });
      }
    }
    for (const cid of Phases.playableAssignmentActionCards(G, actor)) {
      out.push({ kind: 'playAssignmentActionCard', cardId: cid });
    }
    return out;
  }

  // Command
  if (G.phase === 'Command') {
    if (G.passedThisCommand.includes(actor)) return [];
    const out: RebellionAction[] = [{ kind: 'pass' }];
    const f = actor === 'Rebel' ? G.rebel : G.empire;
    // activateSystem: (leader, target) pairs, empty moveOrders.
    for (const lid of f.leaderPool) {
      const ldr = G.catalog.leaders[lid];
      if (!ldr || (ldr.tacticValues.space + ldr.tacticValues.ground) === 0) continue;
      for (const sid of Object.keys(G.map.systems) as SystemId[]) {
        out.push({ kind: 'activateSystem', leaderId: lid, targetSystemId: sid, moveOrders: [] });
      }
    }
    // revealMission: enumerate assigned missions × candidate target systems.
    for (const m of f.leadersOnMissions) {
      for (const sid of Object.keys(G.map.systems) as SystemId[]) {
        out.push({ kind: 'revealMission', missionId: m.missionId, targetSystemId: sid });
      }
    }
    return out;
  }

  return [];
}

/** Enumerate legal Action variants from a pendingChoice's candidate fields. */
function choiceActions(G: GameState, c: ChoiceRequest): RebellionAction[] {
  switch (c.kind) {
    case 'OpposeMission': {
      const out: RebellionAction[] = [{ kind: 'resolveOpposition', opposerLeaderId: null }];
      for (const lid of c.poolLeaders) out.push({ kind: 'resolveOpposition', opposerLeaderId: lid });
      return out;
    }
    case 'YodaReroll': {
      const ctx = c.context;
      const out: RebellionAction[] = [];
      const variant = ctx === 'combat'
        ? { kind: 'resolveYodaReroll' as const, rerollIndex: null }
        : { kind: 'resolveYodaMissionReroll' as const, rerollIndex: null };
      out.push(variant);
      for (const i of c.blankIndices) {
        out.push(ctx === 'combat'
          ? { kind: 'resolveYodaReroll', rerollIndex: i }
          : { kind: 'resolveYodaMissionReroll', rerollIndex: i });
      }
      return out;
    }
    case 'R2D2Flip': {
      const ctx = c.context;
      const out: RebellionAction[] = [];
      out.push(ctx === 'combat'
        ? { kind: 'resolveR2D2Flip', flipIndex: null }
        : { kind: 'resolveR2D2MissionFlip', flipIndex: null });
      for (const i of c.flippableDieIndices) {
        out.push(ctx === 'combat'
          ? { kind: 'resolveR2D2Flip', flipIndex: i }
          : { kind: 'resolveR2D2MissionFlip', flipIndex: i });
      }
      return out;
    }
    case 'StolenPlansReorder':
      return c.remaining.map(cid => ({ kind: 'resolveStolenPlansPick', cardId: cid }));
    case 'InfiltrationPick':
      return [
        { kind: 'resolveInfiltrationPick', keepOnTopId: c.topId },
        { kind: 'resolveInfiltrationPick', keepOnTopId: c.bottomId },
      ];
    case 'CovertOperationPick':
      return c.drawnIds.map(id => ({ kind: 'resolveCovertOperationPick', keepInHandId: id }));
    case 'OverseeProjectPick':
      return c.candidates.map(x => ({ kind: 'resolveOverseeProjectPick', queueIndex: x.queueIndex, slot: x.slot }));
    case 'CaptureOperativePick':
      return c.candidates.map(lid => ({ kind: 'resolveCaptureOperativePick', leaderId: lid }));
    case 'CarbonFreezingPick':
      return c.candidates.map(lid => ({ kind: 'resolveCarbonFreezingPick', leaderId: lid }));
    case 'LureOfTheDarkSidePick':
      return c.candidates.map(lid => ({ kind: 'resolveLureOfTheDarkSidePick', leaderId: lid }));
    case 'HomingBeaconPlace': {
      const out: RebellionAction[] = [];
      for (const lid of c.leaderCandidates) {
        for (const sid of c.systemCandidates) {
          out.push({ kind: 'resolveHomingBeaconPlace', leaderId: lid, systemId: sid });
        }
      }
      return out;
    }
    case 'ResearchAndDevelopmentOption': {
      const out: RebellionAction[] = [{ kind: 'resolveResearchAndDevelopmentOption', option: 'A' }];
      if (c.hasSabotage) out.push({ kind: 'resolveResearchAndDevelopmentOption', option: 'B' });
      return out;
    }
    case 'ResearchAndDevelopmentProjectPick':
      return c.drawnIds.map(id => ({ kind: 'resolveResearchAndDevelopmentProjectPick', keepInHandId: id }));
    case 'DestroyUpToHealth':
      // Representative: empty pick (skip) + single-unit picks.
      return [
        { kind: 'resolveDestroyUpToHealth', instanceIds: [] },
        ...c.candidates.map(id => ({ kind: 'resolveDestroyUpToHealth' as const, instanceIds: [id] })),
      ];
    case 'RogueSquadronRaidPick':
      return [{ kind: 'resolveRogueSquadronRaidPick', picks: [] }];
    case 'DoubleOurEffortsPick':
      return [
        { kind: 'resolveDoubleOurEffortsPick', picks: [] },
        ...c.candidates.map(x => ({
          kind: 'resolveDoubleOurEffortsPick' as const,
          picks: [{ slot: x.slot, queueIndex: x.queueIndex }],
        })),
      ];
    case 'PlanetaryConquestSourcePick':
      return c.sources.map(s => ({ kind: 'resolvePlanetaryConquestSourcePick', sourceSystemId: s.sourceSystemId }));
    case 'FearWillKeepThemInLinePick':
      // Representative: pick the first N candidates.
      return [{
        kind: 'resolveFearWillKeepThemInLinePick',
        systemIds: c.candidates.slice(0, c.count),
      }];
    case 'PublicUprisingPick':
      return [{
        kind: 'resolvePublicUprisingPick',
        picks: { circle: 'corellian-corvette', triangles: ['x-wing', 'x-wing'] },
      }];
    case 'SupportOfMonCalamariPick':
      return [
        { kind: 'resolveSupportOfMonCalamariPick', option: 'loyalty' },
        { kind: 'resolveSupportOfMonCalamariPick', option: 'cruiser' },
      ];
    case 'DeployUnitPick':
      return c.candidates.map(sid => ({ kind: 'resolveDeployUnitPick', systemId: sid }));
    case 'DeathStarPlansAttempt': {
      const out: RebellionAction[] = [{ kind: 'resolveDeathStarPlansAttempt', attempt: false }];
      for (const dsid of c.deathStarInstanceIds) {
        out.push({ kind: 'resolveDeathStarPlansAttempt', attempt: true, deathStarInstanceId: dsid });
      }
      return out;
    }
    case 'InterrogationDroidDecoyPick':
      return [{ kind: 'resolveInterrogationDroidDecoyPick', systemIds: c.candidates.slice(0, c.count) }];
    case 'RetrieveThePlansPick':
      return c.candidates.map(id => ({ kind: 'resolveRetrieveThePlansPick', objectiveId: id }));
    case 'DetainedTargetPick':
      return c.candidates.map(lid => ({ kind: 'resolveDetainedTargetPick', leaderId: lid }));
    case 'ContingencyPlanPick':
      return c.candidates.map(mid => ({ kind: 'resolveContingencyPlanPick', missionId: mid }));
    case 'RapidMobilizationBranch': {
      const out: RebellionAction[] = [{ kind: 'resolveRapidMobilizationBranch', branch: 'establish-base' }];
      if (c.moveUnitsAvailable) {
        out.push({ kind: 'resolveRapidMobilizationBranch', branch: 'move-units' });
      }
      return out;
    }
    case 'RapidMobilizationMovePick':
      // No candidates field; representative empty move (skip).
      return [{ kind: 'resolveRapidMobilizationMove',
                sourceSystemId: 'rebel-base-space' as SystemId, unitInstanceIds: [] }];
    case 'RapidMobilizationBasePick': {
      const ids = c.probeSystemIds ?? (Object.keys(G.map.systems) as SystemId[]);
      return ids.map(sid => ({ kind: 'resolveRapidMobilizationBasePick', systemId: sid }));
    }
    case 'NobleSacrificeOffer':
      return [
        { kind: 'resolveNobleSacrificeOffer', accept: true },
        { kind: 'resolveNobleSacrificeOffer', accept: false },
      ];
    case 'ItIsYourDestinyOffer':
      return [
        { kind: 'resolveItIsYourDestinyOffer', leaderId: null },
        ...c.candidates.map(lid => ({ kind: 'resolveItIsYourDestinyOffer' as const, leaderId: lid })),
      ];
    case 'UndercoverOffer':
      return [
        { kind: 'resolveUndercoverOffer', leaderId: null },
        ...c.candidates.map(lid => ({ kind: 'resolveUndercoverOffer' as const, leaderId: lid })),
      ];
    case 'SonOfSkywalkerOffer':
      return [
        { kind: 'resolveSonOfSkywalkerOffer', missionId: null },
        ...c.candidates.map(mid => ({ kind: 'resolveSonOfSkywalkerOffer' as const, missionId: mid })),
      ];
    case 'BlindsideOffer':
      return [
        { kind: 'resolveBlindsideOffer', accept: true },
        { kind: 'resolveBlindsideOffer', accept: false },
      ];
    case 'WookieGuardianOffer':
      return [
        { kind: 'resolveWookieGuardianOffer', accept: true },
        { kind: 'resolveWookieGuardianOffer', accept: false },
      ];
    case 'C3POOffer':
      return [
        { kind: 'resolveC3POOffer', accept: true },
        { kind: 'resolveC3POOffer', accept: false },
      ];
    case 'FalconOffer':
      return [
        { kind: 'resolveFalconOffer', leaderId: null },
        ...c.candidates.map(lid => ({ kind: 'resolveFalconOffer' as const, leaderId: lid })),
      ];
    case 'CombatStartActionCards':
      return [{ kind: 'resolveCombatStartActionCards', cardIds: [] }];
    case 'CombatAddLeaderPick':
      return [
        { kind: 'resolveCombatAddLeaderPick', leaderId: null },
        ...c.candidates.map(lid => ({ kind: 'resolveCombatAddLeaderPick' as const, leaderId: lid })),
      ];
    case 'CombatAttackerTactics':
      return [{ kind: 'resolveCombatAttackerTactics', plays: {} }];
    case 'CombatDefenderTactics':
      return [{ kind: 'resolveCombatDefenderTactics', plays: { blockCardIds: [], sacrificeCardIds: [] } }];
    case 'SpecialDieSpend':
      return [{ kind: 'resolveSpecialDieSpend', plays: { draws: 0, playCardIds: [] } }];
    case 'MoreDangerousTheaterPick':
      return [
        { kind: 'resolveMoreDangerousTheaterPick', theater: 'space' },
        { kind: 'resolveMoreDangerousTheaterPick', theater: 'ground' },
      ];
    case 'FullyOperationalTargetPick':
      return c.candidates.map(id => ({ kind: 'resolveFullyOperationalTargetPick', instanceId: id }));
    case 'TargetTheGeneratorPick':
      return c.candidates.map(id => ({ kind: 'resolveTargetTheGeneratorPick', instanceId: id }));
    case 'ReadyForActionLeaderPick':
      return c.candidates.map(lid => ({ kind: 'resolveReadyForActionLeaderPick', leaderId: lid }));
    case 'RetreatDecision':
      return [
        { kind: 'resolveRetreatDecision', destSystemId: null, unitInstanceIds: null },
        ...c.legalDestinations.map(sid => ({
          kind: 'resolveRetreatDecision' as const,
          destSystemId: sid,
          unitInstanceIds: c.availableUnits,
        })),
      ];
    case 'CombatAssignDamage': {
      const assignments: (string | null)[] = c.hits.map((_, i) => c.targetsByHit[i]?.[0] ?? null);
      return [{ kind: 'resolveCombatAssignDamage', assignments }];
    }
    case 'OneInAMillionOffer':
      return [{
        kind: c.context === 'combat' ? 'resolveOneInAMillionCombat' : 'resolveOneInAMillionMission',
        picks: [],
      }];
    case 'PlayAssignmentActionCard':
      return c.candidates.map(cid => ({ kind: 'playAssignmentActionCard', cardId: cid }));
    case 'ActionCardSystemPick':
      return c.candidates.map(sid => ({ kind: 'resolveActionCardSystemPick', systemId: sid }));
    case 'RecruitActionCardPick':
      return c.drawnIds.map(id => ({ kind: 'resolveRecruitActionCardPick', keepCardId: id }));
    case 'MisdirectionPick':
      return c.candidates.map(lid => ({ kind: 'resolveMisdirectionPick', leaderId: lid }));
    case 'BuildPick': {
      // Pick the first legal unit type for each icon — representative single
      // valid completion. UI/human picks richer combinations.
      const choices = c.picks.map(p => p.legalUnitTypes[0]).filter(Boolean);
      return [{ kind: 'resolveBuildPicks', choices }];
    }
    case 'PlanTheAssaultShips':
      return [{ kind: 'resolvePlanTheAssaultShips', shipIds: c.availableShipIds }];
    case 'BrilliantAdministratorBuildPick':
      return [{ kind: 'resolveBrilliantAdministratorBuildPick', typeIds: c.icons.map(() => null) }];
    case 'TemporaryAllianceBuildPick':
      return [{ kind: 'resolveTemporaryAllianceBuildPick', typeIds: c.icons.map(() => null) }];
    case 'CatchThemBySurpriseMovePick':
      return c.candidateSourceSystemIds.map(sid => ({
        kind: 'resolveCatchThemBySurpriseMovePick', sourceSystemId: sid, unitInstanceIds: [],
      }));
    case 'ScoutingMissionTIEPick':
      return [{ kind: 'resolveScoutingMissionTIEPick', unitInstanceIds: [] }];
    case 'OurMostDesperateHourPick':
      return c.candidates.map(mid => ({ kind: 'resolveOurMostDesperateHourPick', missionId: mid }));
    case 'ProceedingAsPlannedPick':
      return c.candidates.map(mid => ({ kind: 'resolveProceedingAsPlannedPick', missionId: mid }));
    case 'StartEvacuationPick':
      return c.candidateSystemIds.map(sid => ({
        kind: 'resolveStartEvacuationPick', targetSystemId: sid, unitInstanceIds: [],
      }));
    case 'IndependentOperationEvacPick':
      return c.candidateSystemIds.map(sid => ({
        kind: 'resolveIndependentOperationEvacPick', destinationSystemId: sid,
      }));
    case 'HiddenFleetUnitPick':
      return [{ kind: 'resolveHiddenFleetUnitPick', unitInstanceIds: [] }];
    // Legacy / unused ChoiceRequest shapes: return empty.
    case 'AssignLeaders':
    case 'ChooseSystem':
    case 'ChooseLeader':
    case 'AssignDamage':
    case 'PlayTacticCard':
    case 'CombatAction':
    case 'RetreatTo':
    case 'DeployTarget':
    case 'PickProbeForNewBase':
    case 'PlayObjective':
    case 'YesNo':
    case 'ChooseActionCard':
      return [];
  }
}

// ---------------------------------------------------------------------------
// viewFor  (per-player redaction of opponent hidden info)
// ---------------------------------------------------------------------------

const HIDDEN_CARD = '__hidden__';

function viewFor(state: GameState, viewer: Side): GameState {
  const G = structuredClone(state);
  const opp: Side = viewer === 'Rebel' ? 'Empire' : 'Rebel';
  const oppF = opp === 'Rebel' ? G.rebel : G.empire;

  // Opponent action hand: hide card IDs.
  oppF.actionHand = oppF.actionHand.map(() => HIDDEN_CARD);
  // Opponent mission hand: face-down.
  oppF.missionHand = oppF.missionHand.map(() => HIDDEN_CARD);
  // Opponent mission deck order: count is public; order is not.
  oppF.missionDeck = oppF.missionDeck.map(() => HIDDEN_CARD);
  oppF.actionDeck = oppF.actionDeck.map(() => HIDDEN_CARD);
  // Face-down assigned missions — the mission ID is hidden until reveal.
  // Leader IDs on the assignment ARE public (the meeple is visible behind
  // the card).
  oppF.leadersOnMissions = oppF.leadersOnMissions.map(m => ({
    missionId: HIDDEN_CARD,
    leaderIds: m.leaderIds,
  }));
  // Rebel-only secret piles, redacted from Empire.
  if (opp === 'Rebel') {
    if (oppF.objectiveDeck) oppF.objectiveDeck = oppF.objectiveDeck.map(() => HIDDEN_CARD);
    if (oppF.objectiveHand) oppF.objectiveHand = oppF.objectiveHand.map(() => HIDDEN_CARD);
  }
  // Empire-only secret piles, redacted from Rebel.
  if (opp === 'Empire') {
    if (oppF.probeHand) oppF.probeHand = oppF.probeHand.map(() => HIDDEN_CARD);
    if (oppF.projectDeck) oppF.projectDeck = oppF.projectDeck.map(() => HIDDEN_CARD);
  }

  // Shared probe deck order is hidden from both (only top draws are revealed
  // when missions / probes resolve).
  G.probeDeck = G.probeDeck.map(() => HIDDEN_CARD);

  // Rebel base location: hidden from Empire until revealed.
  if (viewer === 'Empire' && !G.rebelBaseRevealed) {
    // Replace with a sentinel; Empire UI shouldn't render base position.
    G.rebelBaseSystemId = '__hidden__' as SystemId;
  }

  return G;
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

function result(state: GameState): GameResult<Side> | null {
  if (!state.isGameOver) return null;
  return {
    winners: state.winner ? [state.winner] : [],
    reason: state.winReason,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const rebellionAdapter: GameAdapter<GameState, RebellionAction, Side> = {
  applyAction,
  legalActions,
  currentActor,
  viewFor,
  result,
};
