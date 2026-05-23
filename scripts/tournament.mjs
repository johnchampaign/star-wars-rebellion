// Headless AI-vs-AI tournament runner.
//
// Plays N games, both sides driven by the heuristic AI from src/play/randomAI.ts,
// and reports aggregate stats. Per-game JSON logs are written to
// tournament-logs/<run-id>/game-NNN.json so they can be uploaded via the same
// /api/upload-logs pipeline the in-browser app uses.
//
// Usage:
//   node scripts/tournament.mjs --games 50 --seed 1 --out tournament-logs/run-2026-05-23
//
// Defaults: 10 games, seed 1, output dir tournament-logs/run-<timestamp>.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Parse CLI args.
const args = (() => {
  const a = process.argv.slice(2);
  const out = { games: 10, seed: 1, out: null, verbose: false, maxRounds: 8 };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--games') out.games = parseInt(a[++i], 10);
    else if (k === '--seed') out.seed = parseInt(a[++i], 10);
    else if (k === '--out') out.out = a[++i];
    else if (k === '--verbose' || k === '-v') out.verbose = true;
    else if (k === '--max-rounds') out.maxRounds = parseInt(a[++i], 10);
  }
  if (!out.out) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    out.out = join(ROOT, 'tournament-logs', `run-${ts}`);
  }
  return out;
})();

// Register tsx so we can import .ts files.
{
  const mod = await import('tsx/esm/api');
  mod.register();
}

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce: aiStep } = await import('../src/play/randomAI.ts');

function loadJson(path) {
  return JSON.parse(readFileSync(join(ROOT, 'assets', path), 'utf-8'));
}
const data = {
  systems:    loadJson('systems.json'),
  adjacency:  loadJson('adjacency.json'),
  leaders:    loadJson('leaders.json'),
  actions:    loadJson('actions.json'),
  missions:   loadJson('missions.json'),
  objectives: loadJson('objectives.json'),
  tactics:    loadJson('tactics.json'),
  probes:     loadJson('probes.json'),
};

mkdirSync(args.out, { recursive: true });

/** Run one game. Returns { result, rounds, steps, elapsed_ms, log }. */
function playOne(seed) {
  const G = createGame(data, { seed });
  const t0 = performance.now();

  // Setup phase: both sides auto-fill until phase transitions away.
  let setupSafety = 0;
  while (G.phase === 'Setup' && setupSafety < 100) {
    setupSafety++;
    // Either side may owe a setup choice (PickRebelBase, DeployUnitPick, etc.)
    // — let the AI handle them.
    const did = aiStep(G, G.currentPlayer);
    if (!did) {
      // Try the opposing side (it may owe a pending choice).
      const other = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
      const did2 = aiStep(G, other);
      if (!did2) {
        // Fall back to setupAutoFill if available.
        const r1 = phases.setupAutoFill(G, 'Rebel');
        const r2 = phases.setupAutoFill(G, 'Empire');
        if (!r1.ok && !r2.ok) break;
      }
    }
  }

  // Main loop: drive both AIs until game over or we hit the step cap.
  let steps = 0;
  const STEP_CAP = 200000;
  while (!G.isGameOver && steps < STEP_CAP) {
    // Whichever side has an action (current player or owes a pending choice).
    const side = G.currentPlayer;
    const did = aiStep(G, side);
    if (did) { steps++; continue; }
    // Try the other side in case they owe a choice.
    const other = side === 'Rebel' ? 'Empire' : 'Rebel';
    const did2 = aiStep(G, other);
    if (did2) { steps++; continue; }
    // Stuck — both AIs returned false but game isn't over.
    break;
  }

  // Force-end if we hit max rounds (some games stall on uncovered edge cases).
  if (!G.isGameOver && G.timeMarker > args.maxRounds) {
    G.isGameOver = true;
    G.winReason = 'max-rounds-reached';
  }

  const elapsed = performance.now() - t0;
  return {
    seed,
    result: G.isGameOver ? (G.winner ?? 'unknown') : 'stuck',
    winReason: G.winReason ?? null,
    rounds: G.timeMarker,
    reputationMarker: G.reputationMarker,
    rebelBaseRevealed: G.rebelBaseRevealed,
    capturedLeaders: (G.empire.capturedLeaders ?? []).length,
    steps,
    elapsed_ms: Math.round(elapsed),
    finalPhase: G.phase,
    pendingChoice: G.pendingChoice?.kind ?? null,
    logEntries: G.turnLog.length,
    log: G.turnLog,
  };
}

