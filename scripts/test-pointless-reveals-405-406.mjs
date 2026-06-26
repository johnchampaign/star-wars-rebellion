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

// ---- Audit sweep: the same waste class for the other destroy/move missions ----
console.log('\n[ Plant Explosives is pointless with no Empire ground at the target ]');
{
  const G = createGame(data, { seed: 4, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.map.systems.felucia.units = [];
  check('pointless with no Empire ground', missionRevealIsPointless(G, 'Rebel', 'plant-explosives', 'felucia') === true);
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  check('NOT pointless once Empire ground is present', missionRevealIsPointless(G, 'Rebel', 'plant-explosives', 'felucia') === false);
}

console.log('\n[ Plan the Assault is pointless with no Rebel ships at the base ]');
{
  const G = createGame(data, { seed: 4, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.map.rebelBaseSpace.units = [];
  check('pointless with no Rebel ships at base', missionRevealIsPointless(G, 'Rebel', 'plan-the-assault', 'felucia') === true);
  G.map.rebelBaseSpace.units.push({ instanceId: 's2', typeId: 'x-wing', side: 'Rebel', damage: 0 });
  check('NOT pointless once a Rebel ship is at the base', missionRevealIsPointless(G, 'Rebel', 'plan-the-assault', 'felucia') === false);
}

console.log('\n[ Lead the Strike Team: pointless only with no base ground AND no Rebel at target ]');
{
  const G = createGame(data, { seed: 4, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.map.rebelBaseSpace.units = [];
  G.map.systems.felucia.units = [];
  check('pointless when base has no ground and target has no Rebel units',
    missionRevealIsPointless(G, 'Rebel', 'lead-the-strike-team', 'felucia') === true);
  // A Rebel unit already at the target gives the combat-trigger a purpose → not pointless.
  G.map.systems.felucia.units.push({ instanceId: 'r1', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 });
  check('NOT pointless when the Rebel already has a unit at the target',
    missionRevealIsPointless(G, 'Rebel', 'lead-the-strike-team', 'felucia') === false);
  // Ground at the base → always something to send.
  const G3 = createGame(data, { seed: 4, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G3.map.systems.felucia.units = [];
  check('NOT pointless once movable ground is at the base',
    missionRevealIsPointless(G3, 'Rebel', 'lead-the-strike-team', 'felucia') === false);
}

console.log('\n[ Demolition is pointless when nothing queued matches the system icons ]');
{
  const G = createGame(data, { seed: 4, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.empire.buildQueue = { 1: [], 2: [], 3: [] };
  // Pick a system and a queued unit type that matches one of its resource icons.
  const sys = Object.values(G.catalog.systems).find((d) => (d.resources?.length ?? 0) > 0);
  const icon = sys.resources[0];
  const match = Object.values(G.catalog.unitTypes).find(
    (u) => u.class !== 'station' && u.theater === icon.type && u.tier === icon.shape);
  check('pointless with an empty build queue', missionRevealIsPointless(G, 'Rebel', 'demolition', sys.id) === true);
  if (match) {
    G.empire.buildQueue[1].push(match.id);
    check('NOT pointless once a matching unit is queued', missionRevealIsPointless(G, 'Rebel', 'demolition', sys.id) === false);
  } else { check('(found a matchable unit type for the icon)', false, 'no matching unit type'); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
