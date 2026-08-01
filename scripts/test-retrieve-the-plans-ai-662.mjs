// #662 — "Imperial AI successfully did 'Retrieve the Plans' but didn't take the
// Death Star Plans even though vulnerable to it."
//
// Retrieve the Plans reveals the Rebel's objective hand and buries one card on
// the bottom of the deck. The AI ranked candidates purely by printed
// reputation and only replaced its pick on a STRICTLY greater value. Death Star
// Plans is worth 2 — tied with Heart of the Empire / Return of the Jedi /
// Uprising — so on a tie the AI kept whichever card came first and left the
// Plans in the Rebel's hand, even with a Death Star on the board.
//
// Run: node scripts/test-retrieve-the-plans-ai-662.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const PLANS = 'death-star-plans-2';
const RIVAL = 'heart-of-the-empire-2'; // also reputation 2 — the tie that hid the bug

function setup(seed, { withDeathStar, candidates }) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  // Strip any Death Star / DSUC that setup placed, so the flag is ours to set.
  for (const ss of Object.values(G.map.systems)) {
    for (const u of ss.units.filter((x) => x.typeId === 'death-star' || x.typeId === 'death-star-under-construction')) {
      M.destroyUnit(G, u.instanceId, 'combat');
    }
  }
  if (withDeathStar) M.deployUnit(G, 'Empire', 'death-star', 'coruscant');
  G.rebel.objectiveHand = [...candidates];
  G.pendingChoice = { kind: 'RetrieveThePlansPick', side: 'Empire', candidates };
  return G;
}
// The resolver logs exactly what it bottomed — read that, not the deck tail.
const buried = (G) => (G.turnLog.filter((l) => l.kind === 'retrieve-plans-applied').slice(-1)[0] || {}).payload?.bottomed;

console.log('\n[ reputation values that made this a tie ]');
{
  const G = setup(662, { withDeathStar: true, candidates: [PLANS] });
  check('Death Star Plans is worth 2', G.catalog.objectives[PLANS]?.reputation === 2);
  check('Heart of the Empire is also worth 2', G.catalog.objectives[RIVAL]?.reputation === 2,
    'a strictly-greater comparison can never prefer the Plans over this');
}

console.log('\n[ #662 with a Death Star on the board, take the Plans ]');
{
  // RIVAL first in the list — the order that lost under the old tie-break.
  const G = setup(662, { withDeathStar: true, candidates: [RIVAL, PLANS] });
  const ok = stepOnce(G, 'Empire');
  check('the AI acted', ok);
  check('it buried the Death Star Plans', buried(G) === PLANS, `buried=${buried(G)}`);
}

console.log('\n[ order must not matter ]');
{
  const G = setup(663, { withDeathStar: true, candidates: [PLANS, RIVAL] });
  stepOnce(G, 'Empire');
  check('still buries the Plans when they are listed first', buried(G) === PLANS, `buried=${buried(G)}`);
}

console.log('\n[ a Death Star Under Construction counts as vulnerable too ]');
{
  const G = setup(664, { withDeathStar: false, candidates: [RIVAL, PLANS] });
  M.deployUnit(G, 'Empire', 'death-star-under-construction', 'mustafar');
  stepOnce(G, 'Empire');
  check('DSUC on the board also prioritises the Plans', buried(G) === PLANS, `buried=${buried(G)}`);
}

console.log('\n[ with nothing to blow up, fall back to reputation ]');
{
  const G = setup(665, { withDeathStar: false, candidates: [PLANS, 'a-time-for-peace-2'] });
  stepOnce(G, 'Empire');
  const pick = buried(G);
  check('it still buries a real objective', !!pick, `buried=${pick}`);
  check('the Plans are not force-picked when the Empire has no Death Star',
    G.catalog.objectives[pick]?.reputation >= G.catalog.objectives['a-time-for-peace-2']?.reputation,
    `buried=${pick}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
