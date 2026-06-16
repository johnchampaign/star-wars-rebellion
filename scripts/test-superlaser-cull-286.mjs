// #286 — when Superlaser Online destroys a system, the Empire CHOOSES which of
// its ground units to lose to the transport limit (instead of an auto-cull),
// per RR p.7. The 0-capacity (all lost) / no-excess / all-same-type cases skip
// the choice and auto-resolve.
// Run: node scripts/test-superlaser-cull-286.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');
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

const opts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, roeUnits: true },
});

handlers.registerAll();
const TARGET = 'geonosis';

function fireSuperlaser(G) {
  const card = G.catalog.missions['superlaser-online'];
  const ctx = registry.makeContext('Empire', card, { targetSystemId: TARGET });
  registry.invokeByKey(G, 'superlaser-online', ctx);
}
function groundCount(G, side) {
  return G.map.systems[TARGET].units.filter(
    (u) => u.side === side && G.catalog.unitTypes[u.typeId]?.theater === 'ground').length;
}

console.log('\n[ #286 partial cull → Empire chooses which ground to lose ]');
{
  const G = createGame(data, opts(960));
  G.map.systems[TARGET].units = [];
  // 1 carrier (capacity 4) + 6 mixed ground → excess 2, mixed types → a choice.
  M.deployUnit(G, 'Empire', 'assault-carrier', TARGET);
  M.deployUnit(G, 'Empire', 'at-at', TARGET);
  M.deployUnit(G, 'Empire', 'at-at', TARGET);
  M.deployUnit(G, 'Empire', 'at-st', TARGET);
  M.deployUnit(G, 'Empire', 'at-st', TARGET);
  M.deployUnit(G, 'Empire', 'stormtrooper', TARGET);
  M.deployUnit(G, 'Empire', 'stormtrooper', TARGET);
  fireSuperlaser(G);
  check('DestroyedSystemCull posted', G.pendingChoice?.kind === 'DestroyedSystemCull',
    G.pendingChoice?.kind);
  check('destroyCount == excess (6 ground - 4 capacity = 2)', G.pendingChoice?.destroyCount === 2,
    `got ${G.pendingChoice?.destroyCount}`);
  check('system NOT yet destroyed (choice comes first)', !G.map.systems[TARGET].destroyed);
  // Choose to destroy the two AT-ATs (the player keeps the cheaper units —
  // proving the choice is honoured, not an auto cheapest-first cull).
  const atatIds = G.map.systems[TARGET].units.filter((u) => u.typeId === 'at-at').map((u) => u.instanceId);
  const r = phases.resolveDestroyedSystemCull(G, atatIds);
  check('resolve ok', r.ok, r.reason);
  check('system now destroyed', G.map.systems[TARGET].destroyed === true);
  check('both chosen AT-ATs gone', !G.map.systems[TARGET].units.some((u) => u.typeId === 'at-at'));
  check('surviving ground == capacity (4)', groundCount(G, 'Empire') === 4, `got ${groundCount(G, 'Empire')}`);
  // After the cull, the superlaser loyalty pick (or its auto-apply) should follow.
  check('flow continued (loyalty pick or none, but no cull pending)',
    G.pendingChoice?.kind !== 'DestroyedSystemCull');
}

console.log('\n[ #286 no ships → all Empire ground lost, no choice ]');
{
  const G = createGame(data, opts(961));
  G.map.systems[TARGET].units = [];
  M.deployUnit(G, 'Empire', 'at-at', TARGET);
  M.deployUnit(G, 'Empire', 'at-st', TARGET);
  M.deployUnit(G, 'Empire', 'stormtrooper', TARGET);
  fireSuperlaser(G);
  check('no cull choice posted (capacity 0)', G.pendingChoice?.kind !== 'DestroyedSystemCull');
  check('system destroyed', G.map.systems[TARGET].destroyed === true);
  check('all Empire ground destroyed', groundCount(G, 'Empire') === 0);
}

console.log('\n[ #286 enough transport → no cull, no choice ]');
{
  const G = createGame(data, opts(962));
  G.map.systems[TARGET].units = [];
  M.deployUnit(G, 'Empire', 'assault-carrier', TARGET); // cap 4
  M.deployUnit(G, 'Empire', 'at-at', TARGET);
  M.deployUnit(G, 'Empire', 'at-st', TARGET);
  fireSuperlaser(G);
  check('no cull choice (2 ground <= 4 capacity)', G.pendingChoice?.kind !== 'DestroyedSystemCull');
  check('both ground units survive', groundCount(G, 'Empire') === 2, `got ${groundCount(G, 'Empire')}`);
}

console.log('\n[ #286 all-same-type excess → auto-cull, no pointless prompt ]');
{
  const G = createGame(data, opts(963));
  G.map.systems[TARGET].units = [];
  M.deployUnit(G, 'Empire', 'assault-carrier', TARGET); // cap 4
  for (let i = 0; i < 6; i++) M.deployUnit(G, 'Empire', 'stormtrooper', TARGET); // 6 identical
  fireSuperlaser(G);
  check('no cull choice (units interchangeable)', G.pendingChoice?.kind !== 'DestroyedSystemCull');
  check('auto-culled down to capacity (4 survive)', groundCount(G, 'Empire') === 4,
    `got ${groundCount(G, 'Empire')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
