// Position-level instrument for #718 part 2 ("the AI Rebel doesn't go straight
// for Utapau on turn 1") and part 4's cousin: WHAT does the AI Rebel open with?
//
// Reads the turn-1 exact human-Rebel positions from reports/human-decisions.jsonl
// and asks each Command policy what IT would do from that same board, so the
// AI's opener distribution is directly comparable to the human's on identical
// positions — no self-play confound, no fresh-game variance.
//
// Arms (--arm):
//   shipped  searchMctsCommand (MCTS + imitation ranker, the 2026-09-03 default)
//   eval     evalCommandStepDeep depth-2 (the Rebel rokhm1 played on 2026-08-15)
//   heur     the plain heuristic's top candidate
//
// Determinism: SWR_MCTS_MS is forced high so the pull loop is budget-bound, not
// wall-clock-bound (see tournament.mjs --deterministic). Budget stays at the
// shipped 64 unless SWR_MCTS_BUDGET is set.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const argOf = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const ARM = argOf('--arm', 'shipped');
const LIMIT = Number(argOf('--limit', '0'));
const TURN = argOf('--turn', '1') === 'any' ? null : Number(argOf('--turn', '1'));
const SIDE = argOf('--side', 'Rebel');
// --post-reveal: keep only positions where the Rebel base is REVEALED. This is
// the #539 cluster's instrument (#538/#690/#722/#708 — "the base is revealed and
// the Empire walks its force the wrong way"): on the same boards a WINNING human
// Empire faced, does the shipped Empire pick a move that closes on the base?
const POST_REVEAL = a.includes('--post-reveal');

// Must be set before mctsAI is imported: defaultConfig() reads env at import.
process.env.SWR_MCTS_MS ??= '600000';

const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });

let pick; // (G, side) -> {kind, missionId?, leaderId?, targetSystemId?} | null
if (ARM === 'shipped') {
  const mcts = await import('../src/play/mctsAI.ts');
  const ranker = await import('../src/play/candidateRanker.ts');
  console.log(`arm=shipped  mcts budget=${mcts.defaultConfig().budget} topK=${mcts.defaultConfig().topK} horizon=${mcts.defaultConfig().horizonRounds}  ranker=${ranker.RANKER_ENABLED} final=${ranker.RANKER_FINAL}`);
  pick = (G, side, seed) => { mcts.seedMCTS(seed); const r = mcts.searchMctsCommand(G, side); return r ? r.chosen : null; };
} else if (ARM === 'eval') {
  const { evalCommandStepDeep } = await import('../src/play/boardEval.ts');
  console.log('arm=eval (evalCommandStepDeep depth 2 — the pre-2026-09-02 shipped Rebel)');
  pick = (G, side) => { const before = G.turnLog.length; const ok = evalCommandStepDeep(G, side, 2); return ok ? actionFromLog(G, before) : null; };
} else if (ARM === 'heur') {
  console.log('arm=heur (plain heuristic top candidate)');
  pick = (G, side) => AI.bestCommandAction(G, side)[0] ?? null;
} else throw new Error(`unknown --arm '${ARM}' (shipped | eval | heur)`);

/** Recover the action a mutating policy took, from the events it appended. */
function actionFromLog(G, from) {
  for (let i = from; i < G.turnLog.length; i++) {
    const e = G.turnLog[i];
    if (e.kind === 'reveal-mission') return { kind: 'reveal', missionId: e.payload.missionId, targetSystemId: e.payload.targetSystemId };
    if (e.kind === 'activate-system') return { kind: 'activate', leaderId: e.payload.leaderId, targetSystemId: e.payload.targetSystemId };
    if (e.kind === 'pass') return { kind: 'pass' };
  }
  return null;
}

const norm = (x) => !x ? 'none'
  : x.kind === 'pass' ? 'pass'
  : x.kind === 'activate' || x.kind === 'activate-system' ? `activate @ ${x.targetSystemId}`
  : `${x.missionId} @ ${x.targetSystemId}`;
const sameMove = (x, h) => !x ? false
  : h.kind === 'pass' ? x.kind === 'pass'
  : h.kind === 'activate-system' ? ((x.kind === 'activate') && x.leaderId === h.leaderId && x.targetSystemId === h.targetSystemId)
  : ((x.kind === 'reveal') && x.missionId === h.missionId && x.targetSystemId === h.targetSystemId);

/** Hop distances from `origin` over the catalog adjacency (mirrors randomAI's
 *  private bfsDistances). */
function bfs(G, origin, maxHops = 12) {
  const dist = new Map([[origin, 0]]);
  let frontier = [origin];
  for (let d = 1; d <= maxHops; d++) {
    const next = [];
    for (const s of frontier) for (const n of (G.catalog.adjacency[s] ?? [])) if (!dist.has(n)) { dist.set(n, d); next.push(n); }
    frontier = next;
    if (!frontier.length) break;
  }
  return dist;
}

