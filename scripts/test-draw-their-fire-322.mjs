// #322 — Draw Their Fire's "remove up to 2 damage from Rebel ships" is now a
// player decision when the allocation matters (more wounded damage than budget),
// and the suggested/AI allocation saves lethally-damaged (staged) ships first
// instead of blindly healing the most-damaged ship and letting a dying one sink.
// Run: node scripts/test-draw-their-fire-322.mjs
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
function forceOnlyDrawTheirFire(G) {
  G.rebel.cinematicTacticDiscard = Object.values(G.catalog.tactics)
    .filter((t) => t.cinematic && t.side === 'Rebel' && t.theater === 'space'
      && t.id !== 'cin-rebel-space-draw-their-fire')
    .map((t) => t.id);
}

console.log('\n[ #322 a meaningful Draw Their Fire heal posts an interactive choice ]');
{
  const G = createGame(data, baseOpts(701));
  forceOnlyDrawTheirFire(G);
  const sys = 'felucia';
  G.map.systems[sys].units = [];
  // Rebel: two wounded cruisers (total damage 4 > 2 budget → a real decision),
  // plus the Nebulon-B primary so the card is playable. One cruiser is at lethal.
  M.deployUnit(G, 'Empire', 'star-destroyer', sys);
  M.deployUnit(G, 'Empire', 'star-destroyer', sys);
  M.deployUnit(G, 'Rebel', 'nebulon-b-frigate', sys); // primary → card playable
  const c1 = M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', sys);
  const c2 = M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', sys);
  // Pre-damage: c1 lethal (3/3 staged-able), c2 wounded (1).
  const u1 = G.map.systems[sys].units.find((u) => u.instanceId === (c1?.instanceId ?? c1));
  const u2 = G.map.systems[sys].units.find((u) => u.instanceId === (c2?.instanceId ?? c2));
  const cruisers = G.map.systems[sys].units.filter((u) => u.typeId === 'mon-cala-cruiser');
  cruisers[0].damage = 3; // lethal
  cruisers[1].damage = 2;
  combat.beginCombat(G, 'Rebel', 'kashyyyk', sys);
  combat.runCombat(G);

  let guard = 0, sawHeal = false, suggested = null;
  while (G.pendingCombat && guard++ < 400) {
    const pc = G.pendingChoice;
    if (!pc) break;
    if (pc.kind === 'CinematicDeferredHeal' && pc.side === 'Rebel') {
      sawHeal = true;
      suggested = pc.suggested;
      check('heal budget is 2', pc.amount === 2, `amount=${pc.amount}`);
      check('a staged (dying) candidate is flagged', pc.candidates.some((x) => x.staged));
      // Suggested should spend on the staged ship first (save it).
      const stagedId = pc.candidates.find((x) => x.staged)?.instanceId;
      const onStaged = (pc.suggested.find((s) => s.instanceId === stagedId)?.amount) ?? 0;
      check('suggested heals the dying ship', onStaged > 0, `onStaged=${onStaged}`);
      const r = combat.resolveCinematicDeferredHeal(G, pc.suggested.map((s) => ({ ...s })));
      check('resolve ok', r.ok, r.reason);
      break;
    }
    if (!stepOnce(G, pc.side)) { check('no stall before heal', false, pc.kind); break; }
  }
  check('Draw Their Fire posted an interactive heal', sawHeal);
}

console.log('\n[ #322 a forced heal (all damage <= budget) auto-applies, no pause ]');
{
  const G = createGame(data, baseOpts(702));
  forceOnlyDrawTheirFire(G);
  const sys = 'felucia';
  G.map.systems[sys].units = [];
  M.deployUnit(G, 'Empire', 'star-destroyer', sys);
  M.deployUnit(G, 'Rebel', 'nebulon-b-frigate', sys);
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', sys);
  const cruiser = G.map.systems[sys].units.find((u) => u.typeId === 'mon-cala-cruiser');
  cruiser.damage = 1; // total wounded damage (1) <= budget (2) → forced, no choice
  combat.beginCombat(G, 'Rebel', 'kashyyyk', sys);
  combat.runCombat(G);
  let guard = 0, sawHeal = false;
  while (G.pendingCombat && guard++ < 400) {
    const pc = G.pendingChoice;
    if (!pc) break;
    if (pc.kind === 'CinematicDeferredHeal') { sawHeal = true; break; }
    if (!stepOnce(G, pc.side)) break;
  }
  check('no interactive prompt when the heal is forced', !sawHeal);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
