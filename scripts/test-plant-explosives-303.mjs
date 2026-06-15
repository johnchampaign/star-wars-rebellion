// #303 — Plant Explosives: two separate limits — at most 3 ground units AND
// combined health up to the success margin (NOT a flat 3-health cap).
// Run: node scripts/test-plant-explosives-303.mjs
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

function runPlant(G, sysId, margin) {
  const card = G.catalog.missions['plant-explosives'];
  const ctx = registry.makeContext('Rebel', card, { targetSystemId: sysId, successMargin: margin });
  registry.invokeByKey(G, 'plant-explosives', ctx);
}

console.log('\n[ #303 health budget = success margin (not capped at 3) ]');
{
  const G = createGame(data, opts(990));
  G.map.systems['felucia'].units = [];
  // 4 stormtroopers (1 hp each) — with margin 4, all 4 fit on health but only
  // 3 may be destroyed (unit cap).
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  runPlant(G, 'felucia', 4);
  const pc = G.pendingChoice;
  check('DestroyUpToHealth posted', pc?.kind === 'DestroyUpToHealth');
  check('health budget equals the margin (4, not 3)', pc?.budget === 4, `budget=${pc?.budget}`);
  check('unit cap is 3', pc?.unitCap === 3, `cap=${pc?.unitCap}`);
  // Try to destroy 4 units (within health budget but over the 3-unit cap).
  const four = pc.candidates.slice(0, 4);
  const rOver = phases.resolveDestroyUpToHealth(G, four);
  check('rejects destroying 4 units (over unit cap)', !rOver.ok, rOver.reason);
  // Destroying 3 is allowed.
  const three = pc.candidates.slice(0, 3);
  const rOk = phases.resolveDestroyUpToHealth(G, three);
  check('destroying 3 units is allowed', rOk.ok, rOk.reason);
  const left = G.map.systems['felucia'].units.filter((u) => u.typeId === 'stormtrooper').length;
  check('3 stormtroopers destroyed (1 left)', left === 1, `left=${left}`);
}

console.log('\n[ #303 a single high-health unit can be destroyed when margin allows ]');
{
  const G = createGame(data, opts(991));
  G.map.systems['felucia'].units = [];
  M.deployUnit(G, 'Empire', 'at-at', 'felucia'); // at-at is multi-health ground
  const atatHp = G.catalog.unitTypes['at-at'].health.value;
  runPlant(G, 'felucia', atatHp); // margin exactly equals AT-AT health
  const pc = G.pendingChoice;
  check('budget equals AT-AT health (>3 if at-at hp>3)', pc?.budget === atatHp, `budget=${pc?.budget} hp=${atatHp}`);
  const r = phases.resolveDestroyUpToHealth(G, [pc.candidates[0]]);
  check('AT-AT destroyed within full-margin budget', r.ok, r.reason);
  check('AT-AT gone', !G.map.systems['felucia'].units.some((u) => u.typeId === 'at-at'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
