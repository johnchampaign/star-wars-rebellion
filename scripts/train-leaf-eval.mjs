// Train the LEARNED leaf evaluator (#539 Phase 2). Reads every v2 play log
// with a known outcome, extracts board features from each turn snapshot for
// BOTH perspectives (Rebel-features labeled rebelWon, Empire-features labeled
// !rebelWon — enforces symmetry and doubles the data), standardizes them, and
// fits an L2-regularized logistic regression by gradient descent. Emits
// src/play/leafEvalWeights.ts: a P(side wins) model that drops into
// boardEval.evaluateLearned. Holds out 15% of GAMES (not snapshots — snapshots
// within a game are correlated) for an honest accuracy/log-loss readout.
// Run: node scripts/train-leaf-eval.mjs [--l2 0.5] [--iters 400] [--lr 0.3]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { readGameLog, snapshotToCodec } = await import('./lib/log-reader.mjs');
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const { boardFeatures, FEATURE_NAMES } = await import('../src/play/evalFeatures.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = setup.buildCatalog(data);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? parseFloat(argv[i + 1]) : d; };
const L2 = flag('--l2', 0.5), ITERS = flag('--iters', 400), LR = flag('--lr', 0.3);

// ---- 1. Gather (features, label) per game, holding games out ----
const files = readdirSync(join(ROOT, 'logs')).filter((f) => f.endsWith('.json'));
const games = []; // { rows: [{x, y}], held }
let seed = 12345; const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let skipped = 0;
for (const f of files) {
  let g;
  try { g = readGameLog(join(ROOT, 'logs', f)); } catch { skipped++; continue; }
  const winner = g.winner;
  if (winner !== 'Rebel' && winner !== 'Empire') { skipped++; continue; }
  const rebelWon = winner === 'Rebel' ? 1 : 0;
  const rows = [];
  for (const snap of g.snapshots) {
    let G;
    try { G = codec.decode(snapshotToCodec(snap.state), catalog); } catch { continue; }
    if (G.isGameOver) continue; // terminal snapshots are trivially separable
    // Two examples per snapshot: each side's features vs its own win label.
    rows.push({ x: boardFeatures(G, 'Rebel'), y: rebelWon });
    rows.push({ x: boardFeatures(G, 'Empire'), y: 1 - rebelWon });
  }
  if (rows.length > 0) games.push({ rows, held: rng() < 0.15 });
}
const train = games.filter((g) => !g.held).flatMap((g) => g.rows);
const test = games.filter((g) => g.held).flatMap((g) => g.rows);
const D = FEATURE_NAMES.length;
console.log(`games ${games.length} (skipped ${skipped}) | train rows ${train.length} | test rows ${test.length} | features ${D}`);
if (train.length < 200) { console.error('too few training rows — is logs/ populated?'); process.exit(1); }

// ---- 2. Standardize (skip the bias column 0) ----
const mean = new Array(D).fill(0), std = new Array(D).fill(1);
for (let d = 1; d < D; d++) {
  let m = 0; for (const r of train) m += r.x[d]; m /= train.length;
  let v = 0; for (const r of train) v += (r.x[d] - m) ** 2; v /= train.length;
  mean[d] = m; std[d] = Math.sqrt(v) || 1;
}
const z = (x) => x.map((v, d) => (d === 0 ? 1 : (v - mean[d]) / std[d]));
const trainZ = train.map((r) => ({ x: z(r.x), y: r.y }));

// ---- 3. Logistic regression, batch GD with L2 (not on bias) ----
const sigmoid = (t) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, t))));
const dot = (w, x) => { let s = 0; for (let d = 0; d < D; d++) s += w[d] * x[d]; return s; };
let w = new Array(D).fill(0);
for (let it = 0; it < ITERS; it++) {
  const grad = new Array(D).fill(0);
  for (const r of trainZ) {
    const err = sigmoid(dot(w, r.x)) - r.y;
    for (let d = 0; d < D; d++) grad[d] += err * r.x[d];
  }
  for (let d = 0; d < D; d++) {
    grad[d] /= trainZ.length;
    if (d > 0) grad[d] += L2 * w[d] / trainZ.length; // ridge, skip bias
    w[d] -= LR * grad[d];
  }
}

// ---- 4. Metrics ----
const evalSet = (set) => {
  let ll = 0, correct = 0;
  for (const r of set) {
    const p = sigmoid(dot(w, z(r.x)));
    ll += -(r.y * Math.log(p + 1e-9) + (1 - r.y) * Math.log(1 - p + 1e-9));
    if ((p >= 0.5 ? 1 : 0) === r.y) correct++;
  }
  return { logloss: ll / set.length, acc: correct / set.length };
};
const trM = evalSet(train), teM = evalSet(test);
console.log(`train  logloss ${trM.logloss.toFixed(4)}  acc ${(trM.acc * 100).toFixed(1)}%`);
console.log(`test   logloss ${teM.logloss.toFixed(4)}  acc ${(teM.acc * 100).toFixed(1)}%  (held-out games)`);
console.log('\ntop feature weights (standardized magnitude):');
FEATURE_NAMES.map((n, d) => ({ n, w: w[d] })).filter((f) => f.n !== 'bias')
  .sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 12)
  .forEach((f) => console.log(`  ${f.w >= 0 ? '+' : ''}${f.w.toFixed(3)}  ${f.n}`));

// ---- 5. Emit weights ----
const out = `// AUTO-GENERATED by scripts/train-leaf-eval.mjs — do not hand-edit.
// Learned leaf evaluator (#539 Phase 2): logistic P(side wins) over
// evalFeatures.boardFeatures, standardized. Retrain after adding features.
// Trained on ${games.length} games; held-out test acc ${(teM.acc * 100).toFixed(1)}%, logloss ${teM.logloss.toFixed(4)}.
export const LEAF_EVAL = {
  mean: ${JSON.stringify(mean.map((x) => +x.toFixed(6)))},
  std: ${JSON.stringify(std.map((x) => +x.toFixed(6)))},
  w: ${JSON.stringify(w.map((x) => +x.toFixed(6)))},
};
`;
writeFileSync(join(ROOT, 'src/play/leafEvalWeights.ts'), out);
console.log('\nwrote src/play/leafEvalWeights.ts');
