// Phase 5d-i: RoE objective scoring — condition + combat objectives.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();
const { createGame } = await import('../src/engine/setup.ts');
const Obj = await import('../src/engine/objectives.ts');
const Phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let fail = 0;
const check = (n, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : `  — ${extra}`)); if (!ok) fail++; };
const newG = () => createGame(data, { seed: 7, expansion: { enabled: true } });
let uid = 0;
const unit = (typeId, side) => ({ instanceId: `t${++uid}`, typeId, side, damage: 0 });

// ---- Refresh-condition objectives (objectiveConditionMet) ----

console.log('[ defensive-position-1: 3 Rebel structures in one system ]');
{
  const G = newG();
  const sys = Object.keys(G.map.systems).find((s) => s !== G.rebelBaseSystemId);
  G.map.systems[sys].units.push(unit('shield-generator', 'Rebel'), unit('ion-cannon', 'Rebel'));
  check('2 structures → not met', !Obj.objectiveConditionMet(G, 'defensive-position-1'));
  G.map.systems[sys].units.push(unit('golan-arms-turret', 'Rebel'));
  check('3 structures → met', Obj.objectiveConditionMet(G, 'defensive-position-1'));
}

console.log('[ support-of-the-hutts-1: 3 Rebel-loyalty systems in Nal Hutta region ]');
{
  const G = newG();
  const region = G.catalog.systems['nal-hutta'].region;
  const inRegion = Object.keys(G.map.systems).filter((id) => G.catalog.systems[id]?.region === region);
  inRegion.forEach((id) => { G.map.systems[id].loyalty = 'neutral'; });
  G.map.systems[inRegion[0]].loyalty = 'rebel';
  G.map.systems[inRegion[1]].loyalty = 'rebel';
  check('2 rebel-loyal → not met', !Obj.objectiveConditionMet(G, 'support-of-the-hutts-1'));
  G.map.systems[inRegion[2]].loyalty = 'rebel';
  check('3 rebel-loyal → met', Obj.objectiveConditionMet(G, 'support-of-the-hutts-1'));
}

console.log('[ threaten-the-core-1: 5 Rebel units in/adjacent Coruscant ]');
{
  const G = newG();
  // clear any rebels already in scope
  const scope = ['coruscant', ...(G.catalog.adjacency['coruscant'] ?? [])];
  scope.forEach((s) => { if (G.map.systems[s]) G.map.systems[s].units = G.map.systems[s].units.filter((u) => u.side !== 'Rebel'); });
  for (let i = 0; i < 4; i++) G.map.systems['coruscant'].units.push(unit('rebel-trooper', 'Rebel'));
  check('4 units → not met', !Obj.objectiveConditionMet(G, 'threaten-the-core-1'));
  const adj = G.catalog.adjacency['coruscant'][0];
  G.map.systems[adj].units.push(unit('rebel-trooper', 'Rebel'));
  check('5 units (4 in + 1 adjacent) → met', Obj.objectiveConditionMet(G, 'threaten-the-core-1'));
}

console.log('[ uprising-3: 9 Rebel-loyalty systems ]');
{
  const G = newG();
  Object.values(G.map.systems).forEach((ss) => { ss.loyalty = 'neutral'; });
  const ids = Object.keys(G.map.systems);
  for (let i = 0; i < 8; i++) G.map.systems[ids[i]].loyalty = 'rebel';
  check('8 → not met', !Obj.objectiveConditionMet(G, 'uprising-3'));
  G.map.systems[ids[8]].loyalty = 'rebel';
  check('9 → met', Obj.objectiveConditionMet(G, 'uprising-3'));
}

// ---- Combat objectives (combatObjectivesTriggered) ----

const atk = (theater, dmg) => ({ theater, damageApplied: dmg, destroyed: [], side: 'Rebel' });
const report = (over) => ({
  attackerSide: 'Rebel', winner: 'Rebel', systemId: 'tatooine',
  rounds: [{ attacks: [] }], retreatDestructions: [], ...over,
});

console.log('[ decisive-victory-1: win space AND ground battle ]');
{
  const G = newG(); G.rebel.objectiveHand = ['decisive-victory-1'];
  const spaceOnly = report({ rounds: [{ attacks: [atk('space', 2)] }] });
  check('space only → not fired', !Obj.combatObjectivesTriggered(G, spaceOnly).includes('decisive-victory-1'));
  const both = report({ rounds: [{ attacks: [atk('space', 2), atk('ground', 1)] }] });
  check('space + ground → fired', Obj.combatObjectivesTriggered(G, both).includes('decisive-victory-1'));
}

