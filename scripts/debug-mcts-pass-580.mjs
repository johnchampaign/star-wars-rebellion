// #580/#581 passivity diagnosis — load the reporter's exact state, step to the
// Empire's Command decisions, and dump per-arm rollout outcomes (needs
// SWR_MCTS_DEBUG=1 SWR_MCTS=1). Why does 'pass' out-roll a score-43 reveal?
// Run: SWR_MCTS_DEBUG=1 SWR_MCTS=1 node scripts/debug-mcts-pass-580.mjs <state.json>
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const wrapper = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const G = codec.decode(JSON.stringify(wrapper), setup.buildCatalog(data));
console.log('tm:', G.timeMarker, 'phase:', G.phase, 'cp:', G.currentPlayer, 'baseRevealed:', G.rebelBaseRevealed);

mcts.seedMcts?.(7);
AI.seedAI(7);
AI.setCommandPolicyOverride('Empire', (g, s) => mcts.mctsCommandStep(g, s));

// Step until we've seen 3 Empire Command decisions (the debug hook prints arms).
let empireDecisions = 0, guard = 0;
while (!G.isGameOver && empireDecisions < 3 && guard++ < 300) {
  const side = G.currentPlayer;
  const wasEmpireCommand = side === 'Empire' && G.phase === 'Command' && !G.pendingChoice && !G.pendingMission && !G.pendingCombat;
  let did = AI.stepOnce(G, side);
  if (wasEmpireCommand && did) empireDecisions++;
  if (!did) {
    const o = side === 'Rebel' ? 'Empire' : 'Rebel';
    if (!AI.stepOnce(G, o)) break;
  }
}
console.log('done after', guard, 'steps,', empireDecisions, 'Empire command decisions');
