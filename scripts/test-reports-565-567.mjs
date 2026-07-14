// #567 — Liberation ("win a ground battle in a subjugated system") didn't score
// when the Rebel won the GROUND battle but the Empire still held orbit: the check
// required winning the whole combat (report.winner === 'Rebel' = sole occupant).
// RAW/FAQ: it's the ground BATTLE that counts. Now uses rebelWonBattleIn('ground').
// #565 — with 2 Dig In cards ("discard 1 ground tactic to block up to 2"), you
// couldn't play one and discard the other: the guard rejected a sacrifice with the
// same card id. Two copies share an id, so it now checks by COPY COUNT.
// Run: node scripts/test-reports-565-567.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const Obj = await import('../src/engine/objectives.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const mk = (t, s) => ({ instanceId: t + Math.random(), typeId: t, side: s, damage: 0 });

console.log('[ #567 — Liberation scores on a ground-battle win under contested space ]');
{
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  G.rebel.objectiveHand = ['liberation-2'];
  const SYS = 'corellia';
  // Live post-combat state: Rebel holds the GROUND (cleared Empire ground), but
  // the Empire still has a SHIP in orbit → not the sole occupant → winner != Rebel.
  G.map.systems[SYS].units = [mk('rebel-trooper', 'Rebel'), mk('star-destroyer', 'Empire')];
  const atk = (theater, dmg) => ({ theater, side: 'Rebel', damageApplied: dmg, destroyed: [] });
  const report = {
    attackerSide: 'Rebel', winner: null, systemId: SYS,
    systemSubjugatedAtStart: true,
    rounds: [{ attacks: [atk('ground', 1), atk('space', 1)] }], retreatDestructions: [],
  };
  check('Liberation fires (ground battle won, space still contested)', Obj.combatObjectivesTriggered(G, report).includes('liberation-2'));
  // Guard: not subjugated at start → does NOT fire.
  const notSubj = { ...report, systemSubjugatedAtStart: false };
  G.map.systems[SYS].subjugated = false;
  check('does NOT fire when the system was not subjugated', !Obj.combatObjectivesTriggered(G, notSubj).includes('liberation-2'));
  // Guard: Empire still holds the ground (Rebel didn't win the ground battle) → no.
  G.map.systems[SYS].units = [mk('rebel-trooper', 'Rebel'), mk('stormtrooper', 'Empire')];
  check('does NOT fire when the Empire still holds the ground', !Obj.combatObjectivesTriggered(G, report).includes('liberation-2'));
}

console.log('\n[ #565 — play one Dig In, sacrifice the OTHER copy ]');
{
  // Drive a base (non-cinematic) combat where the Rebel DEFENDS a ground battle,
  // reach its CombatDefenderTactics window, inject two Dig In cards, and play one
  // by sacrificing the other.
  const G = createGame(data, { seed: 4, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'], forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'], expansion: { enabled: true, roeUnits: true } });
  const SYS = 'felucia';
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);   // Rebel ground defenders
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Empire', 'stormtrooper', SYS);   // Empire attackers (black attack)
  combat.beginCombat(G, 'Empire', 'malastare', SYS);
  let reached = false, guard = 0;
  while (G.pendingCombat && guard++ < 400) {
    const c = G.pendingChoice;
    if (!c) { combat.runCombat(G); continue; }
    if (c.kind === 'CombatDefenderTactics' && c.side === 'Rebel') {
      // Inject two Dig In into the Rebel defender's hand.
      const cc = G.pendingCombat;
      const defHand = cc.attackerSide === 'Rebel' ? cc.attackerHand : cc.defenderHand;
      defHand.length = 0; defHand.push('ground-dig-in', 'ground-dig-in');
      const before = defHand.length;
      const r = combat.resolveCombatDefenderTactics(G, { blockCardIds: ['ground-dig-in'], sacrificeCardIds: ['ground-dig-in'] });
      check('playing Dig In + sacrificing the 2nd copy resolves ok', r.ok, r.reason);
      check('both Dig In copies left the hand (played + sacrificed)', defHand.filter((x) => x === 'ground-dig-in').length === 0, `remaining=${defHand.length}`);
      reached = true;
      break;
    }
    // Auto-resolve everything else to progress the combat.
    switch (c.kind) {
      case 'CombatAddLeaderPick': combat.resolveCombatAddLeaderPick(G, null); break;
      case 'CombatStartActionCards': combat.resolveCombatStartActionCards(G, []); break;
      case 'CombatAttackerTactics': combat.resolveCombatAttackerTactics(G, {}); break;
      case 'CombatDefenderTactics': combat.resolveCombatDefenderTactics(G, { blockCardIds: [], sacrificeCardIds: [] }); break;
      case 'CombatAssignDamage': combat.resolveCombatAssignDamage(G, c.hits.map((_, i) => (c.targetsByHit[i] ?? [])[0] ?? null)); break;
      case 'YodaReroll': combat.resolveYodaReroll(G, null); break;
      case 'RetreatDecision': combat.resolveRetreatDecision(G, { retreat: false }); break;
      default: guard = 999; break;
    }
  }
  check('reached the Rebel defender-tactics window', reached);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
