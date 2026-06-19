// Issue #369 — Demolition: "for each of this system's resource icons destroy
// 1 unit on the build queue that matches the icon." A queued unit matches an
// icon only if it shares BOTH the icon's theater AND its tier — so a system
// without a circle icon (e.g. Mon Calamari = triangle+square) must never be
// able to destroy a circle-tier Assault Carrier. When several units match one
// icon, the most valuable (a Death Star, else highest cost) is destroyed.
// Run: node scripts/test-demolition-369.mjs
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

function fireDemolition(G, targetSys) {
  const card = G.catalog.missions['demolition'];
  const ctx = registry.makeContext('Rebel', card, { targetSystemId: targetSys });
  registry.invokeByKey(G, 'demolition', ctx);
}
const queue = (G) => [...G.empire.buildQueue[1], ...G.empire.buildQueue[2], ...G.empire.buildQueue[3]];

// Sanity: confirm Mon Calamari really has no circle icon.
const monCal = data.systems.systems ? data.systems.systems.find((s) => s.id === 'mon-calamari')
  : data.systems.find((s) => s.id === 'mon-calamari');
check('Mon Calamari has triangle+square icons, no circle',
  monCal.resources.every((r) => r.shape !== 'circle') && monCal.resources.some((r) => r.shape === 'triangle') && monCal.resources.some((r) => r.shape === 'square'),
  JSON.stringify(monCal.resources));

console.log('\n[ #369 Mon Calamari (triangle+square) cannot destroy a circle Assault Carrier ]');
{
  const G = createGame(data, opts(1));
  G.empire.buildQueue[1] = ['assault-carrier', 'tie-fighter']; // circle-space, triangle-space
  G.empire.buildQueue[2] = ['star-destroyer', 'death-star'];   // square-space, square-space(station)
  G.empire.buildQueue[3] = [];
  fireDemolition(G, 'mon-calamari');
  const q = queue(G);
  check('Assault Carrier (circle) survives — no matching icon', q.includes('assault-carrier'), q.join(','));
  check('TIE Fighter destroyed by triangle icon', !q.includes('tie-fighter'), q.join(','));
  check('Death Star destroyed by square icon (the prize over Star Destroyer)', !q.includes('death-star'), q.join(','));
  check('Star Destroyer survives (Death Star was the better square target)', q.includes('star-destroyer'), q.join(','));
}

console.log('\n[ #369 a square icon with only a Star Destroyer destroys it (exact-tier match works) ]');
{
  const G = createGame(data, opts(2));
  G.empire.buildQueue[1] = ['star-destroyer'];
  G.empire.buildQueue[2] = [];
  G.empire.buildQueue[3] = [];
  fireDemolition(G, 'mon-calamari'); // square icon -> destroys the only square-space unit
  check('Star Destroyer destroyed by square icon', !queue(G).includes('star-destroyer'), queue(G).join(','));
}

console.log('\n[ #369 nothing matching -> nothing destroyed ]');
{
  const G = createGame(data, opts(3));
  G.empire.buildQueue[1] = ['assault-carrier']; // circle only; Mon Cal has no circle
  G.empire.buildQueue[2] = [];
  G.empire.buildQueue[3] = [];
  fireDemolition(G, 'mon-calamari');
  check('Assault Carrier untouched', queue(G).includes('assault-carrier'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
