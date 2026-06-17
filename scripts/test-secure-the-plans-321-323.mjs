// #323 — while a Secure the Plans target marker is on the board, the Empire may
//        NOT play Death Star Plans (the choice is blocked).
// #321 — when the Rebel moves a ground unit into the marker's system and the
//        Empire has no ground there, the marker is auto-removed (RoE p.7),
//        re-enabling Death Star Plans. Also checks Raid Outposts removal scores
//        the Rebel 1 reputation.
// Run: node scripts/test-secure-the-plans-321-323.mjs
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

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

// Pick a system with no units of either side, on an adjacency we can move into.
function emptySystem(G) {
  return Object.keys(G.map.systems).find((id) => G.map.systems[id].units.length === 0);
}

console.log('\n[ #321 Secure the Plans marker auto-removed when Rebel moves ground in ]');
{
  const G = createGame(data, opts(70));
  const sys = emptySystem(G);
  M.placeTargetMarker(G, sys, 'secure-the-plans', 'Empire');
  check('marker placed', (G.map.systems[sys].targetMarkers ?? []).some((m) => m.source === 'secure-the-plans'));
  // Rebel ground unit moves in; Empire has none there.
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
  const stillThere = (G.map.systems[sys].targetMarkers ?? []).some((m) => m.source === 'secure-the-plans');
  check('marker removed once Rebel holds the system alone', !stillThere);
}

console.log('\n[ #321 marker stays while the Empire (owner) still has ground there ]');
{
  const G = createGame(data, opts(71));
  const sys = emptySystem(G);
  M.placeTargetMarker(G, sys, 'secure-the-plans', 'Empire');
  M.deployUnit(G, 'Empire', 'stormtrooper', sys);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
  const stillThere = (G.map.systems[sys].targetMarkers ?? []).some((m) => m.source === 'secure-the-plans');
  check('marker NOT removed while owner contests the ground', stillThere);
}

console.log('\n[ #321 Raid Outposts removal scores the Rebel 1 reputation ]');
{
  const G = createGame(data, opts(72));
  const sys = emptySystem(G);
  const repBefore = G.reputationMarker; // lower = more Rebel reputation
  M.placeTargetMarker(G, sys, 'raid-outposts-2', 'Empire');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
  const gone = !(G.map.systems[sys].targetMarkers ?? []).some((m) => m.source === 'raid-outposts-2');
  check('raid-outposts marker removed', gone);
  check('Rebel gained 1 reputation on removal', G.reputationMarker === repBefore - 1,
    `before=${repBefore} after=${G.reputationMarker}`);
}

console.log('\n[ #321 the Rebel does NOT auto-remove their OWN marker ]');
{
  const G = createGame(data, opts(73));
  const sys = emptySystem(G);
  M.placeTargetMarker(G, sys, 'rebel-cell-2', 'Rebel');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys); // Rebel holds it, but it's THEIR marker
  const stillThere = (G.map.systems[sys].targetMarkers ?? []).some((m) => m.source === 'rebel-cell-2');
  check('own marker stays when only the owner holds ground', stillThere);
  // ...but the Empire moving in (Rebel gone) removes it.
  G.map.systems[sys].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', sys);
  const removedByEmpire = !(G.map.systems[sys].targetMarkers ?? []).some((m) => m.source === 'rebel-cell-2');
  check('Empire removes the Rebel marker when it holds the system alone', removedByEmpire);
}

// #323 — Death Star Plans attempt is suppressed while a secure-the-plans marker
// is anywhere on the board, and offered once it's gone. Set up a Rebel fighter +
// Empire Death Star combat with Death Star Plans in the objective hand, drive the
// combat, and watch whether a DeathStarPlansAttempt choice appears.
function dsPlansOffered(seed, withMarker) {
  const G = createGame(data, opts(seed));
  G.rebel.objectiveHand = ['death-star-plans-2'];
  const sys = 'felucia';
  G.map.systems[sys].units = [];
  M.deployUnit(G, 'Empire', 'death-star', sys);
  for (let i = 0; i < 5; i++) M.deployUnit(G, 'Rebel', 'x-wing', sys); // fighters — the DS-Plans trigger
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', sys);
  if (withMarker) {
    const other = emptySystem(G);
    M.placeTargetMarker(G, other, 'secure-the-plans', 'Empire');
  }
  combat.beginCombat(G, 'Rebel', 'kashyyyk', sys);
  combat.runCombat(G);
  let guard = 0, offered = false;
  while (G.pendingCombat && G.pendingChoice && guard++ < 400) {
    if (G.pendingChoice.kind === 'DeathStarPlansAttempt') { offered = true; break; }
    if (!stepOnce(G, G.pendingChoice.side)) break;
  }
  return offered;
}

console.log('\n[ #323 Death Star Plans blocked while a Secure the Plans marker is on the board ]');
{
  check('NOT offered while a secure-the-plans marker exists', dsPlansOffered(80, true) === false);
  check('offered when no secure-the-plans marker exists', dsPlansOffered(80, false) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
