// Cinematic targeting (#373 Intercept, #374 Overrun).
//  #373: Intercept is a SPACE tactic whose primary destroys a GROUND triangle
//        unit — its targets must come from the ground theatre, not space.
//  #374: Overrun (ground) "Deal 2 damage" should offer a target pick when 2+
//        enemy ground units are present.
// Run: node scripts/test-cinematic-target-theater-373-374.mjs
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
const ct = await import('../src/engine/cinematicTactics.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
const baseOpts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true },
});
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

// Cinematic combat at felucia with BOTH theatres contested: Empire attacks with
// a ground + space presence; the Rebel has 2 ground troopers (triangle) and a
// space fighter.
const G = createGame(data, baseOpts(700));
M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
M.deployUnit(G, 'Empire', 'tie-fighter', 'felucia');
(G.empire.leadersOnBoard.felucia ??= []).push('general-veers');
M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
(G.rebel.leadersOnBoard.felucia ??= []).push('general-madine');
combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
const c = G.pendingCombat;
check('cinematic combat started', !!c && c.cinematic === true);

const unitType = (iid) => {
  const u = (G.map.systems.felucia.units ?? []).find((x) => x.instanceId === iid);
  return u ? u.typeId : iid;
};

console.log('\n[ #373: Intercept (space tactic) targets GROUND triangle units ]');
{
  const de = ct.destroyAbilityFor('cin-empire-space-intercept', true);
  check('Intercept primary is a destroy effect', !!de, JSON.stringify(de));
  // Pass the tactic's theatre (space) as the call site does; the effect must
  // override to ground.
  const cands = ct.cinematicDestroyCandidates(G, c, 'Empire', 'space', de);
  const types = cands.map(unitType);
  check('candidates are ground troopers, not the X-wing',
    cands.length === 2 && types.every((t) => t === 'rebel-trooper'),
    JSON.stringify(types));
  check('the space X-wing is NOT a target', !types.includes('x-wing'));
}

console.log('\n[ #374: Overrun (ground) deal offers a pick among 2+ ground units ]');
{
  const dl = ct.dealAbilityFor('cin-empire-ground-overrun', true);
  check('Overrun primary is a deal effect', !!dl && dl.amount === 2, JSON.stringify(dl));
  const cands = ct.cinematicDealCandidates(G, c, 'Empire', 'ground', dl);
  const types = cands.map(unitType);
  check('2 ground targets available (so a pick is offered)', cands.length === 2, JSON.stringify(types));
  check('targets are the Rebel ground troopers', types.every((t) => t === 'rebel-trooper'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
