import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass=0,fail=0; const check=(n,ok,x='')=>{console.log(`  ${ok?'✓':'✗'} ${n}${ok?'':' — '+x}`);ok?pass++:fail++;};

// Feature 1: combat removed-units tally
const G = createGame(data, { seed: 9, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo','corellia','kashyyyk'], forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'] });
M.deployUnit(G,'Empire','stormtrooper','felucia');
M.deployUnit(G,'Rebel','rebel-trooper','felucia');
combat.beginCombat(G,'Empire','malastare','felucia');
const st = G.map.systems.felucia.units.find(u=>u.typeId==='stormtrooper');
M.destroyUnit(G, st.instanceId, 'combat');
check('combat records a removed unit', (G.pendingCombat.removed ?? []).some(r=>r.typeId==='stormtrooper' && r.side==='Empire'),
  JSON.stringify(G.pendingCombat.removed));

// destroying outside combat should NOT record (no pending combat)
const G3 = createGame(data, { seed: 9, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo'], forcedImperialLoyalty: ['alderaan'] });
M.deployUnit(G3,'Empire','stormtrooper','felucia');
const st3 = G3.map.systems.felucia.units.find(u=>u.typeId==='stormtrooper');
M.destroyUnit(G3, st3.instanceId, 'superlaser');
check('no pendingCombat → no crash, nothing tracked', !G3.pendingCombat);

// Feature 2: scored-objectives list + report still fires
const G2 = createGame(data, { seed: 1 });
const beforeReports = (G2.objectiveReports ?? []).length;
M.recordObjectiveScored(G2, 'rebel-cell-2', 1, 'refresh', 5);
check('scoredObjectives records the score', (G2.rebel.scoredObjectives ?? []).some(s=>s.objectiveId==='rebel-cell-2' && s.reputation===1 && typeof s.turn==='number'));
check('objectiveReports still queued (modal unaffected)', (G2.objectiveReports ?? []).length === beforeReports + 1 && G2.objectiveReports.at(-1).seq === 5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
