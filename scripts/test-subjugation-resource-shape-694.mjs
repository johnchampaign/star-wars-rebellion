// jocke01 (#694): "The empire did move a fleet to Kashyyk now on the next turn.
// However in doing so it left mon calamari unsubjugated despite having a start
// fleet next to it. Giving the rebel player both a fighter and a cruiser is a
// play that no human opponent would do just to subjugate Kashyyk instead."
//
// He is right, and the cause was that the target scorer counted resource ICONS
// and ignored their SHAPE. On his board:
//
//   kashyyyk      triangle/ground + triangle/ground   -> two troopers
//   mon-calamari  triangle/space  + SQUARE/space      -> a fighter AND a cruiser
//
// Both scored "2 resources" and Kashyyyk won on other terms. A square icon
// builds a capital ship or an AT-AT; a triangle builds a fighter or a trooper.
// So two systems with the same icon COUNT can be worth very different amounts,
// both to take and — since subjugating a Rebel-loyal system denies its owner
// the build — to deny.
//
// Weighing square 3 / circle 2 / triangle 1 measured, over 1200 expansion games
// per arm: Empire 38.0% -> 40.8%, base found 61.4% -> 67.7% (and a third of a
// round sooner), invasions 41.9% -> 45.9%, with subjugations per game flat at
// ~13.7. Not more subjugations — better ones.
//
// The fixture is the reporter's own position, decoded from the report he filed,
// so this asserts against the real board rather than a synthetic one.
//
// Run: node scripts/test-subjugation-resource-shape-694.mjs
//   Counterfactual: SWR_RESOURCE_SHAPE=0 node scripts/test-subjugation-resource-shape-694.mjs
//   must FAIL — that flag restores plain icon counting.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const fixture = readFileSync(join(ROOT, 'scripts/fixtures/subjugation-shape-694.json'), 'utf-8');
const G = codec.decode(fixture, setup.buildCatalog(data));

console.log('\n[ the fixture is the reported position ]');
{
  check('decoded into a Command phase on turn 1',
    G.phase === 'Command' && G.timeMarker === 1, `${G.phase} t${G.timeMarker}`);
  const shapes = (sid) => (G.catalog.systems[sid]?.resources ?? []).map((r) => r.shape).sort().join('+');
  check('kashyyyk is two triangles', shapes('kashyyyk') === 'triangle+triangle', shapes('kashyyyk'));
  check('mon-calamari is a square plus a triangle',
    shapes('mon-calamari') === 'square+triangle', shapes('mon-calamari'));
  check('both are Rebel-loyal, so both deny the Rebel if taken',
    G.map.systems['kashyyyk'].loyalty === 'rebel' && G.map.systems['mon-calamari'].loyalty === 'rebel');
  check('they have the same icon COUNT — which is why counting them tied',
    (G.catalog.systems['kashyyyk'].resources ?? []).length
      === (G.catalog.systems['mon-calamari'].resources ?? []).length);
  check('neither is subjugated yet',
    !G.map.systems['kashyyyk'].subjugated && !G.map.systems['mon-calamari'].subjugated);
}

console.log('\n[ #694 the AI takes the system that actually builds the Rebel fleet ]');
{
  const acts = ai.bestCommandAction(G, 'Empire');
  const activates = acts.filter((a) => a.kind === 'activate');
  check('an activation is offered at all', activates.length > 0);
  const top = activates[0];
  check('the bug: it now goes for Mon Calamari, not Kashyyyk',
    top?.targetSystemId === 'mon-calamari',
    `chose ${top?.targetSystemId} (score ${top?.score})`);
  const score = (sid) => activates.find((a) => a.targetSystemId === sid)?.score;
  const mc = score('mon-calamari'), ky = score('kashyyyk');
  if (mc != null && ky != null) {
    check('Mon Calamari outranks Kashyyyk head to head', mc > ky, `mc=${mc} ky=${ky}`);
  } else {
    // Only the best-scoring system gets a leader paired to it, so the loser may
    // not appear as its own candidate. Top-choice identity is the real assertion.
    check('Kashyyyk is no longer the chosen target', top?.targetSystemId !== 'kashyyyk');
  }
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
