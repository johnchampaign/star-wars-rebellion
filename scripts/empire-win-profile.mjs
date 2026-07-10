// Positive reference for the Empire strike-fleet plan layer (#539).
//
// A full human-Empire WIN (base captured, dantooine, turn 8) — the shape the AI
// should aspire to. The negative fixtures (empire-finish-538/516) show the AI
// FAILING to finish; this one quantifies what SUCCESS looks like, so the planner
// has concrete targets from real winning play rather than a vibe.
//
// Prints the "winning profile": maneuver rate, industrial buildup curve, base-
// narrowing trajectory, and the same-turn find→capture that the AI can't do.
// Run: node scripts/empire-win-profile.mjs
import { readGameLog } from './lib/log-reader.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const g = readGameLog(join(ROOT, 'scripts', 'fixtures', 'empire-win-reference-dantooine.json'));

console.log(`=== Empire WIN reference — ${g.gameId} (human ${g.humanSide}, ${g.winner}/${g.winReason}) ===\n`);

// Per-round maneuver + economy.
const R = {};
for (const e of g.events) {
  const t = e.turn ?? 0;
  (R[t] ??= { move: 0, build: 0, subj: 0, probe: 0 });
  if (e.kind === 'move-unit') R[t].move++;
  else if (e.kind === 'build-queue') R[t].build++;
  else if (e.kind === 'subjugated') R[t].subj++;
  else if (e.kind === 'draw-probe') R[t].probe += (e.payload?.count || 1);
}
const turns = Object.keys(R).map(Number).sort((a, b) => a - b);
const totalMove = turns.reduce((s, t) => s + R[t].move, 0);
console.log('Per-round maneuver + economy:');
console.log('  turn |  moves  builds  subjug  probes');
for (const t of turns) { const r = R[t]; console.log(`   t${String(t).padStart(2)}  | ${String(r.move).padStart(5)}  ${String(r.build).padStart(6)}  ${String(r.subj).padStart(6)}  ${String(r.probe).padStart(6)}`); }
console.log(`  => maneuver rate: ${(totalMove / turns.length).toFixed(1)} moves/round  (contrast: AI ~1.14/round in ai-divergence)\n`);

// Buildup + narrowing + reveal from snapshots.
console.log('Buildup / narrowing / reveal:');
console.log('  snapshot        | empUnits  ruledOut  rep/time  baseRevealed');
let revealTurn = null, captureTurn = null;
for (const s of g.snapshots) {
  const st = s.state;
  const emp = Object.values(st.map?.systems || {}).reduce((n, ss) => n + (ss.units || []).filter((u) => u.side === 'Empire').length, 0);
  const ruled = (st.empireSearchedRuledOut || []).length;
  console.log(`  t${st.timeMarker}/${(s.at + '            ').slice(0, 14)}| ${String(emp).padStart(7)}  ${String(ruled).padStart(7)}   ${st.reputationMarker}/${st.timeMarker}      ${st.rebelBaseRevealed}`);
  if (st.rebelBaseRevealed && revealTurn == null) revealTurn = st.timeMarker;
}
const go = g.events.find((e) => e.kind === 'game-over');
captureTurn = go?.turn ?? null;

console.log('\nThe winning shape (planner targets):');
console.log('  • Heavy MANEUVER throughout — force sweeps candidate systems to narrow the base.');
console.log('  • Industrial BUILDUP before the strike — overwhelming force, not a thin rush.');
console.log('  • Subjugation does double duty — narrows the search AND grows production.');
console.log(`  • SAME-TURN find→capture — base revealed t${revealTurn}, captured t${captureTurn} (pre-massed force converts the reveal immediately).`);
console.log('  • Clock control — the Rebel never neared a reputation win, so the hunt had no deadline.');
