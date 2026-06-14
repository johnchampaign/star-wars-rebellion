// #218 — No Escape now has a play path. Run: node scripts/test-no-escape-218.mjs
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

// Attacker plays No Escape -> defender (Rebel) cannot retreat this round.
{
  const G = createGame(data, {
    seed: 200, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  // Space fight at felucia: Empire star-destroyer (attacker) vs Rebel x-wings.
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  combat.runCombat(G);

  // Drive to the attacker-tactics window.
  let guard = 0;
  while (G.pendingChoice && G.pendingChoice.kind !== 'CombatAttackerTactics' && guard++ < 50) {
    const c = G.pendingChoice;
    if (c.kind === 'SpecialDieSpend') { combat.resolveSpecialDieSpend(G, { draws: c.specialCount ?? 0, playCardIds: [] }); }
    else if (c.kind === 'CombatAddLeaderPick') { combat.resolveCombatAddLeaderPick(G, null); }
    else if (c.kind === 'YodaReroll') { combat.resolveYodaReroll(G, null); }
    else break;
  }
  check('reached CombatAttackerTactics', G.pendingChoice?.kind === 'CombatAttackerTactics',
    `got ${G.pendingChoice?.kind}`);

  const c = G.pendingCombat;
  // Inject No Escape into the attacker's hand.
  c.attackerHand.push('space-no-escape');
  const before = !!c.flags?.cannotRetreatThisRound?.Rebel;
  const r = combat.resolveCombatAttackerTactics(G, {
    concentrateFireCardId: null, damageBoostCardIds: [], noEscapeCardId: 'space-no-escape',
  });
  check('resolve ok', r.ok, r.reason);
  check('defender (Rebel) flagged cannot-retreat', c.flags?.cannotRetreatThisRound?.Rebel === true,
    `before=${before} after=${c.flags?.cannotRetreatThisRound?.Rebel}`);
  check('No Escape discarded from attacker hand', !c.attackerHand.includes('space-no-escape'));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
