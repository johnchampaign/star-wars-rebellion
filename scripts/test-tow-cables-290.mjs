// #290 — Tow Cables targeted-deal now offers the playing side a target choice
// (instead of auto-picking the most-damaged AT-AT/AT-ST).
// Run: node scripts/test-tow-cables-290.mjs
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

// Leave ONLY Tow Cables available to the Rebel ground deck: discard every other
// rebel ground cinematic card so the select step is forced onto it.
function forceOnlyTowCables(G) {
  const others = Object.values(G.catalog.tactics)
    .filter((t) => t.cinematic && t.side === 'Rebel' && t.theater === 'ground'
      && t.id !== 'cin-rebel-ground-tow-cables')
    .map((t) => t.id);
  G.rebel.cinematicTacticDiscard = others;
}

console.log('\n[ #290 Tow Cables posts a CinematicTargetPick with 2 candidates ]');
{
  const G = createGame(data, baseOpts(900));
  forceOnlyTowCables(G);
  // Rebel attacks a ground battle at felucia: 2 Empire AT-STs to choose between,
  // a Rebel airspeeder (Tow Cables' unit prereq) leading the assault.
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');

  // Drive until the target-pick choice surfaces (resolving everything else via AI).
  combat.runCombat(G);
  let guard = 0, sawPick = false, chosen = null, before = -1;
  while (G.pendingCombat && G.pendingChoice && guard++ < 300) {
    const pc = G.pendingChoice;
    if (pc.kind === 'CinematicTargetPick') {
      sawPick = true;
      check('target pick offers 2 AT-ST candidates', pc.candidates.length === 2,
        `got ${pc.candidates.length}`);
      check('target pick amount = 4', pc.amount === 4, `amount=${pc.amount}`);
      // Pick the SECOND candidate explicitly (proves the choice is honored —
      // the auto-picker would have taken index 0, an undamaged unit).
      chosen = pc.candidates[1];
      const ss = G.map.systems['felucia'];
      before = ss.units.find((u) => u.instanceId === chosen)?.damage ?? -1;
      const r = combat.resolveCinematicTargetPick(G, chosen);
      check('resolveCinematicTargetPick ok', r.ok, r.reason);
      const after = ss.units.find((u) => u.instanceId === chosen);
      // AT-ST health is 1 → 4 damage destroys/stages it. Confirm the chosen
      // unit specifically took the hit (staged or damage bumped).
      const staged = G.pendingCombat?.theaterStaged?.includes(chosen);
      check('chosen unit took the burst (staged or damaged)',
        staged === true || (after && after.damage > before),
        `staged=${staged} before=${before} after=${after?.damage}`);
      break;
    }
    const side = pc.side;
    if (!stepOnce(G, side)) { check('AI step did not stall', false, pc.kind); break; }
  }
  check('CinematicTargetPick was reached', sawPick);
}

console.log('\n[ #290 single candidate → auto-applies, no choice ]');
{
  const G = createGame(data, baseOpts(901));
  forceOnlyTowCables(G);
  M.deployUnit(G, 'Empire', 'at-st', 'felucia'); // only ONE eligible target
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia'); // not an at-walker
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);
  let guard = 0, sawPick = false;
  while (G.pendingCombat && G.pendingChoice && guard++ < 300) {
    if (G.pendingChoice.kind === 'CinematicTargetPick') { sawPick = true; break; }
    if (!stepOnce(G, G.pendingChoice.side)) break;
  }
  check('no target-pick posted for a single candidate', !sawPick);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
