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
  // maxRounds defaults to 16 — the real length of the time track. (It was 8,
  // which force-ended healthy games early and inflated "max-rounds-reached".)
  const out = { games: 10, seed: 1, out: null, verbose: false, maxRounds: 16, expansion: false, rebelPolicy: null, empirePolicy: null, fastSearch: false };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--games') out.games = parseInt(a[++i], 10);
    else if (k === '--seed') out.seed = parseInt(a[++i], 10);
    else if (k === '--out') out.out = a[++i];
    else if (k === '--verbose' || k === '-v') out.verbose = true;
    else if (k === '--max-rounds') out.maxRounds = parseInt(a[++i], 10);
    // Rise of the Empire. WITHOUT this the harness runs the BASE game, so no
    // expansion content exists to measure — no DSUC, no Shield Bunkers, no RoE
    // units or missions. Every A/B run here before this flag existed was a
    // base-game result, which is fine for base-game behaviour but silently
    // measures nothing when the change under test is expansion-only.
    else if (k === '--expansion' || k === '--roe') out.expansion = true;
    // Swap in a STRONGER Command-phase brain for one side. Both sides run the
    // plain heuristic by default, which means every A/B here measures a change
    // against that specific opponent. That matters for anything defensive or
    // denial-based: if the opponent never mounts the attack a change defends
    // against, the A/B can only ever see the change's COST. Measured case:
    // the heuristic Rebel enters the Death Star's system in 3.3% of games and
    // has never destroyed a DSUC, so a Shield Bunker's protection had no
    // opportunity to pay for itself. Values: 'mcts' | 'eval'.
    else if (k === '--rebel-policy') out.rebelPolicy = a[++i];
    else if (k === '--empire-policy') out.empirePolicy = a[++i];
    // Cheaper search for A/B arms. The full MCTS budget (64 rollouts, horizon
    // 4) is what players face and costs ~115s/game as the Rebel — a 300-game
    // arm is ~10 hours. --fast-search sets budget 24 / horizon 2, measured
    // (see docs/ab-levers.md, "MCTS-Rebel arm") to keep most of the strength
    // at a fraction of the cost. It is a DIFFERENT opponent from the shipped
    // one, so the run summary names it; never compare a fast-search arm
    // against a full-search arm as if they were the same baseline.
    else if (k === '--fast-search') out.fastSearch = true;
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
const { stepOnce: aiStep, seedAI, setCommandPolicyOverride } = await import('../src/play/randomAI.ts');
// Optional stronger Command policies. Imported lazily so a default run pays
// nothing for them.
async function installPolicy(side, name) {
  if (!name) return null;
  if (name === 'mcts') {
    const { mctsCommandStep } = await import('../src/play/mctsAI.ts');
    setCommandPolicyOverride(side, (G, s) => mctsCommandStep(G, s));
    return 'mcts';
  }
  if (name === 'eval') {
    const { evalCommandStepDeep } = await import('../src/play/boardEval.ts');
    setCommandPolicyOverride(side, (G, s) => evalCommandStepDeep(G, s, 2));
    return 'eval(depth2)';
  }
  throw new Error(`unknown policy '${name}' (want: mcts | eval)`);
}

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

// Install any stronger Command policies BEFORE the first game.
if (args.fastSearch) {
  process.env.SWR_MCTS_BUDGET ??= '24';
  process.env.SWR_MCTS_HORIZON ??= '2';
}
const rebelPolicyName = await installPolicy('Rebel', args.rebelPolicy);
const empirePolicyName = await installPolicy('Empire', args.empirePolicy);
if (rebelPolicyName || empirePolicyName) {
  const prof = args.fastSearch ? ' [fast-search: budget 24 / horizon 2 — NOT the shipped strength]' : ' [full search]';
  console.log(`policies: Rebel=${rebelPolicyName ?? 'heuristic'} Empire=${empirePolicyName ?? 'heuristic'}${prof}`);
}
console.log(`mode: ${args.expansion ? 'Rise of the Empire' : 'base game'}`);

/** Run one game. Returns { result, rounds, steps, elapsed_ms, log }. */
function playOne(seed) {
  // Use interactive setup (the same mode the live game uses) so the AI's
  // setup logic — including Rebel base-thinning — actually runs and can be
  // measured. With the default autoSetupUnits:true the engine pre-places
  // all units and the Setup phase is skipped entirely.
  // Seed the AI's own RNG too (not just the engine) so each game is fully
  // reproducible from its seed.
  seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: false,
    expansion: args.expansion
      ? { enabled: true, roeUnits: true, roeMissions: true }
      : undefined });
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
  const metrics = computeEmpireMetrics(G);
  return {
    seed,
    result: G.isGameOver ? (G.winner ?? 'unknown') : 'stuck',
    winReason: G.winReason ?? null,
    rounds: G.timeMarker,
    reputationMarker: G.reputationMarker,
    scoredObjectives: (G.rebel.scoredObjectives ?? []).length,
    rebelBaseRevealed: G.rebelBaseRevealed,
    capturedLeaders: (G.empire.capturedLeaders ?? []).length,
    steps,
    elapsed_ms: Math.round(elapsed),
    finalPhase: G.phase,
    pendingChoice: G.pendingChoice?.kind ?? null,
    logEntries: G.turnLog.length,
    metrics,
    log: G.turnLog,
  };
}

