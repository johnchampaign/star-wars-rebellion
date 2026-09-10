// @timeout 120000
// SWR_REBEL_SPREAD — mechanism test. With Establish Outposts in hand and few
// systems holding a Rebel unit, an activation into an EMPTY system scores
// higher with the lever than without (legacy child), and Sabotage on an
// unmarked Imperial world scores higher while Cut Supply Lines is in hand. The
// measurement lives in scripts/tournament.mjs ("Rebel ladder @turn 8").
// Run: node scripts/test-rebel-spread.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = process.env.SPREAD_CHILD === '1';
if (!CHILD) process.env.SWR_REBEL_SPREAD = '1';
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
let k = 0; const mk = (typeId, side) => ({ instanceId: `s${k++}`, typeId, side, damage: 0 });

/** Hidden base; a Rebel stack (corvette + 2 troopers) at `from`; `empty` adjacent to it holds nothing; Empire far away. */
function board() {
  const G = createGame(data, { seed: 31, autoSetupUnits: true });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.map.rebelBaseSpace.units = [];
  G.rebelBaseRevealed = false;
  const base = G.rebelBaseSystemId; const adj = G.catalog.adjacency;
  // pick from = a non-remote system 2+ hops from the base, empty = a non-remote neighbour of it
  const dist = new Map([[base, 0]]); const q = [base]; while (q.length) { const c = q.shift(); for (const n of adj[c] ?? []) if (!dist.has(n)) { dist.set(n, dist.get(c) + 1); q.push(n); } }
  const from = [...dist.entries()].find(([sid, d]) => d >= 2 && !G.catalog.systems[sid]?.isRemote && (adj[sid] ?? []).some((n) => !G.catalog.systems[n]?.isRemote && n !== base && (dist.get(n) ?? 9) >= 2))?.[0];
  // 2+ hops from the hidden base, so the 'don't draw attention to the base' terms stay out of the comparison
  const empty = (adj[from] ?? []).find((n) => !G.catalog.systems[n]?.isRemote && n !== base && (dist.get(n) ?? 9) >= 2);
  G.map.systems[from].units.push(mk('corellian-corvette', 'Rebel'), mk('rebel-trooper', 'Rebel'), mk('rebel-trooper', 'Rebel'));
  G.map.systems[empty].loyalty = 'neutral';
  G.rebel.objectiveHand = ['establish-outposts-3', 'cut-supply-lines-1'];
  // two tactic-capable leaders: the generator emits one activation per eligible leader (best targets first), so the empty system needs a second slot
  G.rebel.leaderPool = ['jan-dodonna', 'admiral-ackbar', 'mon-mothma'];
  G.phase = 'Command'; G.currentPlayer = 'Rebel';
  return { G, from, empty };
}
const scoreOf = (G, pred) => { AI.seedAI(1); const a = AI.bestCommandAction(G, 'Rebel').find(pred); return a ? a.score : null; };
const topActivation = (G) => { AI.seedAI(1); return AI.bestCommandAction(G, 'Rebel').find((a) => a.kind === 'activate'); };
const scoreAt = (G, tgt) => scoreOf(G, (a) => a.kind === 'activate' && a.targetSystemId === tgt);
/** Same board, but Rebel units already stand in 3 systems: Outposts (5) is within 2 → the near-threshold bump. */
function nearBoard() {
  const b = board(); const G = b.G;
  const extra = Object.keys(G.map.systems).filter((sid) => !G.catalog.systems[sid]?.isRemote && sid !== b.from && sid !== b.empty && G.map.systems[sid].units.length === 0 && sid !== G.rebelBaseSystemId).slice(0, 2);
  for (const sid of extra) G.map.systems[sid].units.push(mk('rebel-trooper', 'Rebel'));
  return b;
}
function sabotageScore() {
  const G = createGame(data, { seed: 31, autoSetupUnits: true });
  const imp = Object.entries(G.map.systems).find(([sid, ss]) => ss.loyalty === 'imperial' && !ss.sabotage && !G.catalog.systems[sid]?.isRemote)?.[0];
  G.rebel.objectiveHand = ['cut-supply-lines-1'];
  return { imp, s: AI.rebelMissionTargetScore(G, 'sabotage', imp, null) };
}
if (CHILD) {
  const tgt = process.env.SPREAD_TARGET;
  const { G } = board(); const { G: G2 } = nearBoard();
  console.log(JSON.stringify({ far: scoreAt(G, tgt), near: scoreAt(G2, tgt), sab: sabotageScore().s })); process.exit(0);
}
const { G, empty } = board();
const top = topActivation(G);
const legacy = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, SPREAD_CHILD: '1', SWR_REBEL_SPREAD: '0', SPREAD_TARGET: top?.targetSystemId ?? '' }, encoding: 'utf8' }).trim().split('\n').pop());
console.log('[ an empty system Establish Outposts would count is worth a leader ]');
{
  check(`the top activation is into an EMPTY system (${top?.targetSystemId})`, !!top && G.map.systems[top.targetSystemId].units.length === 0 && top.targetSystemId !== empty + 'x', JSON.stringify(top));
  const on = top?.score ?? null;
  check(`far from the threshold (1 of 5 systems held): +6 over the legacy score (${on} vs ${legacy.far})`, on != null && legacy.far != null && on - legacy.far === 6, JSON.stringify(legacy));
  const { G: G2 } = nearBoard(); const on2 = scoreAt(G2, top.targetSystemId);
  check(`within 2 of the threshold (3 of 5 held): +10 (${on2} vs ${legacy.near})`, on2 != null && legacy.near != null && on2 - legacy.near === 10, JSON.stringify(legacy));
}
console.log('[ Sabotage on an unmarked Imperial world while Cut Supply Lines is in hand ]');
{
  const { imp, s } = sabotageScore();
  check(`sabotage target score at ${imp}: lever ${s} vs legacy ${legacy.sab} (+8)`, s - legacy.sab === 8);
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