console.log('[ seize-control-2: win in sabotage-marked system ]');
{
  const G = newG(); G.rebel.objectiveHand = ['seize-control-2'];
  const r = report({ rounds: [{ attacks: [atk('ground', 1)] }] });
  check('no sabotage → not fired', !Obj.combatObjectivesTriggered(G, r).includes('seize-control-2'));
  G.map.systems['tatooine'].sabotage = true;
  check('sabotage present → fired', Obj.combatObjectivesTriggered(G, r).includes('seize-control-2'));
}
// #423: Rebel wins the GROUND battle but Empire ships remain in orbit, so the
// Rebel is NOT the sole occupant → report.winner is not 'Rebel'. Seize Control
// must still fire on the ground-battle win.
{
  const G = newG(); G.rebel.objectiveHand = ['seize-control-2'];
  const rebelGround = Object.values(G.catalog.unitTypes).find((u) => u.side === 'Rebel' && u.theater === 'ground');
  const empireSpace = Object.values(G.catalog.unitTypes).find((u) => u.side === 'Empire' && u.theater === 'space');
  G.map.systems['tatooine'].sabotage = true;
  G.map.systems['tatooine'].units = [unit(rebelGround.id, 'Rebel'), unit(empireSpace.id, 'Empire')];
  // Ground battle fought (Empire ground cleared); overall winner is NOT Rebel.
  const rGround = report({ winner: null, rounds: [{ attacks: [atk('ground', 1)] }] });
  check('ground win + Empire ships in orbit (not overall winner) → still fired',
    Obj.combatObjectivesTriggered(G, rGround).includes('seize-control-2'));
}

console.log('[ raid-imperial-factory-3: rebel-initiated win in resource system ]');
{
  const G = newG(); G.rebel.objectiveHand = ['raid-imperial-factory-3'];
  // find a system with a resource icon and one without
  const withRes = Object.keys(G.catalog.systems).find((id) => (G.catalog.systems[id].resources?.length ?? 0) > 0 && G.map.systems[id]);
  const noRes = Object.keys(G.catalog.systems).find((id) => (G.catalog.systems[id].resources?.length ?? 0) === 0 && G.map.systems[id]);
  const rNo = report({ systemId: noRes, rounds: [{ attacks: [atk('ground', 1)] }] });
  check('no resource icon → not fired', !Obj.combatObjectivesTriggered(G, rNo).includes('raid-imperial-factory-3'));
  const rDef = report({ systemId: withRes, attackerSide: 'Empire', rounds: [{ attacks: [atk('ground', 1)] }] });
  check('rebel did NOT initiate → not fired', !Obj.combatObjectivesTriggered(G, rDef).includes('raid-imperial-factory-3'));
  const rYes = report({ systemId: withRes, rounds: [{ attacks: [atk('ground', 1)] }] });
  check('rebel-initiated win in resource system → fired', Obj.combatObjectivesTriggered(G, rYes).includes('raid-imperial-factory-3'));
}

// ---- 5d-ii: action-cost objectives ----

console.log('[ the-long-war-1: discard 2 other objectives ]');
{
  const G = newG();
  G.rebel.objectiveHand = ['the-long-war-1', 'uprising-3'];
  G.rebel.objectiveDiscard = [];
  check('1 other → condition not met', !Obj.objectiveConditionMet(G, 'the-long-war-1'));
  G.rebel.objectiveHand = ['the-long-war-1', 'uprising-3', 'decisive-victory-1', 'seize-control-2'];
  check('3 others → condition met', Obj.objectiveConditionMet(G, 'the-long-war-1'));
  // simulate the play path removing the card, then the side-effect. With MORE
  // than 2 other objectives the player now chooses which 2 to discard (#424/
  // #462), so the side-effect raises a generic card-domain choice instead of
  // auto-discarding the last two.
  G.rebel.objectiveHand = G.rebel.objectiveHand.filter((id) => id !== 'the-long-war-1');
  Phases.applyObjectiveScoreSideEffect(G, 'the-long-war-1');
  check('3 others → raises a discard choice (min/max 2)',
    G.pendingChoice?.kind === 'Choice' && G.pendingChoice.tag === 'the-long-war-discard'
    && G.pendingChoice.min === 2 && G.pendingChoice.max === 2);
  check('nothing auto-discarded before the choice', (G.rebel.objectiveDiscard?.length ?? 0) === 0);
  Phases.resolveGenericChoice(G, ['uprising-3', 'decisive-victory-1']);
  check('exactly the 2 chosen were discarded',
    (G.rebel.objectiveDiscard ?? []).includes('uprising-3')
    && (G.rebel.objectiveDiscard ?? []).includes('decisive-victory-1')
    && G.rebel.objectiveDiscard.length === 2);
  check('the unchosen other remains in hand', G.rebel.objectiveHand.includes('seize-control-2'));
}

