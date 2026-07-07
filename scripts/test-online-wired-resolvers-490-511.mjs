// Online soft-lock class (see docs / memory "online-adapter-missing-resolvers"):
// an engine resolver called directly from the UI but NOT wired into the online
// adapter (rebellionAction union + rebellionAdapter switch + onlineEngine shim)
// mutates only the local view online, so the next server poll reverts it — the
// choice re-appears forever ("Move rejected" / frozen opponent turn).
//
// This session wired a batch of previously-unwired resolvers:
//   #490  resolveRescuerReturn         (rescue "send heroes home?" froze online)
//   —     resolveGenericChoice         (the WHOLE generic-choice framework: The
//                                        Long War discard, Seize Control marker…)
//   #511  resolveRegionalAidPick       (Rebel "gain loyalty in which system")
//         resolveSuperlaserLoyaltyPick, resolveDrawThemOutPick, resolveDestroyedSystemCull
//   cinematic combat (#483/#495/#497/#498/#499): resolveCinematic{TacticSelect,
//         Reroll,Heal,DeferredHeal,TargetPick,DestroyPick}
//
// A resolver that reaches the engine returns the engine's own {ok:false,
// reason:'no-pending'|…} when no matching choice is set — which PROVES routing.
// An UNWIRED action instead comes back as "Illegal action: <kind>" from the
// adapter's assertNever default. This tripwire fails the moment one regresses.
// Run: node scripts/test-online-wired-resolvers-490-511.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const ACTIONS = [
  { kind: 'resolveRescuerReturn', leaderIds: [] },
  { kind: 'resolveGenericChoice', selection: [] },
  { kind: 'resolveRegionalAidPick', systemId: 'tatooine' },
  { kind: 'resolveSuperlaserLoyaltyPick', systemId: 'tatooine' },
  { kind: 'resolveDrawThemOutPick', leaderId: 'mon-mothma' },
  { kind: 'resolveDestroyedSystemCull', instanceIds: [] },
  { kind: 'resolveCinematicTacticSelect', cardId: null, useTop: false },
  { kind: 'resolveCinematicReroll', indices: [] },
  { kind: 'resolveCinematicHeal', allocation: [] },
  { kind: 'resolveCinematicDeferredHeal', allocation: [] },
  { kind: 'resolveCinematicTargetPick', instanceId: 'x' },
  { kind: 'resolveCinematicDestroyPick', instanceId: 'x' },
  // Full-coverage batch (human-vs-human online).
  { kind: 'resolveAmbitionsOfPowerOffer', accept: false },
  { kind: 'resolveArmCardProbePick', probeId: 'x' },
  { kind: 'resolveBehindEnemyLinesUnits', unitIds: [] },
  { kind: 'resolveBreakTheirWillPick', systemId: 'tatooine' },
  { kind: 'resolveDiscreditRebellion', action: 'roll' },
  { kind: 'resolveEstablishTradeChoice', action: 'loyalty' },
  { kind: 'resolveFalseOrders', targetLeaderId: null },
  { kind: 'resolveHeistChoice', action: 'x' },
  { kind: 'resolveImperialMightUnits', queueIndices: [] },
  { kind: 'resolveMissionRecruitLeaderPick', leaderId: 'mon-mothma' },
  { kind: 'resolvePostBountyOffer', leaderId: null },
  { kind: 'resolvePrepareForBattleDeckPick', deckKind: 'space-tactic' },
  { kind: 'resolveRaidOutpostsPlace', systemIds: [] },
  { kind: 'resolveRebelCellDiscard', objectiveId: null },
  { kind: 'resolveRebelCellPlace', systemId: 'tatooine' },
  { kind: 'resolveReconnaissancePick', missionId: 'x' },
  { kind: 'resolveSabotageChoice', action: 'place-marker' },
  { kind: 'resolveSafeHavenPick', pickedIndices: [] },
  { kind: 'resolveSecretMissionPick', missionId: 'x' },
  { kind: 'resolveStartingCardBranch', action: 'draw' },
  { kind: 'resolveTrustInTheForceDestroyPick', instanceId: 'x' },
  { kind: 'resolveUnderTheRadarKeep', probeId: 'x' },
  { kind: 'resolveUnderTheRadarReorder', placements: [] },
  { kind: 'resolveUnderTheRadarReturn', accept: false },
  { kind: 'resolveWereTheBaitUnits', unitIds: [] },
  { kind: 'requestImmediateActionCardPlay' },
  { kind: 'cancelImmediateActionCardPlay' },
  { kind: 'playImmediateActionCard', cardId: 'x' },
  { kind: 'setupUndoDeployUnit', typeId: 'x', systemId: 'tatooine' },
  { kind: 'undoStolenPlansPick' },
  { kind: 'resolveBazesLoyaltyTarget', instanceId: 'x' },
  { kind: 'resolveConfrontationLeaderPick', leaderId: 'mon-mothma' },
  { kind: 'resolveDsPlansOneInAMillion', picks: [] },
  { kind: 'resolveDsPlansYoda', blankIndex: 0 },
  { kind: 'resolveRogueOneChoice', action: 'x' },
  { kind: 'resolveSomethingToFightForOffer', objectiveId: null },
  { kind: 'resolveTrackThemOffer', leaderId: null },
  { kind: 'resolveTractorBeamCapturePick', leaderId: 'mon-mothma' },
];

console.log('\n[ every newly-wired resolver ROUTES through the online adapter (not "Illegal action") ]');
for (const action of ACTIONS) {
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true } });
  const r = rebellionAdapter.tryApplyAction(G, action, action.kind.includes('Superlaser') || action.kind.includes('DrawThemOut') ? 'Empire' : 'Rebel');
  check(`${action.kind} reaches its resolver`,
    !(r.reason ?? '').startsWith('Illegal action'), r.reason);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
