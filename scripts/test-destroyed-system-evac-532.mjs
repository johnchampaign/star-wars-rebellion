// #532 — moving the Death Star out of a destroyed planet culled all the Imperial
// ground units it was carrying. Root cause: the destroyed-system transport cull
// (RR "Destroyed Systems") ran after EACH single unit move, so a carrier ordered
// before its cargo left the system first, dropped in-system capacity to 0, and the
// cull destroyed the ground the SAME order was about to relocate. The cull is now
// batched to the end of the activation: a carrier + its ground can evacuate
// together; only ground genuinely left behind (no remaining capacity) is culled.
// Run: node scripts/test-destroyed-system-evac-532.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Build a destroyed source system with a Death Star (capacity 8) + ground, an
// adjacent empty destination, and an Empire leader to activate the move.
function setup() {
  const G = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true } });
  const SRC = 'kashyyyk';
  const DST = (G.catalog.adjacency[SRC] ?? []).find((s) => !G.map.systems[s].destroyed) ?? (G.catalog.adjacency[SRC] ?? [])[0];
  G.map.systems[SRC].destroyed = true;
  const mk = (t, id) => ({ instanceId: id, typeId: t, side: 'Empire', damage: 0 });
  G.map.systems[SRC].units = [
    mk('death-star', 'ds1'),
    mk('stormtrooper', 'g1'), mk('stormtrooper', 'g2'), mk('at-st', 'g3'),
  ];
  G.map.systems[DST].units = [];
  const leader = G.empire.leaderPool.find((l) => (G.catalog.leaders[l]?.tacticValues.space ?? 0) > 0) ?? G.empire.leaderPool[0];
  G.phase = 'Command'; G.currentPlayer = 'Empire';
  return { G, SRC, DST, leader };
}
const groundAt = (G, sys) => G.map.systems[sys].units.filter((u) => ['stormtrooper', 'at-st'].includes(u.typeId)).length;

console.log('[ #532 — evacuate ground from a destroyed system with its carrier ]');
{
  // Move the Death Star AND its 3 ground together → all 4 should reach the dest,
  // none culled (the DS carries them; capacity 8 >= 3).
  const { G, SRC, DST, leader } = setup();
  const r = phases.activateSystem(G, 'Empire', leader, DST, [{ fromSystemId: SRC, unitInstanceIds: ['ds1', 'g1', 'g2', 'g3'] }]);
  check('activation succeeds', r.ok, r.reason);
  check('all 3 ground survived (carried to destination)', groundAt(G, DST) === 3, `dstGround=${groundAt(G, DST)} srcGround=${groundAt(G, SRC)}`);
  check('none stranded/culled at the destroyed source', groundAt(G, SRC) === 0, `srcGround=${groundAt(G, SRC)}`);
  check('Death Star arrived at destination', G.map.systems[DST].units.some((u) => u.typeId === 'death-star'));
}
{
  // Move ONLY the Death Star out, abandoning the ground → the ground has no
  // remaining capacity (0) and is correctly culled per RAW.
  const { G, SRC, DST, leader } = setup();
  const r = phases.activateSystem(G, 'Empire', leader, DST, [{ fromSystemId: SRC, unitInstanceIds: ['ds1'] }]);
  check('activation (carrier only) succeeds', r.ok, r.reason);
  check('abandoned ground IS culled (RAW: exceeds 0 capacity)', groundAt(G, SRC) === 0 && groundAt(G, DST) === 0,
    `srcGround=${groundAt(G, SRC)} dstGround=${groundAt(G, DST)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
