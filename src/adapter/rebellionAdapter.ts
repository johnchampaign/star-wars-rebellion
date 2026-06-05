// The game-specific GameAdapter for the digital-boardgame-framework port.
// Bridges the framework's flat (state, action, actor) model onto the existing
// pure-function engine (src/engine/phases.ts + combat.ts), which is driven by
// many discrete entry points returning {ok, reason}.
//
// Status: Phase 1. applyAction/tryApplyAction/currentActor/canAct/result are
// complete. viewFor is a STUB (identity) and is NOT SAFE to send over a
// network — per-seat redaction is Phase 2 (#103). legalActions is intentionally
// minimal (human clients build actions via the existing UI and the server
// validates each submit via tryApplyAction; full enumeration is Phase 4+).

import type { GameAdapter, GameResult } from 'digital-boardgame-framework';
import type { GameState } from '../engine/types';
import type { Side } from '../types';
import type { RebellionAction } from './rebellionAction';
import { assertNever } from './rebellionAction';
import { pendingChoiceOwner } from '../engine/choiceOwner';
import * as phases from '../engine/phases';
import * as combat from '../engine/combat';

type Result = { ok: boolean; reason?: string };

/** Deep, mutation-safe copy. The engine functions mutate G in place and return
 *  {ok, reason}; the framework expects applyAction to be pure, so we always run
 *  the engine against a fresh clone. GameState is fully JSON-serializable (it
 *  round-trips through the engine codec), so structuredClone is safe. */
function clone(state: GameState): GameState {
  return structuredClone(state);
}

/** Dispatch one action onto a (already-cloned) mutable state `G`, calling the
 *  matching engine entry point. `actor` is supplied by the framework and passed
 *  as `side` to the functions that take one; choice-resolution functions read
 *  the owning side from the state itself. */
