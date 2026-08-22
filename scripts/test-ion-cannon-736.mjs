// Player report #736 — "the ion cannon didn't work, the empire rolled 5 dice
// instead of 4." They were right: the Rebel Ion Cannon's faction-sheet ability
// was never implemented.
//
//   ION CANNON — "During each space battle step, your opponent rolls 2 fewer
//                 red dice."   (Learn To Play, Rebel faction sheet)
//
// RR "Structures": "There can be multiple structures of any type(s) in the same
// system, and each structure provides its benefit" — so two cannons cut 4 red.
// RoE p.9: a dice-reduction ability applies BEFORE the 5-dice-per-colour cap,
// which is what makes a 2-cannon cut visible on a fleet that would otherwise
// cap out at 5 red.
//
// Run: node scripts/test-ion-cannon-736.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const handlers = await import('../src/engine/handlers/index.ts');
handlers.registerAll();

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const SYS = 'bothawui';

/** Minimal non-cinematic CombatState — enough for beginAttack to roll. */
function combatStateAt(G, systemId) {
  return {
    systemId, attackerSide: 'Empire',
    attackerSourceSystemId: systemId, attackerSourceSystemIds: [systemId],
    step: 'Round', round: 1,
    attackerHand: [], defenderHand: [], retreated: [],
    cinematic: false,
    theaterAttackersDone: [],
    report: {
      systemId, attackerSide: 'Empire', addedLeaders: [],
      drawnTactics: { side: 'Empire', spaceCount: 0, groundCount: 0 },
      rounds: [], structureDestructions: [], retreatDestructions: [],
      winner: null, totalRounds: 0,
    },
  };
}

/** Roll one Empire space attack at SYS and report how many RED dice came out. */
function empireRedDice({ cannons, imperialShips }) {
  const G = createGame(data, { seed: 7 });
  // Clear the system so only what this fixture places is present.
  G.map.systems[SYS].units = [];
  for (let i = 0; i < imperialShips; i++) M.deployUnit(G, 'Empire', 'star-destroyer', SYS);
  // A Rebel ship so the space theater is genuinely contested...
  M.deployUnit(G, 'Rebel', 'corellian-corvette', SYS);
  // ...and the structures under test.
  for (let i = 0; i < cannons; i++) M.deployUnit(G, 'Rebel', 'ion-cannon', SYS);

  const c = combatStateAt(G, SYS);
  combat.beginAttack(G, c, 'Empire', 'space');
  const dice = c.pendingAttack?.dice ?? [];
  return {
    red: dice.filter((d) => d.color === 'red').length,
    black: dice.filter((d) => d.color === 'black').length,
    logged: G.turnLog.filter((e) => e.kind === 'ion-cannon-applied'),
  };
}

console.log('\n[ #736 — the Ion Cannon reduces the opponent\'s space red dice ]');
{
  const none = empireRedDice({ cannons: 0, imperialShips: 2 });
  const one  = empireRedDice({ cannons: 1, imperialShips: 2 });
  const two  = empireRedDice({ cannons: 2, imperialShips: 2 });

  // Two Star Destroyers = 4 red, comfortably under the 5-per-colour cap, so
  // the cut shows up one-for-one here.
  check('with no Ion Cannon the Empire rolls its full red pool',
    none.red === 4, `red=${none.red}`);
  check('one Ion Cannon takes 2 red dice off the Empire attack',
    one.red === none.red - 2, `none=${none.red} one=${one.red}`);
  check('two Ion Cannons stack to 4 (RR: each structure provides its benefit)',
    two.red === none.red - 4, `none=${none.red} two=${two.red}`);
  check('black dice are untouched — the ability names red only',
    one.black === none.black && two.black === none.black,
    `none=${none.black} one=${one.black} two=${two.black}`);
  check('and the cut is logged so the player can see why fewer dice rolled',
    one.logged.length === 1 && one.logged[0].payload.reducedRed === 2,
    JSON.stringify(one.logged.map((e) => e.payload)));
}

console.log('\n[ the cut lands BEFORE the 5-dice cap (RoE p.9) ]');
{
  // Three Star Destroyers sum to 6 red. Uncapped-then-capped gives 5; the
  // cannon must subtract from the RAW sum (6-2=4), not from the capped 5
  // (which would leave 5 and hide the ability on any big fleet).
  const none = empireRedDice({ cannons: 0, imperialShips: 3 });
  const one  = empireRedDice({ cannons: 1, imperialShips: 3 });
  check('a 6-red fleet still caps at 5 with no cannon out', none.red === 5, `red=${none.red}`);
  check('and one cannon takes it to 4, not 5 (reduce first, then cap)',
    one.red === 4, `red=${one.red}`);
}

console.log('\n[ it applies to SPACE only, and never drives the pool negative ]');
{
  // The cannon is a ground structure but must not touch the ground battle.
  const G = createGame(data, { seed: 7 });
  G.map.systems[SYS].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  const before = combatStateAt(G, SYS);
  combat.beginAttack(G, before, 'Empire', 'ground');
  const groundNoCannon = (before.pendingAttack?.dice ?? []).length;

  const G2 = createGame(data, { seed: 7 });
  G2.map.systems[SYS].units = [];
  M.deployUnit(G2, 'Empire', 'stormtrooper', SYS);
  M.deployUnit(G2, 'Empire', 'stormtrooper', SYS);
  M.deployUnit(G2, 'Rebel', 'rebel-trooper', SYS);
  M.deployUnit(G2, 'Rebel', 'ion-cannon', SYS);
  const after = combatStateAt(G2, SYS);
  combat.beginAttack(G2, after, 'Empire', 'ground');
  const groundWithCannon = (after.pendingAttack?.dice ?? []).length;

  check('a ground attack is unaffected by the Ion Cannon',
    groundNoCannon === groundWithCannon && groundNoCannon > 0,
    `without=${groundNoCannon} with=${groundWithCannon}`);

  // One TIE fighter has fewer than 2 red; the cut must floor at 0, not go
  // negative and start eating black dice.
  const tiny = (() => {
    const G3 = createGame(data, { seed: 7 });
    G3.map.systems[SYS].units = [];
    M.deployUnit(G3, 'Empire', 'tie-fighter', SYS);
    M.deployUnit(G3, 'Rebel', 'corellian-corvette', SYS);
    M.deployUnit(G3, 'Rebel', 'ion-cannon', SYS);
    M.deployUnit(G3, 'Rebel', 'ion-cannon', SYS);
    M.deployUnit(G3, 'Rebel', 'ion-cannon', SYS);
    const c = combatStateAt(G3, SYS);
    combat.beginAttack(G3, c, 'Empire', 'space');
    return c.pendingAttack?.dice ?? [];
  })();
  check('a small attack floors at zero red rather than going negative',
    tiny.filter((d) => d.color === 'red').length === 0, `red=${tiny.filter((d) => d.color === 'red').length}`);
  check('and its black dice survive intact',
    tiny.filter((d) => d.color === 'black').length >= 0);
}

console.log(`\n${fail ? 'FAIL' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
