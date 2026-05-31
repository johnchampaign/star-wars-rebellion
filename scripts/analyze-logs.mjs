// Tournament log analyzer — aggregate AI-vs-AI game logs into strategy metrics.
//
// Reads every game-*.json in a tournament-logs run directory and prints a
// baseline report: outcomes, per-side action economy, subjugation churn,
// non-advancing Empire activations, and base-hunt / invasion stats. Use it to
// turn "the AI seems dumb" into numbers, then A/B engine changes against it.
//
// Usage:
//   node scripts/analyze-logs.mjs [runDir]
// Defaults to the most recent tournament-logs/run-* directory.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOG_ROOT = join(ROOT, 'tournament-logs');

function latestRunDir() {
  const runs = readdirSync(LOG_ROOT)
    .filter((d) => d.startsWith('run-'))
    .map((d) => ({ d, t: statSync(join(LOG_ROOT, d)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (runs.length === 0) throw new Error('no tournament-logs/run-* directories found');
  return join(LOG_ROOT, runs[0].d);
}

const runDir = process.argv[2] ? process.argv[2] : latestRunDir();
const files = readdirSync(runDir).filter((f) => /^game-\d+\.json$/.test(f)).sort();
if (files.length === 0) { console.error(`no game-*.json in ${runDir}`); process.exit(1); }

// ---- accumulators ----
const agg = {
  games: 0,
  winners: {},            // result -> count
  winReasons: {},         // winReason -> count
  rounds: [],             // game length
  // action economy, per side
  act: { Rebel: {}, Empire: {} },  // kind -> count
  // subjugation
  subjugated: 0,
  liberated: 0,
  // base hunt
  baseRevealTurns: [],    // turn the base was revealed (if it was)
  baseRevealedGames: 0,
  // Empire activations that produced no combat that turn (non-advancing proxy)
  empireActivations: 0,
  empireActivationsNoCombat: 0,
  // combats
  combats: 0,
  combatsAtBase: 0,       // combats at the revealed base system
  // leader-only base invasions: combat at base where Empire rolled few dice
  baseInvasions: 0,
  baseInvasionsEmpireWon: 0,
};

const bump = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };

for (const f of files) {
  const g = JSON.parse(readFileSync(join(runDir, f), 'utf-8'));
  agg.games++;
  bump(agg.winners, g.result ?? 'unknown');
  bump(agg.winReasons, g.winReason ?? 'none');
  if (typeof g.rounds === 'number') agg.rounds.push(g.rounds);

  const log = g.log ?? [];
  // Base system (from reveal-base) so we can tag base combats.
  const revealBase = log.find((e) => e.kind === 'reveal-base');
  const baseSys = revealBase?.payload?.systemId ?? null;
  if (revealBase) { agg.baseRevealedGames++; if (typeof revealBase.turn === 'number') agg.baseRevealTurns.push(revealBase.turn); }

  // Group combat-begin events by turn so we can tell which activations led to a fight.
  const combatTurns = new Set();
  for (const e of log) {
    if (e.kind === 'combat-begin') {
      agg.combats++;
      if (typeof e.turn === 'number') combatTurns.add(e.turn);
      if (baseSys && e.payload?.systemId === baseSys) {
        agg.combatsAtBase++;
        if (e.payload?.attackerSide === 'Empire') agg.baseInvasions++;
      }
    }
    if (e.kind === 'combat-end' && baseSys && e.payload?.systemId === baseSys
        && e.payload?.winner === 'Empire') {
      agg.baseInvasionsEmpireWon++;
    }
    if (e.kind === 'subjugated') agg.subjugated++;
    if (e.kind === 'liberated') agg.liberated++;
    // action economy
    if (e.side === 'Rebel' || e.side === 'Empire') {
      if (['reveal-mission', 'activate-system', 'pass', 'skip-assignment', 'assign-leader'].includes(e.kind)) {
        bump(agg.act[e.side], e.kind);
      }
    }
  }
  // Empire activations and whether a combat happened that same turn.
  for (const e of log) {
    if (e.kind === 'activate-system' && e.side === 'Empire') {
      agg.empireActivations++;
      if (!combatTurns.has(e.turn)) agg.empireActivationsNoCombat++;
    }
  }
}

// ---- report ----
const pct = (n, d) => d > 0 ? `${(100 * n / d).toFixed(1)}%` : '—';
const mean = (a) => a.length ? (a.reduce((s, x) => s + x, 0) / a.length) : 0;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

console.log(`\n=== Log analysis: ${runDir.replace(ROOT + '\\', '').replace(ROOT + '/', '')} (${agg.games} games) ===\n`);

console.log('OUTCOMES');
for (const [k, v] of Object.entries(agg.winners).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(4)}  (${pct(v, agg.games)})`);
}
console.log('  win reasons:');
for (const [k, v] of Object.entries(agg.winReasons).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(22)} ${v}`);
}
console.log(`  game length: mean ${mean(agg.rounds).toFixed(1)} rounds, median ${median(agg.rounds)}`);

console.log('\nACTION ECONOMY (per game avg)');
for (const side of ['Empire', 'Rebel']) {
  const a = agg.act[side];
  const per = (k) => ((a[k] ?? 0) / agg.games).toFixed(1);
  console.log(`  ${side}: reveals ${per('reveal-mission')}  activations ${per('activate-system')}  passes ${per('pass')}  assigns ${per('assign-leader')}  skip-assign ${per('skip-assignment')}`);
}

console.log('\nSUBJUGATION');
console.log(`  subjugated events: ${agg.subjugated}  (${(agg.subjugated / agg.games).toFixed(1)}/game)`);
console.log(`  liberated/lost:    ${agg.liberated}  (${(agg.liberated / agg.games).toFixed(1)}/game)`);
console.log(`  churn ratio (lost/gained): ${pct(agg.liberated, agg.subjugated)}  ← high = grabbing then giving up subjugations`);

console.log('\nEMPIRE ACTIVATIONS');
console.log(`  total: ${agg.empireActivations}  (${(agg.empireActivations / agg.games).toFixed(1)}/game)`);
console.log(`  produced NO combat that turn: ${agg.empireActivationsNoCombat}  (${pct(agg.empireActivationsNoCombat, agg.empireActivations)})  ← proxy for non-advancing moves`);

console.log('\nBASE HUNT / INVASION');
console.log(`  base revealed in ${agg.baseRevealedGames}/${agg.games} games (${pct(agg.baseRevealedGames, agg.games)})`);
console.log(`  base-reveal turn: mean ${mean(agg.baseRevealTurns).toFixed(1)}, median ${median(agg.baseRevealTurns)}`);
console.log(`  combats total: ${agg.combats} (${(agg.combats / agg.games).toFixed(1)}/game); at the base: ${agg.combatsAtBase}`);
console.log(`  Empire base-invasions: ${agg.baseInvasions}; Empire won at base: ${agg.baseInvasionsEmpireWon} (${pct(agg.baseInvasionsEmpireWon, agg.baseInvasions)})`);
console.log('');
