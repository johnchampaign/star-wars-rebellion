// @timeout 60000
// #752 — "the rebel ai attacked my star destroyer with 1 or 2 x-wings, 3 times".
// The log's decision traces show why: from turn 7 every arm the Rebel search
// considered had mean EXACTLY 1.0 (every self-play rollout ended in a Rebel
// clock win), so the final pick by visits was noise — a score-3 activation
// beat a score-12 one. The guard: when the live arms carry no signal, the
// heuristic's own score ordering decides, and pass never wins that fallback.
// Run: node scripts/test-mcts-saturation-752.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const mcts = await import('../src/play/mctsAI.ts');
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const arm = (kind, score, n, mean) => ({ a: { kind, score }, n, sum: mean * n });

if (process.env.SAT_CHILD === '1') {
  const r = mcts.saturatedPick([arm('activate', 3, 20, 1), arm('activate', 12, 8, 1), arm('pass', 0.5, 5, 1)]);
  console.log(JSON.stringify({ picked: r ? r.a.score : null })); process.exit(0);
}
console.log('[ the #752 shape: every arm at 1.0 ]');
{
  const alive = [arm('activate', 3, 20, 1), arm('activate', 12, 8, 1), arm('reveal', 8, 6, 1), arm('pass', 0.5, 5, 1)];
  const r = mcts.saturatedPick(alive);
  check('the guard fires and picks the heuristic top (score 12), not the most-visited (score 3)', r?.a.score === 12, JSON.stringify(r?.a));
  const r2 = mcts.saturatedPick([arm('pass', 0.5, 30, 1), arm('activate', 2, 4, 1)]);
  check('pass never wins the fallback while an actionable arm exists', r2?.a.kind === 'activate');
  check('a lone pass arm is left alone', mcts.saturatedPick([arm('pass', 0.5, 30, 1)]) === null);
}
console.log('[ arms that disagree are left to the search ]');
{
  check('means 0.80 vs 0.70: no override', mcts.saturatedPick([arm('activate', 3, 20, 0.8), arm('activate', 12, 8, 0.7)]) === null);
  check('means 0.505 vs 0.50 (inside eps): override', mcts.saturatedPick([arm('activate', 3, 20, 0.505), arm('activate', 12, 8, 0.5)])?.a.score === 12);
}
console.log('[ control: the guard off in a child leaves the noise pick ]');
{
  const out = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, SAT_CHILD: '1', SWR_MCTS_SATURATION: '0' }, encoding: 'utf8' }).trim().split('\n').pop());
  check('SWR_MCTS_SATURATION=0: no override (null)', out.picked === null, JSON.stringify(out));
  const src = readFileSync(join(ROOT, 'src/play/mctsAI.ts'), 'utf8');
  check('the search applies the guard after the final sort and records it in the trace', /const sat = saturatedPick\(alive\);\s*if \(sat\) chosen = sat\.a;/.test(src) && /saturated: true/.test(src));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
