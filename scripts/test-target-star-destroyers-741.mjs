// #741 — Wedge's "Target The Star Destroyers": "During the space battle of each
// combat round, treat up to 2 of your black hits as red hits."
//
// The conversion is NOT applied up-front — it is made by WHERE the attacker
// assigns the hit. finalizeAttack marks up to 2 black plain-hits `convertible`,
// and isLegalTarget then lets a convertible black hit strike a red-health ship
// (Star Destroyer) as well as a black-health one.
//
// The player report was that the card "does not appear to be allowing any black
// dice to be used as red hits" — the engine was right, but the damage-assignment
// choice never told the UI which black dice carried the conversion, so all five
// black dice looked identical and only two of them highlighted a Star Destroyer.
//
// This test pins the engine-side contract the UI badge reads:
//   1. at most 2 black hits are marked convertible (the RAW "up to 2" cap),
//   2. only black plain-hits are marked (red hits and direct-hits need nothing),
//   3. a convertible black hit lists RED-health ships among its legal targets,
//   4. a non-convertible black hit does NOT,
//   5. the marks survive into the posted CombatAssignDamage choice,
//   6. the engine actually accepts a convertible black hit on a Star Destroyer.
//
// Run: node scripts/test-target-star-destroyers-741.mjs
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

/** Rebel fleet attacks an Imperial force of 2 Star Destroyers (RED health) plus
 *  TIE fighters (BLACK health) — the exact shape of the reporter's board. */
function setup(seed) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  G.map.systems.felucia.units = [];
  for (let i = 0; i < 2; i++) M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Empire', 'tie-fighter', 'felucia');
  // Enough Rebel hulls to reliably roll several black hits in one volley.
  for (let i = 0; i < 5; i++) M.deployUnit(G, 'Rebel', 'corellian-corvette', 'felucia');
  for (let i = 0; i < 2; i++) M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  combat.beginCombat(G, 'Rebel', 'mustafar', 'felucia');
  return G;
}

/** Drive to the Rebel damage-assignment choice with the card active. */
function driveToRebelAssign(G) {
  // Turn the card on the way playing it does, without needing Wedge in hand.
  const c0 = G.pendingCombat;
  if (!c0) return null;
  c0.flags = c0.flags ?? {};
  c0.flags.targetTheStarDestroyersActive = true;
  for (let i = 0; i < 3000 && G.pendingCombat; i++) {
    const c = G.pendingChoice;
    if (c && c.kind === 'CombatAssignDamage' && c.side === 'Rebel' && c.theater === 'space') return c;
    if (!c) { combat.runCombat(G); continue; }
    switch (c.kind) {
      case 'CombatAddLeaderPick': combat.resolveCombatAddLeaderPick(G, null); break;
      case 'CombatStartActionCards': combat.resolveCombatStartActionCards(G, []); break;
      case 'SpecialDieSpend': combat.resolveSpecialDieSpend(G, { draws: 0, playCardIds: [] }); break;
      case 'OneInAMillionOffer': combat.resolveOneInAMillionCombat(G, null); break;
      case 'CombatAttackerTactics':
        combat.resolveCombatAttackerTactics(G, { concentrateFireCardId: null, damageBoostCardIds: [] });
        break;
      case 'CombatDefenderTactics':
        combat.resolveCombatDefenderTactics(G, { blockCardIds: [], sacrificeCardIds: [] });
        break;
      case 'RetreatDecision': combat.resolveRetreatDecision(G, null, null); break;
      case 'CombatAssignDamage':
        combat.resolveCombatAssignDamage(G, c.hits.map((_, hi) => (c.targetsByHit[hi] ?? [])[0] ?? null));
        break;
      default: return null;
    }
  }
  return null;
}

console.log('\n[ #741 Target The Star Destroyers marks black hits convertible and lets them strike red ]');

// Find a seed where the Rebel volley produced at least 3 black plain-hits, so
// there is both a convertible pair AND a non-convertible black hit to contrast.
let found = null;
for (let seed = 1; seed <= 400 && !found; seed++) {
  const G = setup(seed);
  if (!G.pendingCombat) continue;
  const c = driveToRebelAssign(G);
  if (!c) continue;
  const blackPlain = c.hits.filter((h) => h.color === 'black' && h.face === 'hit');
  if (blackPlain.length < 3) continue;
  found = { G, c, seed };
}

check('found a Rebel volley with 3+ black hits', !!found, 'no qualifying seed in 400 tries');

if (found) {
  const { G, c } = found;
  const ss = G.map.systems.felucia;
  const healthOf = (id) => {
    const u = ss.units.find((x) => x.instanceId === id);
    return u ? G.catalog.unitTypes[u.typeId]?.health.color : undefined;
  };
  const redTargets = ss.units
    .filter((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.health.color === 'red')
    .map((u) => u.instanceId);
  check('the Empire fleet actually has red-health ships to convert onto', redTargets.length > 0);

  const convertibleIdx = c.hits.map((h, i) => (h.convertible ? i : -1)).filter((i) => i >= 0);
  check('exactly 2 hits are marked convertible (RAW "up to 2")',
    convertibleIdx.length === 2, `marked=${convertibleIdx.length}`);
  check('only black plain-hits are marked convertible',
    convertibleIdx.every((i) => c.hits[i].color === 'black' && c.hits[i].face === 'hit'),
    JSON.stringify(convertibleIdx.map((i) => c.hits[i])));

  for (const i of convertibleIdx) {
    check(`convertible hit #${i + 1} may strike a red-health ship`,
      redTargets.some((r) => c.targetsByHit[i].includes(r)),
      `targets=${JSON.stringify(c.targetsByHit[i].map(healthOf))}`);
  }

  const plainBlackIdx = c.hits
    .map((h, i) => (h.color === 'black' && h.face === 'hit' && !h.convertible ? i : -1))
    .filter((i) => i >= 0);
  check('at least one black hit is left unconverted (the cap bites)', plainBlackIdx.length > 0);
  for (const i of plainBlackIdx) {
    check(`unconverted black hit #${i + 1} may NOT strike a red-health ship`,
      !redTargets.some((r) => c.targetsByHit[i].includes(r)),
      `targets=${JSON.stringify(c.targetsByHit[i].map(healthOf))}`);
  }

  // The engine must actually ACCEPT the conversion, not just advertise it.
  const target = redTargets.find((r) => c.targetsByHit[convertibleIdx[0]].includes(r));
  check('a Star Destroyer is offered as a target for the convertible hit', !!target);
  const assignments = c.hits.map((_, i) => (i === convertibleIdx[0] ? (target ?? null) : null));
  const before = ss.units.find((u) => u.instanceId === target)?.damage ?? 0;
  const r = combat.resolveCombatAssignDamage(G, assignments);
  check('assigning a convertible black hit to a Star Destroyer is accepted', r.ok, r.reason);
  const after = G.map.systems.felucia.units.find((u) => u.instanceId === target);
  check('the Star Destroyer actually took the damage',
    !!after && after.damage > before, `before=${before} after=${after?.damage}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
