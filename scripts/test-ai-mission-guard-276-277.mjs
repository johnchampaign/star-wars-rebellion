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

const G = createGame(data, { seed: 3, roeMissions: true, roeUnits: true });
const sys = 'geonosis';

// #276 Draw Them Out — pointless with an empty Rebel pool, fine otherwise.
G.rebel.leaderPool = [];
check('draw-them-out pointless when Rebel pool empty', ai.missionRevealIsPointless(G, 'Empire', 'draw-them-out', sys));
G.rebel.leaderPool = ['mon-mothma'];
check('draw-them-out useful when a Rebel leader is in pool', !ai.missionRevealIsPointless(G, 'Empire', 'draw-them-out', sys));

// #277 Single Reactor Ignition — pointless with no Rebel ground / markers.
G.map.systems[sys].units = (G.map.systems[sys].units || []).filter(u => u.side !== 'Rebel');
delete G.map.systems[sys].targetMarkers;
check('SRI pointless with no Rebel ground or markers', ai.missionRevealIsPointless(G, 'Empire', 'single-reactor-ignition', sys));
M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
check('SRI useful when a Rebel ground unit is present', !ai.missionRevealIsPointless(G, 'Empire', 'single-reactor-ignition', sys));
// markers also make it useful
G.map.systems[sys].units = G.map.systems[sys].units.filter(u => u.side !== 'Rebel');
M.placeTargetMarker(G, sys, 'rebel-cell-2', 'Rebel');
check('SRI useful when a target marker is present', !ai.missionRevealIsPointless(G, 'Empire', 'single-reactor-ignition', sys));

// Other missions are never flagged pointless by this guard.
check('unrelated mission not flagged', !ai.missionRevealIsPointless(G, 'Empire', 'gather-intel', sys));
// Rebel side never flagged.
check('rebel side never flagged', !ai.missionRevealIsPointless(G, 'Rebel', 'draw-them-out', sys));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
