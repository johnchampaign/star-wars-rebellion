// Guards for the learned leaf evaluator (#539 Phase 2): the weights file loads,
// the feature vector length matches the trained dimension, and the eval is
// near zero-sum (side-relative features → P(Rebel wins) + P(Empire wins) ≈ 1),
// which is the property that lets one weight vector serve both sides.
// Run: node scripts/test-learned-eval.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { evaluateLearned } = await import('../src/play/boardEval.ts');
const { boardFeatures, FEATURE_NAMES } = await import('../src/play/evalFeatures.ts');
const { LEAF_EVAL } = await import('../src/play/leafEvalWeights.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// P(win) recovered from the signed (P-0.5)*120 scale.
const pWin = (G, side) => evaluateLearned(G, side) / 120 + 0.5;

console.log('[ weights + dimensions ]');
check('weight vector length matches feature count', LEAF_EVAL.w.length === FEATURE_NAMES.length, `${LEAF_EVAL.w.length} vs ${FEATURE_NAMES.length}`);
check('mean/std lengths match', LEAF_EVAL.mean.length === FEATURE_NAMES.length && LEAF_EVAL.std.length === FEATURE_NAMES.length);

console.log('\n[ near zero-sum across several positions ]');
let worst = 0;
for (const seed of [1, 7, 13, 21, 33, 42]) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  const pr = pWin(G, 'Rebel'), pe = pWin(G, 'Empire');
  worst = Math.max(worst, Math.abs(pr + pe - 1));
  check(`seed ${seed}: P(Rebel)+P(Empire)≈1 (${pr.toFixed(2)}+${pe.toFixed(2)})`, Math.abs(pr + pe - 1) < 0.12, `sum=${(pr + pe).toFixed(3)}`);
}
check('worst zero-sum deviation < 0.12', worst < 0.12, `worst=${worst.toFixed(3)}`);

console.log('\n[ outputs in a sane range ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  const p = pWin(G, 'Empire');
  check('P(win) in (0,1)', p > 0 && p < 1, `p=${p}`);
  check('features are finite', boardFeatures(G, 'Empire').every(Number.isFinite));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
