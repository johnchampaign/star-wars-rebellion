// jocke01: "Lastly I have gotten 'death star plans' as the first tier 2
// objective several games in a row. The 2nd and third tier should have a death
// star plans in them, but they should be shuffled before being placed in the
// objective deck. I get the feeling the death star plans is always on top."
//
// He was right, and about the mechanism too. RAW p.15 builds the objective deck
// as Level I = 5 random Level I cards, Level II = Death Star Plans + 4 random
// Level II, Level III = Death Star Plans + 4 random Level III. Setup honoured
// the "Death Star Plans is always one of the five" half by returning it at
// index 0 of the level — which also made it the FIRST card of that level drawn,
// every single game.
//
// The base game hid this completely: it has exactly 5 objectives per level, so
// the sampling branch never ran and the level kept its shuffled order. Only
// expansion games, where the pool is larger and 5 must be sampled, took the
// broken path. Measured before the fix: 200/200 expansion seeds opened Level II
// with Death Star Plans, against 19.5% in the base game.
//
// Run: node scripts/test-objective-stage-shuffle.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const N = 120;
const EXPANSION = { enabled: true, roeUnits: true, roeMissions: true };

/** The cards of one level, in deck order. The Rebel draws 1 objective during
 *  setup (RR p.15 step 4), so that card is in hand, not the deck — put it back
 *  at the front to see the level exactly as it was stacked. */
function levelOrder(G, stage) {
  const full = [...(G.rebel.objectiveHand ?? []), ...G.rebel.objectiveDeck];
  return full.filter((id) => G.catalog.objectives[id]?.stage === stage);
}

function sample(expansion) {
  const out = [];
  for (let seed = 1; seed <= N; seed++) {
    out.push(createGame(data, { seed, autoSetupUnits: true, expansion }));
  }
  return out;
}

console.log('\n[ the pool really is oversized with the expansion (else this tests nothing) ]');
{
  const G = createGame(data, { seed: 1, autoSetupUnits: true, expansion: EXPANSION });
  const poolSize = (stage) => Object.values(G.catalog.objectives)
    .filter((o) => o.stage === stage).length;
  check('more Level II objectives exist than fit in a level',
    poolSize(2) > 5, `pool=${poolSize(2)}`);
  check('Level II is still exactly 5 cards', levelOrder(G, 2).length === 5,
    `got ${levelOrder(G, 2).length}`);
  check('Level III is still exactly 5 cards', levelOrder(G, 3).length === 5);
}

for (const stage of [2, 3]) {
  const dsp = `death-star-plans-${stage}`;
  console.log(`\n[ Level ${stage} — Death Star Plans is always present, but not always on top ]`);
  const games = sample(EXPANSION);
  const positions = games.map((G) => levelOrder(G, stage).indexOf(dsp));
  check('RAW: Death Star Plans is in the level in every game',
    positions.every((p) => p >= 0), `missing in ${positions.filter((p) => p < 0).length}/${N}`);
  const onTop = positions.filter((p) => p === 0).length;
  check('the bug: it is NOT on top every game', onTop < N, `on top in ${onTop}/${N}`);
  // 5 slots, so ~20% expected. Allow a wide band — this guards against the
  // deterministic failure (100%), not against RNG drift.
  check('its position looks uniform rather than pinned',
    onTop <= N * 0.4, `on top in ${onTop}/${N} (${(100 * onTop / N).toFixed(1)}%)`);
  check('it lands in at least 3 different slots across seeds',
    new Set(positions).size >= 3, `slots seen: ${[...new Set(positions)].sort().join(',')}`);
}

console.log('\n[ the base game, which never took the broken path, is unchanged ]');
{
  const games = sample({ enabled: false });
  const positions = games.map((G) => levelOrder(G, 2).indexOf('death-star-plans-2'));
  check('Death Star Plans still always in Level II', positions.every((p) => p >= 0));
  const onTop = positions.filter((p) => p === 0).length;
  check('still not pinned to the top', onTop <= N * 0.4, `on top in ${onTop}/${N}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
