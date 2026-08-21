// #600 — "The rebel player passed with 3 facedown missions and some leaders in
// pool." The one REBEL-side report in the pass-with-plays cluster.
//
// The nine Empire-side siblings were closed by SWR_MCTS_PASS_Z, an
// effective-margin floor in mctsAI.ts. That fix cannot have touched this one:
// MCTS_REBEL_ENABLED is OFF by default, so the shipped Rebel runs
// evalCommandStepDeep depth-2 and never executes the guarded path.
//
// Replayed on the reporter's own board (scripts/fixtures/passivity-600.json,
// extracted from the report's encoded state) the shipped Rebel passed 30/30
// with reveal:sabotage@naboo scoring 37 against pass at 0.5. The depth-2 trace
// showed a DIFFERENT failure from the Empire's:
//
//     reveal:sabotage@naboo   heur 37    v1 -233     deep -257
//     pass                    heur 0.5   v1 -234.5   deep -240.5
//
// The reveal LEADS at depth 1 and only loses after the greedy extension. Not
// sampling noise — a confident mispricing. Cause: `passedThisCommand` appeared
// NOWHERE in either evaluator, so a leader in the pool scored the same whether
// or not its owner had just forfeited the ability to use it. Passing was free.
//
// The fix charges for leaders the pass STRANDS (pooled, or committed to a
// face-down mission that can no longer be revealed). Leaders already on the
// board are not charged — they acted. It is a TEMPO cost, not a loss: the
// leaders return at Refresh, so the charge is a fraction of their worth.
//
// Weight swept on this fixture: 0/0.15/0.25 -> still 30/30 passes;
// 0.35/0.5/0.75/1.0 -> 0/30. Default 0.5 sits mid-range with margin either
// side. SWR_PASS_FORFEIT=0 restores the old blindness.
//
// Run: node scripts/test-pass-forfeit-charge-600.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const { evaluate, evalCommandStepDeep } = await import('../src/play/boardEval.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
});
const raw = readFileSync(join(ROOT, 'scripts/fixtures/passivity-600.json'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** The reported decision: rewind the Rebel's pass, put the Rebel on turn. */
const board = () => {
  const G = codec.decode(raw, catalog);
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Rebel');
  G.currentPlayer = 'Rebel';
  return G;
};

console.log('\n[ the fixture still reproduces the reported situation ]');
{
  const G = board();
  check('the Rebel really does hold leaders in the pool', G.rebel.leaderPool.length >= 2,
    JSON.stringify(G.rebel.leaderPool));
  check('and face-down missions it could still reveal',
    (G.rebel.leadersOnMissions ?? []).length >= 3, `${(G.rebel.leadersOnMissions ?? []).length} missions`);
  const acts = AI.bestCommandAction(G, 'Rebel').filter((a) => a.kind !== 'pass');
  check('a high-scoring play IS generated (this is not a dead board)',
    acts.some((a) => a.score >= 30), JSON.stringify(acts.map((a) => `${a.kind}:${a.score}`)));
}

console.log('\n[ the SHIPPED Rebel no longer forfeits this round ]');
{
  let passes = 0;
  for (let s = 1; s <= 30; s++) {
    const g = board(); AI.seedAI(s);
    const before = (g.turnLog ?? []).length;
    evalCommandStepDeep(g, 'Rebel', 2);
    const act = (g.turnLog ?? []).slice(before)
      .find((e) => ['pass', 'activate-system', 'reveal-mission'].includes(e.kind));
    if (act?.kind === 'pass') passes++;
    AI.unseedAI();
  }
  check('0 passes in 30 seeds (was 30/30)', passes === 0, `passed ${passes}/30`);
}

console.log('\n[ the charge is NARROW — structurally, not by tuning ]');
{
  const mk = () => codec.decode(raw, catalog);
  const delta = (mut) => {
    const a = mk(); mut(a); a.passedThisCommand = ['Rebel'];
    const b = mk(); mut(b); b.passedThisCommand = [];
    return evaluate(a, 'Rebel') - evaluate(b, 'Rebel');
  };
  // Nothing to strand -> no charge. This is what protects a side that MUST
  // pass (no leaders, no missions): it is charged exactly nothing.
  check('a side with no pooled leaders and no missions is charged 0',
    Math.abs(delta((g) => { g.rebel.leaderPool = []; g.rebel.leadersOnMissions = []; })) < 1e-9);
  // Leaders already deployed have acted; passing does not strand them.
  check('leaders already ON THE BOARD are not charged',
    Math.abs(delta((g) => {
      g.rebel.leaderPool = []; g.rebel.leadersOnMissions = [];
      g.rebel.leadersOnBoard = { naboo: ['princess-leia', 'general-madine'] };
    })) < 1e-9);
  // And on the real board the charge is big enough to matter.
  const real = delta(() => {});
  check('the reported board IS charged, and enough to close the 16.5 gap',
    real < -16.5, `delta ${real.toFixed(2)}`);
}

console.log('\n[ and it is symmetric — the opponent forfeiting is worth the same ]');
{
  const a = codec.decode(raw, catalog); a.passedThisCommand = ['Empire'];
  const b = codec.decode(raw, catalog); b.passedThisCommand = [];
  const d = evaluate(a, 'Rebel') - evaluate(b, 'Rebel');
  check('the Empire forfeiting improves the Rebel\'s evaluation', d > 0, `delta ${d.toFixed(2)}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
