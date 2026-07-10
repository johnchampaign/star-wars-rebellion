// Tough-defender consolidation benchmark (#539).
//
// The plain consolidation-bench saturates: the AI-Rebel base is thin (~4 ground)
// and falls 0.5-0.7 rounds after reveal, so the Empire's post-reveal delivery
// doctrine (mass, reinforce inward, deploy strong+carrier adjacent, dash) never
// gets a second round to matter — delivered ~5 is already enough and every A/B
// comes back flat. That's a TEST-opponent artifact, not evidence the doctrine is
// worthless (the real payoff is vs a human who defends thick and relocates).
//
// This harness recreates the human regime: at the moment the base is revealed it
// tops the base garrison up to a human-plausible defense (TOUGH ground + a
// structure) so the base SURVIVES the first assault and forces the Empire to
// actually mass and deliver over several rounds. The top-up is applied
// IDENTICALLY with the planner off and on, so it's a fair A/B of the Empire's
// delivery — the only thing that differs between arms is SWR_EMPIRE_PLANNER.
//
// Measures, among revealed-base games: Empire win-rate, PEAK Empire ground ever
// delivered to the base, ground at the FIRST assault, ground at the CAPTURING
// assault, and rounds from reveal to capture.
//
// Usage: [SWR_EMPIRE_PLANNER=1] node scripts/consolidation-bench-hard.mjs [games] [tough=8]
import { readFileSync } from 'node:fs';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(new URL('../assets/' + p, import.meta.url), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const N = parseInt(process.argv[2] ?? '150', 10);
const TOUGH = parseInt(process.argv[3] ?? '8', 10);

const isMobileGround = (G, tid) => { const t = G.catalog.unitTypes[tid]; return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile; };
const rebelGroundAt = (G, base) => { let g = 0; for (const u of G.map.systems[base].units) { const t = G.catalog.unitTypes[u.typeId]; if (u.side === 'Rebel' && t?.theater === 'ground') g++; } return g; };
const empireGroundAt = (G, base) => { let g = 0; for (const u of G.map.systems[base].units) if (u.side === 'Empire' && isMobileGround(G, u.typeId)) g++; return g; };

// Top the base up to TOUGH Rebel ground (+ a shield-generator structure once) to
// simulate a human-defended base. Returns true if it injected anything.
function fortifyBase(G, base, tag) {
  const ss = G.map.systems[base];
  let injected = false;
  let n = rebelGroundAt(G, base);
  let k = 0;
  while (n < TOUGH) {
    ss.units.push({ instanceId: `fort-${tag}-g${k++}`, typeId: 'rebel-trooper', side: 'Rebel', damage: 0 });
    n++; injected = true;
  }
  // one structure (shield generator) if the type exists and none present
  if (G.catalog.unitTypes['shield-generator'] && !ss.units.some((u) => u.side === 'Rebel' && u.typeId === 'shield-generator')) {
    ss.units.push({ instanceId: `fort-${tag}-s`, typeId: 'shield-generator', side: 'Rebel', damage: 0 });
    injected = true;
  }
  return injected;
}

let games = 0, empWins = 0, revealed = 0, converted = 0;
let sumPeak = 0, sumFirst = 0, firsts = 0, sumCapGround = 0, caps = 0, sumTurns = 0;

for (let i = 0; i < N; i++) {
  const seed = 1000 + i; seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: false });
  let s = 0; while (G.phase === 'Setup' && s++ < 100) { if (!aiStep(G, G.currentPlayer)) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!aiStep(G, o)) { phases.setupAutoFill(G, 'Rebel'); phases.setupAutoFill(G, 'Empire'); } } }
  let everRevealed = false, revealTurn = null, fortified = false, firstAssault = false, inCombat = false, peak = 0, st = 0;
  while (!G.isGameOver && st < 200000) {
    const base = G.rebelBaseSystemId;
    if (G.rebelBaseRevealed && !fortified && base) {
      // Fortify on the reveal transition (and re-fortify if the Rebel relocated
      // to a fresh empty base) so the defender is consistently human-thick.
      fortifyBase(G, base, i); fortified = true; everRevealed = true; revealTurn = G.timeMarker;
    }
    if (G.rebelBaseRevealed && base) peak = Math.max(peak, empireGroundAt(G, base));
    const pc = G.pendingCombat;
    if (pc && !inCombat && pc.attackerSide === 'Empire' && pc.systemId === base && G.rebelBaseRevealed) {
      const eg = empireGroundAt(G, base), rg = rebelGroundAt(G, base);
      if (!firstAssault) { firstAssault = true; sumFirst += eg; firsts++; }
    }
    inCombat = !!pc;
    const sd = G.currentPlayer; if (aiStep(G, sd)) { st++; continue; }
    const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (aiStep(G, o)) { st++; continue; } break;
  }
  if (!G.isGameOver && G.timeMarker > 16) G.isGameOver = true;
  games++; const win = G.winner === 'Empire'; if (win) empWins++;
  if (everRevealed) {
    revealed++; sumPeak += peak;
    if (win) { converted++; caps++; sumCapGround += peak; if (revealTurn != null) sumTurns += Math.max(0, G.timeMarker - revealTurn); }
  }
}
const f = (x, d = 1) => x.toFixed(d);
console.log(`Tough-defender benchmark — ${games} games, base fortified to ${TOUGH} ground + shield at reveal\n`);
console.log(`  Empire win-rate (overall):        ${f(100 * empWins / games, 1)}%`);
console.log(`  Base revealed:                    ${revealed}/${games} (${f(100 * revealed / games, 0)}%)`);
console.log(`  ...CONVERTED to a win:            ${converted}/${revealed} (${revealed ? f(100 * converted / revealed, 0) : 0}%)`);
console.log(`  PEAK Empire ground delivered:     ${revealed ? f(sumPeak / revealed) : 0}   (target: mass enough to beat ${TOUGH})`);
console.log(`  ground at FIRST assault:          ${firsts ? f(sumFirst / firsts) : 0}`);
console.log(`  PEAK ground in CONVERTED games:   ${caps ? f(sumCapGround / caps) : 0}`);
console.log(`  rounds reveal -> capture:         ${caps ? f(sumTurns / caps) : '-'}`);
