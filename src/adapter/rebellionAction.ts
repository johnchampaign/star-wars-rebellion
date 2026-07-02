// Discriminated union of every player-submittable Action for the
// digital-boardgame-framework multiplayer port.
//
// One variant per *over-the-wire* engine entry point in src/engine/phases.ts
// and src/engine/combat.ts. Reconciled against the CURRENT engine (the
// framework-port-archive's union predates months of engine divergence, so this
// was re-derived from today's exact signatures — do not assume parity with it).
//
// Design notes:
//   - Per-resolver variants are fully typed so TS catches payload-shape
//     mismatches in the adapter's applyAction switch, and legalActions returns
//     precisely-typed values for the UI.
//   - Most steps that MUTATE engine state must cross the wire, including the
//     ones that open/cancel a sub-choice: requestAssignmentActionCardPlay sets
//     G.pendingChoice server-side, so the following playAssignmentActionCard has
//     something to resolve (otherwise the server rejects it "no-pending"); its
//     cancel must likewise clear that server-side choice. A take-back during the
//     Assignment phase IS allowed (unassignLeader), because nothing is revealed
//     until the Command phase. Pure-local UI (undo stacks, hover) stays local.
//   - The framework's PlayerId is Rebellion's `Side` ('Rebel' | 'Empire').
//     `actor` is supplied by the framework on submit, never packed into the
//     Action payload.

import type { Side, SystemId } from '../types';
import type { LeaderId, UnitInstanceId, UnitTypeId } from '../engine/types';
import type { MoveOrder } from '../engine/phases';

