// #274 — in cinematic combat the attacker may "overdamage" an already-lethally
// damaged unit (to beat a heal). In base combat that hit is skipped.
// Run: node scripts/test-overdamage-274.mjs
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

function driveToRebelAssign(G, cinematic) {
  for (let i=0;i<3000 && G.pendingCombat;i++){
    const c = G.pendingChoice;
    if (c && c.kind === 'CombatAssignDamage' && c.side === 'Rebel') return c;
    if (!c) { combat.runCombat(G); continue; }
    switch(c.kind){
      case 'CinematicTacticSelect': combat.resolveCinematicTacticSelect(G, null); break;
      case 'CinematicReroll': combat.resolveCinematicReroll(G, []); break;
      case 'CinematicHeal': combat.resolveCinematicHeal(G, []); break;
      case 'OneInAMillionOffer': combat.resolveOneInAMillion(G, []); break;
      case 'YodaReroll': combat.resolveYodaReroll(G, null); break;
      case 'CombatAddLeaderPick': combat.resolveCombatAddLeaderPick(G, null); break;
      case 'SpecialDieSpend': combat.resolveSpecialDieSpend(G, { draws: c.specialCount ?? 0, playCardIds: [] }); break;
      case 'CombatAttackerTactics': combat.resolveCombatAttackerTactics(G, { concentrateFireCardId: null, damageBoostCardIds: [] }); break;
      case 'CombatDefenderTactics': combat.resolveCombatDefenderTactics(G, { blockCardIds: [], sacrificeCardIds: [] }); break;
      case 'RetreatDecision': combat.resolveRetreatDecision(G, null, null); break;
      case 'CombatAssignDamage': combat.resolveCombatAssignDamage(G, c.hits.map((_,hi)=>(c.targetsByHit[hi]??[])[0] ?? null)); break;
      default: return null;
    }
  }
  return null;
}

function setup(cinematic, seed) {
  const G = createGame(data, { seed, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo','corellia','kashyyyk'], forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'],
    expansion: { enabled: true, cinematicCombat: cinematic } });
  for (let i=0;i<6;i++) M.deployUnit(G,'Rebel','x-wing','felucia'); // black attack
  M.deployUnit(G,'Empire','tie-fighter','felucia'); // black health, 1 hp
  combat.beginCombat(G,'Rebel','naboo','felucia');
  return G;
}

// Find a seed where the Rebel reaches an assignment that can hit the TIE with 2+ hits.
function tryOverdamage(cinematic) {
  for (let seed=1; seed<=200; seed++) {
    const G = setup(cinematic, seed);
    const c = driveToRebelAssign(G, cinematic);
    if (!c) continue;
    const ss = G.map.systems.felucia;
    const tie = ss.units.find(u=>u.typeId==='tie-fighter');
    if (!tie) continue;
    // hits that can target the TIE
    const tieHits = c.hits.map((_,hi)=>hi).filter(hi=>(c.targetsByHit[hi]??[]).includes(tie.instanceId));
    if (tieHits.length < 2) continue;
    // assign the TIE to TWO hits (overdamage), rest null
    const assignments = c.hits.map(()=>null);
    assignments[tieHits[0]] = tie.instanceId;
    assignments[tieHits[1]] = tie.instanceId;
    const r = combat.resolveCombatAssignDamage(G, assignments);
    return { ok: r.ok, reason: r.reason, tieDamage: tie.damage, seed };
  }
  return null;
}

const cin = tryOverdamage(true);
check('found a cinematic overdamage window', !!cin, 'none in 200 seeds');
if (cin) {
  check('overdamage accepted in cinematic', cin.ok, cin.reason);
  check('TIE took BOTH points (damage 2 = overdamaged)', cin.tieDamage === 2, `damage=${cin.tieDamage}`);
}

const base = tryOverdamage(false);
check('found a base assignment window', !!base, 'none in 200 seeds');
if (base) {
  // In base, the 2nd hit on the already-staged TIE is skipped → damage stays 1.
  check('base combat does NOT overdamage (2nd hit skipped, damage 1)', base.tieDamage === 1, `damage=${base.tieDamage}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
