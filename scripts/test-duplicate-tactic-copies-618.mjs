// #618 — "Not possible to apply just one of two tactic cards with the same
// name." The reporter held two Critical Hit cards; ticking one checkbox ticked
// both, and unticking one unticked both. Root cause was UI-side (the selection
// Set was keyed by CARD ID, and a hand legitimately holds two copies of the
// same id — Critical Hit / Concentrate Fire / Dig In / Take It Down are all
// copies:2, Defensive Formation is copies:3). The panels now key selection by
// POSITION in the offered list.
//
// This test guards the ENGINE half of that contract: the resolvers must play
// each copy passed in, so selecting exactly one of two identical cards plays
// one, and selecting both plays both. If discardCard ever started nuking every
// same-id copy, or the loop ever deduped, the UI fix would silently regress.
// Run: node scripts/test-duplicate-tactic-copies-618.mjs
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

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
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

// The catalog must actually contain duplicate copies, or the whole class of bug
// (and this test) is vacuous.
{
  const dupes = loadJson('tactics.json').tactics.filter((t) => (t.copies ?? 1) > 1);
  check('catalog has multi-copy tactic cards', dupes.length > 0,
    `found ${dupes.length}`);
  check('Critical Hit ships in 2 copies per theater',
    dupes.some((t) => t.id === 'ground-critical-hit' && t.copies === 2));
}

/** Drive a ground combat up to the attacker-tactics window, then hand the
 *  attacker a rigged hand of `cards`. Returns { G, c, pa }. */
function combatAtAttackerTactics(seed, cards) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  // Enough Rebel bodies that the bonus damage always has somewhere to land.
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  for (let i = 0; i < 6; i++) M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');

  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  for (let i = 0; i < 50 && G.pendingCombat; i++) {
    const ch = G.pendingChoice;
    if (!ch) { combat.runCombat(G); continue; }
    if (ch.kind === 'CombatAddLeaderPick') { combat.resolveCombatAddLeaderPick(G, null); continue; }
    if (ch.kind === 'SpecialDieSpend') { combat.resolveSpecialDieSpend(G, { draws: 0, playCardIds: [] }); continue; }
    if (ch.kind === 'CombatAttackerTactics') break;
    // Any other choice means we never reached the window this seed.
    return null;
  }
  const c = G.pendingCombat;
  const pa = c?.pendingAttack;
  if (!c || !pa || G.pendingChoice?.kind !== 'CombatAttackerTactics') return null;
  const hand = pa.side === c.attackerSide ? c.attackerHand : c.defenderHand;
  hand.length = 0;
  hand.push(...cards);
  G.pendingChoice = { ...G.pendingChoice, hand: [...cards] };
  return { G, c, pa, hand };
}

const CH = 'ground-critical-hit';

console.log('\n[ #618: two copies of Critical Hit in hand ]');
{
  const setup = combatAtAttackerTactics(200, [CH, CH]);
  check('reached the attacker-tactics window', !!setup);
  if (setup) {
    const { G, pa, hand } = setup;
    const before = pa.bonusDamage;
    // Play exactly ONE of the two copies — what the reporter could not do.
    combat.resolveCombatAttackerTactics(G, { damageBoostCardIds: [CH] });
    check('playing one copy adds +1 damage', pa.bonusDamage === before + 1,
      `bonusDamage ${before} → ${pa.bonusDamage}`);
    check('the OTHER copy is still in hand', hand.filter((x) => x === CH).length === 1,
      `hand: ${JSON.stringify(hand)}`);
  }
}

{
  const setup = combatAtAttackerTactics(200, [CH, CH]);
  if (setup) {
    const { G, pa, hand } = setup;
    const before = pa.bonusDamage;
    // Play BOTH copies — the UI now submits the id twice (one per position).
    combat.resolveCombatAttackerTactics(G, { damageBoostCardIds: [CH, CH] });
    check('playing both copies adds +2 damage', pa.bonusDamage === before + 2,
      `bonusDamage ${before} → ${pa.bonusDamage}`);
    check('both copies left the hand', hand.filter((x) => x === CH).length === 0,
      `hand: ${JSON.stringify(hand)}`);
    check('each copy is credited as its own damage source',
      (pa.bonusDamageSources ?? []).filter((s) => s.source === CH).length === 2);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
