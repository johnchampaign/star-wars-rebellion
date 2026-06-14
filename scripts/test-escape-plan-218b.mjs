// Escape Plan (ground-escape-plan) carries a ★ on its card, so requiresSpecial
// is now true and it becomes playable in the special-die-spend window (its
// retreatIgnoresTransport handler already existed). Companion to the No Escape
// fix (#218). Run: node scripts/test-escape-plan-218b.mjs
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

const G0 = createGame(data, { seed: 1 });
check('ground-escape-plan now requiresSpecial in catalog', G0.catalog.tactics['ground-escape-plan']?.requiresSpecial === true);

// Seed-search a ground combat that produces a special-die window with Escape
// Plan offered (a ★ must roll). Inject the card into both hands up front.
let proved = false;
for (let seed = 1; seed <= 400 && !proved; seed++) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.attackerHand.push('ground-escape-plan');
  c.defenderHand.push('ground-escape-plan');
  combat.runCombat(G);
  for (let step = 0; step < 200 && G.pendingCombat; step++) {
    const ch = G.pendingChoice;
    if (!ch) { combat.runCombat(G); continue; }
    if (ch.kind === 'SpecialDieSpend' && ch.specialCards.includes('ground-escape-plan')) {
      const side = ch.side;
      const r = combat.resolveSpecialDieSpend(G, { draws: 0, playCardIds: ['ground-escape-plan'] });
      check('Escape Plan offered + played from the special-die window', r.ok, r.reason);
      check('retreatIgnoresTransport set for the player', c.flags?.retreatIgnoresTransport?.[side] === true);
      proved = true;
      break;
    }
    // default no-op resolution to keep combat moving
    switch (ch.kind) {
      case 'SpecialDieSpend': combat.resolveSpecialDieSpend(G, { draws: 0, playCardIds: [] }); break;
      case 'CombatAttackerTactics': combat.resolveCombatAttackerTactics(G, { concentrateFireCardId: null, damageBoostCardIds: [] }); break;
      case 'CombatDefenderTactics': combat.resolveCombatDefenderTactics(G, { blockCardIds: [], sacrificeCardIds: [] }); break;
      case 'RetreatDecision': combat.resolveRetreatDecision(G, null, null); break;
      case 'CombatAddLeaderPick': combat.resolveCombatAddLeaderPick(G, null); break;
      case 'CombatAssignDamage': {
        const ss = G.map.systems[c.systemId];
        const assignments = ch.hits.map((_, hi) => (ch.targetsByHit?.[hi] ?? [])[0] ?? null);
        combat.resolveCombatAssignDamage(G, assignments); break;
      }
      default: step = 999; break;
    }
  }
}
check('found a ground special-die window offering Escape Plan within 400 seeds', proved);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
