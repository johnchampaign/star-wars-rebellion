// #580 — "The empire has several fleets with great targets next to them yet he
// passes with 3 leaders in leader pool... It's turn 3 and again the empire
// player has given up the game and stops playing." Replayed from the reporter's
// own board (scripts/fixtures/passivity-580.json).
//
// NOT a candidate-generation bug (#599/#639: the arms are distinct and real),
// NOT a committed-mission forfeit (#649: the pool is not empty), NOT a lost
// position (#630: every action arm rolls out around 0.82, nowhere near zero).
// It is the LAST shape in the pass-with-plays cluster, and it is a measurement
// problem: a 64-pull search cannot resolve this board at all.
//
// MEASURED 2026-08-16 on this fixture:
//   true gap over 16 paired rollouts   +0.007          (pass and action tie)
//   single-search gap, 24 seeds         0.001 .. 0.088 (median 0.044)
//   SE of that difference               0.019 .. 0.033 (median 0.027)
//
// So a single search just draws from a distribution straddling the 0.05
// activation margin. And which side it lands on was decided by which arm
// happened to top the means: when a REVEAL did, #649's 0.15 margin (~5 SE)
// rescued gaps as large as 0.088; when an ACTIVATION did, the 0.05 margin
// (~1.9 SE) let 0.054 and 0.071 through. Same board, same tie, opposite answer.
//
// The fix gives the activation path the noise robustness #649 gave reveals, as
// a floor that scales with the search's own measured error rather than as a
// bigger constant: effMargin = max(baseMargin, SWR_MCTS_PASS_Z x SE), z=3.
//
// Run: node scripts/test-pass-noise-margin-580.mjs
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
  // The capture is taken just AFTER the pass — rewind the one bit it changed.
  const G = codec.decode(raw, catalog);
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Empire');
  G.currentPlayer = 'Empire';
  return G;
};
// Each search is a full 64-pull MCTS decision (~2.4s under the runner) against
// a 180s per-file budget, so this file spends searches carefully: the pre-fix
// bug reproduced on 2 seeds in 24, and sampling a rate big enough to catch that
// reliably costs more than the budget allows. The two seeds that DID reproduce
// are pinned instead — deterministic, and 4 searches rather than 50.
// The measurement that sized the fix (24 seeds, header above) lives in
// scripts/diag-pass-margin.mjs; this file is the tripwire, not the measurement.
// RE-DERIVED 2026-08-16 (was [3, 11]). Pinned MCTS seeds are coupled to
// EVERYTHING the heuristic does inside a rollout, not just the board: turning
// SWR_BUNKERS back off changed what the Empire builds in rollouts, which moved
// the arm means on this fixture, and seed 3 stopped forfeiting (2/24 -> 1/24
// reproduce). Seed 11 still does. When this trips again, the message below
// says how to re-derive; do NOT read a drifted seed as a regression in the fix.
// RE-DERIVED AGAIN 2026-08-22 (was [11], now back to [3]): implementing the
// Rebel Ion Cannon's dice reduction (#736) changed how space combat resolves
// inside rollouts, which moved the arm means on this fixture again. Rescanned
// seeds 1-30 with the floor off: only seed 3 forfeits, and with the floor on it
// activates — i.e. the fix under test is intact, only the sampling drifted.
const chooseWithSeed = (raw, s) => {
  const g = board(raw);
  AI.seedAI(s); mcts.seedMCTS?.(s);
  const r = mcts.searchMctsCommand(g, 'Empire');
  return r ? r.chosen.kind : null;
};
const withPassZ = (v, fn) => {
  const prev = process.env.SWR_MCTS_PASS_Z;
  process.env.SWR_MCTS_PASS_Z = v;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.SWR_MCTS_PASS_Z;
    else process.env.SWR_MCTS_PASS_Z = prev;
  }
};
const passRate = (raw, seeds) => {
  let passes = 0;
  for (let s = 1; s <= seeds; s++) if (chooseWithSeed(raw, s) === 'pass') passes++;
  return passes / seeds;
};

console.log('[ #580 — a tie the search cannot resolve must not be broken toward pass ]');
const raw = load('passivity-580.json');

{
  const G = board(raw);
  // Pin the shape, so a future engine change that quietly empties this board
  // turns the test red instead of making it vacuously pass.
  check('three leaders really are idle in the pool',
    G.empire.leaderPool.length === 3, `pool=${JSON.stringify(G.empire.leaderPool)}`);
  check('and a leader is committed to a face-down mission',
    (G.empire.leadersOnMissions ?? []).length > 0);

  AI.seedAI(1);
  const acts = AI.bestCommandAction(G, 'Empire').filter((a) => a.kind !== 'pass');
  check('the plays the reporter could see ARE generated', acts.length >= 3,
    `only ${acts.length} actionable candidates`);
  check('including at least one activation (this is the activation-margin path)',
    acts.some((a) => a.kind === 'activate'));
  check('and a high-scoring reveal', acts.some((a) => a.kind === 'reveal' && a.score >= 30));
}
// The control comes FIRST: if the fixture no longer reproduces the bug with the
// fix disabled, then everything below is green for some unrelated reason and
// would not catch a regression. That is the failure mode this project has been
// bitten by before, so it is asserted rather than assumed.
// CONTROL, RATE-BASED (2026-08-31). This file has now re-derived pinned seeds
// THREE times (2026-08-16 bunkers-off, 2026-08-22 Ion Cannon, 2026-08-27
// subjugation re-pricing) and briefly ran its control in a child process with
// the old scoring when the #738 change collapsed the tie entirely. The
// 2026-08-31 SWR_DS_CAUTION default flip restored the tie — with the floor OFF
// at shipped defaults the board forfeits again (measured 30% of seeds) — so
// the control is back in-process, and it is now a RATE over 10 seeds rather
// than a pinned seed: any single seed's behaviour is coupled to everything the
// heuristic does inside a rollout, but "some seed forfeits with the floor off,
// none with it on" is the actual claim this file exists to pin.
console.log('[ control: with the floor OFF, this board still forfeits sometimes ]');
{
  const rateOff = withPassZ('0', () => passRate(raw, 10));
  console.log(`    floor off: passed in ${(100 * rateOff).toFixed(0)}% of 10 seeds`);
  check('at least one seed forfeits with the floor off (the bug still exists to fix)',
    rateOff > 0,
    'no seed forfeits even without the floor — the tie has collapsed again '
    + '(last causes: #738 subjugation re-pricing collapsed it, SWR_DS_CAUTION restored it); '
    + 're-measure with scripts/diag-pass-margin.mjs before touching anything');
}

console.log('[ and the floor fixes it at SHIPPED defaults ]');
{
  const rate = passRate(raw, 10);
  console.log(`    floor on:  passed in ${(100 * rate).toFixed(0)}% of 10 seeds`);
  check('no seed forfeits with the floor on', rate === 0,
    `still passes ${(100 * rate).toFixed(0)}% of the time`);
}

console.log('[ the other reported boards are unaffected ]');
{
  for (const [label, file] of [
    ['#630 (lost position, keep-playing owns it)', 'passivity-630.json'],
    ['#639 (duplicate arms)', 'passivity-639.json'],
    ['#649 (sole committed reveal)', 'passivity-649.json'],
  ]) {
    const rate = passRate(load(file), 4);
    check(`${label} still does not pass (${(100 * rate).toFixed(0)}%)`, rate === 0);
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
