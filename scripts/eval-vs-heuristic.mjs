// Head-to-head: eval-greedy Command policy (src/play/boardEval.ts — John's
// static board-value proposal) vs the tuned heuristic (randomAI), same engine,
// mirrored side assignments. This sidesteps part of the self-play saturation
// problem: instead of asking "does the AI beat the clock", we ask which of two
// DIFFERENT policies is stronger when they fight each other directly.
//
// The eval-greedy side only replaces PLAIN Command decisions (reveal/activate/
// pass); assignment, sub-choices, and combat prompts still run through the
// heuristic stepper for both sides — so the comparison isolates the decision
// policy John proposed.
//
// Run: node scripts/eval-vs-heuristic.mjs [--games 150] [--seed 1] [--max-rounds 14]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce, seedAI } = await import('../src/play/randomAI.ts');
const { evalCommandStep, evalCommandStepDeep } = await import('../src/play/boardEval.ts');

const args = { games: 150, seed: 1, maxRounds: 14, depth: 1 };
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--games') args.games = parseInt(a[++i], 10);
    else if (a[i] === '--seed') args.seed = parseInt(a[++i], 10);
    else if (a[i] === '--max-rounds') args.maxRounds = parseInt(a[++i], 10);
    else if (a[i] === '--depth') args.depth = parseInt(a[++i], 10);
  }
}
const evalStep = args.depth >= 2 ? evalCommandStepDeep : evalCommandStep;

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

/** One game; evalSide uses eval-greedy for Command decisions, null = pure heuristic both sides. */
function playOne(seed, evalSide) {
  seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: false });

  const step = (side) => {
    if (side === evalSide && evalStep(G, side)) return true;
    return stepOnce(G, side);
  };

  let setupSafety = 0;
  while (G.phase === 'Setup' && setupSafety++ < 100) {
    if (step(G.currentPlayer)) continue;
    const otherSide = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
    if (step(otherSide)) continue;
    const r1 = phases.setupAutoFill(G, 'Rebel');
    const r2 = phases.setupAutoFill(G, 'Empire');
    if (!r1.ok && !r2.ok) break;
  }

  let steps = 0;
  const STEP_CAP = 200000;
  while (!G.isGameOver && steps < STEP_CAP) {
    if (G.timeMarker > args.maxRounds) { G.isGameOver = true; G.winReason = 'max-rounds-reached'; break; }
    const side = G.currentPlayer;
    if (step(side)) { steps++; continue; }
    const otherSide = side === 'Rebel' ? 'Empire' : 'Rebel';
    if (step(otherSide)) { steps++; continue; }
    break; // stuck
  }
  return {
    result: G.isGameOver ? (G.winner ?? 'none') : 'stuck',
    rounds: G.timeMarker,
    winReason: G.winReason ?? null,
  };
}

function runConfig(label, evalSide) {
  const t0 = performance.now();
  let rebel = 0, empire = 0, stuck = 0, rounds = 0, maxed = 0;
  for (let i = 0; i < args.games; i++) {
    const r = playOne(args.seed * 1000 + i, evalSide);
    if (r.result === 'Rebel') rebel++;
    else if (r.result === 'Empire') empire++;
    else stuck++;
    if (r.winReason === 'max-rounds-reached') maxed++;
    rounds += r.rounds;
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`\n=== ${label} (${args.games} games, seed ${args.seed}, ${secs}s) ===`);
  console.log(`Rebel wins:   ${rebel} (${(100 * rebel / args.games).toFixed(1)}%)`);
  console.log(`Empire wins:  ${empire} (${(100 * empire / args.games).toFixed(1)}%)`);
  console.log(`Stuck:        ${stuck}   Max-rounds: ${maxed}   Avg rounds: ${(rounds / args.games).toFixed(1)}`);
  return { rebel, empire, stuck };
}

const tag = args.depth >= 2 ? `depth-${args.depth}` : 'greedy';
console.log(`Eval-${tag} vs heuristic head-to-head — ${args.games} games/config, seed ${args.seed}`);
const base = runConfig('BASELINE: heuristic vs heuristic', null);
const evalEmp = runConfig(`Eval-${tag} EMPIRE vs heuristic Rebel`, 'Empire');
const evalReb = runConfig(`Eval-${tag} REBEL vs heuristic Empire`, 'Rebel');

console.log('\n=== Verdict ===');
const d1 = (100 * (evalEmp.empire - base.empire) / args.games).toFixed(1);
const d2 = (100 * (evalReb.rebel - base.rebel) / args.games).toFixed(1);
console.log(`Empire policy: eval-greedy shifts Empire wins by ${d1}pt vs baseline`);
console.log(`Rebel policy:  eval-greedy shifts Rebel wins by ${d2}pt vs baseline`);
