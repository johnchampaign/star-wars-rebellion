// Issue #459 — "Rebels should only be able to make 3 Mon Cali Cruisers."
// The Mon Calamari Cruiser has a 3-mini supply (RR p.6 "Component Limitations
// → Units": "a player cannot build a unit type if there are none available").
// The normal Build step already filters unavailable types, but the
// build-from-resource-icons path (Establish Trade Relations / Construct Factory
// / Address Delays) skipped the check, letting a 4th cruiser onto the build
// queue from Mon Calamari's space-square icon. This test locks in the supply
// cap on that path.
// Run: node scripts/test-build-from-icons-supply-459.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');
const mechanics = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true } });
handlers.registerAll();

function postBuildFromIcons(G, sys) {
  const card = G.catalog.missions['establish-trade-relations'];
  const ctx = registry.makeContext('Rebel', card, { targetSystemId: sys });
  registry.invokeByKey(G, 'establish-trade-relations', ctx);
}
const cruisersQueued = (G) =>
  [1, 2, 3].reduce((n, s) => n + G.rebel.buildQueue[s].filter((t) => t === 'mon-cala-cruiser').length, 0);

console.log('\n[ #459 build-from-icons respects the Mon Cala Cruiser supply cap ]');
{
  // Commit all 3 cruiser minis to the board, exhausting the supply.
  const G = createGame(data, opts(3));
  for (let i = 0; i < 3; i++) mechanics.gainUnit(G, 'Rebel', 'mon-cala-cruiser', 'mon-calamari');
  check('supply exhausted (0 available)', mechanics.unitsAvailableInSupply(G, 'mon-cala-cruiser') === 0);

  postBuildFromIcons(G, 'mon-calamari');
  check('BuildFromIconsPick posted', G.pendingChoice?.kind === 'BuildFromIconsPick', G.pendingChoice?.kind);

  // icons = [space-triangle, space-square]. Try to grab a 4th cruiser on the
  // square icon; leave the triangle empty.
  const res = phases.resolveBuildFromIconsPick(G, [null, 'mon-cala-cruiser']);
  check('4th cruiser rejected', res.ok === false, JSON.stringify(res));
  check('no cruiser reached the queue', cruisersQueued(G) === 0, `queued=${cruisersQueued(G)}`);
}

console.log('\n[ #459 icon build still works when supply remains ]');
{
  const G = createGame(data, opts(4));
  mechanics.gainUnit(G, 'Rebel', 'mon-cala-cruiser', 'mon-calamari'); // 1 of 3 used
  check('2 cruisers still available', mechanics.unitsAvailableInSupply(G, 'mon-cala-cruiser') === 2);
  postBuildFromIcons(G, 'mon-calamari');
  const res = phases.resolveBuildFromIconsPick(G, [null, 'mon-cala-cruiser']);
  check('cruiser accepted while supply remains', res.ok === true, JSON.stringify(res));
  check('cruiser queued', cruisersQueued(G) === 1, `queued=${cruisersQueued(G)}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
