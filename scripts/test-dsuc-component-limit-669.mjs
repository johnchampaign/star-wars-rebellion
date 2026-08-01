// #669 — "DSUC not component limited. Game presently allows multiple DSUC."
//
// RR "Component Limitations": "Units are limited to those included in the game.
// A player cannot build a unit type if there are none available." There is
// exactly one Death Star Under Construction model (supplyCount: 1) and RoE
// setup already places it, so the Construct Death Star project could only ever
// have produced a SECOND one.
//
// Decision recorded here: the whole project fails when no DSUC is available,
// rather than placing only the Death Star on the queue. Skipping just the DSUC
// would give the Empire the payload without the vulnerable intermediate the
// Rebels can destroy — a buff, and the opposite of the component limit's point.
//
// Run: node scripts/test-dsuc-component-limit-669.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
await import('../src/engine/handlers/index.ts'); // populate the registry
const registry = await import('../src/engine/handlers/registry.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const DSUC = 'death-star-under-construction';
const newGame = (seed) => createGame(data, {
  seed, autoSetupUnits: true,
  expansion: { enabled: true, roeUnits: true, roeMissions: true },
});
const countDsuc = (G) => Object.values(G.map.systems)
  .reduce((n, ss) => n + ss.units.filter((u) => u.typeId === DSUC).length, 0);
const queuedDeathStars = (G) => [1, 2, 3]
  .reduce((n, s) => n + (G.empire.buildQueue[s] ?? []).filter((t) => t === 'death-star').length, 0);
const runProject = (G, sysId) => registry.invokeByKey(G, 'construct-death-star', { side: 'Empire', targetSystemId: sysId });

console.log('\n[ the printed component limit ]');
{
  const G = newGame(669);
  check('exactly one DSUC model exists', G.catalog.unitTypes[DSUC]?.supplyCount === 1,
    `supplyCount=${G.catalog.unitTypes[DSUC]?.supplyCount}`);
}

console.log('\n[ #669 the project cannot make a SECOND DSUC ]');
{
  const G = newGame(669);
  // RoE setup already placed one; if this build didn't, place it so the
  // scenario is the reported one either way.
  if (countDsuc(G) === 0) M.deployUnit(G, 'Empire', DSUC, 'coruscant');
  check('a DSUC is already on the board', countDsuc(G) === 1, `count=${countDsuc(G)}`);
  check('supply is exhausted', M.unitsAvailableInSupply(G, DSUC) === 0);

  const dsBefore = queuedDeathStars(G);
  runProject(G, 'mustafar');

  check('still only ONE DSUC on the board', countDsuc(G) === 1, `count=${countDsuc(G)}`);
  check('the whole project failed — no Death Star queued either',
    queuedDeathStars(G) === dsBefore, `queued ${queuedDeathStars(G)} vs ${dsBefore}`);
  check('the no-op was logged for the player', G.turnLog.some(
    (l) => l.kind === 'construct-death-star-noop' && l.payload?.reason === 'no-dsuc-in-supply'));
}

console.log('\n[ it still works when the model is free again ]');
{
  const G = newGame(670);
  // Rebels destroyed it (or it completed) — the model returns to the supply.
  for (const ss of Object.values(G.map.systems)) {
    for (const u of ss.units.filter((x) => x.typeId === DSUC)) M.destroyUnit(G, u.instanceId, 'combat');
  }
  check('no DSUC on the board', countDsuc(G) === 0, `count=${countDsuc(G)}`);
  check('supply has the model back', M.unitsAvailableInSupply(G, DSUC) === 1);

  const dsBefore = queuedDeathStars(G);
  runProject(G, 'mustafar');

  check('the project places a DSUC', countDsuc(G) === 1, `count=${countDsuc(G)}`);
  check('and queues the Death Star', queuedDeathStars(G) === dsBefore + 1,
    `queued ${queuedDeathStars(G)} vs ${dsBefore}`);
  check('no spurious no-op logged',
    !G.turnLog.some((l) => l.kind === 'construct-death-star-noop'));
}

console.log('\n[ the supply invariant holds either way ]');
{
  for (const seed of [671, 672]) {
    const G = newGame(seed);
    if (countDsuc(G) === 0) M.deployUnit(G, 'Empire', DSUC, 'coruscant');
    runProject(G, 'mustafar');
    runProject(G, 'kessel');
    const errs = (M.validateInvariants?.(G) ?? []).filter((e) => /death-star-under-construction/.test(e));
    check(`seed ${seed}: no supply-cap violation after repeated attempts`,
      errs.length === 0 && countDsuc(G) === 1, `${JSON.stringify(errs)} count=${countDsuc(G)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
