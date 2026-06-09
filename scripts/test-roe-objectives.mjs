// Phase 5d-i: RoE objective scoring — condition + combat objectives.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();
const { createGame } = await import('../src/engine/setup.ts');
const Obj = await import('../src/engine/objectives.ts');

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
