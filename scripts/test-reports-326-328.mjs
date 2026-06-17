// #326 — "destroy units of your choice in the system" missions (Hunt Them Down /
//        Hit And Run / Rogue Squadron Raid) are flagged pointless when the
//        opponent has no destroyable units in the target system.
// #328 — a combat card played as a SECOND card via an "extra card" effect cannot
//        contain a cancelling effect (its cancel ability is voided).
// Run: node scripts/test-reports-326-328.mjs
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
const ct = await import('../src/engine/cinematicTactics.ts');
const { missionRevealIsPointless } = await import('../src/engine/missionTargets.ts');

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

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true } });

console.log('\n[ #326 Hunt Them Down is pointless on a system with no Rebel units ]');
{
  const G = createGame(data, opts(60));
  const sys = 'alderaan';
  G.map.systems[sys].units = [];
  check('pointless with no Rebel units present',
    missionRevealIsPointless(G, 'Empire', 'hunt-them-down', sys) === true);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
  check('NOT pointless once a Rebel unit is present',
    missionRevealIsPointless(G, 'Empire', 'hunt-them-down', sys) === false);
}

console.log('\n[ #326 Rebel raids need Imperial units present ]');
{
  const G = createGame(data, opts(61));
  const sys = 'felucia';
  G.map.systems[sys].units = [];
  check('Hit And Run pointless with no Imperial units',
    missionRevealIsPointless(G, 'Rebel', 'hit-and-run', sys) === true);
  check('Rogue Squadron Raid pointless with no Imperial units',
    missionRevealIsPointless(G, 'Rebel', 'rogue-squadron-raid', sys) === true);
  M.deployUnit(G, 'Empire', 'stormtrooper', sys);
  check('Hit And Run NOT pointless with an Imperial unit',
    missionRevealIsPointless(G, 'Rebel', 'hit-and-run', sys) === false);
}

console.log('\n[ #328 an extra-played cancel card does not cancel; a normal one does ]');
{
  // A cancel card: cin-empire-ground-air-superiority (top = CANCEL).
  const cancelCard = 'cin-empire-ground-air-superiority';

  // Normal play sets the opponent cancel...
  const G1 = createGame(data, opts(62));
  const sys = 'felucia';
  G1.map.systems[sys].units = [];
  M.deployUnit(G1, 'Empire', 'stormtrooper', sys);
  M.deployUnit(G1, 'Rebel', 'rebel-trooper', sys);
  combat.beginCombat(G1, 'Empire', 'malastare', sys);
  const c1 = G1.pendingCombat;
  ct.applyCinematicAbility(G1, c1, 'Empire', 'ground', cancelCard, true, false); // isExtra=false
  const rebelKey = `Rebel:ground:${c1.round}`;
  check('normal play sets the opponent cancel', c1.cinematicCancel?.[rebelKey] === true,
    JSON.stringify(c1.cinematicCancel));

  // ...but the SAME card played as an extra does NOT.
  const G2 = createGame(data, opts(63));
  G2.map.systems[sys].units = [];
  M.deployUnit(G2, 'Empire', 'stormtrooper', sys);
  M.deployUnit(G2, 'Rebel', 'rebel-trooper', sys);
  combat.beginCombat(G2, 'Empire', 'malastare', sys);
  const c2 = G2.pendingCombat;
  ct.applyCinematicAbility(G2, c2, 'Empire', 'ground', cancelCard, true, true); // isExtra=true
  const rebelKey2 = `Rebel:ground:${c2.round}`;
  check('extra-played cancel card does NOT set the cancel',
    !c2.cinematicCancel?.[rebelKey2], JSON.stringify(c2.cinematicCancel));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
