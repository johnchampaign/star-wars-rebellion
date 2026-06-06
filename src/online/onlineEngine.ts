// Online engine shim (Phase 4b step 2). PlayTab calls the engine via the
// `phases.*` / `combat.*` namespaces. In online mode we shadow those namespaces
// with these objects: read helpers and constants pass through (spread), but
// every MUTATING action function is overridden to build the matching
// RebellionAction and submit it to the server instead of mutating local state.
//
// The server is authoritative: each override fires submit() (which refreshes
// the view on resolve) and returns {ok:true} synchronously so existing call
// sites (which expect the engine's {ok,reason}) proceed to close their modal /
// advance the UI. A rejected move surfaces via alert and the next poll restores
// the true server state. Params are typed `any` (the call sites pass the local
// G + side, which the server ignores); the `as typeof module` cast restores the
// real types for callers.

import * as phasesModule from '../engine/phases';
import * as combatModule from '../engine/combat';
import type { RebellionAction } from '../adapter/rebellionAction';

type Submit = (a: RebellionAction) => Promise<void>;
type Ok = { ok: true; reason?: string };

// `canSubmit` gates the actual network submit on whether it's the player's turn.
// The board is fully interactive at the DOM level (so read-only features — probe
// overlays, hover-enlarge, info panels — work regardless of turn); only ACTIONS
// are held back. A stray board-action click during the opponent's turn no-ops
// silently here instead of firing a server-rejected move.
function makeAct(submit: Submit, canSubmit: () => boolean) {
  return (action: RebellionAction): Ok => {
    if (!canSubmit()) return { ok: true };
    void submit(action).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      try { alert(`Move rejected: ${msg}`); } catch { /* non-browser */ }
    });
    return { ok: true };
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function makeOnlinePhases(submit: Submit, canSubmit: () => boolean): typeof phasesModule {
  const act = makeAct(submit, canSubmit);
  return {
    ...phasesModule,
    // Setup
    pickRebelBase: (_g: any, systemId: any) => act({ kind: 'pickRebelBase', systemId }),
    setupDeployUnit: (_g: any, _s: any, typeId: any, systemId: any) => act({ kind: 'setupDeployUnit', typeId, systemId }),
    setupAutoFill: (_g: any, _s: any) => act({ kind: 'setupAutoFill' }),
    // Reports
    acknowledgeReport: (_g: any, reportType: any) => act({ kind: 'acknowledgeReport', reportType }),
    // Assignment
    assignLeader: (_g: any, _s: any, missionId: any, leaderIds: any) => act({ kind: 'assignLeader', missionId, leaderIds }),
    unassignLeader: (_g: any, _s: any, missionId: any) => act({ kind: 'unassignLeader', missionId }),
    skipAssignment: (_g: any, _s: any) => act({ kind: 'skipAssignment' }),
    playAssignmentActionCard: (_g: any, cardId: any) => act({ kind: 'playAssignmentActionCard', cardId }),
    // Command
    pass: (_g: any, _s: any) => act({ kind: 'pass' }),
    activateSystem: (_g: any, _s: any, leaderId: any, targetSystemId: any, moveOrders: any = []) => act({ kind: 'activateSystem', leaderId, targetSystemId, moveOrders }),
    revealMission: (_g: any, _s: any, missionId: any, targetSystemId: any, targetLeaderId?: any) => act({ kind: 'revealMission', missionId, targetSystemId, targetLeaderId }),
    // Mission resolution
    resolveOpposition: (_g: any, opposerLeaderId: any) => act({ kind: 'resolveOpposition', opposerLeaderId }),
    resolveYodaMissionReroll: (_g: any, rerollIndex: any) => act({ kind: 'resolveYodaMissionReroll', rerollIndex }),
    resolveR2D2MissionFlip: (_g: any, flipIndex: any) => act({ kind: 'resolveR2D2MissionFlip', flipIndex }),
    resolveStolenPlansPick: (_g: any, cardId: any) => act({ kind: 'resolveStolenPlansPick', cardId }),
    resolveInfiltrationPick: (_g: any, keepOnTopId: any) => act({ kind: 'resolveInfiltrationPick', keepOnTopId }),
    // Mission-effect sub-choices
    resolvePlanTheAssaultShips: (_g: any, shipIds: any) => act({ kind: 'resolvePlanTheAssaultShips', shipIds }),
    resolveLeadStrikeTeamUnits: (_g: any, unitIds: any) => act({ kind: 'resolveLeadStrikeTeamUnits', unitIds }),
    resolveOverseeProjectPick: (_g: any, queueIndex: any, slot: any) => act({ kind: 'resolveOverseeProjectPick', queueIndex, slot }),
    resolveCaptureOperativePick: (_g: any, leaderId: any) => act({ kind: 'resolveCaptureOperativePick', leaderId }),
    resolveCarbonFreezingPick: (_g: any, leaderId: any) => act({ kind: 'resolveCarbonFreezingPick', leaderId }),
    resolveLureOfTheDarkSidePick: (_g: any, leaderId: any) => act({ kind: 'resolveLureOfTheDarkSidePick', leaderId }),
    resolveHomingBeaconPlace: (_g: any, leaderId: any, systemId: any) => act({ kind: 'resolveHomingBeaconPlace', leaderId, systemId }),
    resolveResearchAndDevelopmentOption: (_g: any, option: any) => act({ kind: 'resolveResearchAndDevelopmentOption', option }),
    resolveResearchAndDevelopmentProjectPick: (_g: any, keepInHandId: any) => act({ kind: 'resolveResearchAndDevelopmentProjectPick', keepInHandId }),
    resolveDestroyUpToHealth: (_g: any, instanceIds: any) => act({ kind: 'resolveDestroyUpToHealth', instanceIds }),
    resolveRogueSquadronRaidPick: (_g: any, picks: any) => act({ kind: 'resolveRogueSquadronRaidPick', picks }),
    resolveDoubleOurEffortsPick: (_g: any, picks: any) => act({ kind: 'resolveDoubleOurEffortsPick', picks }),
    resolvePlanetaryConquestSourcePick: (_g: any, sourceSystemId: any) => act({ kind: 'resolvePlanetaryConquestSourcePick', sourceSystemId }),
    resolveFearWillKeepThemInLinePick: (_g: any, systemIds: any) => act({ kind: 'resolveFearWillKeepThemInLinePick', systemIds }),
    resolvePublicUprisingPick: (_g: any, picks: any) => act({ kind: 'resolvePublicUprisingPick', picks }),
    resolveSupportOfMonCalamariPick: (_g: any, option: any) => act({ kind: 'resolveSupportOfMonCalamariPick', option }),
    resolveMisdirectionPick: (_g: any, leaderId: any) => act({ kind: 'resolveMisdirectionPick', leaderId }),
    resolveCovertOperationPick: (_g: any, keepInHandId: any) => act({ kind: 'resolveCovertOperationPick', keepInHandId }),
    resolvePlantFalseLeadPlacement: (_g: any, placements: any) => act({ kind: 'resolvePlantFalseLeadPlacement', placements }),
    resolveDetainedTargetPick: (_g: any, leaderId: any) => act({ kind: 'resolveDetainedTargetPick', leaderId }),
    resolveOneInAMillionMission: (_g: any, picks: any) => act({ kind: 'resolveOneInAMillionMission', picks }),
    resolveNobleSacrificeOffer: (_g: any, accept: any) => act({ kind: 'resolveNobleSacrificeOffer', accept }),
    resolveItIsYourDestinyOffer: (_g: any, leaderId: any) => act({ kind: 'resolveItIsYourDestinyOffer', leaderId }),
    resolveUndercoverOffer: (_g: any, leaderId: any) => act({ kind: 'resolveUndercoverOffer', leaderId }),
    resolveSonOfSkywalkerOffer: (_g: any, missionIdOrNull: any) => act({ kind: 'resolveSonOfSkywalkerOffer', missionId: missionIdOrNull }),
    resolveBlindsideOffer: (_g: any, accept: any) => act({ kind: 'resolveBlindsideOffer', accept }),
    resolveWookieGuardianOffer: (_g: any, accept: any) => act({ kind: 'resolveWookieGuardianOffer', accept }),
    resolveC3POOffer: (_g: any, accept: any) => act({ kind: 'resolveC3POOffer', accept }),
    resolveFalconOffer: (_g: any, leaderId: any) => act({ kind: 'resolveFalconOffer', leaderId }),
    resolveBrilliantAdministratorBuildPick: (_g: any, typeIds: any) => act({ kind: 'resolveBrilliantAdministratorBuildPick', typeIds }),
    resolveCatchThemBySurpriseMovePick: (_g: any, sourceSystemId: any, unitInstanceIds: any) => act({ kind: 'resolveCatchThemBySurpriseMovePick', sourceSystemId, unitInstanceIds }),
    resolveScoutingMissionTIEPick: (_g: any, unitInstanceIds: any) => act({ kind: 'resolveScoutingMissionTIEPick', unitInstanceIds }),
    resolveOurMostDesperateHourPick: (_g: any, missionId: any) => act({ kind: 'resolveOurMostDesperateHourPick', missionId }),
    resolveProceedingAsPlannedPick: (_g: any, missionId: any) => act({ kind: 'resolveProceedingAsPlannedPick', missionId }),
    resolveStartEvacuationPick: (_g: any, targetSystemId: any, unitInstanceIds: any) => act({ kind: 'resolveStartEvacuationPick', targetSystemId, unitInstanceIds }),
    resolveIndependentOperationEvacPick: (_g: any, destinationSystemId: any) => act({ kind: 'resolveIndependentOperationEvacPick', destinationSystemId }),
    resolveHiddenFleetUnitPick: (_g: any, unitInstanceIds: any) => act({ kind: 'resolveHiddenFleetUnitPick', unitInstanceIds }),
    resolveTemporaryAllianceBuildPick: (_g: any, typeIds: any) => act({ kind: 'resolveTemporaryAllianceBuildPick', typeIds }),
    resolveBuildFromIconsPick: (_g: any, typeIds: any) => act({ kind: 'resolveBuildFromIconsPick', typeIds }),
    resolveContingencyPlanPick: (_g: any, missionId: any) => act({ kind: 'resolveContingencyPlanPick', missionId }),
    resolveRetrieveThePlansPick: (_g: any, objectiveId: any) => act({ kind: 'resolveRetrieveThePlansPick', objectiveId }),
    resolveInterrogationDroidDecoyPick: (_g: any, systemIds: any) => act({ kind: 'resolveInterrogationDroidDecoyPick', systemIds }),
    resolvePlayObjectivePick: (_g: any, objectiveId: any) => act({ kind: 'resolvePlayObjectivePick', objectiveId }),
    resolveRecruitActionCardPick: (_g: any, keepCardId: any) => act({ kind: 'resolveRecruitActionCardPick', keepCardId }),
    resolveRecruitLeaderPick: (_g: any, leaderId: any) => act({ kind: 'resolveRecruitLeaderPick', leaderId }),
    recruitDrawAnother: (_g: any) => act({ kind: 'recruitDrawAnother' }),
    resolveBuildPicks: (_g: any, choices: any) => act({ kind: 'resolveBuildPicks', choices }),
    resolveDeployUnitPick: (_g: any, systemId: any) => act({ kind: 'resolveDeployUnitPick', systemId }),
    resolveAttachRing: (_g: any, leaderId: any) => act({ kind: 'resolveAttachRing', leaderId }),
    resolveActionCardSystemPick: (_g: any, systemId: any) => act({ kind: 'resolveActionCardSystemPick', systemId }),
    // Rapid Mobilization
    resolveRapidMobilizationBranch: (_g: any, branch: any) => act({ kind: 'resolveRapidMobilizationBranch', branch }),
    resolveRapidMobilizationMove: (_g: any, sourceSystemId: any, unitInstanceIds: any) => act({ kind: 'resolveRapidMobilizationMove', sourceSystemId, unitInstanceIds }),
    resolveRapidMobilizationBasePick: (_g: any, systemId: any) => act({ kind: 'resolveRapidMobilizationBasePick', systemId }),
  } as typeof phasesModule;
}

