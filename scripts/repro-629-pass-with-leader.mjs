// #629 — "The empire player passed with a leader left in the pool and fleets
// that can still be moved." Replays the reporter's EXACT board.
//
// The attached state is captured just AFTER the pass, so we rewind the one bit
// passing changed (passedThisCommand / currentPlayer) to recover the position
// the AI actually faced, then re-run the Command decision and dump every arm.
//
// The report's own log line already tells us this is NOT a candidate-generation
// problem — the alternatives were enumerated and MCTS still preferred pass:
//   chose {"kind":"pass","score":0.5,"mc":0.85}
//   alts  [{"kind":"reveal","missionId":"gather-intel","score":28,"mc":0.76}, {"kind":"activate", ...}]
// pass carried a HIGHER rollout mean than a score-28 reveal, and the near-tie
// pass-margin rule (SWR_MCTS_PASS_MARGIN, default 0.05) doesn't fire on a
// 0.09 gap. So the question this script answers is whether that 0.85 is real.
//
// Run: node scripts/repro-629-pass-with-leader.mjs [path-to-state.json]
//   SWR_MCTS_BUDGET / _DETS / _HORIZON override the search config.
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

const STATE = process.argv[2] ?? join(ROOT, 'reports', '629-state.json');
const raw = readFileSync(STATE, 'utf8');
const G = codec.decode(raw, setup.buildCatalog(data));

console.log(`loaded: turn ${G.timeMarker}, phase ${G.phase}, currentPlayer ${G.currentPlayer}`);
console.log(`passedThisCommand: ${JSON.stringify(G.passedThisCommand)}`);

// Rewind the pass. Passing mutates nothing else, so this IS the pre-pass board.
G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Empire');
G.currentPlayer = 'Empire';

const f = G.empire;
const tacticLeaders = f.leaderPool.filter((lid) => {
  const l = G.catalog.leaders[lid];
  return l && (l.tacticValues.space + l.tacticValues.ground) > 0;
});
console.log(`\nEmpire pool: ${JSON.stringify(f.leaderPool)}  (tactic-capable: ${JSON.stringify(tacticLeaders)})`);
console.log(`Empire face-down missions: ${JSON.stringify((f.leadersOnMissions ?? []).map((m) => m.missionId))}`);

// What the generator offers.
AI.seedAI(1);
const acts = AI.bestCommandAction(G, 'Empire');
console.log(`\ncandidates generated: ${acts.length}`);
for (const a of acts) {
  const what = a.kind === 'reveal' ? `reveal ${a.missionId} -> ${a.targetSystemId}`
    : a.kind === 'activate' ? `activate ${a.targetSystemId} with ${a.leaderId}`
    : 'pass';
  console.log(`   score ${String(a.score).padStart(6)}   ${what}`);
}
const nonPass = acts.filter((a) => a.kind !== 'pass');
console.log(nonPass.length
  ? `\n=> ${nonPass.length} real action(s) were available; passing forfeits all of them.`
  : '\n=> NOTHING was available — passing would be correct here.');

// What the search does with them — across MANY seeds. One run is a single
// deterministic sample, and the reporter only ever saw one. The question that
// matters is how OFTEN this position passes, which is also a direct read on
// whether the search is resourced enough to decide it at all.
const desc = (a) => a.kind === 'reveal' ? `reveal ${a.missionId}->${a.targetSystemId}`
  : a.kind === 'activate' ? `activate ${a.targetSystemId}/${a.leaderId}` : 'pass';
const SEEDS = Number(process.env.SEEDS ?? 30);
const tally = new Map();
let passes = 0;
for (let s = 1; s <= SEEDS; s++) {
  // Re-decode per seed: searchMctsCommand is pure, but the AI RNG is global and
  // a stale G could carry incidental mutation between runs.
  const g = codec.decode(raw, setup.buildCatalog(data));
  g.passedThisCommand = (g.passedThisCommand ?? []).filter((x) => x !== 'Empire');
  g.currentPlayer = 'Empire';
  AI.seedAI(s);
  mcts.seedMCTS?.(s);
  const r = mcts.searchMctsCommand(g, 'Empire');
  if (!r) continue;
  const k = desc(r.chosen);
  tally.set(k, (tally.get(k) ?? 0) + 1);
  if (r.chosen.kind === 'pass') passes++;
}
console.log(`\n=== ${SEEDS} independent searches on this ONE position ===`);
for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(3)} (${(100 * n / SEEDS).toFixed(0).padStart(3)}%)  ${k}`);
}
console.log(`\nPASSED in ${passes}/${SEEDS} searches (${(100 * passes / SEEDS).toFixed(0)}%)` +
  ` — with ${nonPass.length} real actions on the table.`);
