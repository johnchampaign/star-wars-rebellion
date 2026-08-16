// "The empire uses capture rebel operative way to little ... It's such a big
// advantage to remove a leader ... capture rebel operative should happen more
// often from turn 2-3 IMO."  — jocke01, BGG
//
// He was right, and the cause is structural rather than a matter of taste.
//
// The Empire only assigned the mission if a Rebel leader was ALREADY standing
// in a system containing an Imperial unit. Measured across 60 games: at the
// start of the Assignment phase there were ZERO Rebel leaders on the board in
// 513 of 513 rounds — 100%. Rebel leaders do not reach the board until they
// reveal their own missions during the Command phase, so the gate asked its
// question at the one moment each round when the answer cannot be yes.
//
// Result: assigned 0.23 times per game against rule-by-fear's 5.33, and first
// attempted around turn 6 rather than turn 2-3.
//
// The exception already existed for the other two leader-targeting missions —
// Detained and Collect Bounty — with a comment describing this exact problem.
// capture-rebel-operative was simply never added to it. It does need a
// stricter test than its siblings: they target a leader "in any system", while
// this one needs one "in a system that contains an Imperial unit", so the
// Empire must actually hold ground somewhere for the capture to be possible.
//
// Run: node scripts/test-capture-operative-assignment.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const MID = 'capture-rebel-operative';

/** The board as it actually looks when the Empire assigns: no Rebel leaders
 *  anywhere (they are all still in the pool), Imperial units on the map. */
function board(seed, { empireHoldsGround = true, rebelHasLeaders = true } = {}) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  // The measured reality of every Assignment phase: zero Rebel leaders on board.
  G.rebel.leadersOnBoard = {};
  G.empire.leadersOnBoard = {};
  if (!rebelHasLeaders) { G.rebel.leaderPool = []; G.rebel.leadersOnMissions = []; }
  if (!empireHoldsGround) {
    for (const ss of Object.values(G.map.systems)) {
      ss.units = (ss.units ?? []).filter((u) => u.side !== 'Empire');
    }
  }
  // Put the mission in hand so it is assignable at all.
  if (!(G.empire.missionHand ?? []).includes(MID)) G.empire.missionHand = [MID, ...(G.empire.missionHand ?? [])];
  // A turn-1 pool of 4 leaves ONE assignment slot (EMPIRE_RESERVE_LEADERS holds
  // 3 back for the Command phase), and a single slot goes to gather-intel (base
  // 15) or R&D (13) every time — so a turn-1 board tests the value table, not
  // the gate under test. Recruit the pool up to a mid-game size so there are
  // slots to compete for, which is where the harness sees 3.17 assignments per
  // game rather than 0.21.
  const extra = Object.keys(G.catalog.leaders).filter((l) =>
    G.catalog.leaders[l]?.side === 'Empire' && !G.empire.leaderPool.includes(l));
  G.empire.leaderPool = [...G.empire.leaderPool, ...extra.slice(0, 6)];
  return G;
}

const assigns = (G) => ai.__testPlanAssignment(G, 'Empire').some((p) => p.missionId === MID);
/** How many of N seeded boards assign it — the mission competes with others, so
 *  a rate is the honest measure, not a single board. */
function rate(opts = {}, n = 30) {
  let hits = 0;
  for (let s = 1; s <= n; s++) if (assigns(board(s, opts))) hits++;
  return hits / n;
}

console.log('\n[ the precondition: no Rebel leader is ever on the board to target ]');
{
  const G = board(1);
  const onBoard = Object.values(G.rebel.leadersOnBoard).reduce((n, l) => n + l.length, 0);
  check('zero Rebel leaders on the board at assignment time', onBoard === 0, String(onBoard));
  check('but the Rebel does have leaders that will surface',
    G.rebel.leaderPool.length > 0 || (G.rebel.leadersOnMissions ?? []).length > 0);
  check('and the Empire holds ground somewhere they could surface into',
    Object.values(G.map.systems).some((ss) => (ss.units ?? []).some((u) => u.side === 'Empire')));
}

console.log('\n[ it is now assignable despite no CURRENT target ]');
{
  const on = rate();
  console.log(`    assigned on ${Math.round(on * 100)}% of boards`);
  check('the Empire will now assign Capture Rebel Operative', on > 0,
    'never assigned on any of 30 boards');
}

console.log('\n[ the card\'s extra clause is respected ]');
{
  // Detained and Collect Bounty only need a leader to surface. This one needs a
  // leader to surface WHERE THE EMPIRE IS, so with no Imperial units on the map
  // the assignment is guaranteed waste.
  const noGround = rate({ empireHoldsGround: false });
  check('with NO Imperial units on the map it is never assigned', noGround === 0,
    `assigned on ${Math.round(noGround * 100)}% of boards`);

  const noLeaders = rate({ rebelHasLeaders: false });
  check('with no Rebel leaders to capture it is never assigned', noLeaders === 0,
    `assigned on ${Math.round(noLeaders * 100)}% of boards`);
}

console.log('\n[ the lever restores the old behaviour ]');
{
  process.env.SWR_CAPTURE_ASSIGN = '0';
  const mod = await import(`../src/play/randomAI.ts?nocache=${Date.now()}`);
  let hits = 0;
  for (let s = 1; s <= 30; s++) {
    if (mod.__testPlanAssignment(board(s), 'Empire').some((p) => p.missionId === MID)) hits++;
  }
  delete process.env.SWR_CAPTURE_ASSIGN;
  console.log(`    with SWR_CAPTURE_ASSIGN=0: assigned on ${Math.round(100 * hits / 30)}% of boards`);
  check('the old gate blocks it on every board', hits === 0, `still assigned ${hits}/30`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
