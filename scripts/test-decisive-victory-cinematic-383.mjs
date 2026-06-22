// Decisive Victory in cinematic combat (#383): "Win a space battle and a ground
// battle in the same combat." A theatre won purely via cinematic tactic kills
// (destroy/deal) wasn't being recorded in the combat report, so the objective's
// "a battle was fought here" check missed it and the card never scored. Cinematic
// kills now record to cardDestructions like dice/card kills do.
// Run: node scripts/test-decisive-victory-cinematic-383.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

function runWinBoth(cinematic, seed) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
    expansion: { enabled: true, cinematicCombat: cinematic },
  });
  // Empire: a ship + a ground unit (both theatres). Rebel: overwhelming force.
  M.deployUnit(G, 'Empire', 'tie-fighter', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  for (let i = 0; i < 5; i++) {
    M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
    M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  }
  G.rebel.objectiveHand = ['decisive-victory-1'];
  G.rebel.scoredObjectives = [];
  combat.beginCombat(G, 'Rebel', 'naboo', 'felucia');
  let guard = 0;
  combat.runCombat(G);
  while (G.pendingCombat && guard++ < 400) {
    if (G.pendingChoice) { if (!stepOnce(G, G.pendingChoice.side)) break; }
    else combat.runCombat(G);
  }
  const rep = (G.combatReports ?? [])[G.combatReports.length - 1];
  const scored = (G.rebel.scoredObjectives ?? []).some((s) => s.objectiveId === 'decisive-victory-1');
  return { done: !G.pendingCombat, winner: rep?.winner, scored };
}

for (const cinematic of [false, true]) {
  console.log(`\n[ Decisive Victory fires after winning both theatres — cinematic=${cinematic} ]`);
  let scored = 0, wins = 0, n = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const r = runWinBoth(cinematic, seed);
    if (!r.done) continue;
    n++;
    if (r.winner === 'Rebel') wins++;
    if (r.scored) scored++;
  }
  check(`Rebel won every resolved combat (${wins}/${n})`, wins === n && n > 0);
  check(`Decisive Victory scored every time (${scored}/${n})`, scored === n && n > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
