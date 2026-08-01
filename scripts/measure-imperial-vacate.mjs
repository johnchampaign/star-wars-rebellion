// measure-imperial-vacate.mjs — INSTRUMENTATION, not a pass/fail gate.
//
// #625/#632: "AI Imperials are leaving Imperial loyal systems with no units",
// "moved ALL units away from an imperial loyal system... removing the ability
// for Imperials to deploy or generate any units."
//
// Win-rate benchmarks cannot see this. eval-strength measures each side against
// a RANDOM opponent, and a random Rebel does not systematically punish a vacated
// producing system — exactly as a random opponent could not show the value of the
// War of the Ring garrison fix. So count the mechanism instead:
//
//   VACATED  — an Imperial-loyal PRODUCING system that had Empire units and then
//              had none. Each one is a free opening the Empire handed over.
//   LOST     — of those, the ones that were Rebel-loyal by the end of the game.
//
// Run: node scripts/measure-imperial-vacate.mjs [--games 40]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const ai = await import('../src/play/randomAI.ts');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const GAMES = arg('--games', 40);
const MAX_STEPS = 20000;

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

const empireUnitsAt = (G, sid) => (G.map.systems[sid]?.units ?? []).filter((u) => u.side === 'Empire').length;
const produces = (G, sid) => (G.catalog.systems[sid]?.resources?.length ?? 0) > 0;

let vacated = 0, lost = 0, gamesDone = 0, empireWins = 0;

for (let g = 0; g < GAMES; g++) {
  let G;
  try { G = createGame(data, { seed: g + 1, autoSetupUnits: true }); } catch (e) {
    if (g === 0) console.error('  createGame failed:', e?.message ?? e);
    continue;
  }
  const everVacated = new Set();
  const hadUnits = new Set();

  for (let s = 0; s < MAX_STEPS; s++) {
    if (G.isGameOver) break;
    const actor = rebellionAdapter.currentActor(G);
    if (!actor) break;
    let did = false;
    try { did = ai.stepOnce(G, actor); } catch { break; }
    if (!did) break;

    for (const sid of Object.keys(G.map.systems)) {
      const ss = G.map.systems[sid];
      if (!produces(G, sid)) continue;
      const imperial = ss.loyalty === 'imperial' || ss.subjugated;
      const n = empireUnitsAt(G, sid);
      if (imperial && n > 0) hadUnits.add(sid);
      // Held it, then walked out entirely, while it was still ours to lose.
      if (imperial && n === 0 && hadUnits.has(sid)) everVacated.add(sid);
    }
  }

  for (const sid of everVacated) {
    vacated++;
    if (G.map.systems[sid]?.loyalty === 'rebel') lost++;
  }
  if (G.isGameOver && G.winner === 'Empire') empireWins++;
  gamesDone++;
}

const per = (x) => (gamesDone ? (x / gamesDone).toFixed(2) : '0');
console.log(`\n=== Imperial producing systems walked out of, ${gamesDone} self-play games ===`);
console.log(`  VACATED (held, then emptied): ${vacated}   (${per(vacated)}/game)`);
console.log(`  ...of those LOST to Rebel loyalty by game end: ${lost}   (${per(lost)}/game)`);
console.log(`  Empire wins: ${empireWins}/${gamesDone}`);
console.log();
