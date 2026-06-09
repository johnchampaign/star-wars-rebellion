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
const { stepOnce } = await import('../src/play/randomAI.ts');

/** Drive a combat to completion: resolve every pending combat choice (add-
 *  leader, tactics, damage assignment, retreat) via the AI until pendingCombat
 *  clears. Mirrors what the real AI/UI loop does. */
function driveCombat(G) {
  combat.runCombat(G);
  let guard = 0;
  while (G.pendingCombat && G.pendingChoice && guard++ < 500) {
    const side = G.pendingChoice.side;
    if (!stepOnce(G, side)) break;
  }
}

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

// ---- Cinematic tactic cards: deal-damage ability fires + persistent discard ----
console.log('\n[ Cinematic: advanced tactic cards deal damage + discard persists ]');
{
  const G = createGame(data, baseOpts(703));
  // Empire AT-STs (Overrun: top "deal 2 damage" needs an AT-ST present) vs a
  // tanky Rebel mon-cala on ground? No — ground. Use AT-ST vs airspeeders.
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  const discardBefore = (G.empire.cinematicTacticDiscard ?? []).length;
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveCombat(G);
  const discardAfter = (G.empire.cinematicTacticDiscard ?? []).length;
  check('Empire played at least one advanced tactic card (discard grew)',
    discardAfter > discardBefore, `${discardAfter} vs ${discardBefore}`);
  // Discard should contain only cinematic Empire-ground cards.
  const allEmpireGround = (G.empire.cinematicTacticDiscard ?? []).every((id) => {
    const t = G.catalog.tactics[id];
    return t && t.cinematic && t.side === 'Empire' && t.theater === 'ground';
  });
  check('discard contains only Empire-ground cinematic cards', allEmpireGround);
}

// ---- Cinematic discard PERSISTS across separate combats ----
console.log('\n[ Cinematic: discard persists across combats ]');
{
  const G = createGame(data, baseOpts(704));
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveCombat(G);
  const afterFirst = [...(G.empire.cinematicTacticDiscard ?? [])];
  // Second combat at a different system — discard from the first must remain.
  M.deployUnit(G, 'Empire', 'at-st', 'naboo');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'naboo');
  combat.beginCombat(G, 'Empire', 'felucia', 'naboo');
  driveCombat(G);
  const afterSecond = G.empire.cinematicTacticDiscard ?? [];
  check('first-combat discards still present after second combat',
    afterFirst.every((id) => afterSecond.includes(id)),
    `first=${afterFirst.length} second=${afterSecond.length}`);
}

// ---- 7c-2: destroy-without-rolling (Support of the 501st: destroy 1 triangle) ----
console.log('\n[ Cinematic 7c-2: destroy-without-rolling kills a triangle unit ]');
{
  const G = createGame(data, baseOpts(705));
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveCombat(G);
  const destroyLog = G.turnLog.filter((l) => l.kind === 'cinematic-tactic-play'
    && l.payload?.cardId === 'cin-empire-ground-support-of-the-501st' && l.payload?.destroyed);
  check('Support of the 501st destroyed a triangle unit (no roll)', destroyLog.length > 0,
    `plays: ${destroyLog.length}`);
  check('combat resolved', G.pendingCombat === undefined);
}

// ---- 7c-2: gain-unit (Reinforcements: gain a TIE Fighter) ----
console.log('\n[ Cinematic 7c-2: gain-unit deploys a new unit ]');
{
  const G = createGame(data, baseOpts(706));
  M.deployUnit(G, 'Empire', 'assault-carrier', 'felucia');
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveCombat(G);
  const gained = G.turnLog.filter((l) => l.kind === 'cinematic-tactic-play' && l.payload?.gained === 'tie-fighter');
  check('Reinforcements gained a TIE Fighter', gained.length > 0, `gains: ${gained.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
