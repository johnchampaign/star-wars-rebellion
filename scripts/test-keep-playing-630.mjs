// #630 — "The empire gave up on turn 6 and passed after one action despite
// having several leaders and missions. Granted my win is guaranteed at this
// point, but still." Replayed from the reporter's own board
// (scripts/fixtures/passivity-630.json).
//
// WHAT THIS IS. Unlike #639's duplicate-arm bug, MCTS was NOT malfunctioning
// here. The Empire is genuinely lost, and the search says so — its own trace on
// this position:
//   pass                              n=17  mean=0.118  win=2  loss=15
//   reveal research-and-development   n=10  mean=0.000  win=0  loss=10
//   activate moff-jerjerrod@mustafar  n=10  mean=0.000  win=0  loss=10
//   ...three more action arms, all 0.000
// Every action loses every rollout; pass picks up 2 stray wins purely because
// ending the round early lands the rollout elsewhere in the tree. Pass really
// was the highest-EV arm, and the 0.118 gap sails past the 0.05 pass-margin.
//
// So this guard is a deliberate PREFERENCE, not a bug fix: when the search has
// NO gradient (no action arm ever won), 2/17 against 0/10 is not a distinction
// worth forfeiting the round for, and an opponent that visibly downs tools is
// bad to play against. We fall back to the heuristic's ranking instead.
//
// Narrowness is the thing to protect. One action arm above the floor and the
// search has a real preference again, so the rule stops firing — measured at
// 0.0% of 205 decisions across the replay bench. If this ever starts firing
// routinely it has stopped being a lost-position guard and become an
// aggression knob, which the record says A/Bs negative.
//
// Run: node scripts/test-keep-playing-630.mjs
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
const raw = readFileSync(join(ROOT, 'scripts/fixtures/passivity-630.json'), 'utf8');
/** Snapshot is captured just AFTER the pass; rewind that one bit. */
const board = () => {
  const G = codec.decode(raw, catalog);
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Empire');
  G.currentPlayer = 'Empire';
  return G;
};

console.log('[ #630 — a losing Empire must still take its turn ]');
{
  const G = board();
  AI.seedAI(1);
  const acts = AI.bestCommandAction(G, 'Empire');
  const real = acts.filter((a) => a.kind !== 'pass');
  check('the board really does offer legal actions', real.length >= 4, `${real.length} real actions`);
  check('and a leader is genuinely available', G.empire.leaderPool.length > 0, 'pool empty');

  const SEEDS = 20;
  let passes = 0, chosenScores = [], chosen = [];
  for (let s = 1; s <= SEEDS; s++) {
    // The heuristic's action list is seed-dependent, so the bar for "took the
    // best action" has to be computed under the SAME seed. Comparing every
    // seed's choice against a single seed-1 maximum only ever passed because
    // the top action happened to be stable, and it broke the moment tie-breaks
    // stopped resolving alphabetically. Fresh board for the ranking so the
    // search below still sees an untouched one.
    const gRank = board();
    AI.seedAI(s);
    const actsS = AI.bestCommandAction(gRank, 'Empire').filter((a) => a.kind !== 'pass');
    const bestS = actsS.length ? Math.max(...actsS.map((a) => a.score)) : -Infinity;

    const g = board();
    AI.seedAI(s); mcts.seedMCTS?.(s);
    const r = mcts.searchMctsCommand(g, 'Empire');
    if (!r) continue;
    if (r.chosen.kind === 'pass') passes++;
    else { chosenScores.push(r.chosen.score); chosen.push({ got: r.chosen.score, want: bestS }); }
  }
  console.log(`    passed in ${passes}/${SEEDS} searches`);
  // Pre-guard this was 25/25. It must now essentially never give up.
  check('the Empire plays on instead of giving up', passes <= 2, `passed ${passes}/${SEEDS}`);
  // And it should take a SERIOUS action, not the cheapest thing on the list —
  // the fallback picks by heuristic score precisely because the rollout means
  // are all tied at zero and carry no ranking.
  // NOTE — this used to assert the chosen action was the highest-SCORING one,
  // which is not something the search promises and stopped being true when
  // tie-breaks stopped resolving alphabetically. The reason is worth recording,
  // because it is not a regression:
  //
  //   old tiebreak — every action arm rolled out 0.000 (the trace in the header
  //     above). Nothing to choose between them, so the argmax fell through to
  //     arm order, arms are sorted by heuristic score, and the top-scoring
  //     action won by default. The assertion passed by luck of that ordering.
  //   new tiebreak — reveal:secret-weapons-research@coruscant now WINS a
  //     rollout (mean 0.1 vs 0.091 for the rest). The position is no longer
  //     hopeless in the search's eyes, so the lost-position fallback does not
  //     fire here at all, and MCTS picks by rollout mean over heuristic score.
  //     That is the search doing exactly what it exists to do.
  //
  // So the fixture no longer exercises the fallback, and asserting the
  // fallback's tie-break through it would be asserting nothing. What #630
  // actually reported — the Empire downing tools with a full hand — is the
  // `passes <= 2` check above, which is the guard that matters.
  //
  // COVERAGE GAP, stated rather than hidden: "the fallback picks by heuristic
  // score" is now unasserted. Reaching that branch needs a position where pass
  // beats every action by more than the margin AND all action means sit under
  // the lost floor, which this fixture no longer is.
  check('every search committed to a real action, never a no-op pass',
    chosen.length === SEEDS - passes && chosen.every((c) => c.got > 0),
    `chose ${JSON.stringify([...new Set(chosenScores)])}`);
}

console.log('[ narrowness — the guard must stay off when the search has signal ]');
{
  // #639's board is winnable and its arms carry real values, so the
  // lost-position fallback must never engage there.
  const raw639 = readFileSync(join(ROOT, 'scripts/fixtures/passivity-639.json'), 'utf8');
  mcts.resetMctsStats?.();
  for (let s = 1; s <= 10; s++) {
    const g = codec.decode(raw639, catalog);
    g.passedThisCommand = (g.passedThisCommand ?? []).filter((x) => x !== 'Empire');
    g.currentPlayer = 'Empire';
    AI.seedAI(s); mcts.seedMCTS?.(s);
    mcts.searchMctsCommand(g, 'Empire');
  }
  const fired = mcts.mctsStats.keepPlaying ?? 0;
  console.log(`    keep-playing fired ${fired}/${mcts.mctsStats.decisions} decisions on a live position`);
  check('the guard does not fire where the search has a real preference', fired === 0, `fired ${fired}×`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
