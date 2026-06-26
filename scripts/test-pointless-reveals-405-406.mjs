// #405/#406 — the AI shouldn't reveal a mission whose effect does nothing:
// Assault (destroys Empire Stormtroopers) on a system with none; Behind Enemy
// Lines (moves units from the Rebel Base) when nothing at the base can move.
import { readFileSync } from 'node:fs';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const { missionRevealIsPointless } = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(new URL('../assets/' + p, import.meta.url), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e='') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e?' — '+e:''}`); fail++; } };
const G = createGame(data, { seed: 3, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
const SYS = 'felucia';
G.map.systems[SYS].subjugated = true;

console.log('\n[ #406 Assault is pointless with no Empire Stormtroopers ]');
check('pointless when no stormtroopers at target', missionRevealIsPointless(G, 'Rebel', 'assault', SYS) === true);
M.deployUnit(G, 'Empire', 'at-st', SYS); // AT-ST is not a Stormtrooper
check('still pointless with only an AT-ST (Assault hits Stormtroopers only)', missionRevealIsPointless(G, 'Rebel', 'assault', SYS) === true);
M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
check('NOT pointless once a Stormtrooper is present', missionRevealIsPointless(G, 'Rebel', 'assault', SYS) === false);

console.log('\n[ #405 Behind Enemy Lines is pointless with nothing movable at the base ]');
const G2 = createGame(data, { seed: 3, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
G2.map.rebelBaseSpace.units = []; // empty base
check('pointless when the Rebel Base has no units', missionRevealIsPointless(G2, 'Rebel', 'behind-enemy-lines', 'felucia') === true);
// Add a ground unit but NO carrier — still undeliverable.
G2.map.rebelBaseSpace.units.push({ instanceId: 'g1', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 });
check('still pointless with ground but no carrier (transport not waived)', missionRevealIsPointless(G2, 'Rebel', 'behind-enemy-lines', 'felucia') === true);
// Add a ship (self-mobile) → now deliverable.
G2.map.rebelBaseSpace.units.push({ instanceId: 's1', typeId: 'x-wing', side: 'Rebel', damage: 0 });
check('NOT pointless once a self-mobile ship is at the base', missionRevealIsPointless(G2, 'Rebel', 'behind-enemy-lines', 'felucia') === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
