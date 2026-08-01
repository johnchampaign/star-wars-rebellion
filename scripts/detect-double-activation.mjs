// Detector for the "double/triple activation" cluster (#488/#493/#494/#500/#509):
// a side taking 2+ consecutive Command-phase actions (activate-system /
// reveal-mission) with NO intervening opponent action AND without the opponent
// having passed — which RAW forbids (players strictly alternate until a pass).
// Runs RoE AI-vs-AI self-play and scans each game's log.
// Run: node scripts/detect-double-activation.mjs [--games N]
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

const GAMES = (() => { const i = process.argv.indexOf('--games'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 40; })();

function playOne(seed) {
  seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: false,
    expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
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
  if (!G.isGameOver && G.timeMarker > 16) { G.isGameOver = true; }
  return G.turnLog;
}

// Scan a log for consecutive same-side command actions with no opponent turn /
// pass between them, within one Command phase.
function scanViolations(log) {
  const viols = [];
  let inCommand = false;
  let passed = new Set();
  let lastActor = null;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.kind === 'phase') {
      inCommand = e.payload?.phase === 'Command';
      passed = new Set();
      lastActor = null;
      continue;
    }
    if (!inCommand) continue;
    if (e.kind === 'pass' && e.side) { passed.add(e.side); continue; }
    if ((e.kind === 'activate-system' || e.kind === 'reveal-mission') && e.side) {
      const opp = e.side === 'Rebel' ? 'Empire' : 'Rebel';
      if (lastActor === e.side && !passed.has(opp)) {
        viols.push({ turn: e.turn, side: e.side, kind: e.kind, idx: i });
      }
      lastActor = e.side;
    }
  }
  return viols;
}

let totalViols = 0, gamesWithViols = 0;
const examples = [];
for (let seed = 1; seed <= GAMES; seed++) {
  let log;
  try { log = playOne(seed); } catch (err) { console.log(`  seed ${seed}: threw ${err.message}`); continue; }
  const v = scanViolations(log);
  if (v.length) {
    gamesWithViols++;
    totalViols += v.length;
    if (examples.length < 6) examples.push({ seed, first: v[0], count: v.length });
  }
}
console.log(`Scanned ${GAMES} RoE self-play games.`);
console.log(`Games with double-activation violations: ${gamesWithViols}/${GAMES}`);
console.log(`Total violations: ${totalViols}`);
for (const ex of examples) {
  console.log(`  seed=${ex.seed}: ${ex.count} viol(s); first = ${ex.first.side} ${ex.first.kind} @ turn ${ex.first.turn} (log idx ${ex.first.idx})`);
}
