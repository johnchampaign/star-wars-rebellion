// #569 bench — late-game MCTS decision time. Plays a fresh game forward with
// the heuristic until several per-turn 'state' snapshots (~1MB each) have
// accumulated in turnLog, then times Empire MCTS command decisions from there.
// Before the fix, cloneState copied the full snapshot-laden log 64×/decision.
// Run: node scripts/bench-569-mcts-clone.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const G = createGame(data, { seed: 42, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
AI.seedAI(42);
// Heuristic-play forward to turn 6 (accumulates one snapshot per advanceTime).
let guard = 0;
while (!G.isGameOver && G.timeMarker < 6 && guard++ < 5000) {
  if (!AI.stepOnce(G, G.currentPlayer)) {
    const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
    if (!AI.stepOnce(G, o)) break;
  }
}
const snaps = G.turnLog.filter((e) => e.kind === 'state').length;
const logBytes = JSON.stringify(G.turnLog).length;
console.log(`reached turn ${G.timeMarker}, turnLog ${G.turnLog.length} entries, ${snaps} snapshots, ~${(logBytes / 1e6).toFixed(1)}MB`);

// Time Empire MCTS decisions from here (production wiring).
AI.setCommandPolicyOverride('Empire', (g, s) => mcts.mctsCommandStep(g, s));
const times = [];
guard = 0;
while (!G.isGameOver && times.length < 6 && guard++ < 800) {
  const side = G.currentPlayer;
  const t0 = Date.now();
  let did = AI.stepOnce(G, side);
  const dt = Date.now() - t0;
  if (side === 'Empire' && G.phase === 'Command' && dt > 50) times.push(dt);
  if (!did) {
    const o = side === 'Rebel' ? 'Empire' : 'Rebel';
    if (!AI.stepOnce(G, o)) break;
  }
}
console.log('Empire MCTS decision times (ms):', times);
console.log('mean:', times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 'n/a');
