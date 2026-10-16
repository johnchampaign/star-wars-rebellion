// @timeout 180000
// #809 (fl4qs5, playing Rebel): "Empire left deathstar in Dathomir and moved
// other forces to mygeeto that it had already destroyed. It has dantoone, yavin
// that could have been rebel bases (it was yavin)."
//
// Replayed from the reporter's board (scripts/fixtures/destroyed-world-809.json,
// captured just after the move; rewound here). Only three worlds could still
// hide the base — Dantooine, Hoth, Yavin — and the Death Star's stack on
// Dathomir sat next to two of them. The activation scorer priced the destroyed
// Mygeeto like any neutral world: +6 as a subjugation pickup and +20 as a live
// base candidate. A destroyed system has no loyalty, can never be subjugated
// (rr p.7) and cannot hide the base (MCTS baseCandidates already knew that), so
// Mygeeto (53) outscored Yavin (41), the real base.
//
// Pins: destroyed systems earn neither bonus (Mygeeto stops leading, the AI no
// longer moves into it; SWR_DESTROYED_GUARD=0 reproduces the report), and the
// Rebel's "build presence" bonus has the same guard.
// Run: node scripts/test-destroyed-world-809.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const raw = readFileSync(join(ROOT, 'scripts/fixtures/destroyed-world-809.json'), 'utf8');

// The 12 units Admiral Piett moved from Dathomir into Mygeeto (the report's log).
const MOVED = ['s100016', 's100014', 's100022', 's100028', 's100002', 's100003', 's100004', 's100005', 's100020', 's100026', 's100008', 's100032'];
function board() {
  const G = codec.decode(raw, catalog);
  const my = G.map.systems.mygeeto, da = G.map.systems.dathomir;
  for (const id of MOVED) { const i = my.units.findIndex((u) => u.instanceId === id); if (i >= 0) da.units.push(...my.units.splice(i, 1)); }
  delete G.empire.leadersOnBoard.mygeeto;
  G.empire.leaderPool.push('admiral-piett');
  G.currentPlayer = 'Empire'; G.pendingChoice = undefined;
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Empire');
  return G;
}

// Child mode: the heuristic's top activation, for the counterfactual.
if (process.argv[2] === '--pick') {
  const top = AI.bestCommandAction(board(), 'Empire').find((a) => a.kind === 'activate');
  console.log(`PICK ${top?.targetSystemId}:${top?.score}`);
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const SHIPPED = { SWR_HUNT_OCCUPY: '1', SWR_EMPIRE_PLANNER: '1', SWR_MCTS_BELIEF: '1' };
const pick = (env) => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--pick'], { env: { ...process.env, ...SHIPPED, ...env }, encoding: 'utf8' });
  return (r.stdout.match(/PICK (\S+)/) ?? [])[1] ?? `error: ${r.stderr.slice(-300)}`;
};

console.log('[ the reporter\'s board ]');
{
  const G = board();
  check('Mygeeto has been destroyed', !!G.map.systems.mygeeto.destroyed);
  check('the base is at Yavin, still hidden', G.rebelBaseSystemId === 'yavin' && !G.rebelBaseRevealed);
  const cands = mcts.baseCandidates(G).sort();
  check('only Dantooine, Hoth and Yavin could still hide it', cands.join(',') === 'dantooine,hoth,yavin', cands.join(','));
  check('the Death Star\'s stack on Dathomir carries ground and is next to Yavin',
    G.map.systems.dathomir.units.some((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')
    && G.catalog.adjacency.dathomir.includes('yavin'));
}

console.log('[ a destroyed world is not a target ]');
{
  const before = pick({ SWR_DESTROYED_GUARD: '0' });
  check('control: without the guard the destroyed Mygeeto leads at 53 (the reported move)', before === 'mygeeto:53', before);
  const now = pick({});
  check('with the guard the AI no longer leads with Mygeeto', !now.startsWith('mygeeto:'), now);
  const G = board();
  AI.seedAI(1); mcts.seedMCTS?.(1);
  const r = mcts.searchMctsCommand(G, 'Empire');
  check('the full search does not move into Mygeeto either', !!r && !(r.chosen.kind === 'activate' && r.chosen.targetSystemId === 'mygeeto'), r && JSON.stringify(r.chosen));
}

console.log('[ tripwires ]');
{
  const src = readFileSync(join(ROOT, 'src/play/randomAI.ts'), 'utf8');
  check('destroyed systems are not base candidates', /if \(DESTROYED_GUARD && G\.map\.systems\[sid\]\?\.destroyed\) return false;/.test(src));
  check('…nor Empire subjugation pickups', /sys\.loyalty !== 'imperial'\s*\n\s*&& !\(DESTROYED_GUARD && sys\.destroyed\)\) \{/.test(src));
  check('…nor Rebel "build presence" targets (the mirror)', /dFromBase >= 2\s*\n\s*&& !\(DESTROYED_GUARD && sys\.destroyed\)\) \{/.test(src));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
