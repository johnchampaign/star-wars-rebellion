// diag-pass-margin.mjs — INSTRUMENTATION for the "AI passed with plays on the
// table" cluster (#705 #706 #702 #695 #629 #617 #600 #581 #580 #649 #516).
//
// scripts/repro-629-pass-with-leader.mjs answers "were actions available?" and
// "how often does this board pass?". It does NOT answer the question that
// decides where the fix goes: when pass wins, does it win on SIGNAL or on the
// dice? The pass guard in mctsAI.ts is two hand-picked constants (0.05 for
// activations, 0.15 for reveals) standing in for the search's sampling error,
// and until mctsAI tracked per-arm sum-of-squares nothing could check whether
// those constants were wider or narrower than the noise they guard.
//
// This replays ONE captured board across many seeds and prints, per seed, the
// pass-vs-best-action gap alongside the measured standard error of that
// difference (the `passGuard` field mctsAI now writes into every trace):
//
//   gap >> se   the search genuinely prefers pass    -> LEAF EVAL question
//   gap ~  se   pass is winning a coin flip          -> GUARD question
//
// FIRST READING (#705's board, 20 seeds, default budget 64):
//   se 0.028-0.044, gap 0.018-0.085, passes 30% of seeds.
// The gap runs to ~2 SE, so the 0.05 activation margin is NOT swamped by noise
// the way the reveal margin was in #649 — on that board the search really does
// rate forfeiting the round above every alternative. That points at the leaf
// evaluation (a forfeited Command round costs a pool leader AND every committed
// mission, per RR "when a player passes, he cannot use his leaders to reveal
// missions or activate systems for the rest of this Command Phase"), not at the
// guard. Recorded here so the next attempt starts from the measurement.
//
// Getting a board: every from-game issue with `canEncodeState: true` carries a
// **Game state** ```json block — save it to a file and pass it in.
//
// Run: node scripts/diag-pass-margin.mjs <state.json> [Empire|Rebel]
//   SEEDS=20                 how many independent searches
//   SWR_MCTS_PASS_Z=100      A/B: add 1.0*SE as a floor under the margins
//   SWR_MCTS_BUDGET/_DETS/_HORIZON as usual
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

const STATE = process.argv[2];
if (!STATE) { console.error('usage: node scripts/diag-pass-margin.mjs <state.json> [Empire|Rebel]'); process.exit(2); }
const SIDE = process.argv[3] ?? 'Empire';
const SEEDS = Number(process.env.SEEDS ?? 20);
const raw = readFileSync(STATE, 'utf8');

// The capture is taken just AFTER the pass, so rewind the one bit passing
// changed to recover the position the AI actually faced.
const rewound = () => {
  const g = codec.decode(raw, setup.buildCatalog(data));
  g.passedThisCommand = (g.passedThisCommand ?? []).filter((x) => x !== SIDE);
  g.currentPlayer = SIDE;
  return g;
};

{
  const g = rewound();
  const f = SIDE === 'Rebel' ? g.rebel : g.empire;
  console.log(`board: turn ${g.timeMarker}, phase ${g.phase}, side ${SIDE}`);
  console.log(`${SIDE} pool: ${JSON.stringify(f.leaderPool)}`);
  console.log(`${SIDE} face-down missions: ${JSON.stringify((f.leadersOnMissions ?? []).map((m) => m.missionId))}`);
  AI.seedAI(1);
  const acts = AI.bestCommandAction(g, SIDE).filter((a) => a.kind !== 'pass');
  console.log(`actionable candidates: ${acts.length}\n`);
}

const rows = [];
let passes = 0;
for (let s = 1; s <= SEEDS; s++) {
  const g = rewound();
  AI.seedAI(s); mcts.seedMCTS?.(s);
  const res = mcts.searchMctsCommand(g, SIDE);
  if (!res) { console.log(`seed ${s}: no search (single candidate or ineligible)`); continue; }
  const t = res.trace;
  if (!t) { console.log(`seed ${s}: only one candidate`); continue; }
  const pg = t.search.passGuard ?? null;
  if (t.chose.kind === 'pass') passes++;
  if (pg) rows.push(pg);
  console.log(`seed ${String(s).padStart(2)}  chose=${String(t.chose.kind).padEnd(8)}`
    + `  gap=${pg ? pg.gap.toFixed(3).padStart(6) : '     -'}`
    + `  se=${pg ? pg.se.toFixed(3) : '    -'}`
    + `  effMargin=${pg ? pg.eff : '-'}`
    + `  pulls=${t.search.pulls}`);
}

const stat = (xs) => {
  const a = [...xs].sort((p, q) => p - q);
  return { min: a[0], med: a[Math.floor(a.length / 2)], max: a[a.length - 1] };
};
console.log(`\npassed ${passes}/${SEEDS} (${Math.round(100 * passes / SEEDS)}%) with actions available`);
if (rows.length) {
  const g = stat(rows.map((r) => r.gap));
  const e = stat(rows.map((r) => r.se));
  const ratio = stat(rows.map((r) => (r.se > 0 ? r.gap / r.se : 0)));
  console.log(`gap  (pass - bestAction): min ${g.min.toFixed(3)}  median ${g.med.toFixed(3)}  max ${g.max.toFixed(3)}`);
  console.log(`se   (of that difference): min ${e.min.toFixed(3)}  median ${e.med.toFixed(3)}  max ${e.max.toFixed(3)}`);
  console.log(`gap/se                   : min ${ratio.min.toFixed(2)}  median ${ratio.med.toFixed(2)}  max ${ratio.max.toFixed(2)}`);
  console.log(ratio.med < 1
    ? '\n=> pass is winning INSIDE the noise: the guard margin is the thing to fix.'
    : '\n=> pass wins by more than the measurement error: the LEAF EVAL rates a\n   forfeited round above the alternatives. Fixing the guard only masks that.');
} else {
  console.log('(no guarded decisions — pass never topped the arms)');
}
