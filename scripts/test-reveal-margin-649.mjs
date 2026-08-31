// @timeout 480000
// #649 — "The empire players passed while having vader on a facedown mission.
// If the mission is capture operative the empire has possible targets... it
// seem like a wasted action." Replayed from the reporter's own board
// (scripts/fixtures/passivity-649.json).
//
// NOT the same as the earlier passivity bugs. There is no candidate-generation
// fault here (the reveal IS offered) and the position is not lost (#630's
// all-zero case). The search simply cannot tell the two options apart:
//
//   seed 1  pass 0.585  reveal 0.568   gap +0.017
//   seed 2  pass 0.583  reveal 0.520   gap +0.063
//   seed 3  pass 0.466  reveal 0.491   gap -0.025
//   seed 4  pass 0.521  reveal 0.519   gap +0.002
//
// Both arms sit near 0.5 with almost every rollout horizon-cut, and the gap
// wanders on RNG alone. With ~30 pulls per arm near p=0.5 the sampling error on
// the DIFFERENCE is roughly +/-0.09 — wider than the 0.05 base pass-margin. The
// guard was calibrated tighter than the measurement it guards, so on ~28% of
// seeds noise pushed pass past it and Vader's whole round was forfeited.
//
// Forfeiting a REVEAL is also not symmetric with forfeiting an activation: the
// leaders are ALREADY committed to that mission, so passing spends them for the
// round and buys nothing (the card just returns to hand). And after the
// assignment gate (ddaa0af) a reveal candidate only exists because assignment
// judged the mission worth playing. So reveals get a wider margin
// (SWR_MCTS_REVEAL_MARGIN, default 15) that actually clears the noise.
//
// Run: node scripts/test-reveal-margin-649.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const catalog = setup.buildCatalog(data);
const load = (f) => readFileSync(join(ROOT, 'scripts/fixtures', f), 'utf8');
const board = (raw) => {
  const G = codec.decode(raw, catalog);
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Empire');
  G.currentPlayer = 'Empire';
  return G;
};
const passRate = (raw, seeds = 20) => {
  let passes = 0;
  for (let s = 1; s <= seeds; s++) {
    const g = board(raw);
    AI.seedAI(s); mcts.seedMCTS?.(s);
    const r = mcts.searchMctsCommand(g, 'Empire');
    if (r && r.chosen.kind === 'pass') passes++;
  }
  return passes / seeds;
};

console.log('[ #649 — do not forfeit a mission the leaders are already committed to ]');
{
  const raw = load('passivity-649.json');
  const G = board(raw);
  check('the pool really is empty (so the reveal is the ONLY action)',
    G.empire.leaderPool.length === 0, `pool=${JSON.stringify(G.empire.leaderPool)}`);
  check('and a leader is committed to a face-down mission',
    (G.empire.leadersOnMissions ?? []).length > 0);

  AI.seedAI(1);
  const acts = AI.bestCommandAction(G, 'Empire');
  const reveal = acts.find((a) => a.kind === 'reveal');
  check('the reveal IS generated (this is not a candidate-generation bug)', !!reveal);

  const rate = passRate(raw);
  console.log(`    passed in ${(100 * rate).toFixed(0)}% of searches`);
  // Pre-fix this board forfeited on ~28% of seeds.
  check('the committed mission is played, not thrown away', rate <= 0.08,
    `still passes ${(100 * rate).toFixed(0)}% of the time`);
}

console.log('[ the other reported boards must be unaffected ]');
{
  // #630 is the LOST-position case: every action arm rolls out at 0, so the
  // keep-playing guard handles it and the reveal margin must not be what saves
  // it. #639 is the duplicate-arm case. Both should already sit at 0%.
  for (const [label, file] of [['#630 (lost position)', 'passivity-630.json'], ['#639 (duplicate arms)', 'passivity-639.json']]) {
    const rate = passRate(load(file), 12);
    check(`${label} still does not pass (${(100 * rate).toFixed(0)}%)`, rate <= 0.08);
  }
}

console.log('[ the guard must stay narrow ]');
{
  // It may only ever rescue a REVEAL. If it starts firing on activations the
  // scoping is wrong — activations aren't pre-committed and forfeiting one is a
  // genuine choice the search is entitled to make.
  mcts.resetMctsStats?.();
  passRate(load('passivity-639.json'), 12);
  const s = mcts.mctsStats;
  console.log(`    over ${s.decisions} decisions: pass-margin ${s.passRescues}, reveal-specific ${s.revealRescues}`);
  check('reveal-specific rescues never exceed total pass-margin rescues',
    (s.revealRescues ?? 0) <= (s.passRescues ?? 0),
    'the counter is miscounting — reveal rescues are a subset');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
