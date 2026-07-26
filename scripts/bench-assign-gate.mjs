// A/B the assignment/command consistency gate (task #8, passivity cluster).
//
// Win rate is NOT the headline here. Hold-defender self-play already maxes the
// Empire, so anti-passivity changes read as flat-or-negative on win rate even
// when they fix the reported behavior — that is exactly why the learned leaf
// eval and the aggression term both A/B'd null. So this bench reports the
// BEHAVIORAL metrics the players actually complained about, and carries win
// rate only as a "did we break anything" guard:
//
//   actions/round   activations + reveals taken before passing  (#574 "only
//                   uses 2 leaders per turn")
//   stranded/game   missions still face-down when the side passed (#581/#617)
//   assigned/game   missions committed — watch this doesn't collapse
//   activations     system activations (#599 "not moving units")
//
// Run both arms:
//   node scripts/bench-assign-gate.mjs 40            (gate ON  = default)
//   SWR_ASSIGN_GATE=0 node scripts/bench-assign-gate.mjs 40   (gate OFF)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json') };

const GAMES = Number(process.argv[2] ?? 40);
const gateOn = (() => { try { return process.env.SWR_ASSIGN_GATE !== '0'; } catch { return true; } })();
const divOn = (() => { try { return process.env.SWR_ACTIVATE_DIVERSITY !== '0'; } catch { return true; } })();

const stat = { Empire: mk(), Rebel: mk() };
function mk() { return { assigned: 0, reveals: 0, activations: 0, passes: 0, stranded: 0, wins: 0 }; }
let finished = 0;

for (let seed = 1; seed <= GAMES; seed++) {
  AI.seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: true,
    expansion: { enabled: true, roteUnits: true, roteMissionsRebel: true, roteMissionsEmpire: true } });
  let guard = 0;
  while (!G.isGameOver && guard++ < 6000) {
    const side = G.currentPlayer;
    // Count face-down missions at the moment this side commits to passing.
    if (G.phase === 'Command' && !G.pendingChoice && !G.pendingMission && !G.pendingCombat) {
      let about = null;
      try { about = AI.bestCommandAction(G, side)[0]; } catch { /* ignore */ }
      if (about && about.kind === 'pass') {
        const f = side === 'Rebel' ? G.rebel : G.empire;
        stat[side].stranded += f.leadersOnMissions.length;
      }
    }
    if (!AI.stepOnce(G, side)) {
      const o = side === 'Rebel' ? 'Empire' : 'Rebel';
      if (!AI.stepOnce(G, o)) break;
    }
  }
  if (G.isGameOver) finished++;
  for (const e of G.turnLog) {
    const s = e.side; if (s !== 'Empire' && s !== 'Rebel') continue;
    if (e.kind === 'assign-leader') stat[s].assigned++;
    else if (e.kind === 'reveal-mission') stat[s].reveals++;
    else if (e.kind === 'activate-system') stat[s].activations++;
    else if (e.kind === 'pass') stat[s].passes++;
  }
  if (G.winner === 'Empire' || G.winner === 'Rebel') stat[G.winner].wins++;
}

const f2 = (x) => x.toFixed(2);
console.log(`arm: assign-gate ${gateOn ? 'ON' : 'OFF'} / activate-diversity ${divOn ? 'ON' : 'OFF'}` +
  `   games: ${GAMES}   finished: ${finished}`);
for (const side of ['Empire', 'Rebel']) {
  const s = stat[side];
  console.log(`  ${side.padEnd(6)}  assigned/game ${f2(s.assigned / GAMES).padStart(6)}` +
    `  reveals/game ${f2(s.reveals / GAMES).padStart(6)}` +
    `  activations/game ${f2(s.activations / GAMES).padStart(6)}` +
    `  passes/game ${f2(s.passes / GAMES).padStart(5)}` +
    `  STRANDED/game ${f2(s.stranded / GAMES).padStart(6)}` +
    `  actions/pass ${f2((s.reveals + s.activations) / Math.max(1, s.passes)).padStart(5)}`);
}
console.log(`  win rate — Empire ${(100 * stat.Empire.wins / GAMES).toFixed(1)}%` +
  `  Rebel ${(100 * stat.Rebel.wins / GAMES).toFixed(1)}%`);
