// #304 — Imperial Propaganda: pointless-filter (no Rebel loyalty in the region)
// shared by AI + human, and AI target scoring prefers the region with the most
// Rebel-loyal systems to flip.
// Run: node scripts/test-imperial-propaganda-304.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const { missionRevealIsPointless, rebelLoyalSystemsInRegion } = await import('../src/engine/missionTargets.ts');

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

const G = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true } });

// Clear loyalty everywhere, then set up two regions: one with Rebel loyalty, one
// without. Pick two Imperial-system targets, one in each region.
for (const ss of Object.values(G.map.systems)) ss.loyalty = 'neutral';
const sys = G.catalog.systems;
// Group systems by region.
const byRegion = {};
for (const d of Object.values(sys)) (byRegion[d.region] ??= []).push(d.id);
const regions = Object.keys(byRegion).filter((r) => byRegion[r].length >= 2);
const richRegion = regions[0];
const poorRegion = regions[1];

// Rich region: make 2 systems Rebel-loyal; the target is a 3rd (any) in it.
const richIds = byRegion[richRegion];
M.gainLoyalty(G, 'Rebel', richIds[0], 1);
M.gainLoyalty(G, 'Rebel', richIds[1], 1);
const richTarget = richIds[2] ?? richIds[0];
// Poor region: no Rebel loyalty; target is any system in it.
const poorTarget = byRegion[poorRegion][0];

console.log('\n[ #304 pointless filter ]');
check('Imperial Propaganda is POINTLESS in a region with no Rebel loyalty',
  missionRevealIsPointless(G, 'Empire', 'imperial-propaganda', poorTarget) === true);
check('Imperial Propaganda is NOT pointless in a region WITH Rebel loyalty',
  missionRevealIsPointless(G, 'Empire', 'imperial-propaganda', richTarget) === false);
check('filter is side-agnostic for this card (still pointless for a Rebel actor)',
  missionRevealIsPointless(G, 'Rebel', 'imperial-propaganda', poorTarget) === true);

console.log('\n[ #304 region payoff scoring helper ]');
const richCount = rebelLoyalSystemsInRegion(G, richTarget);
const poorCount = rebelLoyalSystemsInRegion(G, poorTarget);
check('rich region reports >=2 Rebel-loyal systems', richCount >= 2, `got ${richCount}`);
check('poor region reports 0 Rebel-loyal systems', poorCount === 0, `got ${poorCount}`);
check('rich region scores strictly higher payoff than poor', richCount > poorCount);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
