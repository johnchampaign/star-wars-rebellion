import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
const SEED = parseInt(process.argv[2] || '12', 10);
const IDX = parseInt(process.argv[3] || '313', 10);
seedAI(SEED);
const G = createGame(data, { seed: SEED, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
let safety = 0;
while (G.phase === 'Setup' && safety++ < 200) {
  if (aiStep(G, G.currentPlayer)) continue;
  const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
  if (aiStep(G, o)) continue;
  const r1 = phases.setupAutoFill(G, 'Rebel'); const r2 = phases.setupAutoFill(G, 'Empire');
  if (!r1.ok && !r2.ok) break;
}
let steps = 0;
while (!G.isGameOver && steps < 200000) {
  if (aiStep(G, G.currentPlayer)) { steps++; continue; }
  const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
  if (aiStep(G, o)) { steps++; continue; }
  break;
}
const log = G.turnLog;
const lo = Math.max(0, IDX - 22), hi = Math.min(log.length, IDX + 4);
for (let i = lo; i < hi; i++) {
  const e = log[i];
  const mark = i === IDX ? ' <<< VIOLATION' : '';
  console.log(`${i} t${e.turn ?? '?'} ${e.side ?? ''} ${e.kind} ${JSON.stringify(e.payload ?? {}).slice(0, 120)}${mark}`);
}
