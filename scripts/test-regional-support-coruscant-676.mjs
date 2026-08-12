// #676 — "Rebels scored regional support in the region containing coruscant."
//
// The report was closed as working-as-intended, on the reasoning that Coruscant
// is not a populous system because it "has no loyalty space at all". That was
// wrong on the facts, and MichaelSheely reopened the argument with a rules
// analysis plus a designer statement. Checking it against our own sources
// settles it without needing the forum:
//
//   RR p.10  "Each system that has at least one resource icon and a loyalty
//             space is a populous system."
//   RR       "Coruscant is always LOYAL to the Imperial player and cannot gain
//             or lose loyalty."   <- a system that IS loyal has loyalty
//   our data coruscant carries a resource icon (ground triangle)
//
// So Coruscant is populous. Its loyalty marker is pre-printed on the board
// rather than placed, which is why systems.json has no loyaltyMarkerPos for it —
// a rendering detail, not a missing space. Every other check in objectives.ts
// already treats Coruscant as Imperial-loyal; only this one excluded it.
//
// Consequence, and it is the rule rather than a bug in it: region 7 can never
// satisfy Regional Support, because Coruscant can never be Rebel. The card says
// "1 region" — the Rebel scores it elsewhere.
//
// Run: node scripts/test-regional-support-coruscant-676.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const objectives = await import('../src/engine/objectives.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const met = (G) => objectives.objectiveConditionMet(G, 'regional-support-1');

function board(seed) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  // Nobody holds anything to start with, so a region only scores when we say so.
  for (const ss of Object.values(G.map.systems)) { ss.loyalty = 'neutral'; ss.subjugated = false; }
  G.map.systems['coruscant'].loyalty = 'imperial'; // RR: permanently Imperial
  return G;
}
const regionOf = (G, id) => G.catalog.systems[id].region;
const systemsIn = (G, region) => Object.values(G.catalog.systems)
  .filter((s) => s.region === region && (s.resources?.length ?? 0) > 0).map((s) => s.id);

console.log('\n[ the premise: Coruscant meets RAW\'s populous test ]');
{
  const G = board(676);
  const cor = G.catalog.systems['coruscant'];
  check('Coruscant has at least one resource icon', (cor.resources?.length ?? 0) > 0,
    JSON.stringify(cor.resources));
  check('Coruscant is not a remote system', cor.isRemote !== true);
  check('and it starts Imperial-loyal', G.map.systems['coruscant'].loyalty === 'imperial');
}

console.log('\n[ #676 the Core region cannot be scored — Coruscant is in it ]');
{
  const G = board(677);
  const region = regionOf(G, 'coruscant');
  const ids = systemsIn(G, region);
  check('Coruscant IS counted among its region\'s populous systems',
    ids.includes('coruscant'), JSON.stringify(ids));
  // Give the Rebel every other planet in the region — the reported situation.
  for (const id of ids) if (id !== 'coruscant') G.map.systems[id].loyalty = 'rebel';
  check('the bug: holding every OTHER system in the region does not score it',
    met(G) === false,
    `region ${region} = ${JSON.stringify(ids)}`);
  // Even if something forced Rebel loyalty onto Coruscant, it can never count.
  G.map.systems['coruscant'].loyalty = 'rebel';
  check('and it still does not score even if Coruscant is forced Rebel',
    met(G) === false);
}

console.log('\n[ a region without Coruscant still scores normally ]');
{
  const G = board(678);
  const other = [...new Set(Object.values(G.catalog.systems)
    .filter((s) => (s.resources?.length ?? 0) > 0).map((s) => s.region))]
    .find((r) => r !== regionOf(G, 'coruscant'));
  const ids = systemsIn(G, other);
  check('nothing scores before we hand the region over', met(G) === false);
  for (const id of ids) G.map.systems[id].loyalty = 'rebel';
  check(`region ${other} scores once all its populous systems are Rebel`,
    met(G) === true, JSON.stringify(ids));
}

console.log('\n[ remote systems are still excluded — they are not populous ]');
{
  const G = board(679);
  const remotes = Object.values(G.catalog.systems).filter((s) => s.isRemote);
  check('remote systems exist', remotes.length > 0);
  check('none of them carry a resource icon',
    remotes.every((s) => (s.resources?.length ?? 0) === 0),
    JSON.stringify(remotes.filter((s) => (s.resources?.length ?? 0) > 0).map((s) => s.id)));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
