// #834 — "the rebel just activated one x-wing and moved it to a neighbor
// system - why does he do that? he could counter my turn (by intervening in a
// mission)". Replayed from the reporter's own board
// (scripts/fixtures/reserve-leader-834.json).
//
// Round 2, Command, the Rebel to act: four leaders on face-down missions (best
// reveal score 37) and only General Rieekan left in the pool. The MCTS Rebel
// spent Rieekan on a score-1 activation moving one X-wing from Felucia to Mon
// Calamari, leaving nobody to oppose the Empire's four missions. Its own
// search rated the reveals higher (0.21 vs 0.19); the imitation ranker put 94%
// of its prior on the two Rieekan moves and final-by-visits followed the
// prior, on every seed.
//
// The fix (mctsAI deferIdleLastLeader, SWR_RESERVE_LEADER): while a reveal is
// still available, a below-floor activation by the LAST pool leader waits.
//
// Run: node scripts/test-reserve-leader-834.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

// The capture is taken just AFTER the move: put Rieekan back in the pool and
// the X-wing back on Felucia to recreate the decision the AI faced.
const raw = readFileSync(join(ROOT, 'scripts/fixtures/reserve-leader-834.json'), 'utf8');
const board = () => {
  const G = codec.decode(raw, setup.buildCatalog(data));
  delete G.rebel.leadersOnBoard['mon-calamari'];
  G.rebel.leaderPool.push('general-rieekan');
  const mc = G.map.systems['mon-calamari'].units;
  G.map.systems['felucia'].units.push(mc.splice(mc.findIndex((u) => u.instanceId === 'u1000009'), 1)[0]);
  G.currentPlayer = 'Rebel';
  return G;
};
const SEEDS = [1, 2, 3];
const choices = () => SEEDS.map((s) => {
  const G = board();
  AI.seedAI(s); mcts.seedMCTS?.(s);
  return mcts.searchMctsCommand(G, 'Rebel')?.chosen ?? null;
});

// Control mode: the guard is read at module load, so the A/B arm runs in a
// child process with SWR_RESERVE_LEADER=0 and reports its picks.
if (process.env.RESERVE_834_CONTROL === '1') {
  console.log(JSON.stringify(choices().map((c) => c?.kind ?? null)));
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('deferIdleLastLeader on candidate lists:');
{
  const G = board();
  const cands = [
    { kind: 'reveal', score: 37 },
    { kind: 'activate', score: 1 },
    { kind: 'activate', score: 12 },
    { kind: 'pass', score: 0.5 },
  ];
  const out = mcts.deferIdleLastLeader(G, 'Rebel', cands);
  check('drops the below-floor activation of the last pool leader', !out.some((a) => a.kind === 'activate' && a.score === 1));
  check('keeps a real activation, the reveal and pass', out.length === 3 && out.some((a) => a.score === 12));
  check('no reveal on offer -> list untouched',
    mcts.deferIdleLastLeader(G, 'Rebel', cands.filter((a) => a.kind !== 'reveal')).length === 3);
  G.rebel.leaderPool.push('general-dodonna');
  check('two pool leaders -> list untouched', mcts.deferIdleLastLeader(G, 'Rebel', cands).length === 4);
}

console.log('the reporter\'s board (#834):');
{
  const picks = choices();
  check('the Rebel never spends Rieekan on the score-1 move',
    picks.every((c) => c && c.kind !== 'activate'), JSON.stringify(picks.map((c) => c && [c.kind, c.targetSystemId])));
  check('it reveals one of its missions instead', picks.every((c) => c?.kind === 'reveal'),
    JSON.stringify(picks.map((c) => c?.kind)));
}

console.log('control (SWR_RESERVE_LEADER=0) still reproduces the report:');
{
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, SWR_RESERVE_LEADER: '0', RESERVE_834_CONTROL: '1' }, encoding: 'utf8',
  });
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  let kinds = [];
  try { kinds = JSON.parse(line); } catch { /* reported below */ }
  check('with the guard off the board picks the activation (test is not vacuous)',
    kinds.length === SEEDS.length && kinds.every((k) => k === 'activate'),
    `got ${line || r.stderr?.slice(0, 300)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('all passed');
