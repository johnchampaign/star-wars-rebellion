// #312 — a plain cinematic deal-damage card (Bombing Run, "Deal 2 red damage")
// now lets the playing side choose which enemy unit takes the damage, when 2+
// are eligible — instead of auto-picking. Generalizes the #290 target pick to
// plain deals.
// Run: node scripts/test-bombing-run-312.mjs
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

// Leave ONLY Bombing Run available to the Rebel space cinematic deck.
function forceOnlyBombingRun(G) {
  G.rebel.cinematicTacticDiscard = Object.values(G.catalog.tactics)
    .filter((t) => t.cinematic && t.side === 'Rebel' && t.theater === 'space'
      && t.id !== 'cin-rebel-space-bombing-run')
    .map((t) => t.id);
}

console.log('\n[ #312 Bombing Run posts a target pick among red enemy ships ]');
{
  const G = createGame(data, baseOpts(910));
  forceOnlyBombingRun(G);
  // 2 red-health Empire Star Destroyers to choose between; a Rebel ship attacks.
  G.map.systems['felucia'].units = [];
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Rebel', 'y-wing', 'felucia'); // Bombing Run's primary unit → D(2)
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);

  let guard = 0, sawPick = false;
  while (G.pendingCombat && G.pendingChoice && guard++ < 300) {
    const pc = G.pendingChoice;
    if (pc.kind === 'CinematicTargetPick' && pc.side === 'Rebel') {
      sawPick = true;
      check('pick offers the 2 red Star Destroyers', pc.candidates.length === 2,
        `got ${pc.candidates.length}`);
      check('Bombing Run primary deals 2', pc.amount === 2, `amount=${pc.amount}`);
      const chosen = pc.candidates[1];
      const r = combat.resolveCinematicTargetPick(G, chosen);
      check('resolve ok', r.ok, r.reason);
      // #391 superseded the original expectation here. Bombing Run's primary is
      // a PLAIN deal ("Deal 2 red damage" — no "to 1 unit"), so the player may
      // SPREAD it: the engine applies one point and re-prompts for each
      // remaining point. Concentrating both on one ship is still available, by
      // picking the same ship twice — which is what this asserts.
      const dmgOf = (id) => G.map.systems['felucia'].units
        .find((x) => x.instanceId === id)?.damage ?? 0;
      check('first point landed on the chosen ship', dmgOf(chosen) === 1, `dmg=${dmgOf(chosen)}`);
      check('re-prompted for the remaining point',
        G.pendingChoice?.kind === 'CinematicTargetPick' && G.pendingChoice.amount === 1,
        `kind=${G.pendingChoice?.kind} amount=${G.pendingChoice?.amount}`);
      const other = pc.candidates.find((id) => id !== chosen);
      check('the other Star Destroyer is still offered (damage may be split)',
        !!G.pendingChoice?.candidates?.includes(other), 'second point is forced onto one ship');
      const r2 = combat.resolveCinematicTargetPick(G, chosen);
      check('second resolve ok', r2.ok, r2.reason);
      check('both points land on one ship when it is picked twice',
        dmgOf(chosen) >= 2, `dmg=${dmgOf(chosen)}`);
      check('the ship not picked took nothing', dmgOf(other) === 0, `dmg=${dmgOf(other)}`);
      break;
    }
    if (!stepOnce(G, pc.side)) { check('AI did not stall', false, pc.kind); break; }
  }
  check('Bombing Run target pick was reached', sawPick);
}

console.log('\n[ #312 single eligible target → no pick (auto-applies) ]');
{
  const G = createGame(data, baseOpts(911));
  forceOnlyBombingRun(G);
  G.map.systems['felucia'].units = [];
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia'); // only ONE red target
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);
  let guard = 0, sawPick = false;
  while (G.pendingCombat && G.pendingChoice && guard++ < 300) {
    if (G.pendingChoice.kind === 'CinematicTargetPick') { sawPick = true; break; }
    if (!stepOnce(G, G.pendingChoice.side)) break;
  }
  check('no target pick for a single candidate', !sawPick);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
