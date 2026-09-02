// @timeout 120000
// SWR_CAND_K — candidate WIDTH for the Command-phase generator.
//
// Measured on 1,119 exact Command-start positions from winning human games
// (scripts/eval-candidate-coverage.mjs, 2026-08-31): at the historical width
// (one target per mission, one per leader) the human's move is generated only
// 31% of the time, and 74-85% of the misses are "right mission/leader, other
// target". Width fixes generation — K=2 44%, K=3 53%, K=4 60% — but what the
// MCTS root SEES (top-12 by heuristic score) peaks at K=2 (42%) and then falls
// (39%, 34%) because the heuristic cannot rank the human's target above the
// alternatives it now emits. Width is therefore shipped OFF (K=1) until the
// learned ranker exists; this test pins the contract that makes the lever safe:
//   - K=1 (unset) is byte-for-byte the legacy generator;
//   - K>1 is a strict superset with the legacy entries and scores preserved.
// Run: node scripts/test-cand-width.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Child mode: emit candidates for a fixed mid-game board under the ambient K.
if (process.env.CAND_CHILD === '1') {
  const { register } = await import('tsx/esm/api'); register();
  const { createGame } = await import('../src/engine/setup.ts');
  const AI = await import('../src/play/randomAI.ts');
  const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
  const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
  const out = {};
  for (const seed of [3, 7, 11]) {
    AI.seedAI(seed);
    const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
    // Advance into a Command phase with missions assigned by driving the AI.
    let n = 0; while (n++ < 300 && G.phase !== 'Command' && !G.isGameOver) if (!AI.stepOnce(G, G.currentPlayer)) break;
    for (const side of ['Rebel', 'Empire']) {
      AI.seedAI(1);
      out[`${seed}:${side}`] = AI.bestCommandAction(G, side).map((a) => ({ kind: a.kind, leaderId: a.leaderId, targetSystemId: a.targetSystemId, missionId: a.missionId, score: a.score }));
    }
  }
  console.log(JSON.stringify(out)); process.exit(0);
}
const run = (k) => {
  const env = { ...process.env, CAND_CHILD: '1' }; if (k) env.SWR_CAND_K = String(k); else delete env.SWR_CAND_K;
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: 'utf8' });
  const lines = r.stdout.trim().split('\n'); return JSON.parse(lines[lines.length - 1]);
};
const key = (a) => `${a.kind}|${a.leaderId ?? ''}|${a.missionId ?? ''}|${a.targetSystemId ?? ''}`;
const unset = run(null), k1 = run(1), k3 = run(3);

console.log('[ K unset is the legacy generator, and K=1 is identical to it ]');
check('unset == K=1 on every board (same list, same order, same scores)', JSON.stringify(unset) === JSON.stringify(k1));
let boards = 0, superset = true, preserved = true, wider = false, sameK1AsLegacy = true;
for (const b of Object.keys(k1)) {
  boards++;
  const base = new Map(k1[b].map((a) => [key(a), a.score]));
  const wide = new Map(k3[b].map((a) => [key(a), a.score]));
  for (const [kk, sc] of base) { if (!wide.has(kk)) superset = false; else if (wide.get(kk) !== sc) preserved = false; }
  if (k3[b].length > k1[b].length) wider = true;
  // each mission / leader should have at most 1 target at K=1
  const perMission = {}; for (const a of k1[b]) if (a.kind === 'reveal') perMission[a.missionId] = (perMission[a.missionId] || 0) + 1;
  if (Object.values(perMission).some((v) => v > 1)) sameK1AsLegacy = false;
}
console.log(`    boards checked: ${boards}`);
check('K=1 emits at most ONE target per mission (the legacy contract)', sameK1AsLegacy);
console.log('[ K=3 widens without disturbing the legacy entries ]');
check('every K=1 candidate is still present at K=3', superset);
check('with an identical score', preserved);
check('and K=3 emits MORE candidates on at least one board (non-vacuous)', wider);
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