console.log('[ a-time-for-peace-2: destroy 2 triangle + 1 circle + 1 square in queue ]');
{
  const G = newG();
  G.rebel.buildQueue = { 1: [], 2: [], 3: [] };
  // Not enough: only 1 triangle
  G.rebel.buildQueue[1] = ['tie-fighter', 'star-destroyer', 'assault-carrier'];
  check('missing a triangle → not met', !Obj.objectiveConditionMet(G, 'a-time-for-peace-2'));
  // Enough across slots: 2 triangle (tie-fighter, stormtrooper), 1 circle (at-st), 1 square (at-at) + extra
  G.rebel.buildQueue[1] = ['tie-fighter', 'star-destroyer'];      // triangle, square
  G.rebel.buildQueue[2] = ['stormtrooper', 'at-st'];              // triangle, circle
  G.rebel.buildQueue[3] = ['at-at', 'tie-fighter'];               // square, triangle (extra)
  check('2T+1C+1S present → met', Obj.objectiveConditionMet(G, 'a-time-for-peace-2'));
  const before = G.rebel.buildQueue[1].length + G.rebel.buildQueue[2].length + G.rebel.buildQueue[3].length;
  Phases.applyObjectiveScoreSideEffect(G, 'a-time-for-peace-2');
  const after = G.rebel.buildQueue[1].length + G.rebel.buildQueue[2].length + G.rebel.buildQueue[3].length;
  check('exactly 4 units removed from queue', before - after === 4);
  // one tie-fighter (triangle) should remain (we only needed 2 triangle)
  const remainingTriangles = [...G.rebel.buildQueue[1], ...G.rebel.buildQueue[2], ...G.rebel.buildQueue[3]]
    .filter((t) => G.catalog.unitTypes[t]?.tier === 'triangle').length;
  check('1 extra triangle left behind', remainingTriangles === 1);
}

// ---- 5d-ii: persistent Show No Fear ----

console.log('[ show-no-fear-3: place at base, score each refresh, removed on relocation ]');
{
  const G = newG();
  G.rebel.objectiveHand = ['show-no-fear-3'];
  const base = G.rebelBaseSystemId;
  const rep0 = G.reputationMarker;
  // RAW (card): "If the marker is still present AT THE START of each Refresh
  // phase, gain 1 reputation." The Refresh that PLACES the marker must not
  // score — the marker wasn't present at the start of it. Scoring begins the
  // following Refresh.
  Phases.processPersistentObjectives(G);
  check('marker placed at Rebel Base system', hasMarker(G, base));
  check('placement refresh does NOT score', G.reputationMarker === rep0);
  Phases.processPersistentObjectives(G);
  check('next refresh scored +1 (marker present at its start)', G.reputationMarker === rep0 - 1);
  Phases.processPersistentObjectives(G);
  check('each subsequent refresh scores another +1', G.reputationMarker === rep0 - 2);
  // simulate base relocation: remove marker AND discard the spent card
  for (const sid of markerSystems(G)) removeMarker(G, sid);
  G.rebel.objectiveHand = G.rebel.objectiveHand.filter((id) => id !== 'show-no-fear-3');
  const repAfter = G.reputationMarker;
  Phases.processPersistentObjectives(G);
  check('after relocation (spent) → no re-placement', markerSystems(G).length === 0);
  check('after relocation → no further scoring', G.reputationMarker === repAfter);
}

function hasMarker(G, sid) {
  return !!G.map.systems[sid]?.targetMarkers?.some((m) => m.source === 'show-no-fear-3');
}
function markerSystems(G) {
  return Object.keys(G.map.systems).filter((sid) => hasMarker(G, sid));
}
function removeMarker(G, sid) {
  const ss = G.map.systems[sid];
  ss.targetMarkers = (ss.targetMarkers ?? []).filter((m) => m.source !== 'show-no-fear-3');
}

// ---- Base game unaffected: RoE conditions absent from base catalog ----
console.log('[ base game: no RoE objective leakage ]');
{
  const base = createGame(data, { seed: 7 });
  const roeIds = ['defensive-position-1', 'uprising-3', 'decisive-victory-1'];
  const present = roeIds.some((id) => !!base.catalog.objectives[id] && Object.values(base.rebel.objectiveDeck ?? []).includes(id));
  check('RoE objectives not in base Rebel deck', !present);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll objective tests passed');
process.exit(fail ? 1 : 0);
