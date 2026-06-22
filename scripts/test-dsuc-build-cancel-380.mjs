// #380 — Destroying the Death Star Under Construction must also destroy the
//        completed Death Star advancing through the build queue (RR p.6).
// #378 — Hidden Fleet is a no-op (and AI-pointless) once the Rebel Base space
//        holds no units, so the AI shouldn't waste it.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass=0,fail=0; const check=(n,ok,x='')=>{console.log(`  ${ok?'✓':'✗'} ${n}${ok?'':' — '+x}`);ok?pass++:fail++;};

// ---------- #380 ----------
const G = createGame(data, { seed: 7, roeMissions: true, roeUnits: true });
const sys = 'geonosis';
// Simulate the RoE Construct-Death-Star / setup state: DSUC on the map + a
// completed Death Star queued on build space 3.
G.map.systems[sys].units = G.map.systems[sys].units.filter(u => u.side !== 'Empire');
M.deployUnit(G, 'Empire', 'death-star-under-construction', sys);
M.buildToQueue(G, 'Empire', 'death-star', 3);
const queuedBefore = [1,2,3].reduce((n,s)=>n + G.empire.buildQueue[s].filter(t=>t==='death-star').length, 0);
check('Death Star is queued before DSUC destroyed', queuedBefore === 1, `queued=${queuedBefore}`);
const dsuc = G.map.systems[sys].units.find(u => u.typeId === 'death-star-under-construction');
M.destroyUnit(G, dsuc.instanceId, 'combat');
const queuedAfter = [1,2,3].reduce((n,s)=>n + G.empire.buildQueue[s].filter(t=>t==='death-star').length, 0);
check('queued Death Star removed when DSUC destroyed', queuedAfter === 0, `queued=${queuedAfter}`);
check('DSUC is gone from the map', !G.map.systems[sys].units.some(u => u.typeId === 'death-star-under-construction'));

// Destroying a DSUC with no queued Death Star is a safe no-op.
const G2 = createGame(data, { seed: 8, roeMissions: true, roeUnits: true });
G2.map.systems[sys].units = G2.map.systems[sys].units.filter(u => u.side !== 'Empire');
M.deployUnit(G2, 'Empire', 'death-star-under-construction', sys);
const dsuc2 = G2.map.systems[sys].units.find(u => u.typeId === 'death-star-under-construction');
M.destroyUnit(G2, dsuc2.instanceId, 'combat');
check('no crash / no spurious removal when no Death Star queued',
  [1,2,3].every(s => Array.isArray(G2.empire.buildQueue[s])));

// Destroying an ordinary unit never touches the queue.
const G3 = createGame(data, { seed: 9, roeMissions: true, roeUnits: true });
M.buildToQueue(G3, 'Empire', 'death-star', 3);
M.deployUnit(G3, 'Empire', 'tie-fighter', sys);
const tie = G3.map.systems[sys].units.find(u => u.typeId === 'tie-fighter');
M.destroyUnit(G3, tie.instanceId, 'combat');
check('destroying a TIE leaves the queued Death Star intact',
  G3.empire.buildQueue[3].includes('death-star'));

// ---------- #378 ----------
const G4 = createGame(data, { seed: 11, roeMissions: true, roeUnits: true });
G4.map.rebelBaseSpace.units = [];
check('hidden-fleet pointless when Rebel Base space is empty',
  ai.missionRevealIsPointless(G4, 'Rebel', 'hidden-fleet', 'alderaan'));
// The base space isn't a map system, so push a unit onto it directly.
G4.map.rebelBaseSpace.units.push({ instanceId: 'x1', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 });
check('hidden-fleet NOT pointless once the Rebel Base space has units',
  !ai.missionRevealIsPointless(G4, 'Rebel', 'hidden-fleet', 'alderaan'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
