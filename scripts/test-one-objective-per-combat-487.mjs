// #487: "Only one objective can be played during each combat" (RR p.10, "Objective
// Cards"). Reporter destroyed a Death Star in a combat won in BOTH theatres and
// scored Death Star Plans AND Decisive Victory off the same fight. The engine now
// marks the combat's single objective as spent (objectivePlayedThisCombat) so the
// second can't also score.
// Run: node scripts/test-one-objective-per-combat-487.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

// mode: 'attempt' plays Death Star Plans whenever offered; 'decline' always
// refuses it; 'no-dsp' uses a destroyable Empire ship (no Death Star) so
// Decisive Victory can fire the normal way (regression control that the
// combat-end objective path still works when no objective was pre-played).
function run(seed, mode) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
    expansion: { enabled: true },
  });
  // Empire space unit: a Death Star (invulnerable to normal fire; only removable
  // via Death Star Plans) for the DSP modes, or a destroyable Star Destroyer for
  // the no-dsp control. Plus a ground unit so BOTH theatres are contested.
  M.deployUnit(G, 'Empire', mode === 'no-dsp' ? 'star-destroyer' : 'death-star', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  // Rebel: overwhelming fighters (needed alive for the Death Star Plans window) + ground.
  for (let i = 0; i < 6; i++) {
    M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
    M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  }
  G.rebel.objectiveHand = mode === 'no-dsp'
    ? ['decisive-victory-1']
    : ['death-star-plans-2', 'decisive-victory-1'];
  G.rebel.scoredObjectives = [];
  combat.beginCombat(G, 'Rebel', 'naboo', 'felucia');
  let guard = 0;
  combat.runCombat(G);
  while (G.pendingCombat && guard++ < 600) {
    const pc = G.pendingChoice;
    if (pc) {
      if (pc.kind === 'DeathStarPlansAttempt') {
        combat.resolveDeathStarPlansAttempt(G, mode === 'attempt', pc.deathStarInstanceIds?.[0]);
      } else if (!stepOnce(G, pc.side)) break;
    } else {
      combat.runCombat(G);
    }
  }
  const scored = new Set((G.rebel.scoredObjectives ?? []).map((s) => s.objectiveId));
  return {
    done: !G.pendingCombat,
    dsp: scored.has('death-star-plans-2'),
    dv: scored.has('decisive-victory-1'),
    both: scored.has('death-star-plans-2') && scored.has('decisive-victory-1'),
  };
}

console.log('[ #487 — at most one objective scores per combat ]');
let n = 0, dspHits = 0, bothCount = 0;
for (let seed = 1; seed <= 60; seed++) {
  const r = run(seed, 'attempt');
  if (!r.done) continue;
  n++;
  if (r.dsp) dspHits++;
  if (r.both) bothCount++;
}
check(`resolved combats > 0 (${n})`, n > 0);
check(`Death Star Plans scored in some runs (${dspHits}) — exercises the mutual-exclusion`, dspHits > 0);
check(`NEVER both objectives in one combat (both-count=${bothCount})`, bothCount === 0);

// Control (regression): with a destroyable ship and no Death Star, Decisive
// Victory still scores at combat-end as before — proves the endCombat guard
// (skip only when an objective was already played) didn't break the normal path.
let ctrlDv = 0, ctrlN = 0;
for (let seed = 1; seed <= 30; seed++) {
  const r = run(seed, 'no-dsp');
  if (!r.done) continue;
  ctrlN++;
  if (r.dv) ctrlDv++;
}
check(`no-DSP control: Decisive Victory still scores at combat-end (${ctrlDv}/${ctrlN})`, ctrlDv > 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
