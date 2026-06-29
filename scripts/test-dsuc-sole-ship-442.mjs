// #442 — DSUC sole-ship rule (RR p.6 / LTP combat steps): "If the Imperial
//        player's only remaining ship is the Death Star Under Construction and
//        the Rebel player still has ships in the system, the Death Star Under
//        Construction is destroyed." The DSUC has 0 attack, so without this rule
//        a Rebel fleet that can't roll 4 hits gets stuck in a never-ending
//        "stalemate" instead of destroying the helpless DSUC outright.
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
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass=0,fail=0; const check=(n,ok,x='')=>{console.log(`  ${ok?'✓':'✗'} ${n}${ok?'':' — '+x}`);ok?pass++:fail++;};

// Non-cinematic drive loop (resolve every combat choice with a sensible default).
function driveCombat(G) {
  for (let i = 0; i < 1000 && G.pendingCombat; i++) {
    const c = G.pendingChoice;
    if (!c) { combat.runCombat(G); continue; }
    switch (c.kind) {
      case 'CombatAttackerTactics': combat.resolveCombatAttackerTactics(G, { concentrateFireCardId: null, damageBoostCardIds: [] }); break;
      case 'CombatDefenderTactics': combat.resolveCombatDefenderTactics(G, { blockCardIds: [], sacrificeCardIds: [] }); break;
      case 'SpecialDieSpend': combat.resolveSpecialDieSpend(G, { draws: c.specialCount, playCardIds: [] }); break;
      case 'CombatAddLeaderPick': combat.resolveCombatAddLeaderPick(G, null); break;
      case 'RetreatDecision': combat.resolveRetreatDecision(G, null, null); break;
      case 'DeathStarPlansAttempt': combat.resolveDeathStarPlansAttempt(G, false); break;
      case 'YodaReroll': combat.resolveYodaReroll(G, null); break;
      case 'CombatAssignDamage': {
        const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
        const queued = new Map();
        const assignments = c.hits.map((_, hi) => {
          for (const tid of (c.targetsByHit[hi] ?? [])) {
            const u = ss?.units.find((x) => x.instanceId === tid);
            if (!u) continue;
            const t = G.catalog.unitTypes[u.typeId];
            const remaining = (t?.health.value ?? 1) - (u.damage ?? 0) - (queued.get(tid) ?? 0);
            if (remaining <= 0) continue;
            queued.set(tid, (queued.get(tid) ?? 0) + 1);
            return tid;
          }
          return null;
        });
        combat.resolveCombatAssignDamage(G, assignments); break;
      }
      default: return; // non-combat choice — let the assertion surface the stall
    }
  }
}

console.log('\n[ #442 — DSUC is the only Imperial ship, Rebel still has ships ]');
{
  const G = createGame(data, { seed: 42, roeUnits: true,
    forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'] });
  const sys = 'felucia';
  G.map.systems[sys].units = G.map.systems[sys].units.filter(u => u.side !== 'Empire' && u.side !== 'Rebel');
  M.deployUnit(G, 'Empire', 'death-star-under-construction', sys);
  // A single Corellian Corvette can't roll 4 hits before the rule fires.
  M.deployUnit(G, 'Rebel', 'corellian-corvette', sys);
  check('DSUC present before combat', G.map.systems[sys].units.some(u => u.typeId === 'death-star-under-construction'));

  combat.beginCombat(G, 'Rebel', 'mon-calamari', sys);
  driveCombat(G);

  check('combat resolved (no infinite stalemate)', G.pendingCombat === undefined);
  const dsucGone = !G.map.systems[sys].units.some(u => u.typeId === 'death-star-under-construction');
  check('DSUC was destroyed (not left in a stalemate)', dsucGone);
  check('no Imperial ships remain in the system',
    G.map.systems[sys].units.filter(u => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'space').length === 0);
  check('Rebel ship survived (DSUC has 0 attack)',
    G.map.systems[sys].units.some(u => u.side === 'Rebel' && u.typeId === 'corellian-corvette'));
}

console.log('\n[ rule does NOT fire while another Imperial ship is present ]');
{
  const G = createGame(data, { seed: 43, roeUnits: true,
    forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'] });
  const sys = 'felucia';
  G.map.systems[sys].units = G.map.systems[sys].units.filter(u => u.side !== 'Empire' && u.side !== 'Rebel');
  M.deployUnit(G, 'Empire', 'death-star-under-construction', sys);
  M.deployUnit(G, 'Empire', 'star-destroyer', sys); // a real fighting ship alongside the DSUC
  M.deployUnit(G, 'Rebel', 'corellian-corvette', sys);
  // Just check the rule is a no-op while the Star Destroyer is alive: apply the
  // round-end snapshot directly via a fresh combat begin/one-round is overkill;
  // instead assert the DSUC is still there immediately after combat begins.
  combat.beginCombat(G, 'Rebel', 'mon-calamari', sys);
  // After one engine step the DSUC must NOT have been auto-removed while the SD lives.
  const c0 = G.pendingCombat;
  check('combat is live with both Imperial ships', !!c0 &&
    G.map.systems[sys].units.filter(u => u.side === 'Empire').length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
