// Consolidation / assault benchmark — the gate for the Empire structural rebuild.
//
// Runs self-play and measures, among games where the base is REVEALED, how well
// the Empire consolidates force and converts the reveal into a capture. These are
// the metrics Phase 1 (the assault executor) and Phase 2 (the buildup doctrine)
// must move:
//   - conversion:        of revealed-base games, how many end in an Empire win
//   - groundNearReveal:  Empire mobile ground within 2 hops of the base AT reveal
//                        (the buildup metric — is force already staged? Component B)
//   - deliveredGround:   Empire ground in the base system at the first assault
//                        (the executor metric — did it mass enough? Component A)
//   - groundShortfall:   share of assaults arriving with ground <= Rebel ground
//   - turnsToCapture:    rounds from reveal to capture (lower = sharper executor)
//
// Usage: node scripts/consolidation-bench.mjs [games]
import { readFileSync } from 'node:fs';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(new URL('../assets/' + p, import.meta.url), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const N = parseInt(process.argv[2] ?? '250', 10);

const isMobileGround = (G, tid) => { const t = G.catalog.unitTypes[tid]; return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile; };
function hops(G, from, max) { const dist = { [from]: 0 }; let frontier = [from]; for (let d = 1; d <= max; d++) { const next = []; for (const s of frontier) for (const a of (G.catalog.adjacency[s] ?? [])) if (dist[a] === undefined) { dist[a] = d; next.push(a); } frontier = next; } return dist; }

let games = 0, empWins = 0;
let revealed = 0, converted = 0;
let sumGroundNearReveal = 0, sumDeliveredGround = 0, sumRebelGroundAtAssault = 0, assaults = 0, shortfalls = 0;
let sumTurnsToCapture = 0, captureTimed = 0;

for (let i = 0; i < N; i++) {
  const seed = 1000 + i; seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: false });
  let s = 0; while (G.phase === 'Setup' && s++ < 100) { if (!aiStep(G, G.currentPlayer)) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!aiStep(G, o)) { phases.setupAutoFill(G, 'Rebel'); phases.setupAutoFill(G, 'Empire'); } } }
  let everRevealed = false, revealTurn = null, measuredReveal = false, firstAssault = false, inCombat = false, st = 0;
  while (!G.isGameOver && st < 200000) {
    const base = G.rebelBaseSystemId;
    if (G.rebelBaseRevealed && !measuredReveal) {
      measuredReveal = true; everRevealed = true; revealTurn = G.timeMarker;
      const d = hops(G, base, 2); let g = 0;
      for (const [sid, ss] of Object.entries(G.map.systems)) if (sid !== base && d[sid] !== undefined) for (const u of ss.units) if (u.side === 'Empire' && isMobileGround(G, u.typeId)) g++;
      sumGroundNearReveal += g;
    }
    const pc = G.pendingCombat;
    if (pc && !inCombat && pc.attackerSide === 'Empire' && pc.systemId === base && G.rebelBaseRevealed && !firstAssault) {
      firstAssault = true; assaults++;
      let eg = 0, rg = 0; for (const u of G.map.systems[base].units) { if (u.side === 'Empire' && isMobileGround(G, u.typeId)) eg++; else if (u.side === 'Rebel') { const t = G.catalog.unitTypes[u.typeId]; if (t?.theater === 'ground') rg++; } }
      sumDeliveredGround += eg; sumRebelGroundAtAssault += rg; if (eg <= rg) shortfalls++;
    }
    inCombat = !!pc;
    const sd = G.currentPlayer; if (aiStep(G, sd)) { st++; continue; }
    const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (aiStep(G, o)) { st++; continue; } break;
  }
  if (!G.isGameOver && G.timeMarker > 16) G.isGameOver = true;
  games++; const win = G.winner === 'Empire'; if (win) empWins++;
  if (everRevealed) { revealed++; if (win) { converted++; if (revealTurn != null) { sumTurnsToCapture += Math.max(0, G.timeMarker - revealTurn); captureTimed++; } } }
}
const f = (x, d = 1) => x.toFixed(d);
console.log(`Consolidation benchmark — ${games} self-play games\n`);
console.log(`  Empire win-rate (overall):        ${f(100 * empWins / games, 1)}%`);
console.log(`  Base revealed:                    ${revealed}/${games} (${f(100 * revealed / games, 0)}%)`);
console.log(`  ...CONVERTED to a win:            ${converted}/${revealed} (${revealed ? f(100 * converted / revealed, 0) : 0}%)   <- Component A+B gate`);
console.log(`\n  Buildup (Component B) — ground staged at reveal:`);
console.log(`    Empire mobile ground within 2 hops of base AT reveal: ${revealed ? f(sumGroundNearReveal / revealed) : 0}`);
console.log(`\n  Executor (Component A) — force delivered to the assault:`);
console.log(`    first base assaults observed:     ${assaults}`);
console.log(`    delivered Empire ground:          ${assaults ? f(sumDeliveredGround / assaults) : 0}  vs Rebel ground ${assaults ? f(sumRebelGroundAtAssault / assaults) : 0}`);
console.log(`    assaults arriving under-strength: ${assaults ? f(100 * shortfalls / assaults, 0) : 0}%  (ground <= Rebel ground)`);
console.log(`    rounds from reveal to capture:    ${captureTimed ? f(sumTurnsToCapture / captureTimed) : '-'}`);
