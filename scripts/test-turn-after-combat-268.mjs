// #268 — after an activate-triggered combat fully resolves, the turn passes to
// the opponent (the same player was incorrectly getting another turn).
// Run: node scripts/test-turn-after-combat-268.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');

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

const opts = (seed, cinematic) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, roeUnits: true, cinematicCombat: !!cinematic },
});

/** Drive every pending combat choice via the AI until combat clears. */
function driveCombat(G) {
  let guard = 0;
  while (G.pendingCombat && G.pendingChoice && guard++ < 500) {
    if (!stepOnce(G, G.pendingChoice.side)) break;
  }
}

for (const cinematic of [false, true]) {
  console.log(`\n[ #268 turn passes to Empire after a Rebel activate-combat (cinematic=${cinematic}) ]`);
  const G = createGame(data, opts(cinematic ? 940 : 941, cinematic));
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  G.passedThisCommand = [];
  G.pendingChoice = undefined;
  // Rebel force at ryloth, Empire force at the adjacent geonosis.
  G.map.systems['ryloth'].units = [];
  G.map.systems['geonosis'].units = [];
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'ryloth');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'ryloth');
  M.deployUnit(G, 'Empire', 'tie-fighter', 'geonosis');
  // A Rebel leader in the pool to lead the activation.
  if (!G.rebel.leaderPool.includes('admiral-ackbar')) G.rebel.leaderPool.push('admiral-ackbar');

  const movers = G.map.systems['ryloth'].units.map((u) => u.instanceId);
  const r = phases.activateSystem(G, 'Rebel', 'admiral-ackbar', 'geonosis',
    [{ fromSystemId: 'ryloth', unitInstanceIds: movers }]);
  check('activate ok', r.ok, r.reason);
  // Combat may pause for choices — drive it to completion.
  driveCombat(G);
  check('combat fully resolved', !G.pendingCombat, `pendingCombat=${!!G.pendingCombat}`);
  check('turn passed to Empire (not stuck on Rebel)',
    G.currentPlayer === 'Empire', `currentPlayer=${G.currentPlayer}`);
}

console.log('\n[ #268 if the opponent already passed, the activator keeps the turn ]');
{
  const G = createGame(data, opts(942, false));
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  G.passedThisCommand = ['Empire']; // Empire is done this phase
  G.pendingChoice = undefined;
  G.map.systems['ryloth'].units = [];
  G.map.systems['geonosis'].units = [];
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'ryloth');
  M.deployUnit(G, 'Empire', 'tie-fighter', 'geonosis');
  if (!G.rebel.leaderPool.includes('admiral-ackbar')) G.rebel.leaderPool.push('admiral-ackbar');
  const movers = G.map.systems['ryloth'].units.map((u) => u.instanceId);
  phases.activateSystem(G, 'Rebel', 'admiral-ackbar', 'geonosis',
    [{ fromSystemId: 'ryloth', unitInstanceIds: movers }]);
  driveCombat(G);
  check('Rebel keeps the turn (Empire passed)',
    G.currentPlayer === 'Rebel', `currentPlayer=${G.currentPlayer}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
