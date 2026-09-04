// Fit mission base values so the heuristic planner's per-mission assignment
// rates match the recorded humans' on the SAME positions (the #555/#718
// instrument). Coordinate ascent on the marginals: each pass, nudge each
// mission's value by k*(human% - heuristic%), re-plan, repeat. Games are split
// by log into train/holdout halves so the printed Jaccard is out-of-sample.
//
// node scripts/calibrate-assignment-values.mjs reports/human-assignments.jsonl --side Empire [--passes 12] [--k 0.12]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SWR_RANKER = '0';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SIDE = arg('--side', 'Empire'), PASSES = Number(arg('--passes', 12)), K = Number(arg('--k', 0.12));
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts'); const codec = await import('../src/engine/codec.ts'); const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });
const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.stage === 'assignment' && r.quality === 'exact' && r.humanSide === SIDE);
const pos = []; for (const r of rows) { try { pos.push({ G: codec.decode(r.state, catalog), H: r.humanAssignments.map((x) => x.missionId), log: r.gameId ?? '' }); } catch { /* skip */ } }
// split by game so holdout games are unseen
const logs = [...new Set(pos.map((p) => p.log))]; const hold = new Set(logs.filter((_, i) => i % 2 === 1));
const train = pos.filter((p) => !hold.has(p.log)), test = pos.filter((p) => hold.has(p.log));
const fkey = SIDE === 'Rebel' ? 'rebel' : 'empire';
function evaluate(set, table) {
  AI.__setMissionValueOverride(SIDE, table);
  const m = {}; let jacc = 0, cntH = 0, cntA = 0;
  for (const p of set) {
    AI.seedAI(1);
    const A = AI.__testPlanAssignment(p.G, SIDE).map((x) => x.missionId);
    for (const mid of new Set(p.G[fkey].missionHand)) (m[mid] ??= { held: 0, h: 0, a: 0 }).held++;
    for (const mid of p.H) (m[mid] ??= { held: 0, h: 0, a: 0 }).h++;
    for (const mid of A) (m[mid] ??= { held: 0, h: 0, a: 0 }).a++;
    const As = new Set(A), Hs = new Set(p.H); const inter = [...As].filter((x) => Hs.has(x)).length, uni = new Set([...As, ...Hs]).size;
    jacc += uni ? inter / uni : 1; cntH += p.H.length; cntA += A.length;
  }
  AI.__setMissionValueOverride(SIDE, null);
  return { m, jacc: jacc / set.length, perRoundH: cntH / set.length, perRoundA: cntA / set.length };
}
// starting table = the shipped values (read back through the planner's own function is not exported; seed from the eval)
const table = {};
const base = evaluate(train, null);
console.log(`${SIDE}: train ${train.length} positions / ${logs.length - hold.size} games, holdout ${test.length} / ${hold.size} games`);
console.log(`pass 0  train Jaccard ${base.jacc.toFixed(3)}  per-round human ${base.perRoundH.toFixed(2)} heur ${base.perRoundA.toFixed(2)}  holdout Jaccard ${evaluate(test, null).jacc.toFixed(3)}`);
// initial values: we don't know the shipped numbers programmatically, so start every mission at its
// shipped value by probing: override only missions we touch; untouched fall through to the table.
let cur = base; let best = { jacc: -1, table: {} };
for (let pass = 1; pass <= PASSES; pass++) {
  for (const [mid, e] of Object.entries(cur.m)) {
    if (e.held < 10) continue;
    const gap = (e.h - e.a) / e.held; // human% - heuristic%
    if (Math.abs(gap) < 0.03) continue;
    table[mid] = (table[mid] ?? AI.__testMissionBaseValue(mid, SIDE)) + K * 100 * gap * 0.1;
    table[mid] = Math.max(1, Math.min(20, table[mid]));
  }
  cur = evaluate(train, table);
  const t = evaluate(test, table);
  // keep the pass with the best TRAIN agreement (holdout is only reported, never selected on)
  if (cur.jacc > best.jacc) best = { jacc: cur.jacc, table: { ...table } };
  console.log(`pass ${pass}  train Jaccard ${cur.jacc.toFixed(3)}  per-round heur ${cur.perRoundA.toFixed(2)}  holdout Jaccard ${t.jacc.toFixed(3)}${cur.jacc === best.jacc ? '  *best' : ''}`);
}
const out = Object.fromEntries(Object.entries(best.table).map(([k, v]) => [k, Math.round(v * 10) / 10]));
writeFileSync(join(ROOT, 'reports', `calib-${SIDE.toLowerCase()}.json`), JSON.stringify(out, null, 1));
console.log('\nfitted values (shipped -> fitted), with human% vs fitted heuristic% on train:');
const fin = evaluate(train, out);
for (const [mid, v] of Object.entries(out).sort((a, b) => Math.abs(b[1] - AI.__testMissionBaseValue(b[0], SIDE)) - Math.abs(a[1] - AI.__testMissionBaseValue(a[0], SIDE)))) {
  const e = fin.m[mid]; console.log(`  ${mid.padEnd(32)} ${String(AI.__testMissionBaseValue(mid, SIDE)).padStart(4)} -> ${String(v).padStart(4)}   human ${(100 * e.h / e.held).toFixed(0).padStart(3)}%  heur ${(100 * e.a / e.held).toFixed(0).padStart(3)}%`);
}
console.log(`final: train Jaccard ${fin.jacc.toFixed(3)}  holdout ${evaluate(test, out).jacc.toFixed(3)}  per-round heur ${fin.perRoundA.toFixed(2)} (human ${fin.perRoundH.toFixed(2)})`);
