// Issue #370 — the Death Star (and Death Star Under Construction) are unique
// "station" units: they are NOT built by any resource icon (no triangle/circle/
// square build tier) and the Death Star "does not have a health value and
// cannot be assigned or dealt damage" (RR p.6). Therefore neither Demolition
// ("destroy 1 unit on the build queue that matches the icon") nor Rogue Squadron
// Raid ("destroy up to 4 health worth of units on the build queue") can ever
// remove a Death Star from the build queue. The only RAW way to lose a queued
// Death Star is to destroy its Death Star Under Construction on the board.
// Run: node scripts/test-deathstar-buildqueue-370.mjs
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

function fireMission(G, key, targetSys) {
  const card = G.catalog.missions[key];
  const ctx = registry.makeContext('Rebel', card, { targetSystemId: targetSys });
  registry.invokeByKey(G, key, ctx);
}
const queue = (G) => [...G.empire.buildQueue[1], ...G.empire.buildQueue[2], ...G.empire.buildQueue[3]];

console.log('\n[ #370 Demolition never destroys a queued Death Star ]');
{
  // Mon Calamari has triangle + square space icons. Pre-fix, the square icon
  // would (wrongly) grab the Death Star as "the prize". It must take the Star
  // Destroyer instead and leave the Death Star alone.
  const G = createGame(data, opts(1));
  G.empire.buildQueue[1] = ['tie-fighter'];          // triangle-space
  G.empire.buildQueue[2] = ['star-destroyer', 'death-star']; // square-space, station
  G.empire.buildQueue[3] = [];
  fireMission(G, 'demolition', 'mon-calamari');
  const q = queue(G);
  check('Death Star survives Demolition', q.includes('death-star'), q.join(','));
  check('Star Destroyer taken by the square icon instead', !q.includes('star-destroyer'), q.join(','));
  check('TIE Fighter taken by the triangle icon', !q.includes('tie-fighter'), q.join(','));
}

console.log('\n[ #370 Demolition with ONLY a Death Star on the queue destroys nothing ]');
{
  const G = createGame(data, opts(2));
  G.empire.buildQueue[1] = [];
  G.empire.buildQueue[2] = ['death-star'];
  G.empire.buildQueue[3] = [];
  fireMission(G, 'demolition', 'mon-calamari'); // square icon has no legal target
  check('Death Star untouched (no legal Demolition target)', queue(G).includes('death-star'), queue(G).join(','));
}

console.log('\n[ #370 Rogue Squadron Raid never lists a Death Star as a target ]');
{
  const G = createGame(data, opts(3));
  G.empire.buildQueue[1] = ['death-star', 'star-destroyer'];
  G.empire.buildQueue[2] = [];
  G.empire.buildQueue[3] = [];
  fireMission(G, 'rogue-squadron-raid');
  const cand = G.pendingChoice?.candidates ?? [];
  const ids = cand.map((c) => c.unitTypeId);
  check('Rogue Squadron Raid offered a choice', G.pendingChoice?.kind === 'RogueSquadronRaidPick', JSON.stringify(G.pendingChoice));
  check('Death Star is NOT among the targets', !ids.includes('death-star'), ids.join(','));
  check('Star Destroyer IS a valid target', ids.includes('star-destroyer'), ids.join(','));
}

console.log('\n[ #370 Rogue Squadron Raid with ONLY a Death Star has no targets ]');
{
  const G = createGame(data, opts(4));
  G.empire.buildQueue[1] = ['death-star'];
  G.empire.buildQueue[2] = [];
  G.empire.buildQueue[3] = [];
  fireMission(G, 'rogue-squadron-raid');
  check('No Rogue Squadron Raid choice raised (Death Star not targetable)', !G.pendingChoice, JSON.stringify(G.pendingChoice));
  check('Death Star still on the queue', queue(G).includes('death-star'), queue(G).join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
