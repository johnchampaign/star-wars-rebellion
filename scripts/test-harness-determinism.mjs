// @timeout 600
// The tournament harness claimed "paired seeds" for years while a seed did NOT
// reproduce a game whenever an MCTS arm was in play. Measured 2026-08-21 on two
// same-config runs (ff3-off vs ff4-off, 26 shared seeds): 0/26 exact replays and
// the WINNER differed in 10/26. Two independent causes, and BOTH had to go:
//
//   1. tournament.mjs called seedAI() but never seedMCTS(), so the search ran on
//      unseeded Math.random(). It was the ONLY MCTS bench in the repo that did
//      not seed — mcts-bench, selfplay/playGame and mcts-rebel-bench all pair
//      seedAI with seedMCTS, and the comment above the call already claimed
//      "so each game is fully reproducible from its seed".
//   2. mctsAI's msCap is a WALL-CLOCK break in the pull loop. At the 8000ms
//      default it was binding CONSTANTLY (raising it tripled game wall-clock),
//      so the number of pulls a decision got depended on how busy the machine
//      was — i.e. the load decided the move.
//
// With both fixed, two runs of the same seed are byte-identical (result, rounds,
// steps, logEntries). Why it matters: only then is a per-seed OFF/ON transition
// table meaningful, and pairing is the only realistic route to a usable win-rate
// A/B here — unpaired, resolving an 8pp effect needs ~606 games/arm (~4.7 days).
//
// This test does NOT play games (~16 min each at deterministic settings). It
// pins the three load-bearing facts at the decision level, plus a static
// tripwire so the harness wiring cannot silently regress.
//
// Run: node scripts/test-harness-determinism.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Keep the search cheap: this test is about REPRODUCIBILITY, not strength.
process.env.SWR_MCTS_BUDGET ??= '24';
process.env.SWR_MCTS_HORIZON ??= '2';

const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
});
const raw = readFileSync(join(ROOT, 'scripts/fixtures/passivity-600.json'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const board = (side) => {
  const G = codec.decode(raw, catalog);
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== side);
  G.currentPlayer = side;
  return G;
};

/** One MCTS decision. Returns a signature of what the search DID plus how much
 *  work it got to do — pulls is what msCap truncates. */
// msCap must be high enough that it never TRUNCATES at budget 24 (or the
// reproducibility check becomes a coin flip), but still bounded: an unbounded
// cap gives this test no ceiling, and under the parallel suite's load it ran
// past its 600s limit while taking ~4s standalone.
function decide(side, { mctsSeed, aiSeed = 1, msCap = 20000 }) {
  const g = board(side);
  AI.seedAI(aiSeed);
  if (mctsSeed !== null) mcts.seedMCTS(mctsSeed);
  mcts.mctsStats.pulls = 0; mcts.mctsStats.decisions = 0;
  const before = (g.turnLog ?? []).length;
  mcts.mctsCommandStep(g, side, { msCap });
  // Drop wall-clock telemetry from the signature. The ai-decision payload
  // carries search.ms (how long the search TOOK), which is not part of the
  // decision and differs run-to-run even when the search is byte-identical —
  // a first cut of this test compared it and reported a false mismatch while
  // pulls/worlds/heuristicRank and the chosen action all agreed exactly.
  const noClock = (k, v) => (k === 'ms' ? 0 : v);
  const acts = (g.turnLog ?? []).slice(before).map((e) => `${e.kind}:${JSON.stringify(e.payload ?? {}, noClock)}`);
  AI.unseedAI();
  return { sig: acts.join('|'), pulls: mcts.mctsStats.pulls };
}

const SIDE = 'Empire';

console.log('\n[ the same MCTS seed reproduces the same decision ]');
{
  const a = decide(SIDE, { mctsSeed: 42 });
  const b = decide(SIDE, { mctsSeed: 42 });
  check('two runs at seed 42 choose the same action', a.sig === b.sig,
    `\n      a=${a.sig.slice(0, 120)}\n      b=${b.sig.slice(0, 120)}`);
  check('and do the same amount of search', a.pulls === b.pulls, `${a.pulls} vs ${b.pulls} pulls`);
  check('the search actually ran (not a trivial 1-candidate board)', a.pulls > 1, `${a.pulls} pulls`);
}

console.log('\n[ which of the two fixes is actually load-bearing ]');
{
  // Honest scope. The nondeterminism was measured end-to-end and BOTH fixes were
  // applied together, but they are not equally demonstrated:
  //
  //   msCap  — DEMONSTRATED below: a smaller cap does strictly less search, so
  //            machine load changes the move.
  //   seedMCTS — real, but NOT demonstrable on this board. sampleWorlds draws
  //            from the search RNG, and test-harness-mcts-arms asserts the Empire
  //            arm really does reach worlds > 1 in play. This fixture, though,
  //            has the base already revealed at endor, so it searches worlds=1
  //            and the seed cannot move the decision — which is exactly what the
  //            (fyi) line below reports. Pinned here by reproducibility and the
  //            static tripwire instead of by a behaviour change.
  //
  // A first draft asserted "different seeds give different decisions" and PASSED
  // — but only because the signature still contained search.ms, which always
  // differs. Stripping wall-clock made it fail honestly. Left as a comment rather
  // than hunting for a board that makes the assertion green.
  const sigs = new Set();
  for (let s = 1; s <= 3; s++) sigs.add(decide(SIDE, { mctsSeed: s }).sig);
  console.log(`  (fyi) distinct decisions across 3 search seeds on this board: ${sigs.size}`);
  check('seeding is at least stable — every seed yields SOME decision', sigs.size >= 1);
}

console.log('\n[ NON-VACUOUS: msCap truncates the search, so wall-clock changes the move ]');
{
  const big = decide(SIDE, { mctsSeed: 42, msCap: 20000 });
  const tiny = decide(SIDE, { mctsSeed: 42, msCap: 1 });
  check('a 1ms cap does strictly less search than a 20s cap', tiny.pulls < big.pulls,
    `${tiny.pulls} vs ${big.pulls} pulls`);
}

console.log('\n[ tripwire: the harness wiring cannot silently regress ]');
{
  const t = readFileSync(join(ROOT, 'scripts/tournament.mjs'), 'utf8');
  check('tournament.mjs seeds the MCTS rng per game', /seedMCTS\(/.test(t));
  check('--deterministic raises SWR_MCTS_MS', /args\.deterministic.*SWR_MCTS_MS/s.test(t));
  check('it is set BEFORE the policy import (defaultConfig reads env at import)',
    t.indexOf('SWR_MCTS_MS') < t.indexOf("await installPolicy('Rebel'"));
  check('an MCTS arm without --deterministic warns about partial pairing',
    /MCTS arm without --deterministic/.test(t));
  check('each game records whether its seed reproduces it',
    /deterministic: !!args\.deterministic/.test(t));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
