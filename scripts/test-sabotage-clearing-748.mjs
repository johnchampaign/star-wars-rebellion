// #748 — "the ai did not remove the sabotage I put on corellia in turn one -
// although it played research and development multiple times ... at the end of
// the game, I had more square-level ships than the imperials, which should
// never ever occur! it had only one sd on the board ... all this followed bad
// resource management in the beginning, where the imperials screwed up the most
// important task of building a strong army, e.g. having as many strong
// production sites (un-sabotaged) in every round where units are built."
//
// A sabotage marker "prevents the Empire from building or deploying units in
// this system" (assets/missions.json), and phases.ts skips a sabotaged system
// when it collects build icons — so a marker on an Imperial-loyal populous
// world is a standing tax on Imperial production until someone clears it.
//
// The TARGETING layer already knew that: empireMissionTargetScore has given
// Research & Development and Construct Factory +25 for a sabotaged target since
// #199/#468. The ASSIGNMENT layer did not. missionBaseValue is board-blind, so
// R&D sat at its calibrated 8.7 whether or not the Empire's only square-icon
// worlds were choked, and lost the slot to Lure of the Dark Side (17.2) and
// Construct Death Star (16.7) — the +25 aim never got a leader to aim. Worse,
// R&D was ALSO suppressed by -8 as a "probe mission" once the probe deck ran
// down, which is exactly when its sabotage-clearing half matters most.
//
// MEASURED over 191 archived games with turn snapshots (2026-09-08): 177 had an
// Imperial build system choked at some point, 65% of all turn-starts had at
// least one, 12.2% of the Empire's visible build icons were lost to sabotage
// (577 of them SQUARE — ~3 forfeited Star Destroyer/AT-AT builds per game), and
// a choke persisted a mean of 2.6 consecutive turn-starts, 43% of them for
// three or more.
//
// This test runs the reporter's own board (issue #747/#748, same game), where
// BOTH Corellia and Sullust — the two triangle+SQUARE production worlds — are
// sabotaged and Imperial-loyal, and R&D is sitting in the Empire's hand.
//
// The lever ships DEFAULT OFF (flat on the self-play bench, which can see its
// cost but not its benefit — see the A/B in randomAI.ts), so this test turns it
// on itself. NON-VACUOUSNESS: with SWR_SABOTAGE_CLEAR unset the board-blind
// assignment value is restored and two of these assertions fail. Run:
//   node scripts/test-sabotage-clearing-748.mjs
//   SWR_SABOTAGE_CLEAR=0 node scripts/test-sabotage-clearing-748.mjs   (must FAIL)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Must be set BEFORE randomAI.ts is imported — the flag is read once at module
// load. `??=` so the control run (SWR_SABOTAGE_CLEAR=0) still disables it.
process.env.SWR_SABOTAGE_CLEAR ??= '1';
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

const fixture = readFileSync(join(ROOT, 'scripts/fixtures/imperial-production-747-748.json'), 'utf-8');

// The snapshot was taken mid-COMMAND, so every Empire leader is already placed
// on the board and the pool is empty — the Assignment decision this test is
// about no longer exists on the raw board. Rewind to it the standard way: pull
// the leaders back off the map and into the pool. (Same convention as
// test-noop-activation-647 / test-mixed-theater-activation-666.)
const rewound = () => {
  const G = codec.decode(fixture, setup.buildCatalog(data));
  for (const [sid, ids] of Object.entries(G.empire.leadersOnBoard)) {
    for (const id of ids) if (!G.empire.leaderPool.includes(id)) G.empire.leaderPool.push(id);
    delete G.empire.leadersOnBoard[sid];
  }
  return G;
};

const G = rewound();

console.log('Sabotage clearing — assignment priority #748');

// ---- the fixture must actually contain the situation, or nothing below means
// anything (test-suite-baseline: "a guard only matters when the action would
// otherwise be competitive").
const sabotaged = Object.entries(G.map.systems)
  .filter(([, ss]) => ss.sabotage && ss.loyalty === 'imperial')
  .map(([sid]) => sid);
const squareChoked = sabotaged.filter((sid) =>
  (G.catalog.systems[sid]?.resources ?? []).some((r) => r.shape === 'square'));
check('fixture has Imperial-loyal systems under sabotage', sabotaged.length >= 2, `got ${sabotaged.join(',') || 'none'}`);
check('at least one choked world carries a SQUARE build icon (a capital ship / AT-AT site)',
  squareChoked.length >= 1, `choked: ${sabotaged.join(',')}`);
check('the Empire is actually holding Research & Development',
  G.empire.missionHand.includes('research-and-development'), G.empire.missionHand.join(','));
check('the Empire has leaders to assign', G.empire.leaderPool.length > 0, `${G.empire.leaderPool.length}`);

// ---- the fix: R&D must get a leader.
const plan = ai.__testPlanAssignment(G, 'Empire');
const assigned = plan.map((p) => p.missionId);
// Rank, not mere presence: with the probe deck only a third spent this board
// assigned R&D second even before the fix, so "did it appear at all" would be a
// vacuously-green assertion. Two square-icon production worlds choked is the
// Empire's most valuable errand on this board, so it must come FIRST.
check('Research & Development is the Empire\'s FIRST assignment while two square worlds are choked',
  assigned[0] === 'research-and-development',
  `planned: ${assigned.join(', ') || '(nothing)'}`);

// ---- and the reveal it will then run must aim at a sabotaged system, so the
// leader actually clears the choke rather than drawing a project somewhere else.
const rdScores = Object.keys(G.map.systems)
  .map((sid) => ({ sid, s: ai.empireMissionTargetScore(G, 'research-and-development', sid) }))
  .sort((a, b) => b.s - a.s);
check('R&D still aims at a sabotaged system once assigned',
  sabotaged.includes(rdScores[0].sid),
  `top target ${rdScores[0].sid} (${rdScores[0].s})`);

// ---- the probe-suppression carve-out: R&D must not be damped as a "probe
// mission" while its other half has a marker to clear. Post-reveal is the
// clearest form of that suppression (-8, unconditional before this change).
const Gr = rewound();
Gr.rebelBaseRevealed = true;
const planRevealed = ai.__testPlanAssignment(Gr, 'Empire').map((p) => p.missionId);
check('R&D survives the post-reveal probe suppression while a choke stands',
  planRevealed.includes('research-and-development'),
  `planned: ${planRevealed.join(', ') || '(nothing)'}`);

// ---- and the bump must be gated on a real choke, not handed out unconditionally.
const Gc = rewound();
for (const sid of sabotaged) Gc.map.systems[sid].sabotage = false;
Gc.rebelBaseRevealed = true;
const planClean = ai.__testPlanAssignment(Gc, 'Empire').map((p) => p.missionId);
check('with no sabotage on the board R&D is NOT force-assigned post-reveal',
  !planClean.includes('research-and-development'),
  `planned: ${planClean.join(', ')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