function dispatch(G: GameState, a: RebellionAction, actor: Side): Result {
  switch (a.kind) {
    // ---------- Setup ----------
    case 'pickRebelBase':      return phases.pickRebelBase(G, a.systemId);
    case 'setupDeployUnit':    return phases.setupDeployUnit(G, actor, a.typeId, a.systemId);
    case 'setupAutoFill':      return phases.setupAutoFill(G, actor);

    // ---------- Assignment ----------
    case 'assignLeader':       return phases.assignLeader(G, actor, a.missionId, a.leaderIds);
    case 'unassignLeader':     return phases.unassignLeader(G, actor, a.missionId);
    case 'skipAssignment':     return phases.skipAssignment(G, actor);
    case 'playAssignmentActionCard': return phases.playAssignmentActionCard(G, a.cardId);

    // ---------- Command (top-level) ----------
    case 'pass':               return phases.pass(G, actor);
    case 'activateSystem':     return phases.activateSystem(G, actor, a.leaderId, a.targetSystemId, a.moveOrders);
    case 'revealMission':      return phases.revealMission(G, actor, a.missionId, a.targetSystemId, a.targetLeaderId);

    // ---------- Mission resolution (top of flow) ----------
    case 'resolveOpposition':        return phases.resolveOpposition(G, a.opposerLeaderId);
    case 'resolveYodaMissionReroll': return phases.resolveYodaMissionReroll(G, a.rerollIndex);
    case 'resolveR2D2MissionFlip':   return phases.resolveR2D2MissionFlip(G, a.flipIndex);
    case 'resolveStolenPlansPick':   return phases.resolveStolenPlansPick(G, a.cardId);
    case 'resolveInfiltrationPick':  return phases.resolveInfiltrationPick(G, a.keepOnTopId);

    // ---------- Mission-effect sub-choices ----------
    case 'resolvePlanTheAssaultShips':           return phases.resolvePlanTheAssaultShips(G, a.shipIds);
    case 'resolveLeadStrikeTeamUnits':           return phases.resolveLeadStrikeTeamUnits(G, a.unitIds);
    case 'resolveOverseeProjectPick':            return phases.resolveOverseeProjectPick(G, a.queueIndex, a.slot);
    case 'resolveCaptureOperativePick':          return phases.resolveCaptureOperativePick(G, a.leaderId);
    case 'resolveCarbonFreezingPick':            return phases.resolveCarbonFreezingPick(G, a.leaderId);
    case 'resolveLureOfTheDarkSidePick':         return phases.resolveLureOfTheDarkSidePick(G, a.leaderId);
    case 'resolveHomingBeaconPlace':             return phases.resolveHomingBeaconPlace(G, a.leaderId, a.systemId);
    case 'resolveResearchAndDevelopmentOption':  return phases.resolveResearchAndDevelopmentOption(G, a.option);
    case 'resolveResearchAndDevelopmentProjectPick': return phases.resolveResearchAndDevelopmentProjectPick(G, a.keepInHandId);
    case 'resolveDestroyUpToHealth':             return phases.resolveDestroyUpToHealth(G, a.instanceIds);
    case 'resolveRogueSquadronRaidPick':         return phases.resolveRogueSquadronRaidPick(G, a.picks);
    case 'resolveDoubleOurEffortsPick':          return phases.resolveDoubleOurEffortsPick(G, a.picks);
    case 'resolvePlanetaryConquestSourcePick':   return phases.resolvePlanetaryConquestSourcePick(G, a.sourceSystemId);
    case 'resolveFearWillKeepThemInLinePick':    return phases.resolveFearWillKeepThemInLinePick(G, a.systemIds);
    case 'resolvePublicUprisingPick':            return phases.resolvePublicUprisingPick(G, a.picks);
    case 'resolveSupportOfMonCalamariPick':      return phases.resolveSupportOfMonCalamariPick(G, a.option);
    case 'resolveMisdirectionPick':              return phases.resolveMisdirectionPick(G, a.leaderId);
    case 'resolveCovertOperationPick':           return phases.resolveCovertOperationPick(G, a.keepInHandId);
    case 'resolvePlantFalseLeadPlacement':       return phases.resolvePlantFalseLeadPlacement(G, a.placements);
    case 'resolveDetainedTargetPick':            return phases.resolveDetainedTargetPick(G, a.leaderId);
    case 'resolveOneInAMillionMission':          return phases.resolveOneInAMillionMission(G, a.picks);
    case 'resolveNobleSacrificeOffer':           return phases.resolveNobleSacrificeOffer(G, a.accept);
    case 'resolveItIsYourDestinyOffer':          return phases.resolveItIsYourDestinyOffer(G, a.leaderId);
    case 'resolveUndercoverOffer':               return phases.resolveUndercoverOffer(G, a.leaderId);
    case 'resolveSonOfSkywalkerOffer':           return phases.resolveSonOfSkywalkerOffer(G, a.missionId);
    case 'resolveBlindsideOffer':                return phases.resolveBlindsideOffer(G, a.accept);
    case 'resolveWookieGuardianOffer':           return phases.resolveWookieGuardianOffer(G, a.accept);
    case 'resolveC3POOffer':                     return phases.resolveC3POOffer(G, a.accept);
    case 'resolveFalconOffer':                   return phases.resolveFalconOffer(G, a.leaderId);
    case 'resolveBrilliantAdministratorBuildPick': return phases.resolveBrilliantAdministratorBuildPick(G, a.typeIds);
    case 'resolveCatchThemBySurpriseMovePick':   return phases.resolveCatchThemBySurpriseMovePick(G, a.sourceSystemId, a.unitInstanceIds);
    case 'resolveScoutingMissionTIEPick':        return phases.resolveScoutingMissionTIEPick(G, a.unitInstanceIds);
    case 'resolveOurMostDesperateHourPick':      return phases.resolveOurMostDesperateHourPick(G, a.missionId);
    case 'resolveProceedingAsPlannedPick':       return phases.resolveProceedingAsPlannedPick(G, a.missionId);
    case 'resolveStartEvacuationPick':           return phases.resolveStartEvacuationPick(G, a.targetSystemId, a.unitInstanceIds);
    case 'resolveIndependentOperationEvacPick':  return phases.resolveIndependentOperationEvacPick(G, a.destinationSystemId);
    case 'resolveHiddenFleetUnitPick':           return phases.resolveHiddenFleetUnitPick(G, a.unitInstanceIds);
    case 'resolveTemporaryAllianceBuildPick':    return phases.resolveTemporaryAllianceBuildPick(G, a.typeIds);
    case 'resolveBuildFromIconsPick':            return phases.resolveBuildFromIconsPick(G, a.typeIds);
    case 'resolveContingencyPlanPick':           return phases.resolveContingencyPlanPick(G, a.missionId);
    case 'resolveRetrieveThePlansPick':          return phases.resolveRetrieveThePlansPick(G, a.objectiveId);
    case 'resolveInterrogationDroidDecoyPick':   return phases.resolveInterrogationDroidDecoyPick(G, a.systemIds);
    case 'resolvePlayObjectivePick':             return phases.resolvePlayObjectivePick(G, a.objectiveId);
    case 'resolveRecruitActionCardPick':         return phases.resolveRecruitActionCardPick(G, a.keepCardId);
    case 'resolveRecruitLeaderPick':             return phases.resolveRecruitLeaderPick(G, a.leaderId);
    case 'recruitDrawAnother':                   return phases.recruitDrawAnother(G);
    case 'resolveBuildPicks':                    return phases.resolveBuildPicks(G, a.choices);
    case 'resolveDeployUnitPick':                return phases.resolveDeployUnitPick(G, a.systemId);
    case 'resolveAttachRing':                    return phases.resolveAttachRing(G, a.leaderId);
    case 'resolveActionCardSystemPick':          return phases.resolveActionCardSystemPick(G, a.systemId);

    // ---------- Rapid Mobilization ----------
    case 'resolveRapidMobilizationBranch':  return phases.resolveRapidMobilizationBranch(G, a.branch);
    case 'resolveRapidMobilizationMove':    return phases.resolveRapidMobilizationMove(G, a.sourceSystemId, a.unitInstanceIds);
    case 'resolveRapidMobilizationBasePick': return phases.resolveRapidMobilizationBasePick(G, a.systemId);

    // ---------- Combat sub-machine ----------
    case 'resolveCombatStartActionCards':   return combat.resolveCombatStartActionCards(G, a.cardIds);
    case 'resolveCombatAddLeaderPick':      return combat.resolveCombatAddLeaderPick(G, a.leaderId);
    case 'resolveCombatAttackerTactics':    return combat.resolveCombatAttackerTactics(G, a.plays);
    case 'resolveCombatDefenderTactics':    return combat.resolveCombatDefenderTactics(G, a.plays);
    case 'resolveYodaReroll':               return combat.resolveYodaReroll(G, a.rerollIndex);
    case 'resolveR2D2Flip':                 return combat.resolveR2D2Flip(G, a.flipIndex);
    case 'resolveSpecialDieSpend':          return combat.resolveSpecialDieSpend(G, a.plays);
    case 'resolveCombatAssignDamage':       return combat.resolveCombatAssignDamage(G, a.assignments);
    case 'resolveOneInAMillionCombat':      return combat.resolveOneInAMillionCombat(G, a.picks);
    case 'resolveMoreDangerousTheaterPick': return combat.resolveMoreDangerousTheaterPick(G, a.theater);
    case 'resolveFullyOperationalTargetPick': return combat.resolveFullyOperationalTargetPick(G, a.instanceId);
    case 'resolveTargetTheGeneratorPick':   return combat.resolveTargetTheGeneratorPick(G, a.instanceId);
    case 'resolveReadyForActionLeaderPick': return combat.resolveReadyForActionLeaderPick(G, a.leaderId);
    case 'resolveRetreatDecision':          return combat.resolveRetreatDecision(G, a.destSystemId, a.unitInstanceIds, a.leaderId ?? null);
    case 'resolveCombatObjectivePick':      return combat.resolveCombatObjectivePick(G, a.objectiveId);
    case 'resolveDeathStarPlansAttempt':    return combat.resolveDeathStarPlansAttempt(G, a.attempt, a.deathStarInstanceId);

    default: return assertNever(a);
  }
}

