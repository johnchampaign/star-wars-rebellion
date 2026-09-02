// @timeout 300000
// The imitation ranker (docs/imitation-plan.md step 2): candidateRanker.ts
// re-orders the heuristic's Command candidates by a model trained on the
// recorded human decisions (scripts/train-ranker.mjs), and the MCTS root
// explores in that order. Default OFF (SWR_RANKER=1 / ?ranker=1).
//
// Pins: the shipped weights match this catalog's feature layout (a catalog
// change must disable, never misalign); the lever really is off by default
// and really re-orders when on; the recorded held-out metrics beat the
// heuristic by a margin (so a bad retrain cannot be committed quietly); the
// MCTS root is wired; and generation width follows the lever.
//
// Run: node scripts/test-imitation-ranker.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const { createGame } = setup;
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = setup.buildCatalog(data);
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Child mode: report ordering with the lever ON for one position.
if (process.env.RANKER_TEST_CHILD === '1') {
  const AI = await import('../src/play/randomAI.ts');
  const R = await import('../src/play/candidateRanker.ts');
  // A real mid-game Rebel position with reveals AND activations on offer
  // (the #600 reporter's board, committed as a fixture). A fresh setup board
  // has a single candidate and cannot show a re-ordering.
  const raw0 = readFileSync(join(ROOT, 'scripts/fixtures/passivity-600.json'), 'utf8');
  const G = codec.decode(raw0, catalog);
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((x) => x !== 'Rebel'); G.currentPlayer = 'Rebel';
  AI.seedAI(1);
  const raw = AI.bestCommandAction(G, 'Rebel');
  const ranked = R.rankCandidates(G, 'Rebel', raw);
  const key = (c) => `${c.kind}:${c.missionId ?? c.leaderId ?? ''}@${c.targetSystemId ?? ''}`;
  // Empire side on a real Empire board: must be untouched while the model has no Empire data.
  const GE = codec.decode(readFileSync(join(ROOT, 'scripts/fixtures/passivity-580.json'), 'utf8'), catalog);
  GE.passedThisCommand = (GE.passedThisCommand ?? []).filter((x) => x !== 'Empire'); GE.currentPlayer = 'Empire';
  AI.seedAI(1); const rawE = AI.bestCommandAction(GE, 'Empire'); const rankedE = R.rankCandidates(GE, 'Empire', rawE);
  const pri = R.rankerPriors(G, 'Rebel', raw); const priE = R.rankerPriors(GE, 'Empire', rawE);
  console.log(JSON.stringify({ enabled: R.RANKER_ENABLED, usable: R.rankerUsable(G), raw: raw.map(key), ranked: ranked.map(key), k: raw.length,
    priors: pri, priorsEmpire: priE, rankedTop: ranked[0] ? key(ranked[0]) : null, priorTop: pri ? key(raw[pri.indexOf(Math.max(...pri))]) : null,
    empireUntouched: JSON.stringify(rawE.map(key)) === JSON.stringify(rankedE.map(key)), empireK: rawE.length }));
  process.exit(0);
}

const W = JSON.parse(readFileSync(join(ROOT, 'src/play/rankerWeights.json'), 'utf8'));

console.log('[ the shipped weights match this catalog ]');
{
  const F = await import('../src/play/candidateFeatures.ts');
  const G = createGame(data, { seed: 3, autoSetupUnits: true });
  const names = F.featureNames(G);
  check('feature layout unchanged since training', names.length === W.names.length && names.every((n, i) => n === W.names[i]),
    `${names.length} vs ${W.names.length} features — retrain with scripts/train-ranker.mjs`);
  check('weights/mean/std are the same length as the names', W.w.length === names.length && W.mean.length === names.length && W.std.length === names.length);
}

console.log('[ the recorded held-out metrics beat the heuristic by a margin ]');
{
  const m = W.metrics?.heldOut;
  check('held-out set is by unseen games and non-trivial', (m?.positions ?? 0) >= 80, JSON.stringify(m));
  check('ranker top-3 exceeds heuristic top-3 by at least 15 points', (m?.ranker?.top3 ?? 0) >= (m?.baseline?.top3 ?? 1) + 0.15,
    `ranker ${((m?.ranker?.top3 ?? 0) * 100).toFixed(1)}% vs baseline ${((m?.baseline?.top3 ?? 0) * 100).toFixed(1)}%`);
  check('and top-1 at least triples it', (m?.ranker?.top1 ?? 0) >= 3 * (m?.baseline?.top1 ?? 1),
    `ranker ${((m?.ranker?.top1 ?? 0) * 100).toFixed(1)}% vs baseline ${((m?.baseline?.top1 ?? 0) * 100).toFixed(1)}%`);
}

