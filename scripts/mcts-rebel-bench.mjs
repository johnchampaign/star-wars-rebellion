// MCTS-Rebel bench — the Rebel-side counterpart of mcts-bench. Self-play:
// the PRODUCTION Empire (MCTS + planner + hunt, as real games run) against
// two Rebel arms on the same seeds:
//   OFF = depth-2 eval (current production Rebel)
//   ON  = MCTS-Rebel (searchMctsCommand, no determinization — knows its base)
// Metric: Rebel win rate + loss reasons + rounds survived. The Rebel knows
// its own base, so no replay/determinization arm is needed; self-play against
// the strongest Empire we have IS the instrument (unlike belief changes,
// nothing here depends on human-like base placement).
// Run: node scripts/mcts-rebel-bench.mjs [--games 12] [--seed 7] [--arm on|off|both]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');
const BE = await import('../src/play/boardEval.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const N = parseInt(flag('--games', '12'), 10);
const SEED = parseInt(flag('--seed', '7'), 10);
const ARM = flag('--arm', 'both');

function playGame(seed, rebelArm) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  AI.seedAI(seed * 13 + 1);
  mcts.seedMCTS(seed * 29 + 3);
  // Production Empire: MCTS command policy.
  AI.setCommandPolicyOverride('Empire', (g, s) => mcts.mctsCommandStep(g, s));
  // Rebel arm.
  AI.setCommandPolicyOverride('Rebel', rebelArm === 'on'
    ? (g, s) => mcts.mctsCommandStep(g, s)
    : (g, s) => BE.evalCommandStepDeep(g, s, 2));
  let guard = 0;
  while (!G.isGameOver && G.timeMarker <= 16 && guard++ < 8000) {
    const side = G.currentPlayer;
    if (!AI.stepOnce(G, side)) {
      const o = side === 'Rebel' ? 'Empire' : 'Rebel';
      if (!AI.stepOnce(G, o)) break;
    }
  }
  AI.setCommandPolicyOverride('Empire', null);
  AI.setCommandPolicyOverride('Rebel', null);
  return { winner: G.winner ?? 'none', reason: G.winReason ?? 'stalled', rounds: G.timeMarker };
}

for (const arm of ARM === 'both' ? ['off', 'on'] : [ARM]) {
  const t0 = Date.now();
  let rebelWins = 0; const reasons = {}; let roundsSum = 0;
  for (let i = 0; i < N; i++) {
    const r = playGame(SEED + i * 101, arm);
    if (r.winner === 'Rebel') rebelWins++;
    reasons[`${r.winner}:${r.reason}`] = (reasons[`${r.winner}:${r.reason}`] ?? 0) + 1;
    roundsSum += r.rounds;
    console.log(`  [${arm}] game ${i + 1}/${N}: ${r.winner} (${r.reason}) rnd ${r.rounds}`);
  }
  console.log(`ARM ${arm.toUpperCase()}: Rebel wins ${rebelWins}/${N} (${Math.round(100 * rebelWins / N)}%), avg rounds ${(roundsSum / N).toFixed(1)}, ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('  outcomes:', JSON.stringify(reasons));
}
