// #793 — a combat prompt with exactly one legal answer is not a decision, so
// the engine answers it instead of pausing (John, 2026-10-03: every mode, no
// setting). An async online pair reported a single combat taking a week of
// back-and-forth, largely approving prompts that had nothing to decide.
//
// Covered here:
//   - damage assignment where every hit has at most one legal target
//     (the defender is down to one unit of the hit colour) is applied without
//     a CombatAssignDamage prompt, and the damage still lands;
//   - a genuine choice (two legal targets) still prompts — the control that
//     proves the shortcut is not just suppressing every assignment;
//   - Fully Operational with a single Rebel ship destroys it without a pick.
//
// NOT auto-resolved, on purpose: tactic-card windows. "Nothing playable" there
// reflects the hidden hand, and answering instantly would leak it.
//
// Run: node scripts/test-forced-choice-793.mjs
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

function setup(seed, rebelShips, before) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  G.map.systems.felucia.units = [];
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  for (const t of rebelShips) M.deployUnit(G, 'Rebel', t, 'felucia');
  if (before) before(G);
  combat.beginCombat(G, 'Empire', 'mustafar', 'felucia');
  return G;
}

/** Play the combat out with every side declining everything, answering any
 *  damage prompt with first-legal-target. Returns what the Empire was asked. */
function drive(G, onStart) {
  const seen = { empireAssignPrompts: 0, forced: 0 };
  for (let i = 0; i < 3000 && G.pendingCombat; i++) {
    const c = G.pendingChoice;
    if (!c) { combat.runCombat(G); continue; }
    switch (c.kind) {
      case 'CombatAddLeaderPick': combat.resolveCombatAddLeaderPick(G, null); break;
      case 'CombatStartActionCards':
        if (onStart && onStart(G, c)) break;
        combat.resolveCombatStartActionCards(G, []); break;
      case 'SpecialDieSpend': combat.resolveSpecialDieSpend(G, { draws: 0, playCardIds: [] }); break;
      case 'OneInAMillionOffer': combat.resolveOneInAMillionCombat(G, null); break;
      case 'CombatAttackerTactics':
        combat.resolveCombatAttackerTactics(G, { concentrateFireCardId: null, damageBoostCardIds: [] }); break;
      case 'CombatDefenderTactics':
        combat.resolveCombatDefenderTactics(G, { blockCardIds: [], sacrificeCardIds: [] }); break;
      case 'RetreatDecision': combat.resolveRetreatDecision(G, null, null); break;
      case 'CombatAssignDamage':
        if (c.side === 'Empire') seen.empireAssignPrompts++;
        combat.resolveCombatAssignDamage(G, c.hits.map((_, hi) => (c.targetsByHit[hi] ?? [])[0] ?? null));
        break;
      default: seen.stuck = c.kind; return seen;
    }
  }
  seen.forced = G.turnLog.filter((e) => e.kind === 'combat-assign-forced' && e.side === 'Empire').length;
  return seen;
}

console.log('\n[ one legal target per hit: no prompt, damage still lands ]');
{
  let forcedTotal = 0, prompts = 0, destroyed = 0, stuck = null;
  for (let seed = 1; seed <= 20; seed++) {
    const G = setup(seed, ['corellian-corvette']);
    const s = drive(G);
    if (s.stuck) stuck = s.stuck;
    forcedTotal += s.forced; prompts += s.empireAssignPrompts;
    if (!G.map.systems.felucia.units.some((u) => u.side === 'Rebel')) destroyed++;
  }
  check('combats ran to the end', stuck === null, `stuck on ${stuck}`);
  check('the Empire was never asked to assign against a lone corvette', prompts === 0, `${prompts} prompts`);
  check('the forced assignment actually ran (non-vacuous)', forcedTotal > 0, 'no forced assignments logged');
  check('the corvette is destroyed in most fights (damage really lands)', destroyed >= 10, `${destroyed}/20`);
}

console.log('\n[ control: two legal targets still prompt ]');
{
  let prompts = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const G = setup(seed, ['corellian-corvette', 'corellian-corvette', 'corellian-corvette']);
    prompts += drive(G).empireAssignPrompts;
  }
  check('the Empire is asked when it has a real choice of target', prompts > 0, '0 prompts');
}

console.log('\n[ Fully Operational with one Rebel ship needs no pick ]');
{
  const G = setup(1, ['corellian-corvette'], (G0) => {
    M.deployUnit(G0, 'Empire', 'death-star', 'felucia');
    M.placeLeader(G0, 'Empire', 'moff-jerjerrod', 'felucia');
    G0.empire.actionHand.push('fully-operational');
  });
  const corvette = G.map.systems.felucia.units.find((u) => u.side === 'Rebel').instanceId;
  let posted = false, played = false;
  drive(G, (G2, c) => {
    if (c.side !== 'Empire' || played || !c.playable.includes('fully-operational')) return false;
    played = true;
    const r = combat.resolveCombatStartActionCards(G2, ['fully-operational']);
    posted = G2.pendingChoice?.kind === 'FullyOperationalTargetPick';
    check('card accepted', r.ok, r.reason);
    return true;
  });
  check('the start-of-combat window was reached', played);
  check('no target pick was posted', !posted);
  check('the lone Rebel ship was destroyed by the card',
    G.turnLog.some((e) => e.kind === 'combat-action-card-effect' && e.payload?.card === 'fully-operational'
      && e.payload?.destroyed === corvette));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
