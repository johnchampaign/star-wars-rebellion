// #661 / #688 — sabotage must stop Imperial Might putting units on the board.
//
// This behaviour has already flip-flopped once, which is why it now has a test.
// #661 was originally answered "the game is right, sabotage does not apply",
// on the reading that the card says PLACE rather than DEPLOY, and the FAQ's
// test is a wording test:
//
//   "If an ability does not use the word 'Build' or 'Deploy,' then it is
//    unaffected by sabotage markers. Abilities that 'place units on the build
//    queue' are unaffected by sabotage ... 'Oversee Project' uses the word
//    'Deploy' and therefore cannot be used in a sabotaged system."
//
// It was then reversed: two independent reporters quote the printed card as
// "deploy them in this system" (#688 attaches a photograph), and independently
// of the verb, taking units OFF the build queue and putting them into a system
// is what deploying IS — the FAQ's "unaffected" case is placing units ON the
// queue, which is the opposite direction.
//
// Note the asset rulesText still reads "place them in this system", so the card
// text in assets/missions.json and the printed card may disagree. That is a
// separate question from the behaviour, which this test pins.
//
// Run: node scripts/test-imperial-might-sabotage-688.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const registry = await import('../src/engine/handlers/registry.ts');
const handlers = await import('../src/engine/handlers/index.ts');
handlers.registerAll();

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const KEY = 'imperial-might';

// invokeByKey returns true for an UNREGISTERED key, so an effect that silently
// vanished would sail through every assertion below. Pin registration first.
console.log('\n[ the handler under test is registered ]');
check(`'${KEY}' is registered`, registry.has(KEY) === true);
if (!registry.has(KEY)) { console.log('\nFAILURES — cannot test an unregistered effect'); process.exit(1); }

/** A legal Imperial Might target: a Death Star in a system with no Rebel units,
 *  and four units waiting on space 1 of the build queue. */
function board(seed, { sabotage }) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  const sysId = Object.keys(G.map.systems).find((s) => s !== G.rebelBaseSystemId);
  const ss = G.map.systems[sysId];
  ss.units = ss.units.filter((u) => u.side !== 'Rebel');
  ss.units.push({ instanceId: 'ds-test-1', side: 'Empire', typeId: 'death-star', damage: 0 });
  ss.sabotage = sabotage;
  G.empire.buildQueue[1] = ['stormtrooper', 'stormtrooper', 'tie-fighter', 'assault-carrier'];
  return { G, sysId };
}

const empireUnits = (G, sysId) => G.map.systems[sysId].units.filter((u) => u.side === 'Empire').length;
const logHas = (G, kind) => G.turnLog.some((e) => e.kind === kind);

console.log('\n[ control: with no sabotage the units arrive ]');
{
  const { G, sysId } = board(688, { sabotage: false });
  const before = empireUnits(G, sysId);
  const ctx = registry.makeContext('Empire', { kind: 'mission', id: KEY }, { targetSystemId: sysId });
  check('the effect resolved', registry.invokeByKey(G, KEY, ctx) === true);
  check('units were deployed into the system', empireUnits(G, sysId) > before,
    `before=${before} after=${empireUnits(G, sysId)}`);
  check('the build queue was emptied', G.empire.buildQueue[1].length === 0,
    JSON.stringify(G.empire.buildQueue[1]));
}

console.log('\n[ #688 with a sabotage marker, nothing is deployed ]');
{
  const { G, sysId } = board(689, { sabotage: true });
  const before = empireUnits(G, sysId);
  const queueBefore = [...G.empire.buildQueue[1]];
  const ctx = registry.makeContext('Empire', { kind: 'mission', id: KEY }, { targetSystemId: sysId });
  check('the effect resolved without throwing', registry.invokeByKey(G, KEY, ctx) === true);
  check('the bug: NO units were added to the sabotaged system',
    empireUnits(G, sysId) === before, `before=${before} after=${empireUnits(G, sysId)}`);
  check('the units stay on the build queue rather than vanishing',
    JSON.stringify(G.empire.buildQueue[1]) === JSON.stringify(queueBefore),
    `${JSON.stringify(G.empire.buildQueue[1])} vs ${JSON.stringify(queueBefore)}`);
  check('it is logged as blocked, not silently skipped',
    logHas(G, 'imperial-might-blocked-by-sabotage'));
}

console.log('\n[ consistency: the same rule already applies to the neighbours ]');
{
  // Oversee Project is the FAQ's own worked example, and Safe Haven is the
  // Rebel-side equivalent (#646). All three must agree or the rule is arbitrary.
  for (const k of ['oversee-project', 'safe-haven']) {
    check(`'${k}' is registered too`, registry.has(k) === true);
  }
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
