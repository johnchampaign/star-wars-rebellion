// @timeout 120000
// #555 / #718 — "always deploying all their units at the rebel base then using
// rapid mobilisation every turn" / "plays Rapid Mobilization every turn and then
// moves an x-wing to base". Both reporters were right, and the discipline gate
// from #439/#445/#453 was not the fix it looked like.
//
// Measured 2026-09-03 with the Assignment-phase instrument (mine-human-decisions
// --stage assignment + eval-assignment-agreement) on 335 EXACT human-Rebel
// positions from the archive: the heuristic assigned Rapid Mobilization in 66%
// of them, the recorded humans in 15%. Cause: the gate's "massing" branch
// (>= 2 Empire mobile ground within TWO hops of the hidden base, +2) was true
// in 67% of hidden-base positions — the Empire garrisons everywhere — so RM
// scored 11 and the planner took it. The humans' RM rate barely tracks that
// count (12-21% from 0 to 6+ units). Fix: the massing signal is ground within
// ONE hop (SWR_RM_GATE=0 restores two). Same positions after the fix: 17%
// (hidden base: 15%). Also calibrated Sabotage 6->8 and Hidden Fleet 8->5
// toward the humans (83% / 2% vs heuristic 71% / 11%); SWR_ASSIGN_CALIB=0
// restores. This test pins the gate on a synthetic board; the archive
// measurement lives in scripts/eval-assignment-agreement.mjs.
//
// Run: node scripts/test-rm-gate-555-718.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SWR_RANKER = '0'; // the gate is heuristic-side; keep the test focused
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** Hidden base with RM in hand and a couple of Rebel leaders; Empire ground at `hops` from the base. */
function board(hops, nGround = 2) {
  const G = createGame(data, { seed: 17, autoSetupUnits: true });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.rebelBaseRevealed = false;
  const base = G.rebelBaseSystemId;
  const adjacency = G.catalog.adjacency;
  const bfs = (o) => { const d = new Map([[o, 0]]); const q = [o]; while (q.length) { const c = q.shift(); for (const nb of adjacency[c] ?? []) if (!d.has(nb)) { d.set(nb, d.get(c) + 1); q.push(nb); } } return d; };
  const dist = bfs(base);
  const at = [...dist.entries()].find(([sid, d]) => d === hops && !G.catalog.systems[sid]?.isRemote)?.[0];
  for (let i = 0; i < nGround; i++) G.map.systems[at].units.push({ instanceId: `st${i}`, typeId: 'stormtrooper', side: 'Empire', damage: 0 });
  if (!G.rebel.missionHand.includes('rapid-mobilization')) G.rebel.missionHand.push('rapid-mobilization');
  G.phase = 'Assignment'; G.currentPlayer = 'Rebel';
  return { G, at };
}
const rmAssigned = (G) => { AI.seedAI(1); return AI.__testPlanAssignment(G, 'Rebel').some((p) => p.missionId === 'rapid-mobilization'); };

if (process.env.RM_CHILD === '1') {
  const { G } = board(2);
  console.log(JSON.stringify({ rm2: rmAssigned(G) })); process.exit(0);
}

console.log('[ a hidden base with Empire ground TWO hops away is not a reason to mobilise ]');
{
  const { G, at } = board(2);
  check(`RM is NOT assigned with 2 stormtroopers 2 hops from the hidden base (${at})`, !rmAssigned(G));
  // NON-VACUOUS: the legacy two-hop gate on the same board DID assign it.
  const legacy = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, RM_CHILD: '1', SWR_RM_GATE: '0' }, encoding: 'utf8' }).trim().split('\n').pop());
  check('the legacy two-hop gate assigned RM on that same board (the bug this fixes)', legacy.rm2 === true);
}
console.log('[ but an IMMINENT threat still triggers it ]');
{
  const { G, at } = board(1);
  check(`RM IS assigned with 2 stormtroopers ONE hop from the hidden base (${at})`, rmAssigned(G));
  const G2 = board(1).G; G2.rebelBaseRevealed = true;
  check('and a revealed base always mobilises', rmAssigned(G2));
}
console.log('[ the calibration toward the recorded humans is on by default ]');
{
  const src = readFileSync(join(ROOT, 'src/play/randomAI.ts'), 'utf8');
  check('Sabotage 6 -> 8, Hidden Fleet 8 -> 5 behind SWR_ASSIGN_CALIB', /'sabotage': ASSIGN_CALIB \? 8 : 6/.test(src) && /'hidden-fleet': ASSIGN_CALIB \? 5 : 8/.test(src));
  check('RM gate defaults to the one-hop signal', /RM_GATE_ONE_HOP \? empireProximityToBase\(G, 1\) >= 2/.test(src));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
