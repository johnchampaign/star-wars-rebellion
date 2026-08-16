// #719 / #721 — jocke01: "The empire is using the mission deployment ... The
// empire uses the mission on alderaan that it already controls with massive
// fleet." / "Same issue again with the empire targeting a planet with a bunch
// of ground units with the deployment mission."
//
// Deployment reads "Attempt on a system with no Rebel units or loyalty. Gain 1
// triangle ground unit." It had NO entry in empireMissionTargetScore — the same
// hole #561 closed for Planetary Conquest — so EVERY legal target scored an
// identical 17 (the undefended-attempt term and nothing else) and the pick fell
// out of the tiebreak hash. One more stormtrooper on a stack of nineteen is
// worth nothing; the same stormtrooper on a system with no Imperial ground is
// the garrison a subjugation needs (#696).
//
// Note on shape: "never targets Alderaan" is NOT a valid assertion here. With
// 27 legal targets tied, the #98 tiebreak already scatters the pick, so Alderaan
// comes up ~1/32 of the time and a handful of seeds miss it with the fix
// removed — a vacuously green test. The board below leaves exactly TWO legal
// targets so the two arms are a coin flip apart, and runs 24 seeds.
//
// Run: node scripts/test-deployment-target-719-721.mjs
//   Counterfactual: change the `missionId === 'deployment'` guard in
//   src/play/randomAI.ts to `false &&` and the preference assertions must FAIL.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const mk = (t, s, id) => ({ instanceId: id ?? t + Math.random(), typeId: t, side: s, damage: 0 });

const SEEDS = [1, 2, 3, 5, 7, 8, 11, 13, 17, 19, 21, 23, 29, 31, 34, 37, 41, 43, 47, 53, 55, 59, 61, 67];

/** Board shaped like the reports. `open` systems stay legal for Deployment;
 *  every other system is made illegal by a Rebel loyalty marker, so the choice
 *  is between exactly the ones we care about and the tiebreak alone cannot
 *  produce the right answer more than half the time. */
function board(seed, { open, garrisoned = [], imperial = [] }) {
  ai.seedAI(seed);
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissionsEmpire: true },
  });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  const openSet = new Set(open);
  for (const [sid, ss] of Object.entries(G.map.systems)) {
    ss.units = [];
    ss.subjugated = false;
    // Rebel loyalty makes a system an illegal Deployment target, which is how
    // the board is narrowed to just the systems under test.
    ss.loyalty = openSet.has(sid) ? (imperial.includes(sid) ? 'imperial' : null) : 'rebel';
  }
  for (const sid of garrisoned) {
    G.map.systems[sid].units = [
      mk('stormtrooper', 'Empire'), mk('stormtrooper', 'Empire'), mk('stormtrooper', 'Empire'),
      mk('at-at', 'Empire'), mk('at-st', 'Empire'), mk('assault-carrier', 'Empire'),
    ];
  }
  // A leader with enough diplomacy to reveal Deployment (skillCost 2).
  const leader = G.empire.leaderPool[0];
  G.catalog.leaders[leader].skills = { ...(G.catalog.leaders[leader].skills ?? {}), diplomacy: 3 };
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== leader);
  G.empire.leadersOnMissions = [{ missionId: 'deployment', leaderIds: [leader] }];
  G.empire.missionHand = (G.empire.missionHand ?? []).filter((m) => m !== 'deployment');
  return G;
}

const targetOver = (opts) => SEEDS.map((seed) => {
  const G = board(seed, opts);
  const dep = ai.bestCommandAction(G, 'Empire')
    .find((a) => a.kind === 'reveal' && a.missionId === 'deployment');
  return dep ? dep.targetSystemId : null;
});

console.log('[ #719/#721 — Deployment garrisons the empty world, not the stack at Alderaan ]');
{
  const targets = targetOver({ open: ['alderaan', 'ryloth'], garrisoned: ['alderaan'], imperial: ['alderaan'] });
  check('a Deployment reveal is generated on every seed',
    targets.every(Boolean), `${targets.filter(Boolean).length}/${SEEDS.length}`);
  const onStack = targets.filter((t) => t === 'alderaan').length;
  check('never reinforces the garrisoned stack when an ungarrisoned world is legal',
    onStack === 0, `alderaan chosen on ${onStack}/${SEEDS.length} seeds`);
}

console.log('\n[ the driver is the GARRISON, not loyalty or a grudge against Alderaan ]');
{
  // Ryloth and Kessel are twins for scoring purposes — both neutral, both a
  // single triangle resource. The ONLY difference is that Ryloth already holds
  // Imperial ground. If the ground term is what's working, Kessel wins every
  // seed; if the previous result came from the "already Imperial" term instead,
  // these two tie and the tiebreak splits them.
  const targets = targetOver({ open: ['ryloth', 'kessel'], garrisoned: ['ryloth'] });
  const onEmpty = targets.filter((t) => t === 'kessel').length;
  check('picks the ungarrisoned twin over the garrisoned twin',
    onEmpty === SEEDS.length, `kessel chosen on only ${onEmpty}/${SEEDS.length} seeds`);
}

console.log('\n[ a garrisoned world is still better than not playing the card ]');
{
  // Guard against over-correcting into "never deploy": with one garrisoned
  // system the only legal target, the reveal must still be offered, not dropped.
  const G = board(7, { open: ['alderaan'], garrisoned: ['alderaan'], imperial: ['alderaan'] });
  const dep = ai.bestCommandAction(G, 'Empire')
    .filter((a) => a.kind === 'reveal' && a.missionId === 'deployment');
  check('the reveal is not filtered out entirely', dep.length > 0, 'no deployment reveal at all');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