let rows = readFileSync(join(ROOT, 'reports', 'human-decisions.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.quality === 'exact' && r.humanSide === SIDE && (TURN === null || r.turn === TURN))
  .filter((r) => !POST_REVEAL || JSON.parse(r.state).state.rebelBaseRevealed);
if (LIMIT > 0) rows = rows.slice(0, LIMIT);

const aiCount = {}, humanCount = {}, aiKind = {}, humanKind = {};
let agree = 0, nulls = 0, aiUtapau = 0, humanUtapau = 0;
const distAI = [], distHuman = [], distAIact = [], distHumanAct = [];
const movedAI = []; let applyFailed = 0;
const t0 = Date.now();
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const G = codec.decode(r.state, catalog);
  AI.seedAI(1000 + i);
  let chosen = null;
  try { chosen = pick(G, SIDE, 1000 + i); } catch (e) { console.error(`  [${i}] policy threw: ${e.message}`); }
  if (!chosen) nulls++;
  const ak = norm(chosen), hk = norm(r.humanAction.kind === 'activate-system' ? { kind: 'activate', targetSystemId: r.humanAction.targetSystemId } : r.humanAction);
  aiCount[ak] = (aiCount[ak] || 0) + 1;
  humanCount[hk] = (humanCount[hk] || 0) + 1;
  const kindOf = (s) => s.startsWith('activate') ? 'activate' : s === 'pass' || s === 'none' ? s : 'reveal';
  aiKind[kindOf(ak)] = (aiKind[kindOf(ak)] || 0) + 1;
  humanKind[kindOf(hk)] = (humanKind[kindOf(hk)] || 0) + 1;
  if (sameMove(chosen, r.humanAction)) agree++;
  // What the activation actually DELIVERS. The reporters' complaint in the
  // #539 cluster is not only "wrong destination" but "activated my base space
  // to do nothing" (#538) — so apply the chosen action on this throwaway copy
  // and read the engine's own unitsMoved off the activate-system event.
  if (POST_REVEAL && chosen) {
    const before = G.turnLog.length;
    let ok = false;
    try { ok = chosen.kind === 'pass' ? false : AI.tryCommandAction(G, SIDE, chosen); } catch { ok = false; }
    if (ok) {
      for (let k = before; k < G.turnLog.length; k++) {
        const e = G.turnLog[k];
        if (e.kind === 'activate-system') { movedAI.push(e.payload.unitsMoved ?? 0); break; }
      }
    } else if (chosen.kind === 'activate') applyFailed++;
  }
  if (POST_REVEAL && G.rebelBaseSystemId) {
    const d = bfs(G, G.rebelBaseSystemId);
    const at = (x) => x && x.targetSystemId ? (d.get(x.targetSystemId) ?? 99) : null;
    const ad = at(chosen);
    const hd = at(r.humanAction.kind === 'activate-system' || r.humanAction.kind === 'reveal-mission' ? r.humanAction : null);
    if (ad !== null) { distAI.push(ad); if (chosen.kind === 'activate') distAIact.push(ad); }
    if (hd !== null) { distHuman.push(hd); if (r.humanAction.kind === 'activate-system') distHumanAct.push(hd); }
  }
  if (ak.includes('utapau')) aiUtapau++;
  if (hk.includes('utapau')) humanUtapau++;
  if ((i + 1) % 20 === 0) process.stderr.write(`  ${i + 1}/${rows.length} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
}

const pct = (n) => `${(100 * n / rows.length).toFixed(0)}%`;
const table = (c) => Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 12)
  .map(([k, n]) => `  ${String(n).padStart(4)}  ${pct(n).padStart(4)}  ${k}`).join('\n');
console.log(`\npositions: ${rows.length} exact human-${SIDE} turn-${TURN} openers   elapsed ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`\nHUMAN opener (what winning players actually did):\n${table(humanCount)}`);
console.log(`  kinds: ${JSON.stringify(humanKind)}   utapau-targeted: ${humanUtapau} (${pct(humanUtapau)})`);
console.log(`\nAI opener, arm=${ARM} (same positions):\n${table(aiCount)}`);
console.log(`  kinds: ${JSON.stringify(aiKind)}   utapau-targeted: ${aiUtapau} (${pct(aiUtapau)})`);
console.log(`\nexact agreement with the human's move: ${agree}/${rows.length} (${pct(agree)})   no-decision: ${nulls}`);
const top = Object.entries(aiCount).sort((x, y) => y[1] - x[1])[0];
console.log(`AI opener concentration: top opener ${top[0]} = ${pct(top[1])}; distinct openers ${Object.keys(aiCount).length} (human: ${Object.keys(humanCount).length})`);

if (POST_REVEAL) {
  const stat = (xs) => xs.length ? `n=${xs.length} mean=${(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2)} median=${xs.slice().sort((p, q) => p - q)[xs.length >> 1]} at-base=${xs.filter((x) => x === 0).length} within-1=${xs.filter((x) => x <= 1).length} far(>=3)=${xs.filter((x) => x >= 3).length}` : 'n=0';
  console.log(`\nHOPS FROM THE REVEALED BASE to the chosen target (lower = closing on the base):`);
  console.log(`  human, all moves : ${stat(distHuman)}`);
  console.log(`  AI,    all moves : ${stat(distAI)}`);
  console.log(`  human, activations only : ${stat(distHumanAct)}`);
  console.log(`  AI,    activations only : ${stat(distAIact)}`);
  if (movedAI.length) {
    const z = movedAI.filter((x) => x === 0).length, one = movedAI.filter((x) => x <= 1).length;
    const mean = (movedAI.reduce((s, x) => s + x, 0) / movedAI.length).toFixed(2);
    console.log(`\nWHAT THE AI's ACTIVATION ACTUALLY MOVED (engine's own unitsMoved):`);
    console.log(`  n=${movedAI.length}  mean=${mean}  moved 0 units: ${z} (${(100 * z / movedAI.length).toFixed(0)}%)  moved <=1: ${one} (${(100 * one / movedAI.length).toFixed(0)}%)  rejected-by-executor: ${applyFailed}`);
  }
}
