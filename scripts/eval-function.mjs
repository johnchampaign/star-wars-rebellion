// Evaluation-function viability probe.
//
// The heuristic AI is greedy (scores immediate actions). Search / lookahead needs
// a POSITION evaluator: given a mid-game state, how likely is each side to win?
// This script tests whether a SIMPLE feature set + logistic regression can predict
// the eventual winner from a position — and from how early in the game. If yes, an
// eval function is viable (and improves greedy play on its own); if only the clock
// predicts late, it adds little.
//
// Labeled data is generated from self-play (snapshot features each round, label =
// did Empire win). Drift-free and unlimited. Log-calibration is a later refinement.
//
// Usage: node scripts/eval-function.mjs [games]
import { readFileSync } from 'node:fs';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(new URL('../assets/' + p, import.meta.url), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const GAMES = parseInt(process.argv[2] ?? '150', 10);

function hops(G, from, max) {
  const dist = { [from]: 0 }; let frontier = [from];
  for (let d = 1; d <= max; d++) { const next = []; for (const s of frontier) for (const a of (G.catalog.adjacency[s] ?? [])) if (dist[a] === undefined) { dist[a] = d; next.push(a); } frontier = next; }
  return dist;
}
const FEATURES = ['repMargin', 'timeMarker', 'baseRevealed', 'baseCandidates',
  'empGround', 'empSpace', 'rebGround', 'rebSpace', 'subjugated', 'captures', 'empGroundNearBase'];
function features(G) {
  let empGround = 0, empSpace = 0, rebGround = 0, rebSpace = 0;
  const ground = (tid) => { const t = G.catalog.unitTypes[tid]; return t && t.theater === 'ground' && t.class !== 'structure'; };
  for (const ss of Object.values(G.map.systems)) for (const u of ss.units) {
    const g = ground(u.typeId);
    if (u.side === 'Empire') { if (g) empGround++; else empSpace++; }
    else if (u.side === 'Rebel') { if (g) rebGround++; else rebSpace++; }
  }
  let subjugated = 0; for (const ss of Object.values(G.map.systems)) if (ss.subjugated) subjugated++;
  const captures = (G.empire.capturedLeaders ?? []).length;
  const ruledOut = new Set((G.empire.probeHand ?? []).map((pid) => G.catalog.probes[pid]?.systemId).filter(Boolean));
  let baseCandidates = 0;
  if (!G.rebelBaseRevealed) for (const sid of Object.keys(G.map.systems)) { if (sid === 'coruscant') continue; if (!ruledOut.has(sid)) baseCandidates++; }
  let empGroundNearBase = 0;
  if (G.rebelBaseRevealed && G.rebelBaseSystemId) {
    const d = hops(G, G.rebelBaseSystemId, 2);
    for (const [sid, ss] of Object.entries(G.map.systems)) if (d[sid] !== undefined) for (const u of ss.units) if (u.side === 'Empire' && ground(u.typeId)) empGroundNearBase++;
  }
  return [G.reputationMarker - G.timeMarker, G.timeMarker, G.rebelBaseRevealed ? 1 : 0, baseCandidates,
    empGround, empSpace, rebGround, rebSpace, subjugated, captures, empGroundNearBase];
}

// ---- generate labeled samples from self-play ----
const samples = []; // {x, y, game, stage}
let empWins = 0, games = 0;
for (let i = 0; i < GAMES; i++) {
  const seed = 9000 + i; seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: false });
  let s = 0; while (G.phase === 'Setup' && s++ < 100) { if (!aiStep(G, G.currentPlayer)) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!aiStep(G, o)) { phases.setupAutoFill(G, 'Rebel'); phases.setupAutoFill(G, 'Empire'); } } }
  const snaps = []; let lastTime = -1, st = 0;
  while (!G.isGameOver && st < 200000) {
    if (G.timeMarker !== lastTime) { lastTime = G.timeMarker; snaps.push({ x: features(G), t: G.timeMarker }); }
    const sd = G.currentPlayer; if (aiStep(G, sd)) { st++; continue; }
    const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (aiStep(G, o)) { st++; continue; } break;
  }
  if (!G.isGameOver && G.timeMarker > 16) G.isGameOver = true;
  const y = G.winner === 'Empire' ? 1 : 0; if (y) empWins++; games++;
  for (const sn of snaps) samples.push({ x: sn.x, y, game: i, stage: sn.t });
}

