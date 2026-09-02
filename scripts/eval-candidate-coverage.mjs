// Position-level instrument (step 1 of the imitation plan): does the AI's
// candidate generator contain the move a WINNING human actually made?
//
// Reads reports/human-decisions.jsonl (from scripts/mine-human-decisions.mjs:
// exact Command-start states + the human's first action), regenerates the
// candidate list with the CURRENT generator, and reports coverage. Because it
// re-runs the generator, it measures whatever levers are set in the env —
// SWR_CAND_K=3 node scripts/eval-candidate-coverage.mjs — so a generator change
// can be judged in seconds on ~1,100 real positions instead of hours of noisy
// self-play. Coverage is a CEILING for the search: MCTS can only pick among
// candidates, so a move that is never generated can never be chosen.
//
// Baseline 2026-08-31 (K=1, shipped): in-candidates 31%, top-3 16%.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || join(ROOT, 'reports', 'human-decisions.jsonl');
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });

const rows = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.quality === 'exact');
const TOPK = Number(process.env.SWR_MCTS_TOPK ?? 12); // what the MCTS root actually sees
const agg = {}; const bump = (k, f) => { agg[k] ??= { n: 0, inC: 0, in12: 0, top3: 0, top1: 0, cands: 0 }; const a = agg[k]; a.n++; if (f.idx >= 0) a.inC++; if (f.idx >= 0 && f.idx < TOPK) a.in12++; if (f.idx >= 0 && f.idx < 3) a.top3++; if (f.idx === 0) a.top1++; a.cands += f.n; };
for (const r of rows) {
  const G = codec.decode(r.state, catalog);
  AI.seedAI(1);
  const cands = AI.bestCommandAction(G, r.humanSide);
  const ha = r.humanAction;
  const same = (c) => ha.kind === 'pass' ? c.kind === 'pass'
    : ha.kind === 'activate-system' ? (c.kind === 'activate' && c.leaderId === ha.leaderId && c.targetSystemId === ha.targetSystemId)
    : (c.kind === 'reveal' && c.missionId === ha.missionId && c.targetSystemId === ha.targetSystemId);
  const f = { idx: cands.findIndex(same), n: cands.length };
  bump('ALL', f); bump(ha.kind, f); bump(r.humanSide, f);
}
const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(0).padStart(3) + '%';
console.log(`positions: ${rows.length} exact   levers: SWR_CAND_K=${process.env.SWR_CAND_K ?? '(default)'}`);
console.log(`${'slice'.padEnd(18)} ${'n'.padStart(5)}  in-cands  in-top${TOPK}(MCTS sees)  top-3  top-1  cands/pos`);
for (const [k, a] of Object.entries(agg)) console.log(`${k.padEnd(18)} ${String(a.n).padStart(5)}  ${pct(a.inC, a.n)}     ${pct(a.in12, a.n)}             ${pct(a.top3, a.n)}   ${pct(a.top1, a.n)}   ${(a.cands / a.n).toFixed(1)}`);
