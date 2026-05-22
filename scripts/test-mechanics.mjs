// Smoke tests for the Mechanics façade and post-mutation invariants.
// Run: node scripts/test-mechanics.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }

const data = {
  systems: loadJson('systems.json'),
  adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'),
  missions: loadJson('missions.json'),
  objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'),
  probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
}

// ---------- subjugation ----------
console.log('\n[ subjugation ]');
{
  const G = createGame(data, {
    seed: 1, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  // Place an Imperial stormtrooper on a neutral non-Coruscant system -> should subjugate.
  const target = 'felucia'; // populous, non-Coruscant, neutral after our forced loyalty
  M.deployUnit(G, 'Empire', 'stormtrooper', target);
  check('subjugation marker placed', G.map.systems[target].subjugated === true);

  // Remove the unit -> should liberate.
  const stoneId = G.map.systems[target].units[0].instanceId;
  M.destroyUnit(G, stoneId, 'test');
  check('subjugation marker removed when no empire ground', G.map.systems[target].subjugated === false);
}

// ---------- coruscant locked ----------
console.log('\n[ coruscant loyalty locked ]');
{
  const G = createGame(data, { seed: 2 });
  M.gainLoyalty(G, 'Rebel', 'coruscant', 2);
  check('coruscant stays imperial', G.map.systems['coruscant'].loyalty === 'imperial');
}

// ---------- rebel base reveal: imperial ground entry ----------
console.log('\n[ rebel base reveal ]');
{
  const G = createGame(data, {
    seed: 3, forcedBaseSystem: 'bothawui',
    forcedRebelLoyalty: ['bothawui', 'kashyyyk', 'mon-calamari'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  check('base initially hidden', G.rebelBaseRevealed === false);
  M.deployUnit(G, 'Empire', 'stormtrooper', 'bothawui'); // imperial ground enters base system
  check('base revealed when imperial ground enters', G.rebelBaseRevealed === true);
}

// ---------- rebel base reveal: imperial loyalty in base system ----------
console.log('\n[ rebel base reveal via loyalty ]');
{
  const G = createGame(data, {
    seed: 4, forcedBaseSystem: 'kashyyyk',
    forcedRebelLoyalty: ['kashyyyk', 'mon-calamari', 'bothawui'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  check('base hidden, kashyyyk rebel', G.rebelBaseRevealed === false && G.map.systems['kashyyyk'].loyalty === 'rebel');
  M.gainLoyalty(G, 'Empire', 'kashyyyk', 2); // 1 to neutral, 1 to imperial
  check('base revealed when imperial loyalty in base system', G.rebelBaseRevealed === true);
}

// ---------- empire wins: imperial in revealed base, no rebel ----------
console.log('\n[ empire wins by capturing base ]');
{
  const G = createGame(data, {
    seed: 5, forcedBaseSystem: 'felucia',
    forcedRebelLoyalty: ['felucia', 'mon-calamari', 'bothawui'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  M.revealRebelBase(G, 'test'); // moves Rebel units from rebel-base-space to felucia
  check('base revealed', G.rebelBaseRevealed === true);
  // While Rebel units present, deploying Empire should NOT end the game.
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  check('game continues while Rebels defend base', G.isGameOver === false);
  // Destroy all Rebel units in felucia.
  const rebelIds = G.map.systems['felucia'].units.filter((u) => u.side === 'Rebel').map((u) => u.instanceId);
  for (const id of rebelIds) M.destroyUnit(G, id, 'test');
  check('empire wins after rebels gone', G.isGameOver === true && G.winner === 'Empire', `reason=${G.winReason}`);
}

// ---------- rebel wins: reputation meets time ----------
console.log('\n[ rebel wins by reputation ]');
{
  const G = createGame(data, { seed: 6 });
  // timeMarker=1, reputation=14. Gain 13 reputation -> reputation=1, equals time.
  M.gainReputation(G, 13);
  check('rebel wins via reputation', G.isGameOver === true && G.winner === 'Rebel', `rep=${G.reputationMarker} time=${G.timeMarker}`);
}

// ---------- determinism: same seed = same log ----------
console.log('\n[ determinism ]');
{
  const G1 = createGame(data, { seed: 42 });
  const G2 = createGame(data, { seed: 42 });
  M.drawMission(G1, 'Rebel');
  M.drawMission(G2, 'Rebel');
  check('same seed, same draw',
    G1.rebel.missionHand[G1.rebel.missionHand.length-1] === G2.rebel.missionHand[G2.rebel.missionHand.length-1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
