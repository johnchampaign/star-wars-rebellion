// Imitation ranker trainer (docs/imitation-plan.md, step 2).
//
// Input : reports/human-decisions.jsonl from mine-human-decisions.mjs — exact
//         positions where the human moved first, plus the action they chose.
// Model : pairwise logistic ranker over candidateFeatures — for each position,
//         P(human's candidate beats candidate c) = σ(w·(f_h − f_c)). Plain SGD,
//         L2, standardised features. No dependencies.
// Split : by gameId (hash), 80/20, so held-out positions come from unseen games.
// Output: src/play/rankerWeights.json (names, mean, std, w, metrics) — read by
//         candidateRanker.ts at runtime. Metrics printed: held-out top-1 /
//         top-3 for the heuristic's own ordering vs the ranker's.
//
// Usage: node scripts/train-ranker.mjs [--k 4] [--epochs 40] [--l2 1e-3] [--seed 1]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const K = Number(arg('--k', 4)), EPOCHS = Number(arg('--epochs', 40)), L2 = Number(arg('--l2', 1e-3)), SEED = Number(arg('--seed', 1));
process.env.SWR_CAND_K = String(K); // widen generation before the AI module loads

const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const AI = await import('../src/play/randomAI.ts');
const F = await import('../src/play/candidateFeatures.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });

// ---- build (position → candidates → features, label) ----
const rows = readFileSync(join(ROOT, 'reports', 'human-decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.quality === 'exact');
const same = (ha, c) => ha.kind === 'pass' ? c.kind === 'pass'
  : ha.kind === 'activate-system' ? (c.kind === 'activate' && c.leaderId === ha.leaderId && c.targetSystemId === ha.targetSystemId)
  : (c.kind === 'reveal' && c.missionId === ha.missionId && c.targetSystemId === ha.targetSystemId);
let names = null; const positions = []; const sides = new Set();
for (const r of rows) {
  let G; try { G = codec.decode(r.state, catalog); } catch { continue; }
  AI.seedAI(1);
  const cands = AI.bestCommandAction(G, r.humanSide);
  const hi = cands.findIndex((c) => same(r.humanAction, c));
  if (hi < 0) continue; // human's move not generated even at K — unrankable
  if (!names) names = F.featureNames(G);
  const ctx = F.positionContext(G, r.humanSide, cands.length);
  sides.add(r.humanSide);
  positions.push({ gameId: r.gameId, hi, X: cands.map((c, i) => F.candidateFeatures(G, ctx, c, i)) });
}
const hash = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
const train = positions.filter((p) => (hash(p.gameId + SEED) % 5) !== 0), test = positions.filter((p) => (hash(p.gameId + SEED) % 5) === 0);
console.log(`positions with the human move generated at K=${K}: ${positions.length}/${rows.length}  (train ${train.length}, held-out ${test.length} by game)`);

// ---- standardise on train ----
const D = names.length; const mean = new Array(D).fill(0), std = new Array(D).fill(0); let n = 0;
for (const p of train) for (const x of p.X) { n++; for (let d = 0; d < D; d++) mean[d] += x[d]; }
for (let d = 0; d < D; d++) mean[d] /= Math.max(1, n);
for (const p of train) for (const x of p.X) for (let d = 0; d < D; d++) std[d] += (x[d] - mean[d]) ** 2;
for (let d = 0; d < D; d++) std[d] = Math.sqrt(std[d] / Math.max(1, n)) || 1;
const z = (x) => x.map((v, d) => (v - mean[d]) / std[d]);
for (const p of [...train, ...test]) p.Z = p.X.map(z);

// ---- pairwise logistic SGD ----
let rng = SEED >>> 0; const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };
const w = new Array(D).fill(0);
const dot = (a, b) => { let s = 0; for (let d = 0; d < D; d++) s += a[d] * b[d]; return s; };
for (let ep = 0; ep < EPOCHS; ep++) {
  const lr = 0.05 / (1 + ep * 0.1);
  const order = [...train].sort(() => rand() - 0.5);
  for (const p of order) {
    const fh = p.Z[p.hi];
    for (let c = 0; c < p.Z.length; c++) {
      if (c === p.hi) continue;
      const diff = fh.map((v, d) => v - p.Z[c][d]);
      const s = 1 / (1 + Math.exp(-dot(w, diff)));
      const g = (1 - s); // gradient of -log σ(w·diff)
      for (let d = 0; d < D; d++) w[d] += lr * (g * diff[d] - L2 * w[d]);
    }
  }
}

// ---- evaluate ----
function evalSet(set, scoreFn, label) {
  let t1 = 0, t3 = 0;
  for (const p of set) {
    const order = p.Z.map((zv, i) => [scoreFn(zv, i), i]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
    const r = order.indexOf(p.hi); if (r === 0) t1++; if (r < 3) t3++;
  }
  console.log(`  ${label.padEnd(30)} n=${set.length}  top-1 ${(100 * t1 / set.length).toFixed(1)}%  top-3 ${(100 * t3 / set.length).toFixed(1)}%`);
  return { top1: t1 / set.length, top3: t3 / set.length };
}
console.log('\nheld-out (unseen games):');
const base = evalSet(test, (zv, i) => -i, 'heuristic order (baseline)');
const rk = evalSet(test, (zv) => dot(w, zv), 'ranker');
console.log('train (for overfit check):');
evalSet(train, (zv, i) => -i, 'heuristic order (baseline)');
evalSet(train, (zv) => dot(w, zv), 'ranker');

// ---- top weights, for eyeballing what it learned ----
const top = names.map((nm, d) => [nm, w[d]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 14);
console.log('\nlargest weights (standardised):'); for (const [nm, v] of top) console.log(`  ${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}  ${nm}`);

writeFileSync(join(ROOT, 'src', 'play', 'rankerWeights.json'), JSON.stringify({
  trainedAt: new Date().toISOString(), k: K, epochs: EPOCHS, l2: L2, seed: SEED, sides: [...sides].sort(), names, mean, std, w,
  metrics: { heldOut: { positions: test.length, baseline: base, ranker: rk }, trainPositions: train.length },
}, null, 0) + '\n');
console.log('\nwrote src/play/rankerWeights.json');
