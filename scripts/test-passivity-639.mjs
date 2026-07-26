// #639 — "The Empire passed on turn one. No missions. No movement." Replayed
// from the reporter's OWN board (scripts/fixtures/passivity-639.json, lifted
// from the state attached to the issue).
//
// This is the regression test for the duplicate-activation-arm bug (#599, fixed
// in 04320e6), and it is what proved that fix actually addresses the passivity
// reports rather than just tidying the candidate list.
//
// MECHANISM. bestCommandAction used to give EVERY pool leader the argmax of a
// leader-independent system score, so this board's three pool leaders (Piett,
// Tagge, Palpatine) all proposed Naboo. MCTS then split its 64-rollout budget
// across three arms naming the SAME destination, so each individual arm carried
// only a third of the evidence for "go to Naboo" — while `pass` sat as ONE
// consolidated arm. Fragmented arms lose to a consolidated one, and the Empire
// passed with three leaders idle and six legal actions on the table.
//
// The reporter's own decision trace shows it, and #629's shows the identical
// signature (pass beating the best action by ~0.09, just over the 0.05
// pass-margin that would have rescued it):
//   #639  chose pass mc=0.77   alts: activate piett->naboo score 33 mc=0.68
//   #629  chose pass mc=0.85   alts: reveal gather-intel score 28 mc=0.76
//
// Measured on this fixture, 25 independent searches:
//   duplicate arms (SWR_ACTIVATE_DIVERSITY=0): PASSES 12/25 (48%)
//   distinct arms  (default)                 : PASSES  0/25 (0%)
//
// Run: node scripts/test-passivity-639.mjs
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

const raw = readFileSync(join(ROOT, 'scripts/fixtures/passivity-639.json'), 'utf8');
const catalog = setup.buildCatalog(data);
/** The snapshot is captured just AFTER the pass; rewind that one bit to recover
 *  the position the AI actually faced. Passing mutates nothing else. */
const board = () => {
  const G = codec.decode(raw, catalog);
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Empire');
  G.currentPlayer = 'Empire';
  return G;
};

console.log('[ #639 — the reporter\'s board must not pass with leaders idle ]');
{
  const G = board();
  const pool = G.empire.leaderPool;
  check('fixture still has multiple Empire leaders in pool', pool.length >= 2, `pool=${JSON.stringify(pool)}`);

  AI.seedAI(1);
  const acts = AI.bestCommandAction(G, 'Empire');
  const activates = acts.filter((a) => a.kind === 'activate');
  const real = acts.filter((a) => a.kind !== 'pass');
  check('real actions are available (so passing is a choice, not forced)', real.length > 0, `${real.length}`);
  // The fix itself: distinct destinations, not N copies of one.
  const distinct = new Set(activates.map((a) => a.targetSystemId)).size;
  check(`activation candidates name distinct systems (${distinct} of ${activates.length})`,
    activates.length === 0 || distinct === activates.length,
    'duplicate targets fragment the rollout budget and let pass win');

  // The behaviour that matters: across many searches, this board must act.
  const SEEDS = 25;
  let passes = 0;
  for (let s = 1; s <= SEEDS; s++) {
    const g = board();
    AI.seedAI(s);
    mcts.seedMCTS?.(s);
    const r = mcts.searchMctsCommand(g, 'Empire');
    if (r && r.chosen.kind === 'pass') passes++;
  }
  console.log(`    passed in ${passes}/${SEEDS} searches`);
  // Pre-fix this sat at 12/25. Allow a little headroom for search noise but
  // fail loudly if passivity comes back.
  check('the Empire does not pass this position', passes <= 2, `passed ${passes}/${SEEDS}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