export type RebellionAction =
  // ---------- Setup ----------
  | { kind: 'pickRebelBase'; systemId: SystemId }
  | { kind: 'setupDeployUnit'; typeId: UnitTypeId; systemId: SystemId }
  | { kind: 'setupAutoFill' }

  // ---------- Reports / notices (dismiss a queued modal) ----------
  | { kind: 'acknowledgeReport'; reportType: 'mission' | 'combat' | 'objective' | 'refresh' | 'activation' }
  | { kind: 'acknowledgeNotices' }

  // ---------- Assignment ----------
  | { kind: 'assignLeader'; missionId: string; leaderIds: LeaderId[] }
  | { kind: 'unassignLeader'; missionId: string }
  | { kind: 'skipAssignment' }
  | { kind: 'requestAssignmentActionCardPlay' }
  | { kind: 'cancelAssignmentActionCardPlay' }
  | { kind: 'playAssignmentActionCard'; cardId: string }

  // ---------- Command (top-level) ----------
  | { kind: 'pass' }
  | { kind: 'activateSystem'; leaderId: LeaderId; targetSystemId: SystemId; moveOrders: MoveOrder[] }
  | { kind: 'revealMission'; missionId: string; targetSystemId: SystemId; targetLeaderId?: LeaderId; assignedLeaderIds?: LeaderId[] }

  // ---------- Mission resolution (top of the mission flow) ----------
  | { kind: 'resolveOpposition'; opposerLeaderId: LeaderId | null }
  | { kind: 'resolveYodaMissionReroll'; rerollIndex: number | null }
  | { kind: 'resolveR2D2MissionFlip'; flipIndex: number | null }
  | { kind: 'resolveStolenPlansPick'; cardId: string }
  | { kind: 'resolveInfiltrationPick'; keepOnTopId: string }

  // ---------- Mission-effect sub-choices ----------
  | { kind: 'resolvePlanTheAssaultShips'; shipIds: UnitInstanceId[] }
  | { kind: 'resolveLeadStrikeTeamUnits'; unitIds: UnitInstanceId[] }
  | { kind: 'resolveOverseeProjectPick'; queueIndex: number; slot: 1 | 2 }
  | { kind: 'resolveCaptureOperativePick'; leaderId: LeaderId }
  | { kind: 'resolveCarbonFreezingPick'; leaderId: LeaderId }
  | { kind: 'resolveLureOfTheDarkSidePick'; leaderId: LeaderId }
  | { kind: 'resolveHomingBeaconPlace'; leaderId: LeaderId; systemId: SystemId }
  | { kind: 'resolveResearchAndDevelopmentOption'; option: 'A' | 'B' }
  | { kind: 'resolveResearchAndDevelopmentProjectPick'; keepInHandId: string }
  | { kind: 'resolveDestroyUpToHealth'; instanceIds: UnitInstanceId[] }
  | { kind: 'resolveRogueSquadronRaidPick'; picks: { slot: 1 | 2 | 3; queueIndex: number }[] }
  | { kind: 'resolveDoubleOurEffortsPick'; picks: { slot: 2 | 3; queueIndex: number }[] }
  | { kind: 'resolvePlanetaryConquestSourcePick'; sourceSystemId: SystemId }
  | { kind: 'resolveFearWillKeepThemInLinePick'; systemIds: SystemId[] }
  | {
      kind: 'resolvePublicUprisingPick';
      picks: {
        circle: 'corellian-corvette' | 'airspeeder';
        triangles: ('x-wing' | 'rebel-trooper')[];
      };
    }
  | { kind: 'resolveSupportOfMonCalamariPick'; option: 'loyalty' | 'cruiser' }
  | { kind: 'resolveMisdirectionPick'; leaderId: LeaderId }
  | { kind: 'resolveCovertOperationPick'; keepInHandId: string }
  | { kind: 'resolvePlantFalseLeadPlacement'; placements: { cardId: string; position: 'top' | 'bottom' }[] }
  | { kind: 'resolveDetainedTargetPick'; leaderId: LeaderId }
  | { kind: 'resolveOneInAMillionMission'; picks: { index: number; face: string }[] }
  | { kind: 'resolveNobleSacrificeOffer'; accept: boolean }
  | { kind: 'resolveItIsYourDestinyOffer'; leaderId: LeaderId | null }
  | { kind: 'resolveUndercoverOffer'; leaderId: LeaderId | null }
  | { kind: 'resolveSonOfSkywalkerOffer'; missionId: string | null }
  | { kind: 'resolveBlindsideOffer'; accept: boolean }
  | { kind: 'resolveWookieGuardianOffer'; accept: boolean }
  | { kind: 'resolveC3POOffer'; accept: boolean }
  | { kind: 'resolveFalconOffer'; leaderId: LeaderId | null }
  | { kind: 'resolveBrilliantAdministratorBuildPick'; typeIds: (UnitTypeId | null)[] }
  | { kind: 'resolveCatchThemBySurpriseMovePick'; sourceSystemId: SystemId; unitInstanceIds: UnitInstanceId[] }
  | { kind: 'resolveScoutingMissionTIEPick'; unitInstanceIds: UnitInstanceId[] }
  | { kind: 'resolveOurMostDesperateHourPick'; missionId: string }
  | { kind: 'resolveProceedingAsPlannedPick'; missionId: string }
  | { kind: 'resolveStartEvacuationPick'; targetSystemId: SystemId; unitInstanceIds: UnitInstanceId[] }
  | { kind: 'resolveIndependentOperationEvacPick'; destinationSystemId: SystemId }
  | { kind: 'resolveHiddenFleetUnitPick'; unitInstanceIds: UnitInstanceId[] }
  | { kind: 'resolveTemporaryAllianceBuildPick'; typeIds: (UnitTypeId | null)[] }
  | { kind: 'resolveBuildFromIconsPick'; typeIds: (UnitTypeId | null)[] }
  | { kind: 'resolveContingencyPlanPick'; missionId: string }
  | { kind: 'resolveRetrieveThePlansPick'; objectiveId: string }
  | { kind: 'resolveInterrogationDroidDecoyPick'; systemIds: SystemId[] }
  | { kind: 'resolvePlayObjectivePick'; objectiveId: string }
  | { kind: 'resolveRecruitActionCardPick'; keepCardId: string }
  | { kind: 'resolveRecruitLeaderPick'; leaderId: LeaderId }
  | { kind: 'recruitDrawAnother' }
  | { kind: 'resolveBuildPicks'; choices: string[] }
  | { kind: 'resolveDeployUnitPick'; systemId: SystemId }
  | { kind: 'declineDeployUnit' }
  | { kind: 'resolveHandLimitDiscard'; missionIds: string[] }
  | { kind: 'resolveLeaderPoolEliminate'; leaderId: LeaderId }
  | { kind: 'resolveAssignSecondLeader'; leaderId: LeaderId | null }
  | { kind: 'switchDeployType'; typeId: string }
  | { kind: 'resolveSecretFacilityUnitPick'; typeId: string }
  | { kind: 'resolveArmedCardRevealOffer'; reveal: boolean }
  | { kind: 'resolveAttachRing'; leaderId: LeaderId }
  | { kind: 'resolveActionCardSystemPick'; systemId: SystemId }

  // ---------- Rapid Mobilization (end-of-Command-phase drain) ----------
  | { kind: 'resolveRapidMobilizationBranch'; branch: 'move-units' | 'establish-base' }
  | { kind: 'resolveRapidMobilizationMove'; sourceSystemId: SystemId; unitInstanceIds: UnitInstanceId[] }
  | { kind: 'resolveRapidMobilizationBasePick'; systemId: SystemId }

  // ---------- Combat sub-machine ----------
  | { kind: 'resolveCombatStartActionCards'; cardIds: string[] }
  | { kind: 'resolveCombatAddLeaderPick'; leaderId: LeaderId | null }
  | {
      kind: 'resolveCombatAttackerTactics';
      plays: { concentrateFireCardId?: string | null; damageBoostCardIds?: string[] };
    }
  | { kind: 'resolveCombatDefenderTactics'; plays: { blockCardIds: string[]; sacrificeCardIds: string[] } }
  | { kind: 'resolveYodaReroll'; rerollIndex: number | null }
  | { kind: 'resolveR2D2Flip'; flipIndex: number | null }
  | { kind: 'resolveSpecialDieSpend'; plays: { draws: number; playCardIds: string[] } }
  | { kind: 'resolveCombatAssignDamage'; assignments: (UnitInstanceId | null)[] }
  | { kind: 'resolveOneInAMillionCombat'; picks: { index: number; face: string }[] }
  | { kind: 'resolveMoreDangerousTheaterPick'; theater: 'space' | 'ground' }
  | { kind: 'resolveMoreDangerousRetrievePick'; cardIds: string[] }
  | { kind: 'resolveFullyOperationalTargetPick'; instanceId: UnitInstanceId }
  | { kind: 'resolveTargetTheGeneratorPick'; instanceId: UnitInstanceId }
  | { kind: 'resolveReadyForActionLeaderPick'; leaderId: LeaderId }
  | {
      kind: 'resolveRetreatDecision';
      destSystemId: SystemId | null;
      unitInstanceIds: UnitInstanceId[] | null;
      leaderId?: LeaderId | null;
    }
  | { kind: 'resolveCombatObjectivePick'; objectiveId: string }
  | { kind: 'resolveDeathStarPlansAttempt'; attempt: boolean; deathStarInstanceId?: UnitInstanceId };

export type RebellionActionKind = RebellionAction['kind'];

/** Compile-time exhaustiveness helper for the adapter's applyAction switch:
 *  `default: return assertNever(action);` — fails to compile the moment a new
 *  variant is added but not handled. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled RebellionAction variant: ${JSON.stringify(x)}`);
}
