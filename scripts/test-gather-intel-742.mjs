// #742 — "Gather Intel is not giving the correct number of cards based on the
// number of units in the Rebel base." RAW (card + SWR_Mission_Reference):
// "Attempt in any Rebel System. If successful, draw 1 probe card for every 4
// rebel units at the rebel base (min 1)". RR p.? — while the base is REVEALED,
// abilities that reference the "Rebel Base" space apply to the base's SYSTEM.
// Run: node scripts/test-gather-intel-742.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
function loadJson(f) { return JSON.parse(readFileSync(join(ROOT, 'assets', f), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

handlers.registerAll();

function mkUnit(i, typeId, side) {
  return { instanceId: `t${i}`, typeId, side, damaged: false };
}

function run(nUnits, revealed) {
  const G = createGame(data, { seed: 42, expansion: { enabled: true, roeUnits: true } });
  G.rebelBaseRevealed = revealed;
  const baseId = G.rebelBaseSystemId;
  const dest = revealed ? G.map.systems[baseId] : G.map.rebelBaseSpace;
  // Clear whatever setup put there so the count is exactly nUnits Rebel units.
  G.map.rebelBaseSpace.units = [];
  G.map.systems[baseId].units = [];
  for (let i = 0; i < nUnits; i++) dest.units.push(mkUnit(i, 'rebel-trooper', 'Rebel'));
  // Plenty of deck so truncation never masks the count.
  G.empire.probeHand = [];
  const before = G.empire.probeHand.length;
  const ctx = registry.makeContext('Empire', { kind: 'mission', id: 'gather-intel' },
    { targetSystemId: baseId, leaderIds: [] });
  registry.invokeByKey(G, 'gather-intel', ctx);
  return { drawn: G.empire.probeHand.length - before, deckLeft: G.probeDeck.length };
}

console.log('Gather Intel — probe draw count (min 1, +1 per full 4 units)');
for (const revealed of [false, true]) {
  console.log(` base ${revealed ? 'REVEALED (counts units in the base system)' : 'HIDDEN (counts units in the "Rebel Base" space)'}`);
  for (const [n, want] of [[0, 1], [1, 1], [3, 1], [4, 1], [7, 1], [8, 2], [11, 2], [12, 3]]) {
    const { drawn, deckLeft } = run(n, revealed);
    check(`${String(n).padStart(2)} rebel units -> ${want} card(s)`, drawn === want,
      `drew ${drawn} (deck left ${deckLeft})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