export function makeOnlineCombat(submit: Submit, canSubmit: () => boolean): typeof combatModule {
  const act = makeAct(submit, canSubmit);
  return {
    ...combatModule,
    // Called from PlayTab.
    resolveCombatObjectivePick: (_g: any, objectiveId: any) => act({ kind: 'resolveCombatObjectivePick', objectiveId }),
    resolveDeathStarPlansAttempt: (_g: any, attempt: any, deathStarInstanceId?: any) => act({ kind: 'resolveDeathStarPlansAttempt', attempt, deathStarInstanceId }),
    // The combat sub-machine — called from CombatBoardLive (step 2b).
    resolveCombatStartActionCards: (_g: any, cardIds: any) => act({ kind: 'resolveCombatStartActionCards', cardIds }),
    resolveCombatAddLeaderPick: (_g: any, leaderId: any) => act({ kind: 'resolveCombatAddLeaderPick', leaderId }),
    resolveCombatAttackerTactics: (_g: any, plays: any) => act({ kind: 'resolveCombatAttackerTactics', plays }),
    resolveCombatDefenderTactics: (_g: any, plays: any) => act({ kind: 'resolveCombatDefenderTactics', plays }),
    resolveYodaReroll: (_g: any, rerollIndex: any) => act({ kind: 'resolveYodaReroll', rerollIndex }),
    resolveR2D2Flip: (_g: any, flipIndex: any) => act({ kind: 'resolveR2D2Flip', flipIndex }),
    resolveSpecialDieSpend: (_g: any, plays: any) => act({ kind: 'resolveSpecialDieSpend', plays }),
    resolveCombatAssignDamage: (_g: any, assignments: any) => act({ kind: 'resolveCombatAssignDamage', assignments }),
    resolveOneInAMillionCombat: (_g: any, picks: any) => act({ kind: 'resolveOneInAMillionCombat', picks }),
    resolveMoreDangerousTheaterPick: (_g: any, theater: any) => act({ kind: 'resolveMoreDangerousTheaterPick', theater }),
    resolveFullyOperationalTargetPick: (_g: any, instanceId: any) => act({ kind: 'resolveFullyOperationalTargetPick', instanceId }),
    resolveTargetTheGeneratorPick: (_g: any, instanceId: any) => act({ kind: 'resolveTargetTheGeneratorPick', instanceId }),
    resolveReadyForActionLeaderPick: (_g: any, leaderId: any) => act({ kind: 'resolveReadyForActionLeaderPick', leaderId }),
    resolveRetreatDecision: (_g: any, destSystemId: any, unitInstanceIds: any, leaderId?: any) => act({ kind: 'resolveRetreatDecision', destSystemId, unitInstanceIds, leaderId }),
  } as typeof combatModule;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