// Run the tournament.
const stats = {
  games: 0,
  rebelWins: 0,
  empireWins: 0,
  stuck: 0,
  maxRoundsReached: 0,
  totalRounds: 0,
  totalSteps: 0,
  totalElapsedMs: 0,
  winReasons: {},
  finalPhases: {},
  pendingChoiceAtEnd: {},
};

console.log(`Tournament: ${args.games} games, seed=${args.seed}, out=${args.out}`);
console.log('');

for (let i = 0; i < args.games; i++) {
  const seed = args.seed * 1000 + i;
  const r = playOne(seed);
  stats.games++;
  if (r.result === 'Rebel') stats.rebelWins++;
  else if (r.result === 'Empire') stats.empireWins++;
  else stats.stuck++;
  if (r.winReason === 'max-rounds-reached') stats.maxRoundsReached++;
  stats.totalRounds += r.rounds;
  stats.totalSteps += r.steps;
  stats.totalElapsedMs += r.elapsed_ms;
  stats.winReasons[r.winReason ?? 'none'] = (stats.winReasons[r.winReason ?? 'none'] ?? 0) + 1;
  stats.finalPhases[r.finalPhase] = (stats.finalPhases[r.finalPhase] ?? 0) + 1;
  if (r.pendingChoice) {
    stats.pendingChoiceAtEnd[r.pendingChoice] = (stats.pendingChoiceAtEnd[r.pendingChoice] ?? 0) + 1;
  }

  // Write per-game JSON.
  const filename = `game-${String(i + 1).padStart(4, '0')}.json`;
  writeFileSync(join(args.out, filename), JSON.stringify({
    schemaVersion: 1,
    seed,
    result: r.result,
    winReason: r.winReason,
    rounds: r.rounds,
    reputationMarker: r.reputationMarker,
    rebelBaseRevealed: r.rebelBaseRevealed,
    capturedLeaders: r.capturedLeaders,
    steps: r.steps,
    elapsed_ms: r.elapsed_ms,
    finalPhase: r.finalPhase,
    pendingChoiceAtEnd: r.pendingChoice,
    logEntries: r.logEntries,
    log: r.log,
  }, null, 2));

  // Progress line.
  const tag = r.result === 'stuck' ? `STUCK (${r.pendingChoice ?? r.finalPhase})` : `${r.result} (${r.winReason})`;
  console.log(`  game ${String(i + 1).padStart(4)}: ${tag.padEnd(40)}  rnd ${String(r.rounds).padStart(2)}  steps ${String(r.steps).padStart(6)}  ${r.elapsed_ms}ms`);
  if (args.verbose && r.result === 'stuck') {
    console.log(`    last 5 log: ${r.log.slice(-5).map(e => e.kind).join(' | ')}`);
  }
}

console.log('');
console.log('=== Aggregate ===');
console.log(`Games:                  ${stats.games}`);
console.log(`Rebel wins:             ${stats.rebelWins} (${(100 * stats.rebelWins / stats.games).toFixed(1)}%)`);
console.log(`Empire wins:            ${stats.empireWins} (${(100 * stats.empireWins / stats.games).toFixed(1)}%)`);
console.log(`Stuck:                  ${stats.stuck} (${(100 * stats.stuck / stats.games).toFixed(1)}%)`);
console.log(`Max-rounds reached:     ${stats.maxRoundsReached}`);
console.log(`Avg rounds per game:    ${(stats.totalRounds / stats.games).toFixed(1)}`);
console.log(`Avg steps per game:     ${(stats.totalSteps / stats.games).toFixed(0)}`);
console.log(`Avg ms per game:        ${(stats.totalElapsedMs / stats.games).toFixed(0)}`);
console.log('');
console.log('Win reasons:');
for (const [k, v] of Object.entries(stats.winReasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}
console.log('');
console.log('Final phase distribution:');
for (const [k, v] of Object.entries(stats.finalPhases).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}
if (Object.keys(stats.pendingChoiceAtEnd).length > 0) {
  console.log('');
  console.log('Pending choice at stuck/end (diagnostics):');
  for (const [k, v] of Object.entries(stats.pendingChoiceAtEnd).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
}
console.log('');
console.log(`Per-game logs in: ${args.out}`);
