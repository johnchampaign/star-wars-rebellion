// #653 (follow-up comment) — the reporter believed the Empire AI SPLIT its two
// hits between the Mon Calamari Cruiser and the Nebulon-B Frigate instead of
// concentrating both on the Nebulon-B to destroy it.
//
// This test drives real combats until the Empire AI faces a damage assignment
// with 2+ hits that can each reach either Rebel ship, then asserts the AI
// concentrates on the SAME target (and specifically the one closest to dying)
// rather than spreading. It also pins the printed stats the reporter's premise
// depended on: the Nebulon-B has 3 red health (not 2), so two hits cannot kill
// an undamaged one however they are assigned.
//
// Run: node scripts/test-ai-damage-concentration-653.mjs
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
const { stepOnce, seedAI } = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

console.log('\n[ printed stats the report depended on ]');
{
  const G = createGame(data, { seed: 1, expansion: { enabled: true, roeUnits: true } });
  const neb = G.catalog.unitTypes['nebulon-b-frigate'];
  const mcc = G.catalog.unitTypes['mon-cala-cruiser'];
  const ac = G.catalog.unitTypes['assault-carrier'];
  check('Nebulon-B has 3 red health (report assumed 2)',
    neb.health.value === 3 && neb.health.color === 'red', `got ${neb.health.color} ${neb.health.value}`);
  check('Mon Calamari Cruiser has 4 red health',
    mcc.health.value === 4 && mcc.health.color === 'red', `got ${mcc.health.color} ${mcc.health.value}`);
  // Corroborates the reporter's own log: Ion Blast 1 + one red hit destroyed it.
  check('Assault Carrier has 2 red health (matches the reported log)',
    ac.health.value === 2 && ac.health.color === 'red', `got ${ac.health.color} ${ac.health.value}`);
  check('two hits cannot destroy an undamaged Nebulon-B', 2 < neb.health.value);
}

/** Answer every non-Empire-assignment prompt generically so combat advances. */
function advance(G) {
  const c = G.pendingChoice;
  if (!c) { combat.runCombat(G); return true; }
  switch (c.kind) {
    case 'CinematicTacticSelect': combat.resolveCinematicTacticSelect(G, null); return true;
    case 'CinematicReroll':       combat.resolveCinematicReroll(G, []); return true;
    case 'CinematicHeal':         combat.resolveCinematicHeal(G, []); return true;
    case 'CinematicDeferredHeal': combat.resolveCinematicDeferredHeal?.(G, []); return true;
    case 'OneInAMillionOffer':    combat.resolveOneInAMillion(G, []); return true;
    case 'YodaReroll':            combat.resolveYodaReroll(G, null); return true;
    case 'CombatAddLeaderPick':   combat.resolveCombatAddLeaderPick(G, null); return true;
    case 'SpecialDieSpend':       combat.resolveSpecialDieSpend(G, { draws: c.specialCount ?? 0, playCardIds: [] }); return true;
    case 'CombatStartActionCards':combat.resolveCombatStartActionCards?.(G, []); return true;
    case 'CombatAttackerTactics': combat.resolveCombatAttackerTactics(G, { concentrateFireCardId: null, damageBoostCardIds: [] }); return true;
    case 'CombatDefenderTactics': combat.resolveCombatDefenderTactics(G, { blockCardIds: [], sacrificeCardIds: [] }); return true;
    case 'RetreatDecision':       combat.resolveRetreatDecision(G, null, null); return true;
    case 'CombatAssignDamage':
      // Rebel assignments are not under test — resolve them generically.
      combat.resolveCombatAssignDamage(G, c.hits.map((_, i) => (c.targetsByHit[i] ?? [])[0] ?? null));
      return true;
    default: return false;
  }
}

console.log('\n[ Empire AI damage assignment: concentrate, never split ]');
let examined = 0, splits = 0, suboptimal = 0;
for (let seed = 1; seed <= 400 && examined < 25; seed++) {
  const G = createGame(data, {
    seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
    expansion: { enabled: true, roeUnits: true, cinematicCombat: true },
  });
  seedAI?.(seed);
  G.map.systems['felucia'].units = [];
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Rebel', 'nebulon-b-frigate', 'felucia');
  M.deployUnit(G, 'Empire', 'assault-carrier', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');

  for (let guard = 0; guard < 600 && G.pendingCombat; guard++) {
    const c = G.pendingChoice;
    if (c && c.kind === 'CombatAssignDamage' && c.side === 'Empire') {
      // Only interesting when 2+ hits can each reach 2+ distinct targets.
      const multi = c.hits.map((_, i) => c.targetsByHit[i] ?? []).filter((t) => t.length >= 2);
      if (multi.length < 2) { if (!advance(G)) break; continue; }
      const ss = G.map.systems['felucia'];
      const before = new Map(ss.units.map((u) => [u.instanceId, u.damage ?? 0]));
      if (!stepOnce(G, 'Empire')) break;
      const after = new Map(ss.units.map((u) => [u.instanceId, u.damage ?? 0]));
      const touched = [...after.entries()].filter(([id, d]) => d > (before.get(id) ?? 0));
      if (touched.length === 0) continue;
      examined++;
      if (touched.length > 1) {
        splits++;
        console.log(`    seed ${seed}: SPLIT across ${touched.length} units`);
      }
      // The target taken should be the one needing fewest hits to die.
      const remainingOf = (id) => {
        const u = ss.units.find((x) => x.instanceId === id);
        const hp = G.catalog.unitTypes[u.typeId].health.value;
        return hp - (before.get(id) ?? 0);
      };
      const chosen = touched[0][0];
      const best = Math.min(...[...before.keys()]
        .filter((id) => ss.units.find((x) => x.instanceId === id)?.side === 'Rebel')
        .map(remainingOf));
      if (touched.length === 1 && remainingOf(chosen) !== best) {
        suboptimal++;
        console.log(`    seed ${seed}: chose a target needing ${remainingOf(chosen)} (best was ${best})`);
      }
      continue;
    }
    if (!advance(G)) break;
  }
}
check(`examined ${examined} Empire multi-target assignments`, examined > 0, 'no scenarios found');
check('AI never split damage across multiple targets', splits === 0, `${splits} of ${examined} split`);
check('AI always attacked the closest-to-dying target', suboptimal === 0, `${suboptimal} of ${examined} suboptimal`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
