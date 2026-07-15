// #569 — reproduce: after the Rebel destroys the Death Star Under Construction
// on turn 1, every Empire AI response reportedly slows to as much as a minute.
// Load the reporter's exact turn-1 state, verify the DSUC situation, then time
// Empire AI decisions (MCTS default-on, like production).
// Run: node scripts/repro-569-dsuc-slowdown.mjs <path-to-state.json>
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const statePath = process.argv[2];
const wrapper = JSON.parse(readFileSync(statePath, 'utf8'));
const G = codec.decode(JSON.stringify(wrapper), setup.buildCatalog(data));

console.log('timeMarker:', G.timeMarker, 'phase:', G.phase, 'currentPlayer:', G.currentPlayer);
console.log('pending: choice=%s mission=%s combat=%s',
  G.pendingChoice?.kind, G.pendingMission?.missionId, !!G.pendingCombat);

// Where's the DSUC?
for (const [sid, ss] of Object.entries(G.map.systems)) {
  const dsuc = (ss.units ?? []).filter((u) => /under-construction|dsuc/i.test(u.typeId));
  if (dsuc.length) console.log('DSUC at', sid, dsuc.map((u) => u.typeId));
}
console.log('empire projects/hand sizes:', {
  projectDeck: G.empire.projectDeck?.length, projectsActive: G.empire.projectsActive?.length ?? (G.empire.projects?.length),
});

// Production wiring: AI Empire runs the MCTS command policy (default-on).
const mcts = await import('../src/play/mctsAI.ts');
AI.setCommandPolicyOverride('Empire', (g, s) => mcts.mctsCommandStep(g, s));

// Time Empire AI steps from this exact state (MCTS policy, like the browser).
let steps = 0; const times = [];
const t00 = Date.now();
while (steps < 120 && !G.isGameOver) {
  const side = G.currentPlayer;
  const t0 = Date.now();
  let did = false;
  try { did = AI.stepOnce(G, side); } catch (e) { console.log('THREW at step', steps, e.message); break; }
  const dt = Date.now() - t0;
  times.push({ step: steps, side, dt, phase: G.phase });
  if (!did) {
    const o = side === 'Rebel' ? 'Empire' : 'Rebel';
    try { did = AI.stepOnce(G, o); } catch (e) { console.log('THREW (other) at step', steps, e.message); break; }
    if (!did) break;
  }
  steps++;
  if (Date.now() - t00 > 120_000) { console.log('WALL CLOCK CAP HIT'); break; }
}
times.sort((a, b) => b.dt - a.dt);
console.log('\ntotal steps:', steps, 'wall:', Date.now() - t00, 'ms');
console.log('slowest 10 steps:');
for (const t of times.slice(0, 10)) console.log(` step ${t.step} ${t.side} ${t.phase} ${t.dt}ms`);
