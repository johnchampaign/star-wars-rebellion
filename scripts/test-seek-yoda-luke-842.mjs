// #842: "the rebel gave Princess Leia the seek Yoda mission although it had
// Luke - why?"
//
// Seek Yoda: "Attach the Master Yoda ring to this leader ... If Luke Skywalker
// resolves this mission, also replace his leader with Luke Skywalker (Jedi)."
// Sending anyone else throws away the Jedi upgrade.
//
// planAssignment built each mission's leader set greedily, by skill fit (and,
// with the opportunity-cost lever, by cheapest tactics). Seek Yoda costs 1
// intel; Leia and Luke both have 2, and Leia sits earlier in the pool, so both
// orderings seated Leia. The portrait/bespoke pairing bonuses (+9 for Luke) were
// only ever used to SCORE a set already built, never to build one, so Luke was
// never considered. The planner now also builds a pairing-first set.
//
// Board: the reporter's own (fixtures/seek-yoda-842.json, taken right after the
// assignment), rewound to the start of the Assignment phase.
//
// Run: node scripts/test-seek-yoda-luke-842.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const ai = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

function assignmentBoard() {
  const G = codec.decode(readFileSync(join(ROOT, 'scripts/fixtures/seek-yoda-842.json'), 'utf8'),
    setup.buildCatalog(data));
  const r = G.rebel;
  r.missionHand.push('seek-yoda', ...r.leadersOnMissions.map((m) => m.missionId));
  r.missionDiscard = r.missionDiscard.filter((m) => m !== 'seek-yoda');
  r.leaderPool.push('princess-leia', ...r.leadersOnMissions.flatMap((m) => m.leaderIds));
  r.leadersOnMissions = [];
  r.leadersOnBoard = {};
  G.leaderAttachments = {};
  G.phase = 'Assignment';
  return G;
}

console.log('Seek Yoda goes to Luke when he is free (#842)');
const G = assignmentBoard();
check('board rewound: Luke and Leia both in the pool',
  G.rebel.leaderPool.includes('luke-skywalker') && G.rebel.leaderPool.includes('princess-leia'));
check('Leia sits ahead of Luke in the pool (the tie that hid the bug)',
  G.rebel.leaderPool.indexOf('princess-leia') < G.rebel.leaderPool.indexOf('luke-skywalker'));
const plan = ai.__testPlanAssignment(G, 'Rebel');
const yoda = plan.find((p) => p.missionId === 'seek-yoda');
check('Seek Yoda is assigned', !!yoda, JSON.stringify(plan));
check('Seek Yoda goes to Luke alone', yoda && yoda.leaderIds.length === 1 && yoda.leaderIds[0] === 'luke-skywalker',
  JSON.stringify(yoda));

console.log('Without Luke, Seek Yoda can still go to someone else');
const G2 = assignmentBoard();
G2.rebel.leaderPool = G2.rebel.leaderPool.filter((l) => l !== 'luke-skywalker');
const yoda2 = ai.__testPlanAssignment(G2, 'Rebel').find((p) => p.missionId === 'seek-yoda');
check('Seek Yoda still staffed', !!yoda2 && !yoda2.leaderIds.includes('luke-skywalker'), JSON.stringify(yoda2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
