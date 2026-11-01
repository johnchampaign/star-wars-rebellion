// #826 — "Attempt on any system" missions must still offer a DESTROYED system.
// Reporter (Rebel) could not aim Plant Explosives at Mandalore after the Death
// Star destroyed it. RR p.7: Imperial ground units survive in a destroyed system
// (within transport capacity), and the card says "Attempt on any system". The
// any-system fast path used allSystems(), which drops destroyed systems.
// Pins: unit-destroying/probing any-system missions now include a destroyed
// system; loyalty/sabotage and ground-drop-plus-ground-battle ones still don't.
// Run: node scripts/test-any-system-destroyed-826.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const mt = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ #826 — any-system missions on a DESTROYED system ]');
const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
G.map.systems['mandalore'].destroyed = true;
const has = (side, id) => mt.missionTargets(G, side, id).systemIds.includes('mandalore');
check('Plant Explosives offers destroyed Mandalore', has('Rebel', 'plant-explosives'));
check('Hit and Run offers destroyed Mandalore', has('Rebel', 'hit-and-run'));
check('Hunt Them Down offers destroyed Mandalore', has('Empire', 'hunt-them-down'));
check('Sabotage still excludes destroyed Mandalore', !has('Rebel', 'sabotage'));
check('Regional Aid (loyalty) still excludes destroyed Mandalore', !has('Rebel', 'regional-aid'));
check('Lead the Strike Team (ground drop + battle) still excludes it', !has('Rebel', 'lead-the-strike-team'));
check('Planetary Conquest (ground drop + battle) still excludes it', !has('Empire', 'planetary-conquest'));
G.map.systems['mandalore'].destroyed = false;
check('alive Mandalore still offered to Plant Explosives', has('Rebel', 'plant-explosives'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
