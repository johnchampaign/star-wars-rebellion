// #748 — "there are still major gameplay mistakes ... all this followed bad
// resource management in the beginning, where the imperials screwed up the most
// important task of building a strong army, e.g. having as many strong
// production sites (un-sabotaged) in every round where units are built ... at
// the end of the game, I had more square-level ships than the imperials, which
// should never ever occur! it had only one sd on the board."
//
// Address Delays and Construct Factory are the SAME effect — "Place units on
// the build queue using this system's resource icons and number" (assets/
// missions.json) — and it is how the Empire's army gets bought. Construct
// Factory has been target-scored since #468. Address Delays had no target score
// at all: empireMissionTargetScore returned 0 for every legal system, so the
// pick fell through to the tie-break and the build queue was loaded off
// whichever system sorted first, not the one whose icons buy the most.
//
// On the reporter's own board (issue #747/#748, same game) the ten legal
// targets carry three different icon sets, and the Empire was holding TWO
// Address Delays:
//   corellia / mygeeto / sullust   triangle + SQUARE   (a capital ship or AT-AT)
//   mustafar                       triangle + circle
//   bothawui                       circle
// A flat 0 across all ten is indifferent between buying a Star Destroyer and
// buying a TIE fighter. So the score is weighted by icon SHAPE rather than icon
// count — square 3, circle 2, triangle 1 — the same way bestCommandAction has
// priced systems since #694, since for a BUILD mission that is exactly the
// distinction that matters.
//
// Construct Factory is folded into the same branch and keeps its +25 for a
// sabotaged target, which only IT can clear ("if there is a sabotage marker in
// this system, remove the marker before resolving"). Address Delays gets no
// such bonus: it cannot remove a marker, and sabotage does not block placing
// units on the queue anyway.
//
// Run: node scripts/test-address-delays-target-748.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();

const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');
const { missionTargets } = await import('../src/engine/missionTargets.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const fixture = readFileSync(join(ROOT, 'scripts/fixtures/imperial-production-747-748.json'), 'utf-8');
const G = codec.decode(fixture, setup.buildCatalog(data));

const legalFor = (missionId) => {
  const t = missionTargets(G, 'Empire', missionId);
  return t.permissive ? Object.keys(G.map.systems) : t.systemIds;
};
const scoreOf = (missionId, sid) => ai.empireMissionTargetScore(G, missionId, sid);
const shapesAt = (sid) => (G.catalog.systems[sid]?.resources ?? []).map((r) => r.shape);

console.log('Address Delays targeting #748');

// The fixture must actually contain the distinction, or the test proves nothing.
const legal = legalFor('address-delays');
const shapeSets = new Set(legal.map((sid) => shapesAt(sid).slice().sort().join('+')));
check('fixture offers targets with genuinely different icon sets',
  legal.length >= 5 && shapeSets.size >= 3, `${legal.length} legal, ${shapeSets.size} distinct icon sets`);

const square = legal.filter((sid) => shapesAt(sid).includes('square'));
const noSquare = legal.filter((sid) => !shapesAt(sid).includes('square') && shapesAt(sid).length > 0);
check('fixture has both square and non-square production sites',
  square.length > 0 && noSquare.length > 0);

// The bug verbatim: every legal target scored the same, so the choice was
// arbitrary.
const scores = legal.map((sid) => scoreOf('address-delays', sid));
check('Address Delays no longer scores every target identically',
  new Set(scores).size > 1, 'all legal targets still tie at ' + scores[0]);

// And the ordering is the one the report asks for: capital-ship icons first.
const bestSquare = Math.max(...square.map((sid) => scoreOf('address-delays', sid)));
const bestNoSquare = Math.max(...noSquare.map((sid) => scoreOf('address-delays', sid)));
check('a SQUARE production site outranks every non-square one',
  bestSquare > bestNoSquare, `${bestSquare} vs ${bestNoSquare}`);

// Construct Factory keeps the sabotage bonus that only it can act on (#468) —
// it must still prefer a sabotaged system over an equally-iconed clean one.
const sabotaged = legalFor('construct-factory').filter((sid) => G.map.systems[sid]?.sabotage);
check('fixture still contains a sabotaged Imperial system', sabotaged.length > 0);
const cfBest = legalFor('construct-factory')
  .map((sid) => ({ sid, s: scoreOf('construct-factory', sid) }))
  .sort((a, b) => b.s - a.s)[0];
check('Construct Factory still aims at a sabotaged system (#468 intact)',
  G.map.systems[cfBest.sid]?.sabotage === true, `chose ${cfBest.sid} at ${cfBest.s}`);

// ...while Address Delays, which cannot clear a marker, is NOT dragged onto a
// sabotaged system by a bonus it can't use.
const adSabScore = Math.max(...sabotaged.map((sid) => scoreOf('address-delays', sid)));
const adCleanBest = Math.max(...legal.filter((sid) => !G.map.systems[sid]?.sabotage)
  .map((sid) => scoreOf('address-delays', sid)));
check('Address Delays gets no sabotage bonus it cannot spend',
  adSabScore <= adCleanBest + 0.001 || adSabScore < 25,
  `sabotaged ${adSabScore} vs clean ${adCleanBest}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
