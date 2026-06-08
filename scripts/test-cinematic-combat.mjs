// Cinematic Combat (Phase 7b) smoke tests. Run: node scripts/test-cinematic-combat.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');

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

const baseOpts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true },
});

// ---- Cinematic combat resolves cleanly + sets the cinematic flag ----
console.log('\n[ Cinematic: stormtroopers vs rebel troopers ]');
{
  const G = createGame(data, baseOpts(700));
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  check('cinematic flag set on combat', G.pendingCombat?.cinematic === true);
  combat.runCombat(G);
  // Combat may pause for a damage-assignment choice; if so that's fine — it
  // means the loop reached an attack with a real target. Drive any auto-
  // resolvable tail.
  check('combat advanced (resolved or paused on a real choice)',
    G.pendingCombat === undefined || G.pendingChoice != null);
}

// ---- Cinematic: NO standard tactic cards drawn ----
console.log('\n[ Cinematic: standard tactic decks untouched ]');
{
  const G = createGame(data, baseOpts(701));
  const spaceBefore = G.spaceTacticDeck.length;
  const groundBefore = G.groundTacticDeck.length;
  // Give the Empire a high-tactic-value leader at the combat system so the
  // STANDARD path would have drawn cards.
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  G.empire.leadersOnBoard['felucia'] = ['darth-vader']; // Vader has tactic values
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  combat.runCombat(G);
  check('space tactic deck unchanged (no cinematic draw)', G.spaceTacticDeck.length === spaceBefore,
    `${G.spaceTacticDeck.length} vs ${spaceBefore}`);
  check('ground tactic deck unchanged', G.groundTacticDeck.length === groundBefore);
}

// ---- Standard combat still draws cards when a leader is present ----
console.log('\n[ Standard (non-cinematic) still draws tactic cards ]');
{
  const G = createGame(data, {
    seed: 702, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
    expansion: { enabled: true, cinematicCombat: false },
  });
  const spaceBefore = G.spaceTacticDeck.length;
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  G.empire.leadersOnBoard['felucia'] = ['darth-vader'];
  G.rebel.leadersOnBoard['felucia'] = ['admiral-ackbar'];
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  check('standard combat NOT cinematic', G.pendingCombat?.cinematic === false);
  combat.runCombat(G);
  check('standard combat DID draw space tactic cards', G.spaceTacticDeck.length < spaceBefore,
    `${G.spaceTacticDeck.length} vs ${spaceBefore}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
