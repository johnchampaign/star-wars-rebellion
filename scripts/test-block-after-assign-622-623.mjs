// #622 / #623 — RR p.5 resolves combat damage as: step 3 "Assign Damage"
// ("Players must assign all dice that they are able to assign"), THEN step 4
// "Block Damage" ("for each damage blocked, remove one damage that was
// assigned to one of his units").
//
// We used to pre-slice the first N hits off the roll before the attacker ever
// saw them. Two player-visible bugs fell out of that:
//   #622 — a 4-hit roll against 2 blocks only offered 2 dice for assignment.
//   #623 — Take It Down's 2 bonus hits sit at the head of the hit list, so a
//          single block ate one of them and the card looked like +1 damage.
//
// Run: node scripts/test-block-after-assign-622-623.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
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

/** Build a base-game space combat where the Empire attacks with a big fleet. */
function setup(seed) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  G.map.systems.felucia.units = [];
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Rebel', 'corellian-corvette', 'felucia');
  combat.beginCombat(G, 'Empire', 'mustafar', 'felucia');
  return G;
}

/** Drive combat until the Empire is asked to assign damage. `blocks` block
 *  cards are played by the Rebel defender when the chance comes. */
function driveToEmpireAssign(G, blockCards) {
  for (let i = 0; i < 3000 && G.pendingCombat; i++) {
    const c = G.pendingChoice;
    if (c && c.kind === 'CombatAssignDamage' && c.side === 'Empire') return c;
    if (!c) { combat.runCombat(G); continue; }
    switch (c.kind) {
      case 'CombatAddLeaderPick': combat.resolveCombatAddLeaderPick(G, null); break;
      case 'CombatStartActionCards': combat.resolveCombatStartActionCards(G, []); break;
      case 'SpecialDieSpend': combat.resolveSpecialDieSpend(G, { draws: 0, playCardIds: [] }); break;
      case 'OneInAMillionOffer': combat.resolveOneInAMillionCombat(G, null); break;
      case 'CombatAttackerTactics':
        combat.resolveCombatAttackerTactics(G, { concentrateFireCardId: null, damageBoostCardIds: [] });
        break;
      case 'CombatDefenderTactics': {
        // Stack the deck: the defender's hand is redrawn during combat setup,
        // so force the block cards in right at the moment they're playable.
        if (blockCards.length > 0) G.pendingCombat.defenderHand = [...blockCards];
        combat.resolveCombatDefenderTactics(G, { blockCardIds: [...blockCards], sacrificeCardIds: [] });
        break;
      }
      case 'RetreatDecision': combat.resolveRetreatDecision(G, null, null); break;
      case 'CombatAssignDamage':
        combat.resolveCombatAssignDamage(G, c.hits.map((_, hi) => (c.targetsByHit[hi] ?? [])[0] ?? null));
        break;
      default: return null;
    }
  }
  return null;
}

console.log('\n[ #622 every rolled hit is offered for assignment, blocks come off after ]');
{
  // Find a seed where the defender holds a block card AND the attacker rolls
  // more hits than the blocks can absorb.
  let found = null;
  for (let seed = 1; seed <= 300 && !found; seed++) {
    const G = setup(seed);
    if (!G.pendingCombat) continue;
    const c = driveToEmpireAssign(G, ['space-defensive-formation']);
    if (!c) continue;
    const pa = G.pendingCombat?.pendingAttack;
    if (!pa || !pa.pendingAssignment?.blocksApplied) continue;
    const rolledHits = pa.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
    if (rolledHits <= pa.pendingAssignment.blocksApplied) continue;
    found = { c, pa, rolledHits, G, seed };
  }
  check('found a combat where the defender blocked', !!found, 'no blocking seed in 300 tries');
  if (found) {
    const { c, pa, rolledHits } = found;
    const blocks = pa.pendingAssignment.blocksApplied;
    check('the attacker is offered EVERY hit, not hits-minus-blocks',
      c.hits.length === rolledHits + pa.bonusDamage,
      `offered=${c.hits.length} rolled=${rolledHits} bonus=${pa.bonusDamage} blocks=${blocks}`);
    check('the choice tells the UI how many blocks are pending',
      c.blocksApplied === blocks, `choice.blocksApplied=${c.blocksApplied} expected=${blocks}`);

    // Assign every hit to the first legal target, then confirm the blocks
    // actually removed that many points of damage.
    const before = new Map(found.G.map.systems.felucia.units.map((u) => [u.instanceId, u.damage]));
    const assignments = c.hits.map((_, hi) => (c.targetsByHit[hi] ?? [])[0] ?? null);
    const assignable = assignments.filter((a) => a !== null).length;
    const r = combat.resolveCombatAssignDamage(found.G, assignments);
    check('assignment accepted', r.ok, r.reason);
    const dealt = found.G.map.systems.felucia.units
      .reduce((acc, u) => acc + Math.max(0, u.damage - (before.get(u.instanceId) ?? 0)), 0);
    // Units destroyed this step are staged (still on the board) in base combat,
    // so every point of damage that landed is still countable above.
    check('exactly `blocks` of the assigned damage was removed',
      dealt === assignable - blocks, `dealt=${dealt} assigned=${assignable} blocks=${blocks}`);
  }
}

console.log('\n[ #623 Take It Down still lands 2 damage when the defender blocks 1 ]');
{
  // Drive a combat to the assignment step with no blocks, then hand-build the
  // pending attack the way #623 saw it: one blank die, Take It Down (+2) and
  // Critical Hit (+1) as bonus damage, and 1 block from the defender.
  let G = null, c = null;
  for (let seed = 1; seed <= 300 && !c; seed++) {
    G = setup(seed);
    c = driveToEmpireAssign(G, []);
  }
  check('reached an Empire damage assignment', !!c);
  if (c) {
    const ss = G.map.systems.felucia;
    // Needs 4+ health so "3 assigned, 1 blocked → 2 landed" is distinguishable
    // from "2 landed then the unit died and the 3rd hit was skipped".
    M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
    const target = ss.units.filter((u) => u.side === 'Rebel').slice(-1)[0];
    target.damage = 0;
    const hp = G.catalog.unitTypes[target.typeId].health.value;
    check('target survives 3 damage so the block is observable', hp > 3, `hp=${hp}`);

    const pa = G.pendingCombat.pendingAttack;
    pa.bonusDamage = 3;
    pa.bonusDamageSources = [
      { source: 'ground-take-it-down', amount: 2 },
      { source: 'ground-critical-hit', amount: 1 },
    ];
    const hits = [
      { color: null, face: 'direct-hit', source: 'ground-take-it-down' },
      { color: null, face: 'direct-hit', source: 'ground-take-it-down' },
      { color: null, face: 'direct-hit', source: 'ground-critical-hit' },
    ];
    pa.pendingAssignment = { blocksApplied: 1, applicableHits: hits };
    G.pendingChoice = {
      kind: 'CombatAssignDamage', side: 'Empire', theater: pa.theater,
      systemId: 'felucia', hits,
      targetsByHit: hits.map(() => [target.instanceId]),
      blocksApplied: 1,
    };
    const r = combat.resolveCombatAssignDamage(G, [
      target.instanceId, target.instanceId, target.instanceId,
    ]);
    check('assignment accepted (Take It Down same-target rule satisfied)', r.ok, r.reason);
    // 3 damage assigned, 1 blocked → 2 lands. Under the old slice-first code
    // the block ate a Take It Down hit BEFORE assignment and only 2 hits were
    // ever offered, so the card read as +1.
    check('2 of the 3 assigned damage landed (Take It Down kept both points)',
      target.damage === 2, `damage=${target.damage}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
