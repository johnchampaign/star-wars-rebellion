// Board feature extractor for the LEARNED leaf evaluator (#539 Phase 2).
//
// A pure GameState -> number[] map, shared by the offline trainer
// (scripts/train-leaf-eval.mjs) and the runtime learned eval
// (boardEval.evaluateLearned). Features are RAW quantities (not pre-weighted)
// from `side`'s perspective, always self-minus-enemy where symmetric, so one
// coefficient vector serves both sides. The list deliberately includes the
// tempo / commitment signals the hand-tuned evaluate() lacks — forward
// presence, contact, leader commitment, objective progress — because the MCTS
// passivity frontier is exactly boardEval rating "keep units home" above
// "commit to a winning attack" (it counts unit preservation, not tempo).
//
// STABILITY CONTRACT: append-only. The trained weight vector
// (leafEvalWeights.ts) is positional — inserting or reordering a feature
// invalidates it. Add new features at the END and retrain.
import type { GameState, Side, SystemId } from '../engine/types';

const other = (s: Side): Side => (s === 'Rebel' ? 'Empire' : 'Rebel');

/** Unit combat worth = attack dice + health (cheap, matches boardEval's intent
 *  without importing its private helper). */
function unitStrength(G: GameState, typeId: string): number {
  const t = G.catalog.unitTypes[typeId];
  if (!t) return 0;
  return (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0);
}

export const FEATURE_NAMES: string[] = [
  'bias',                    // 0 constant term (intercept)
  'loyalDiff',               // my loyal systems - enemy loyal systems
  'resourceDiff',            // my loyal resource icons - enemy's
  'subjugatedByEnemy',       // systems the ENEMY holds subjugated (bad for me)
  'subjugatedByMe',          // systems I hold subjugated (good for me)
  'sabotagedEnemyResources', // sabotage markers on enemy-producing systems
  'unitStrengthDiff',        // my unit strength - enemy unit strength (all systems)
  'groundStrengthDiff',      // ground-only strength diff
  'spaceStrengthDiff',       // space-only strength diff
  'leaderWorthDiff',         // my in-play leader count - enemy's (pool+board+missions)
  'capturedByEnemy',         // my leaders the enemy holds captured
  'capturedByMe',            // enemy leaders I hold captured
  'repProgress',             // trackLength - reputationMarker (Rebel-positive), signed to side
  'timeRemaining',           // trackLength - timeMarker (clock pressure)
  'baseRevealed',            // 1 if the Rebel base is public (signed to side: Empire-good)
  'empGroundAtBase',         // Empire ground at the revealed base (signed)
  'baseCandidates',          // # systems the base could still be at (Rebel-good, pre-reveal)
  // --- tempo / commitment (the anti-passivity signals) ---
  'contestedSystems',        // systems where BOTH sides have units (contact)
  'myForwardUnits',          // my units sitting in enemy-loyal/subjugated systems
  'leaderCommitment',        // fraction of my leaders out of the pool (0..1)
  'myObjectivesInHand',      // Rebel objective-hand size (signed: Rebel-good)
  'scoredObjectiveRep',      // reputation already scored via objectives (signed)
  'myBuildQueue',            // units queued to build (mine - enemy)
];

