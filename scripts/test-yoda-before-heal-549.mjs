// #549 — "Luke's reroll in combat seems to happen after you apply heal with your
// dice. The reroll needs to happen before you start using the dice results."
// In cinematic combat the window order was cinematic-reroll -> ★-spend heal ->
// Yoda reroll, so the Yoda reroll fired AFTER the heal already spent ★ dice.
// The Yoda window now runs with the other reroll (before prevent + heal), so the
// rolling side's dice are final before any are used. This drives a Rebel
// cinematic attack that offers BOTH a Yoda reroll and a ★-heal, and asserts the
// Yoda offer comes first.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// A Rebel cinematic space attack at felucia: 2 Mon Cal cruisers (one pre-damaged
// so a ★-heal is offered), a Rebel leader with a space tactic value + the Yoda
// ring at the system (enables both the cinematic reroll and the Yoda reroll).
function setupRebelAttack(seed) {
  const G = createGame(data, { seed, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'], forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'], expansion: { enabled: true, cinematicCombat: true } });
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  // Pre-damage one Rebel cruiser so the ★-heal window has a target.
  const woundable = G.map.systems['felucia'].units.find((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'space');
  if (woundable) woundable.damage = 1;
  const ldr = Object.values(G.catalog.leaders).find((l) => l.side === 'Rebel' && (l.tacticValues?.space ?? 0) > 0);
  G.rebel.leadersOnBoard['felucia'] = [ldr.id];
  M.attachRing(G, ldr.id, 'yoda');
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'space'; c.theaterStaged = []; c.theaterAttackersDone = [];
  return { G, c };
}

// Step through the Rebel attack's pending choices, recording the order of choice
// kinds. Auto-resolve each with a no-op (keep dice / no reroll / no heal) so the
// sequence advances. Returns the ordered list of choice kinds seen.
function choiceOrder(seed) {
  const { G, c } = setupRebelAttack(seed);
  combat.beginAttack(G, c, 'Rebel', 'space');
  const seq = [];
  let guard = 0;
  while (G.pendingChoice && guard++ < 12) {
    const k = G.pendingChoice.kind;
    seq.push(k);
    if (k === 'CinematicReroll') combat.resolveCinematicReroll(G, []);
    else if (k === 'YodaReroll') combat.resolveYodaReroll(G, null);      // skip (keeps ring)
    else if (k === 'CinematicHeal') combat.resolveCinematicHeal(G, []);  // heal nothing
    else break; // some other window — stop; we've seen the two we care about
  }
  return seq;
}

console.log('[ #549 — Yoda reroll is offered BEFORE the ★-heal ]');
let checked = false;
for (let seed = 900; seed < 980 && !checked; seed++) {
  const seq = choiceOrder(seed);
  const yi = seq.indexOf('YodaReroll');
  const hi = seq.indexOf('CinematicHeal');
  if (yi >= 0 && hi >= 0) {
    checked = true;
    check(`both windows fire (seq: ${seq.join(' → ')})`, true);
    check('Yoda reroll comes BEFORE the ★-heal', yi < hi, `yodaIdx=${yi} healIdx=${hi}`);
  }
}
check('found a combat exercising both windows', checked);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
