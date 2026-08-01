// #667 — "I played the action card point blank assault that gives minus 1 hp to
// each unit in the combat. It didn't work in the battle."
//
// "All units in the system have -1 health, to a minimum of 1" was applied as
// `u.damage = Math.max(u.damage ?? 0, 1)`, which only ever RAISES damage to 1.
// Any unit that had already taken a hit therefore got no reduction at all and
// the card silently did nothing to it.
//
// Boundary case settled by the FFG FAQ rather than guessed: "the Rebel player
// uses Point Blank Assault and then proceeds to destroy an AT-AT by dealing it
// TWO damage" — a 3-health unit dies to 2 damage, so the destruction threshold
// drops by one and a unit already at that threshold is destroyed. The same FAQ
// says Crippling Blow / Baze's Loyalty read the PRINTED health, which is why
// this is modelled as damage instead of editing the catalog.
//
// Run: node scripts/test-point-blank-assault-667.mjs
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

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const SYS = 'felucia';
/** A combat at SYS with the given Imperial ground units, then play the card. */
function play(seed, preDamage) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
    expansion: { enabled: true, roeUnits: true },
  });
  G.map.systems[SYS].units = [];
  M.deployUnit(G, 'Empire', 'at-at', SYS);        // 3 health
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS); // 1 health — the "minimum of 1" case
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  const atat = G.map.systems[SYS].units.find((u) => u.typeId === 'at-at');
  atat.damage = preDamage;
  // The card needs its leader in the system and to be in hand.
  G.rebel.actionHand = ['point-blank-assault'];
  M.placeLeader(G, 'Rebel', 'admiral-ackbar', SYS);
  combat.beginCombat(G, 'Rebel', 'kashyyyk', SYS);
  combat.runCombat(G);
  // Answer prompts until the start-of-combat action-card window, then play it.
  let played = false;
  for (let i = 0; i < 60 && G.pendingCombat && G.pendingChoice; i++) {
    const c = G.pendingChoice;
    if (c.kind === 'CombatStartActionCards' && c.side === 'Rebel' && !played) {
      played = true;
      combat.resolveCombatStartActionCards(G, ['point-blank-assault']);
      break;
    }
    if (c.kind === 'CombatStartActionCards') { combat.resolveCombatStartActionCards(G, []); continue; }
    if (c.kind === 'CombatAddLeaderPick') { combat.resolveCombatAddLeaderPick(G, null); continue; }
    if (c.kind === 'CinematicTacticSelect') { combat.resolveCinematicTacticSelect(G, null); continue; }
    break;
  }
  return { G, atat, played, trooper: G.map.systems[SYS].units.find((u) => u.typeId === 'stormtrooper') };
}
const printedHealth = (G, id) => G.catalog.unitTypes[id].health.value;

console.log('\n[ an UNDAMAGED unit loses 1 effective health (already worked) ]');
{
  const { G, atat } = play(667, 0);
  check('AT-AT carries 1 damage', atat.damage === 1, `damage=${atat.damage}`);
  check('so it now dies to 2 more damage, per the FAQ',
    printedHealth(G, 'at-at') - atat.damage === 2, `remaining=${printedHealth(G, 'at-at') - atat.damage}`);
}

console.log('\n[ #667 an ALREADY-DAMAGED unit is reduced too (was a no-op) ]');
{
  const { G, atat } = play(668, 1);
  check('AT-AT went from 1 damage to 2', atat.damage === 2,
    `damage=${atat.damage} (Math.max left this at 1 — the reported bug)`);
  check('it now dies to 1 more damage',
    printedHealth(G, 'at-at') - atat.damage === 1, `remaining=${printedHealth(G, 'at-at') - atat.damage}`);
}

console.log('\n[ boundary: a unit already at the reduced threshold is destroyed ]');
{
  const { G, atat } = play(669, 2);
  check('AT-AT reaches its printed health', atat.damage === printedHealth(G, 'at-at'),
    `damage=${atat.damage} vs health ${printedHealth(G, 'at-at')}`);
  check('so it has no health left and dies at the destruction step',
    printedHealth(G, 'at-at') - atat.damage === 0);
}

console.log('\n[ "to a minimum of 1": 1-health units are untouched ]');
{
  const { trooper } = play(670, 0);
  check('Stormtrooper takes no damage from the card', (trooper.damage ?? 0) === 0,
    `damage=${trooper.damage}`);
}

console.log('\n[ printed health is never edited (Crippling Blow / Baze read it) ]');
{
  const { G } = play(671, 1);
  check('AT-AT still prints 3 health', printedHealth(G, 'at-at') === 3);
  check('Stormtrooper still prints 1 health', printedHealth(G, 'stormtrooper') === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
