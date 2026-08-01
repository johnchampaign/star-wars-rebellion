// #666 — "The empire player activated geonosis with krennics finest to do
// nothing." Logged as orders:0, unitsMoved:0.
//
// THE BUG. bestCommandAction sinks a bring-nothing activation to -50, but the
// exemption read `canFightHere = enemyHere && ownHere > 0`. beginCombat does
// not start a fight on that condition — its gate is bothSidesPresent, both
// sides having units in the SAME theater. combat.ts says so directly: "when
// they disagree (e.g. Empire ships arrive where the Rebel has only ground
// units), beginCombat no-ops and no combat happens." So the AI kept choosing
// activations expecting a battle the engine then declined to start.
//
// The board here is a REAL one, captured from self-play with the fix disabled
// (scripts/fixtures/mixed-theater-activation-666.json): the Empire holds
// Malastare with ground units while the Rebel has only ships overhead, and the
// old code activated it for nothing. A synthetic stripped-down board does NOT
// work for this — with nothing else to do the activation drops out of the
// candidate list on score alone, so the assertion passes with or without the
// fix and proves nothing.
//
// Run: node scripts/test-mixed-theater-activation-666.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const setup = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const AI = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const catalog = setup.buildCatalog(data);
const raw = readFileSync(join(ROOT, 'scripts/fixtures/mixed-theater-activation-666.json'), 'utf8');
const board = () => codec.decode(raw, catalog);
const TARGET = 'malastare';
const SIDE = 'Empire';
const theaters = (G, sysId, side) => new Set(G.map.systems[sysId].units
  .filter((u) => u.side === side).map((u) => G.catalog.unitTypes[u.typeId]?.theater));

console.log('\n[ the fixture still reproduces the reported shape ]');
{
  const G = board();
  const own = theaters(G, TARGET, SIDE);
  const enemy = theaters(G, TARGET, SIDE === 'Empire' ? 'Rebel' : 'Empire');
  check('both sides hold the system', own.size > 0 && enemy.size > 0,
    `own=${[...own]} enemy=${[...enemy]}`);
  check('but they share NO theater — beginCombat would no-op',
    ![...own].some((t) => enemy.has(t)), `own=${[...own]} enemy=${[...enemy]}`);
  check('the acting side is on turn with a leader to spend',
    G.currentPlayer === SIDE && G.empire.leaderPool.length > 0);
}

console.log('\n[ #666 the AI must not propose that activation ]');
{
  const G = board();
  AI.seedAI(1);
  const acts = AI.bestCommandAction(G, SIDE);
  const bad = acts.find((a) => a.kind === 'activate' && a.targetSystemId === TARGET);
  check('the mixed-theater activation is not offered', !bad,
    `still proposed at score ${bad?.score} — the engine would start no combat here`);
  check('and the AI still has something real to do', acts.length > 0 && acts[0].kind !== 'pass',
    `top=${acts[0]?.kind}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