/** Whose input the engine is currently waiting on. When a choice/combat
 *  sub-step is open the actor is the choice owner (NOT G.currentPlayer); when
 *  the game is over there is no actor. */
function currentActor(state: GameState): Side | null {
  if (state.isGameOver || state.phase === 'GameOver') return null;
  if (state.pendingChoice) {
    if (pendingChoiceOwner(state, 'Rebel')) return 'Rebel';
    if (pendingChoiceOwner(state, 'Empire')) return 'Empire';
    return state.currentPlayer; // fallback for any untagged choice
  }
  return state.currentPlayer;
}

export const rebellionAdapter: GameAdapter<GameState, RebellionAction, Side> = {
  applyAction(state, action, actor) {
    const G = clone(state);
    const r = dispatch(G, action, actor);
    if (!r.ok) throw new Error(r.reason ?? `Illegal action: ${action.kind}`);
    return G;
  },

  tryApplyAction(state, action, actor) {
    const G = clone(state);
    const r = dispatch(G, action, actor);
    return { state: r.ok ? G : state, ok: r.ok, reason: r.reason };
  },

  currentActor,

  canAct(state, actor) {
    return currentActor(state) === actor;
  },

  // currentActor already resolves choice owners (incl. opposition/combat
  // defender), so in-turn validation covers the out-of-turn cases.
  allowsOutOfTurn() {
    return false;
  },

  // STUB — identity. NOT SAFE FOR NETWORK USE: this would leak the Rebel base
  // location and both hands to the opponent's client. Real per-seat redaction
  // is Phase 2 (#103); the server must not be wired to clients until it lands.
  viewFor(state) {
    return state;
  },

  result(state): GameResult<Side> | null {
    if (!state.isGameOver) return null;
    return { winners: state.winner ? [state.winner] : [], reason: state.winReason };
  },

  // Minimal for now (see header note). Human clients construct actions via the
  // existing PlayTab UI; the server validates each one with tryApplyAction.
  // Full enumeration (needed for online AI) is deferred to Phase 4+.
  legalActions(state, actor) {
    if (currentActor(state) !== actor) return [];
    if (!state.pendingChoice && state.phase === 'Command') return [{ kind: 'pass' }];
    return [];
  },

  schemaVersion: 1,
};
