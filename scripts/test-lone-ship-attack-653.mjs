// #653 — "The Empire AI sends a single Assault Carrier to bothawui without any
// Ground Units. There is a Mon Calamari Cruiser and a Nebulon-B Frigate in the
// System. This move makes 0 sense."
//
// bestCommandAction has had a strength gate since #246/#237, and a target that
// fails it is dropped outright (`.filter(ts > 0)`). So the attack should never
// have been generated. The gate was measuring the wrong army: it summed EVERY
// Empire unit in every non-leader-blocked adjacent system, while the executor
// in tryCommandAction commits far less, for two reasons the gate modelled
// nowhere —
//
//   • TRANSPORT (RR p.9): ground and restricted fighters only move if a capital
//     ship at the SAME source has spare capacity.
//   • THE GARRISON RESERVE: the executor keeps 1 ground unit at each subjugated
//     or producing Imperial-loyal system, unless the Rebel base is revealed.
//
// Replayed out of self-play (seed 28, Sullust, turn 8): the gate read 15 v 13
// and waved the attack through; the reserve then held the AT-AT back and a
// single Star Destroyer arrived alone against 13 of Rebel force and died.
//
// This fixture is that position, using the report's own defenders. The numbers
// are chosen so the gate is genuinely load-bearing — asserted below rather than
// assumed, since a scenario the AI would reject anyway proves nothing:
//   naive adjacent sum : Star Destroyer 7 + AT-AT 6 = 13  >= defenders 12  (passes)
//   really deliverable : Star Destroyer 7 only          <  defenders 12  (fails)
// The AT-AT is the only ground unit at a subjugated system, so the reserve
// pins it in place and no capital-ship capacity can help.
//
// Run: node scripts/test-lone-ship-attack-653.mjs
//   Counterfactual: SWR_REAL_REINFORCE=0 node scripts/test-lone-ship-attack-653.mjs
//   must FAIL — that flag restores the old count-everything estimate.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const strength = (G, u) => {
  const t = G.catalog.unitTypes[u.typeId];
  return (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0);
};

/** Target system holding the report's two Rebel capital ships, with an Imperial
 *  Star Destroyer + AT-AT next door at a SUBJUGATED system (so the AT-AT is
 *  pinned as the garrison reserve). Everything else is swept off the board so
 *  no unrelated force muddies either side of the comparison. */
function board(seed) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.rebelBaseRevealed = false; // post-reveal waives the garrison reserve

  // A target adjacent to a staging system, neither of them the hidden base.
  const target = Object.keys(G.map.systems).find((sid) =>
    sid !== G.rebelBaseSystemId
    && (G.catalog.adjacency[sid] ?? []).some((a) => a !== G.rebelBaseSystemId && G.map.systems[a]));
  const staging = (G.catalog.adjacency[target] ?? [])
    .find((a) => a !== G.rebelBaseSystemId && G.map.systems[a]);

  // Defenders: the report's own pair.
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', target);
  M.deployUnit(G, 'Rebel', 'nebulon-b-frigate', target);
  G.map.systems[target].loyalty = 'rebel'; // give the Empire a reason to want it

  // Staging: one capital ship + one ground unit, at a subjugated system.
  M.deployUnit(G, 'Empire', 'star-destroyer', staging);
  M.deployUnit(G, 'Empire', 'at-at', staging);
  G.map.systems[staging].subjugated = true;
  G.empire.leadersOnBoard = {};
  G.rebel.leadersOnBoard = {};
  return { G, target, staging };
}

const { G, target, staging } = board(653);

console.log('\n[ the fixture is load-bearing: naive count passes the gate, real delivery fails it ]');
{
  const def = G.map.systems[target].units.filter((u) => u.side === 'Rebel');
  const adj = G.map.systems[staging].units.filter((u) => u.side === 'Empire');
  const defenders = def.reduce((a, u) => a + strength(G, u), 0);
  const naive = adj.reduce((a, u) => a + strength(G, u), 0);
  const deliverable = adj.filter((u) => G.catalog.unitTypes[u.typeId].theater !== 'ground')
    .reduce((a, u) => a + strength(G, u), 0);
  check('defenders are the reported Mon Cal + Nebulon-B', def.length === 2 && defenders === 12, `=${defenders}`);
  check('naive adjacent sum would CLEAR the gate', naive >= defenders, `naive=${naive} def=${defenders}`);
  check('what can really be delivered is hopeless', deliverable < defenders * 0.6,
    `deliverable=${deliverable} def=${defenders}`);
  check('the ground unit is pinned as the only garrison at a subjugated system',
    G.map.systems[staging].subjugated === true
    && adj.filter((u) => G.catalog.unitTypes[u.typeId].theater === 'ground').length === 1);
}

console.log('\n[ #653 the AI must not offer this attack ]');
{
  const acts = ai.bestCommandAction(G, 'Empire');
  const atTarget = acts.filter((a) => a.kind === 'activate' && a.targetSystemId === target);
  check('bestCommandAction returned something', Array.isArray(acts) && acts.length > 0);
  check('the bug: no activation is offered against the stronger system',
    atTarget.length === 0,
    `offered ${atTarget.length}: ${JSON.stringify(atTarget.map((a) => ({ t: a.targetSystemId, s: a.score })))}`);
}

console.log('\n[ the gate discriminates — it does not just suppress all attacks ]');
{
  // Same staging force, but now the target is defended by a single fighter the
  // lone Star Destroyer beats comfortably. This must still be offered, or the
  // fix would be "the Empire never attacks" dressed up as a bug fix.
  const { G: G2, target: t2 } = board(654);
  G2.map.systems[t2].units = [];
  M.deployUnit(G2, 'Rebel', 'x-wing', t2);
  const acts2 = ai.bestCommandAction(G2, 'Empire');
  const atT2 = acts2.filter((a) => a.kind === 'activate' && a.targetSystemId === t2);
  check('a winnable attack IS still offered', atT2.length > 0,
    `activate targets: ${JSON.stringify(acts2.filter((a) => a.kind === 'activate').map((a) => a.targetSystemId))}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
