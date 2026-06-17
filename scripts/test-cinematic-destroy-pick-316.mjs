// #316 audit — cinematic "Destroy 1 X without rolling" tactics (Intercept, Hold
// Them Back, Support of the 501st, cinematic Target the Generator) now let the
// playing side CHOOSE which eligible enemy unit is removed when 2+ are legal,
// instead of auto-picking the cheapest. Verified via Hold Them Back ("Destroy 1
// triangle ground unit") with two triangle units present.
// Run: node scripts/test-cinematic-destroy-pick-316.mjs
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

const baseOpts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true },
});
// Leave only Hold Them Back in the Rebel ground cinematic deck.
function forceOnlyHoldThemBack(G) {
  G.rebel.cinematicTacticDiscard = Object.values(G.catalog.tactics)
    .filter((t) => t.cinematic && t.side === 'Rebel' && t.theater === 'ground'
      && t.id !== 'cin-rebel-ground-hold-them-back')
    .map((t) => t.id);
}

console.log('\n[ #316 Hold Them Back posts a destroy pick among 2 triangle ground units ]');
{
  const G = createGame(data, baseOpts(801));
  forceOnlyHoldThemBack(G);
  const sys = 'felucia';
  G.map.systems[sys].units = [];
  // Two Imperial triangle ground units (stormtroopers) → a real choice. A Rebel
  // ground unit attacks. (AT-ST is not triangle, so it isn't a candidate.)
  M.deployUnit(G, 'Empire', 'stormtrooper', sys);
  M.deployUnit(G, 'Empire', 'stormtrooper', sys);
  M.deployUnit(G, 'Empire', 'at-st', sys);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
  combat.beginCombat(G, 'Rebel', 'kashyyyk', sys);
  combat.runCombat(G);

  let guard = 0, sawPick = false;
  while (G.pendingCombat && guard++ < 300) {
    const pc = G.pendingChoice;
    if (!pc) break;
    if (pc.kind === 'CinematicDestroyPick' && pc.side === 'Rebel') {
      sawPick = true;
      check('only the 2 triangle units are candidates', pc.candidates.length === 2,
        `got ${pc.candidates.length}`);
      const chosen = pc.candidates[1];
      const r = combat.resolveCinematicDestroyPick(G, chosen);
      check('resolve ok', r.ok, r.reason);
      check('chosen unit was destroyed',
        !G.map.systems[sys].units.some((u) => u.instanceId === chosen));
      check('the other triangle unit survived',
        G.map.systems[sys].units.some((u) => u.instanceId === pc.candidates[0]));
      break;
    }
    if (!stepOnce(G, pc.side)) { check('no stall before pick', false, pc.kind); break; }
  }
  check('Hold Them Back posted an interactive destroy pick', sawPick);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
