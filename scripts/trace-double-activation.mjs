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
// Step manually, printing a trace whenever an activate/reveal is logged, plus
// the currentPlayer/passed state just before each aiStep. Stop after we see the
// second consecutive Empire action in a command phase.
let steps = 0, lastLogLen = G.turnLog.length, lastActor = null, stopAfter = 0;
while (!G.isGameOver && steps < 200000) {
  const before = { cp: G.currentPlayer, passed: [...(G.passedThisCommand ?? [])], phase: G.phase };
  const did = aiStep(G, G.currentPlayer);
  if (!did) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!aiStep(G, o)) break; }
  steps++;
  // Inspect any new log entries.
  for (let i = lastLogLen; i < G.turnLog.length; i++) {
    const e = G.turnLog[i];
    if (G.phase !== 'Command' && e.kind !== 'phase') { /* ignore */ }
    if (e.kind === 'phase') lastActor = null;
    if ((e.kind === 'activate-system' || e.kind === 'reveal-mission') && e.side) {
      const opp = e.side === 'Rebel' ? 'Empire' : 'Rebel';
      const viol = lastActor === e.side && !(G.passedThisCommand ?? []).includes(opp);
      if (e.turn === 3 || viol) {
        console.log(`[idx ${i}] t${e.turn} ${e.side} ${e.kind} | beforeStep: cp=${before.cp} passed=[${before.passed}] | now: cp=${G.currentPlayer} passed=[${(G.passedThisCommand ?? []).join(',')}]${viol ? '  <<< VIOLATION' : ''}`);
        if (i === 292) {
          console.log(`   pending: choice=${G.pendingChoice?.kind ?? null} combat=${!!G.pendingCombat} mission=${G.pendingMission?.missionId ?? null}`);
          console.log(`   rebel.objectiveHand=[${(G.rebel.objectiveHand ?? []).join(',')}]`);
          console.log(`   empire.actionHand=[${(G.empire.actionHand ?? []).join(',')}]`);
          console.log(`   rebel.actionHand=[${(G.rebel.actionHand ?? []).join(',')}]`);
          console.log(`   rebelBaseRevealed=${G.rebelBaseRevealed} rapidMob=${JSON.stringify(G.pendingRapidMobilizations ?? G.rapidMobilizationQueue ?? null)}`);
        }
      }
      if (viol && stopAfter === 0) stopAfter = steps + 2;
      lastActor = e.side;
    }
  }
  lastLogLen = G.turnLog.length;
  if (stopAfter && steps >= stopAfter) break;
}