console.log('[ the lever: off by default, re-orders when on ]');
{
  const run = (env) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, RANKER_TEST_CHILD: '1', ...env }, encoding: 'utf8' }).trim().split('\n').pop());
  const off = run({ SWR_RANKER: '0' });
  const on = run({ SWR_RANKER: '1' });
  check('default: ranker off, candidates untouched', !off.enabled && JSON.stringify(off.raw) === JSON.stringify(off.ranked));
  check('on: ranker enabled and usable on this catalog', on.enabled && on.usable);
  check('on: generation widened to K=4 (more candidates than at K=1)', on.k > off.k, `${on.k} vs ${off.k}`);
  check('on: the order actually changes (non-vacuous)', JSON.stringify(on.raw) !== JSON.stringify(on.ranked), 'ranker returned the heuristic order');
  check('on: it is a permutation, not a filter', on.ranked.length === on.raw.length && [...on.ranked].sort().join() === [...on.raw].sort().join());
  check('on: the Empire is left in heuristic order (model trained on Rebel data only)', on.empireUntouched && on.empireK >= 2, `k=${on.empireK}`);
  check('weights record the sides they cover', Array.isArray(W.sides) && W.sides.includes('Rebel') && !W.sides.includes('Empire'), JSON.stringify(W.sides));
  check('off: no priors', off.priors === null);
  check('on: priors form a distribution over the candidates', Array.isArray(on.priors) && on.priors.length === on.k && Math.abs(on.priors.reduce((a, b) => a + b, 0) - 1) < 1e-6 && on.priors.every((p) => p > 0));
  check('on: the prior\'s top arm is the ranker\'s top candidate', on.priorTop === on.rankedTop, `${on.priorTop} vs ${on.rankedTop}`);
  check('on: no priors for the Empire (side not covered)', on.priorsEmpire === null);
  const on2 = run({ SWR_RANKER: '1' });
  check('on: deterministic', JSON.stringify(on.ranked) === JSON.stringify(on2.ranked));
}

console.log('[ the MCTS root is wired ]');
{
  const src = readFileSync(join(ROOT, 'src/play/mctsAI.ts'), 'utf8');
  check('rankCandidates wraps bestCommandAction before the topK cut', /rankCandidates\(G, side, bestCommandAction\(G, side\)\)\.slice\(0, conf\.topK\)/.test(src));
  check('the prior steers PULLS: a PUCT term in the selection rule', /RANKER_PRIOR_W \* priors\[arms\.indexOf\(x\)\] \* Math\.sqrt\(pulls \+ 1\) \/ \(1 \+ x\.n\)/.test(src));
  check('and can cut the root to the ranker\'s top-N arms', /RANKER_TOPK > 0 && candidates\.length > RANKER_TOPK/.test(src));
  check('the trace records whether the search followed the prior', /rankerTop:/.test(src));
  check('the prior can enter the FINAL pick (λ blend or most-visited)', /RANKER_FINAL === 'visits'/.test(src) && /lam \* priorOf\(y\)/.test(src));
  check('and the default final pick is unchanged (argmax mean)', /else alive\.sort\(\(x, y\) => y\.sum \/ y\.n - x\.sum \/ x\.n\)/.test(src));
  const pt = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
  check('the worker is constructed in the literal form Vite can bundle', /new Worker\(new URL\('\.\/mctsWorker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/.test(pt));
  check('and the ranker flag travels in the search message', /flags: \{ ranker: RANKER_ENABLED \}/.test(pt));
  const wk = readFileSync(join(ROOT, 'src/play/mctsWorker.ts'), 'utf8');
  check('the worker applies the forwarded flag before searching', /setRankerEnabled\(!!flags\?\.ranker\)/.test(wk));
  const ai = readFileSync(join(ROOT, 'src/play/randomAI.ts'), 'utf8');
  check('the rollout policy can follow the ranker (SWR_RANKER_ROLLOUT), default off',
    /RANKER_ROLLOUT \? rankCandidates\(G, side, bestCommandAction\(G, side\)\) : bestCommandAction\(G, side\)/.test(ai));
  check('generation width follows the ranker lever (runtime flag)', /return isRankerEnabled\(\) \? 4 : 1;/.test(ai));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
