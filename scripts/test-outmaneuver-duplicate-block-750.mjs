// #750 — "I have two copies of defensive formation, but game will not allow me
// to discard one with outmaneuver and play the other copy."
//
// Outmaneuver reads "Discard 1 space tactic card from your hand to block up to
// 2 damage", so with [Outmaneuver, Defensive Formation, Defensive Formation] you
// may spend one Defensive Formation as the discard AND play the other for its
// own free block — 3 damage blocked, hand emptied.
//
// The engine already allowed it; both defender panels did not. They compared
// the free-block card to the chosen sacrifice BY CARD ID, and two copies of
// Defensive Formation share one id, so picking either copy as the sacrifice
// greyed out the free block. They now compare by COPY COUNT.
//
// This pins the engine contract the UI fix depends on: submitting the same id
// as both a block and a sacrifice must consume two separate copies.
// Run: node scripts/test-outmaneuver-duplicate-block-750.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const DF = 'space-defensive-formation';
const OM = 'space-outmaneuver';

// Defensive Formation must really ship in multiple copies, or the reporter's
// hand is impossible and this test proves nothing.
{
  const t = loadJson('tactics.json').tactics.find((x) => x.id === DF);
  check('Defensive Formation ships in 2+ copies', (t?.copies ?? 1) >= 2, `copies=${t?.copies}`);
}

/** Drive a space combat to the defender-tactics window and rig the defender's
 *  hand to the reporter's. Returns { G, hand, pa } or null if this seed took a
 *  different path. */
function combatAtDefenderTactics(seed, cards) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');

  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  for (let i = 0; i < 60 && G.pendingCombat; i++) {
    const ch = G.pendingChoice;
    if (!ch) { combat.runCombat(G); continue; }
    if (ch.kind === 'CombatAddLeaderPick') { combat.resolveCombatAddLeaderPick(G, null); continue; }
    if (ch.kind === 'SpecialDieSpend') { combat.resolveSpecialDieSpend(G, { draws: 0, playCardIds: [] }); continue; }
    if (ch.kind === 'CombatAttackerTactics') { combat.resolveCombatAttackerTactics(G, { damageBoostCardIds: [] }); continue; }
    if (ch.kind === 'CombatDefenderTactics') break;
    return null; // this seed wandered somewhere else
  }
  const c = G.pendingCombat;
  const pa = c?.pendingAttack;
  if (!c || !pa || G.pendingChoice?.kind !== 'CombatDefenderTactics') return null;
  const defenderSide = pa.side === c.attackerSide ? c.defenderSide ?? null : c.attackerSide;
  void defenderSide;
  // The defender is whoever is NOT resolving the attack.
  const hand = pa.side === c.attackerSide ? c.defenderHand : c.attackerHand;
  hand.length = 0;
  hand.push(...cards);
  G.pendingChoice = { ...G.pendingChoice, hand: [...cards] };
  return { G, c, pa, hand };
}

let setup = null;
for (const seed of [11, 23, 41, 77, 101, 203, 311, 404]) {
  setup = combatAtDefenderTactics(seed, [OM, DF, DF]);
  if (setup) break;
}

console.log('\n[ #750: Outmaneuver discarding one Defensive Formation, playing the other ]');
check('reached the defender-tactics window', !!setup);
if (setup) {
  const { G, pa, hand } = setup;
  const r = combat.resolveCombatDefenderTactics(G, {
    blockCardIds: [DF, OM],       // free block + the paid block
    sacrificeCardIds: [DF],       // ...paid for with the SECOND copy
    noEscapeCardId: null,
  });
  check('the engine accepts the submission', r.ok !== false, JSON.stringify(r));
  check('both Defensive Formations left the hand', hand.filter((x) => x === DF).length === 0,
    `hand: ${JSON.stringify(hand)}`);
  check('Outmaneuver left the hand', !hand.includes(OM), `hand: ${JSON.stringify(hand)}`);
  const played = pa.tacticsPlayed ?? [];
  check('Defensive Formation is credited with its free block',
    played.some((p) => p.card === DF), JSON.stringify(played));
  check('Outmaneuver is credited, naming the discarded copy',
    played.some((p) => p.card === OM && String(p.detail).includes(DF)), JSON.stringify(played));
}

console.log('\n[ #750: a LONE Defensive Formation still cannot do both jobs ]');
{
  const solo = combatAtDefenderTactics(11, [OM, DF]) ?? combatAtDefenderTactics(23, [OM, DF]);
  check('reached the defender-tactics window', !!solo);
  if (solo) {
    const { G, hand } = solo;
    // The UI won't offer this, but the engine must not conjure a second copy:
    // the one Defensive Formation is spent as the free block, so Outmaneuver
    // has nothing left to discard and is simply not played.
    combat.resolveCombatDefenderTactics(G, {
      blockCardIds: [DF, OM], sacrificeCardIds: [DF], noEscapeCardId: null,
    });
    check('the single Defensive Formation is consumed once', !hand.includes(DF),
      `hand: ${JSON.stringify(hand)}`);
    check('Outmaneuver is refused and stays in hand', hand.includes(OM),
      `hand: ${JSON.stringify(hand)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