/** Extract the feature vector for `side`. Length === FEATURE_NAMES.length. */
export function boardFeatures(G: GameState, side: Side): number[] {
  const enemy = other(side);
  const myLoyalty = side === 'Rebel' ? 'rebel' : 'imperial';
  const enemyLoyalty = side === 'Rebel' ? 'imperial' : 'rebel';
  const sign = side === 'Rebel' ? 1 : -1; // for Rebel-framed raw quantities

  let loyalDiff = 0, resourceDiff = 0, subjEnemy = 0, subjMe = 0, sabEnemyRes = 0;
  let unitDiff = 0, groundDiff = 0, spaceDiff = 0;
  let contested = 0, forward = 0;

  const scanUnits = (units: { side: Side; typeId: string }[]) => {
    let mine = 0, theirs = 0;
    for (const u of units) {
      const w = unitStrength(G, u.typeId);
      const t = G.catalog.unitTypes[u.typeId];
      const s = u.side === side ? 1 : -1;
      unitDiff += s * w;
      if (t?.theater === 'ground') groundDiff += s * w; else if (t?.theater === 'space') spaceDiff += s * w;
      if (u.side === side) mine++; else theirs++;
    }
    return { mine, theirs };
  };

  for (const [sid, ss] of Object.entries(G.map.systems)) {
    if (ss.destroyed) continue;
    const res = G.catalog.systems[sid]?.resources?.length ?? 0;
    if (ss.subjugated) {
      if (side === 'Empire') subjMe += 1; else subjEnemy += 1;
      // (Only the Empire subjugates; from the Rebel's view it's enemy-held.)
    } else if (ss.loyalty === myLoyalty) { loyalDiff += 1; resourceDiff += res; }
    else if (ss.loyalty === enemyLoyalty) { loyalDiff -= 1; resourceDiff -= res; }
    if (ss.sabotage && res > 0) {
      // sabotage hurts the Empire's production → good for whoever opposes Empire
      sabEnemyRes += side === 'Rebel' ? 1 : -1;
    }
    const { mine, theirs } = scanUnits(ss.units);
    if (mine > 0 && theirs > 0) contested += 1;
    if (mine > 0 && (ss.loyalty === enemyLoyalty || ss.subjugated)) forward += mine;
  }
  if (G.map.rebelBaseSpace) scanUnits(G.map.rebelBaseSpace.units);

  // Leaders.
  const countLeaders = (s: Side): number => {
    const f = s === 'Rebel' ? G.rebel : G.empire;
    return f.leaderPool.length
      + Object.values(f.leadersOnBoard).reduce((a, l) => a + l.length, 0)
      + f.leadersOnMissions.reduce((a, m) => a + m.leaderIds.length, 0);
  };
  const myLeaders = countLeaders(side), enemyLeaders = countLeaders(enemy);
  const captured = G.empire.capturedLeaders ?? [];
  // Empire holds captured Rebel leaders: bad for Rebel, good for Empire.
  const capturedByEmpire = captured.length;

  const repProgress = G.trackLength - G.reputationMarker; // Rebel-positive
  const empGroundAtBase = (() => {
    if (!G.rebelBaseRevealed || !G.rebelBaseSystemId) return 0;
    const bs = G.map.systems[G.rebelBaseSystemId as SystemId];
    let n = 0;
    for (const u of bs?.units ?? []) if (u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground') n++;
    return n;
  })();

  const myPool = (side === 'Rebel' ? G.rebel : G.empire).leaderPool.length;
  const leaderCommitment = myLeaders > 0 ? 1 - myPool / myLeaders : 0;
  const objHand = (G.rebel.objectiveHand ?? []).length;
  const scoredRep = (G.rebel.scoredObjectives ?? []).reduce((a, o) => a + o.reputation, 0);
  const buildQueueLen = (f: Side) => {
    const q = (f === 'Rebel' ? G.rebel : G.empire).buildQueue;
    return q ? (q[1].length + q[2].length + q[3].length) : 0;
  };

  return [
    1,
    loyalDiff,
    resourceDiff,
    subjEnemy,
    subjMe,
    sabEnemyRes,
    unitDiff,
    groundDiff,
    spaceDiff,
    myLeaders - enemyLeaders,
    sign > 0 ? capturedByEmpire : 0,      // capturedByEnemy (Rebel view)
    sign < 0 ? capturedByEmpire : 0,      // capturedByMe (Empire view)
    sign * repProgress,
    G.trackLength - G.timeMarker,
    sign < 0 ? (G.rebelBaseRevealed ? 1 : 0) : (G.rebelBaseRevealed ? -1 : 0),
    sign < 0 ? empGroundAtBase : -empGroundAtBase,
    0, // baseCandidates — filled by caller when available (needs mctsAI.baseCandidates); 0 here
    contested,
    forward,
    leaderCommitment,
    sign * objHand,
    sign * scoredRep,
    buildQueueLen(side) - buildQueueLen(enemy),
  ];
}