/** Empire-side diagnostics mined from the turn log — the signal that tells us
 *  WHY the Empire wins/loses, not just whether it did. */
function computeEmpireMetrics(G) {
  const baseSys = G.rebelBaseSystemId;
  let baseFoundTurn = null;
  let empireActivations = 0, empireLeaderOnly = 0, empirePasses = 0, empireReveals = 0;
  let subjugations = 0, baseInvasions = 0;
  for (const e of G.turnLog) {
    if (e.kind === 'reveal-base' && baseFoundTurn === null) baseFoundTurn = e.turn;
    else if (e.kind === 'activate-system' && e.side === 'Empire') {
      empireActivations++;
      if ((e.payload?.orders ?? 0) === 0) empireLeaderOnly++;
    } else if (e.kind === 'pass' && e.side === 'Empire') empirePasses++;
    else if (e.kind === 'reveal-mission' && e.side === 'Empire') empireReveals++;
    else if (e.kind === 'subjugated') subjugations++;
    else if (e.kind === 'combat-begin' && e.payload?.attackerSide === 'Empire'
             && e.payload?.systemId === baseSys) baseInvasions++;
  }
  return {
    baseFound: baseFoundTurn !== null,
    baseFoundTurn,
    empireActivations,
    empireLeaderOnly,
    empirePasses,
    empireReveals,
    subjugations,
    baseInvasions,
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
  totalObjectives: 0,
  totalSteps: 0,
  totalElapsedMs: 0,
  winReasons: {},
  finalPhases: {},
  pendingChoiceAtEnd: {},
  // Empire diagnostics
  baseFoundGames: 0,
  baseFoundTurnSum: 0,
  empireActivations: 0,
  empireLeaderOnly: 0,
  empirePasses: 0,
  empireReveals: 0,
  subjugations: 0,
  baseInvasions: 0,
  baseInvasionGames: 0,
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
  stats.totalObjectives += r.scoredObjectives;
  stats.totalSteps += r.steps;
  stats.totalElapsedMs += r.elapsed_ms;
  stats.winReasons[r.winReason ?? 'none'] = (stats.winReasons[r.winReason ?? 'none'] ?? 0) + 1;
  stats.finalPhases[r.finalPhase] = (stats.finalPhases[r.finalPhase] ?? 0) + 1;
  if (r.pendingChoice) {
    stats.pendingChoiceAtEnd[r.pendingChoice] = (stats.pendingChoiceAtEnd[r.pendingChoice] ?? 0) + 1;
  }
  const m = r.metrics;
  if (m.baseFound) { stats.baseFoundGames++; stats.baseFoundTurnSum += m.baseFoundTurn; }
  stats.empireActivations += m.empireActivations;
  stats.empireLeaderOnly += m.empireLeaderOnly;
  stats.empirePasses += m.empirePasses;
  stats.empireReveals += m.empireReveals;
  stats.subjugations += m.subjugations;
  stats.baseInvasions += m.baseInvasions;
  if (m.baseInvasions > 0) stats.baseInvasionGames++;

  // Write per-game JSON.
  const filename = `game-${String(i + 1).padStart(4, '0')}.json`;
  writeFileSync(join(args.out, filename), JSON.stringify({
    schemaVersion: 1,
    seed,
    // WHICH AI was deciding, per side. Without this a stronger-opponent arm
    // is indistinguishable from heuristic self-play once the run finishes —
    // the exact "which AI is deciding" trap docs/ab-levers.md warns about.
    // Any analysis script that pools directories should key on this.
    policies: {
      Rebel: rebelPolicyName ?? 'heuristic',
      Empire: empirePolicyName ?? 'heuristic',
      search: (rebelPolicyName || empirePolicyName)
        ? { budget: Number(process.env.SWR_MCTS_BUDGET ?? 64), horizon: Number(process.env.SWR_MCTS_HORIZON ?? 4), fast: !!args.fastSearch }
        : null,
    },
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
console.log(`Avg Rebel objectives:   ${(stats.totalObjectives / stats.games).toFixed(2)}`);
console.log(`Avg steps per game:     ${(stats.totalSteps / stats.games).toFixed(0)}`);
console.log(`Avg ms per game:        ${(stats.totalElapsedMs / stats.games).toFixed(0)}`);
console.log('');
console.log('=== Empire diagnostics ===');
const g = stats.games;
console.log(`Base found:             ${stats.baseFoundGames}/${g} (${(100 * stats.baseFoundGames / g).toFixed(1)}%)`
  + (stats.baseFoundGames ? `, avg on round ${(stats.baseFoundTurnSum / stats.baseFoundGames).toFixed(1)}` : ''));
console.log(`Games w/ base invasion: ${stats.baseInvasionGames}/${g} (${(100 * stats.baseInvasionGames / g).toFixed(1)}%)`);
console.log(`Avg base invasions:     ${(stats.baseInvasions / g).toFixed(2)} per game`);
console.log(`Avg subjugations:       ${(stats.subjugations / g).toFixed(1)} per game`);
console.log(`Avg Empire activations: ${(stats.empireActivations / g).toFixed(1)} per game (${(stats.empireLeaderOnly / g).toFixed(1)} leader-only / no-troop)`);
console.log(`Avg Empire missions:    ${(stats.empireReveals / g).toFixed(1)} revealed per game`);
console.log(`Avg Empire passes:      ${(stats.empirePasses / g).toFixed(1)} per game`);
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