// ---- standardize ----
const n = FEATURES.length;
const mu = Array(n).fill(0), sd = Array(n).fill(0);
for (const s of samples) for (let k = 0; k < n; k++) mu[k] += s.x[k];
for (let k = 0; k < n; k++) mu[k] /= samples.length;
for (const s of samples) for (let k = 0; k < n; k++) sd[k] += (s.x[k] - mu[k]) ** 2;
for (let k = 0; k < n; k++) sd[k] = Math.sqrt(sd[k] / samples.length) || 1;
const z = (x) => x.map((v, k) => (v - mu[k]) / sd[k]);

// ---- train/test split by GAME (no leakage) ----
const train = samples.filter((s) => s.game % 5 !== 0);
const test = samples.filter((s) => s.game % 5 === 0);
const sigmoid = (t) => 1 / (1 + Math.exp(-t));
function fit(rows, featIdx) {
  let w = Array(featIdx.length).fill(0), b = 0; const lr = 0.1;
  for (let ep = 0; ep < 400; ep++) {
    const gw = Array(featIdx.length).fill(0); let gb = 0;
    for (const r of rows) { const zx = z(r.x); let t = b; for (let k = 0; k < featIdx.length; k++) t += w[k] * zx[featIdx[k]]; const p = sigmoid(t); const e = p - r.y; for (let k = 0; k < featIdx.length; k++) gw[k] += e * zx[featIdx[k]]; gb += e; }
    for (let k = 0; k < featIdx.length; k++) w[k] -= lr * gw[k] / rows.length; b -= lr * gb / rows.length;
  }
  return { w, b, featIdx };
}
const predict = (m, x) => { const zx = z(x); let t = m.b; for (let k = 0; k < m.featIdx.length; k++) t += m.w[k] * zx[m.featIdx[k]]; return sigmoid(t); };
function metrics(m, rows) {
  let ll = 0; const pos = [], neg = [];
  for (const r of rows) { const p = Math.min(1 - 1e-9, Math.max(1e-9, predict(m, r.x))); ll += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p)); (r.y ? pos : neg).push(p); }
  // AUC via Mann-Whitney.
  let win = 0; for (const pp of pos) for (const np of neg) win += pp > np ? 1 : pp === np ? 0.5 : 0;
  const auc = pos.length && neg.length ? win / (pos.length * neg.length) : 0.5;
  return { logloss: ll / rows.length, auc, n: rows.length };
}

const baseRate = empWins / games;
console.log(`Self-play: ${games} games (Empire win ${(100 * baseRate).toFixed(0)}%), ${samples.length} position snapshots.`);
console.log(`Predicting P(Empire wins) from a position. AUC 0.5 = useless, 1.0 = perfect.\n`);
const all = [...FEATURES.keys()];
const full = fit(train, all);
const clockOnly = fit(train, [0]); // repMargin only
const mFull = metrics(full, test), mClock = metrics(clockOnly, test);
console.log(`Baseline (clock / reputation-margin only):  AUC ${mClock.auc.toFixed(3)}   logloss ${mClock.logloss.toFixed(3)}`);
console.log(`Full feature model:                          AUC ${mFull.auc.toFixed(3)}   logloss ${mFull.logloss.toFixed(3)}`);
console.log(`\nAUC by game stage (full model, test set):`);
for (const [lo, hi, lbl] of [[1, 3, 'early (rd 1-3)'], [4, 6, 'mid (rd 4-6)'], [7, 16, 'late (rd 7+)']]) {
  const rows = test.filter((r) => r.stage >= lo && r.stage <= hi);
  if (rows.length > 20) console.log(`  ${lbl.padEnd(16)} AUC ${metrics(full, rows).auc.toFixed(3)}  (n=${rows.length})`);
}
console.log(`\nStandardized feature weights (|w| = importance, sign = direction toward Empire win):`);
const wr = full.featIdx.map((fi, k) => ({ f: FEATURES[fi], w: full.w[k] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
for (const r of wr) console.log(`  ${r.f.padEnd(18)} ${r.w >= 0 ? '+' : ''}${r.w.toFixed(2)}`);
