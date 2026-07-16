// Replay harness for the suspected "depth-2 RM bypass" (log a34dc0f6adb9b437:
// AI Rebel hopped its hidden base felucia->ilum->nal-hutta->ryloth on t1/2/3).
// VERDICT: NOT A BYPASS. This replay — the game's own t1 snapshot under the
// production Rebel policy (depth2-eval) — resolves the RM branch to move-units
// and the base never moves. The recorded game's meta.build (bb613e4) was
// stamped at UPLOAD time; meta.encodedAt shows the game finished 2026-07-15
// 21:38Z on a bundle loaded BEFORE the branch fix deployed (~19:35Z). Fixed by
// stamping build at archive time. Kept as the template for replaying a v2
// log snapshot under production AI wiring.
// Run: node scripts/repro-rm-bypass.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { readGameLog, snapshotToCodec } = await import('./lib/log-reader.mjs');
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const AI = await import('../src/play/randomAI.ts');
const BE = await import('../src/play/boardEval.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const g = readGameLog(join(ROOT, 'logs', 'a34dc0f6adb9b437.json'));
const snap = g.snapshots.find((s) => s.turn === 1) ?? g.snapshots[0];
console.log('snapshot: turn', snap.turn, 'at', snap.at);
const G = codec.decode(snapshotToCodec(snap.state), setup.buildCatalog(data));
console.log('tm:', G.timeMarker, 'phase:', G.phase, 'cp:', G.currentPlayer, 'base:', G.rebelBaseSystemId, 'revealed:', G.rebelBaseRevealed);

// Production wiring: depth-2 Rebel.
AI.seedAI(99);
AI.setCommandPolicyOverride('Rebel', (gg, s) => BE.evalCommandStepDeep(gg, s, 2));

// If the snapshot decodes mid-Refresh, resume it (hunt-replay harness lesson).
if (G.phase === 'Refresh' && phases.resumeRefreshTurnStart) phases.resumeRefreshTurnStart(G);

const logStart = G.turnLog.length;
let steps = 0;
while (!G.isGameOver && G.timeMarker <= 2 && steps++ < 600) {
  const side = G.currentPlayer;
  if (!AI.stepOnce(G, side)) {
    const o = side === 'Rebel' ? 'Empire' : 'Rebel';
    if (!AI.stepOnce(G, o)) break;
  }
}
console.log('\nsteps:', steps, 'tm now:', G.timeMarker, 'base now:', G.rebelBaseSystemId, 'revealed:', G.rebelBaseRevealed);
console.log('\nRM-related events:');
for (const e of G.turnLog.slice(logStart)) {
  if (/rapid-mobilization|RapidMobilization/.test(e.kind + JSON.stringify(e.payload ?? {}))) {
    console.log(' t' + e.turn, e.side ?? '', e.kind, JSON.stringify(e.payload ?? {}).slice(0, 120));
  }
}
