// diag-pass-decompose.mjs — WHY does the search prefer pass?
//
// scripts/diag-pass-margin.mjs answered "does pass win on signal or on dice?"
// (answer: on signal, ~2 SE, consistently — see the ai-passivity note). This
// script answers the follow-up: WHICH TERM of the leaf value pays for it.
//
// It reimplements one MCTS arm loop (rollout + leafValue) on the reporters'
// captured boards, but records the leaf DECOMPOSED — board eval, information
// term, end-of-rollout time marker, own/enemy material, terminal outcome —
// for the `pass` arm and for the best non-pass arm. If pass wins on board eval
// it is a material/aggression question; if it wins on the info term it is the
// probe-accounting question; if it wins because its rollouts END LATER (more
// refreshes inside the same step budget) it is a horizon-accounting bug.
//
// Boards: any from-game issue with `canEncodeState: true` — save the
// **Game state** ```json block to a file.
//
// Run: node scripts/diag-pass-decompose.mjs <state.json> [Empire|Rebel]
//   ROLLS=12    rollouts per arm
//   SWR_MCTS_HORIZON=4 / SWR_MCTS_TOPK=12  as usual
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');
const boardEval = await import('../src/play/boardEval.ts');
const phases = await import('../src/engine/phases.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

const STATE = process.argv[2];
if (!STATE) { console.error('usage: node scripts/diag-pass-decompose.mjs <state.json> [Empire|Rebel]'); process.exit(2); }
const SIDE = process.argv[3] ?? 'Empire';
const ROLLS = Number(process.env.ROLLS ?? 12);
const HORIZON = Number(process.env.SWR_MCTS_HORIZON ?? 4);
const TOPK = Number(process.env.SWR_MCTS_TOPK ?? 12);
const FORFEIT = process.env.FORFEIT === '1';
const raw = readFileSync(STATE, 'utf8');

// The capture is taken just AFTER the pass — rewind the one bit passing changed.
const rewound = () => {
  const g = codec.decode(raw, setup.buildCatalog(data));
  g.passedThisCommand = (g.passedThisCommand ?? []).filter((x) => x !== SIDE);
  g.currentPlayer = SIDE;
  return g;
};

// Mirrors mctsAI.determinize — the search never rolls out the REAL base, it
// rolls out sampled worlds. Reproducing that matters: without it the rollout
// heuristic plays toward the true base and every arm saturates.
const pidBySystem = new Map();
const clone = (G) => {
  const { catalog, turnLog, ...rest } = G;
  const c = structuredClone(rest);
  c.catalog = catalog;
  c.turnLog = structuredClone(turnLog.filter((e) => e.kind !== 'state'));
  c.ephemeralSearchClone = true;
  return c;
};

const determinize = (c, sampled) => {
  const real = c.rebelBaseSystemId;
  if (!sampled || sampled === real) return;
  c.rebelBaseSystemId = sampled;
  const sPid = pidBySystem.get(sampled);
  const rPid = pidBySystem.get(real);
  if (sPid) {
    const i = c.probeDeck.indexOf(sPid);
    if (i >= 0) {
      const inHand = (c.empire.probeHand ?? []).includes(rPid ?? '');
      if (rPid && !inHand && !c.probeDeck.includes(rPid)) c.probeDeck[i] = rPid;
      else c.probeDeck.splice(i, 1);
    }
  }
};

// Mirrors mctsAI.rollout, but reports how it terminated and how much it spent.
const rollout = (c, horizonRounds) => {
  const endTM = c.timeMarker + horizonRounds;
  const stepCap = 220 * Math.max(1, horizonRounds);
  let steps = 0;
  while (!c.isGameOver && c.timeMarker < endTM && steps < stepCap) {
    const sd = c.currentPlayer;
    if (AI.stepOnce(c, sd)) { steps++; continue; }
    const o = sd === 'Rebel' ? 'Empire' : 'Rebel';
    if (AI.stepOnce(c, o)) { steps++; continue; }
    return { steps, why: 'stuck' };
  }
  return { steps, why: c.isGameOver ? 'over' : (steps >= stepCap ? 'stepcap' : 'horizon') };
};

const material = (c, side) => {
  let n = 0;
  for (const ss of Object.values(c.map.systems)) for (const u of ss.units) if (u.side === side) n++;
  return n;
};

// Mirrors mctsAI.leafValue, but returns the pieces.
const leafParts = (c, side, refWeight) => {
  if (c.winner === side) return { terminal: 1, ev: null, info: null, v: 1 };
  if (c.winner && c.winner !== side) return { terminal: 0, ev: null, info: null, v: 0 };
  const ev = boardEval.leafEvaluate(c, side);
  let info = 0;
  if (!c.rebelBaseRevealed) {
    const cand = mcts.baseCandidates(c);
    const w = mcts.beliefWeights(c, cand);
    let sum = 0; for (const sid of cand) sum += w.get(sid) ?? 1;
    info = (side === 'Empire' ? -1 : 1) * 2 * (sum / Math.max(1e-6, refWeight));
  }
  const v = ev + info;
  return { terminal: null, ev, info, v, squashed: 0.5 + 0.5 * (v / (Math.abs(v) + 60)) };
};

const root = rewound();
for (const [pid, p] of Object.entries(root.catalog.probes)) if (p?.systemId) pidBySystem.set(p.systemId, pid);
// The same belief-weighted world sample the real search draws, cycled by the
// arm's own pull index (common random numbers).
const worlds = (() => {
  if (root.rebelBaseRevealed || SIDE === 'Rebel') return [root.rebelBaseSystemId];
  const pool = mcts.baseCandidates(root);
  if (!pool.length) return [root.rebelBaseSystemId];
  mcts.seedMCTS(7);
  const w = mcts.beliefWeights(root, pool);
  const items = pool.map((sid) => ({ sid, w: w.get(sid) ?? 1 }));
  const out = [];
  const dets = Number(process.env.SWR_MCTS_DETS ?? 8);
  while (out.length < dets && items.length) {
    let total = 0; for (const it of items) total += it.w;
    let r = Math.random() * total, idx = items.length - 1;
    for (let i = 0; i < items.length; i++) { r -= items[i].w; if (r <= 0) { idx = i; break; } }
    out.push(items[idx].sid); items.splice(idx, 1);
  }
  return out;
})();

const refWeight = (() => {
  if (root.rebelBaseRevealed || SIDE === 'Rebel') return 1;
  const pool = mcts.baseCandidates(root);
  if (!pool.length) return 1;
  const w = mcts.beliefWeights(root, pool);
  let s = 0; for (const sid of pool) s += w.get(sid) ?? 1;
  return s / pool.length;
})();

const candidates = AI.bestCommandAction(root, SIDE).slice(0, TOPK);
const label = (a) => a.kind + (a.missionId ? `:${a.missionId}` : '') + (a.leaderId ? `:${a.leaderId}` : '') + (a.targetSystemId ? `@${a.targetSystemId}` : '');

console.log(`== ${basename(STATE)} side=${SIDE} tm=${root.timeMarker} revealed=${!!root.rebelBaseRevealed} horizon=${HORIZON} rolls=${ROLLS}`);
console.log(`   candidates=${candidates.length}: ${candidates.map(label).join(', ')}`);

const rows = [];
for (const a of candidates) {
  const acc = { n: 0, sq: 0, ev: 0, info: 0, endTM: 0, steps: 0, own: 0, enemy: 0, win: 0, loss: 0, term: 0, why: {} };
  for (let r = 0; r < ROLLS; r++) {
    mcts.seedMCTS(1000 + r); AI.seedAI(1000 + r);
    const c = clone(root);
    determinize(c, worlds[r % worlds.length]);
    let ok = false;
    try { ok = a.kind === 'pass' ? phases.pass(c, SIDE).ok : AI.tryCommandAction(c, SIDE, a); } catch { ok = false; }
    if (!ok) break;
    // FORFEIT=1: after the root action, end this side's round in EVERY arm, so
    // every arm shares the same continuation. If pass only wins without this,
    // it was winning by silencing the rollout policy, not on the board.
    if (FORFEIT && a.kind !== 'pass') { try { phases.pass(c, SIDE); } catch { /* not our turn */ } }
    let out;
    try { out = rollout(c, HORIZON); } catch { out = { steps: -1, why: 'throw' }; }
    const p = leafParts(c, SIDE, refWeight);
    acc.n++;
    acc.why[out.why] = (acc.why[out.why] ?? 0) + 1;
    acc.endTM += c.timeMarker; acc.steps += out.steps;
    acc.own += material(c, SIDE); acc.enemy += material(c, SIDE === 'Empire' ? 'Rebel' : 'Empire');
    if (p.terminal === 1) { acc.win++; acc.term++; acc.sq += 1; }
    else if (p.terminal === 0) { acc.loss++; acc.term++; acc.sq += 0; }
    else { acc.ev += p.ev; acc.info += p.info; acc.sq += p.squashed; }
  }
  if (!acc.n) continue;
  const nonTerm = Math.max(1, acc.n - acc.term);
  rows.push({
    action: label(a), score: Math.round(a.score * 10) / 10, n: acc.n,
    mc: +(acc.sq / acc.n).toFixed(4),
    ev: +(acc.ev / nonTerm).toFixed(2), info: +(acc.info / nonTerm).toFixed(2),
    endTM: +(acc.endTM / acc.n).toFixed(2), steps: Math.round(acc.steps / acc.n),
    own: +(acc.own / acc.n).toFixed(1), enemy: +(acc.enemy / acc.n).toFixed(1),
    W: acc.win, L: acc.loss, why: Object.entries(acc.why).map(([k, v]) => `${k}:${v}`).join(' '),
  });
}
rows.sort((p, q) => q.mc - p.mc);
for (const r of rows) console.log('   ', JSON.stringify(r));

const pass = rows.find((r) => r.action === 'pass');
const best = rows.find((r) => r.action !== 'pass');
if (pass && best) {
  console.log(`   >> pass mc=${pass.mc} vs best-action ${best.action} mc=${best.mc}  gap=${(pass.mc - best.mc).toFixed(4)}`);
  console.log(`   >> decompose: d_ev=${(pass.ev - best.ev).toFixed(2)} d_info=${(pass.info - best.info).toFixed(2)} d_endTM=${(pass.endTM - best.endTM).toFixed(2)} d_own=${(pass.own - best.own).toFixed(1)} d_enemy=${(pass.enemy - best.enemy).toFixed(1)}`);
}
