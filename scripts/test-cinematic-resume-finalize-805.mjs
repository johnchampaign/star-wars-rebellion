// #805 — "Empire had 1 Stormtrooper, Rebels 1 trooper. Empire played Support
// of the 501st, Rebels played Hold Them Back. Empire removed my unit, but the
// bottom of Hold Them Back does 1 hit. At the end of the ground battle the
// Stormtrooper was still there."
//
// Support of the 501st's primary destroys the last Rebel ground unit outright
// while the tactic step resolves. Hold Them Back's secondary then stages the
// Stormtrooper for end-of-step destruction. The Empire's attack then pauses
// (reroll window), and on resume runCombat re-tested "do both sides still
// have ground units?" — no — so it skipped the rest of the step, including
// finalizeTheaterDestructions, and endCombat wiped the damage. Pins that an
// in-progress step is resumed and the doomed unit dies, unless the Empire
// legitimately removes the damage with a ★ die.
//
// Run: node scripts/test-cinematic-resume-finalize-805.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();

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

console.log('[ #805 — Hold Them Back damage lands after the last Rebel unit falls ]');
let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); ok ? pass++ : fail++; };

let killed = 0, healedSaves = 0, wrongSurvivors = 0, played = 0;
for (let seed = 1; seed <= 40; seed++) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
    expansion: { enabled: true, cinematicCombat: true },
  });
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-vanguard', 'felucia');
  const before = G.turnLog.length;
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  combat.runCombat(G);
  let guard = 0;
  while (G.pendingCombat && G.pendingChoice && guard++ < 200) {
    const pc = G.pendingChoice;
    if (pc.kind === 'CinematicTacticSelect' && pc.round === 1) {
      const id = pc.side === 'Empire' ? 'cin-empire-ground-support-of-the-501st' : 'cin-rebel-ground-hold-them-back';
      if (!combat.resolveCinematicTacticSelect(G, id, pc.side === 'Empire').ok) break;
      continue;
    }
    if (!stepOnce(G, pc.side)) break;
  }
  const evs = G.turnLog.slice(before);
  if (!evs.some((e) => e.kind === 'cinematic-tactic-play' && e.payload?.cardId === 'cin-rebel-ground-hold-them-back' && e.payload?.dealt === 1)) continue;
  played++;
  const st = G.map.systems.felucia.units.filter((u) => u.typeId === 'stormtrooper');
  const healed = evs.some((e) => e.kind === 'cinematic-remove-damage' && e.side === 'Empire');
  if (st.length === 0) killed++;
  else if (healed) healedSaves++;
  else wrongSurvivors++;
}
check(played >= 35, `scenario reproduced: both cards resolved as reported (${played}/40)`);
check(wrongSurvivors === 0, `no Stormtrooper survives Hold Them Back without a ★ heal (${wrongSurvivors})`);
check(killed > healedSaves, `the Stormtrooper is destroyed in the usual case (${killed} killed, ${healedSaves} saved by ★)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
