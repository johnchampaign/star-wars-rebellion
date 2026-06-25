// #309 — FFG FAQ (May 2019): an Assignment-phase ability that places a leader on
// a mission (Our Most Desperate Hour, Proceeding As Planned) lets the player
// assign a SECOND leader to that mission. (Corrects the earlier #295 ruling.)
// Run: node scripts/test-omdh-second-leader-309.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

function omdhPlaceLeia(G) {
  // Force Leia into the pool, ensure the deck has a target mission, and post the pick.
  if (!G.rebel.leaderPool.includes('princess-leia')) G.rebel.leaderPool.push('princess-leia');
  const target = G.rebel.missionDeck[0];
  G.pendingChoice = { kind: 'OurMostDesperateHourPick', side: 'Rebel', candidates: [target] };
  phases.resolveOurMostDesperateHourPick(G, target);
  return target;
}

console.log('\n[ #309 OMDH offers a second leader after placing Leia ]');
{
  const G = createGame(data, opts(1));
  const target = omdhPlaceLeia(G);
  check('mission assigned with Leia', G.rebel.leadersOnMissions.some(
    (m) => m.missionId === target && m.leaderIds.includes('princess-leia')));
  check('AssignSecondLeaderPick posted', G.pendingChoice?.kind === 'AssignSecondLeaderPick',
    G.pendingChoice?.kind);
  check('candidates are pool leaders (Leia already committed, so not listed)',
    (G.pendingChoice?.candidates?.length ?? 0) > 0 && !G.pendingChoice.candidates.includes('princess-leia'));

  const second = G.pendingChoice.candidates[0];
  const r = phases.resolveAssignSecondLeader(G, second);
  check('assign second leader ok', r.ok, r.reason);
  const am = G.rebel.leadersOnMissions.find((m) => m.missionId === target);
  check('mission now has TWO leaders (Leia + chosen)',
    am?.leaderIds.length === 2 && am.leaderIds.includes('princess-leia') && am.leaderIds.includes(second),
    `leaders=${JSON.stringify(am?.leaderIds)}`);
  check('second leader removed from the pool', !G.rebel.leaderPool.includes(second));
  check('choice cleared', G.pendingChoice === undefined);
}

console.log('\n[ #309 declining keeps the second leader free ]');
{
  const G = createGame(data, opts(2));
  const target = omdhPlaceLeia(G);
  const poolBefore = G.rebel.leaderPool.length;
  const r = phases.resolveAssignSecondLeader(G, null);
  check('decline ok', r.ok, r.reason);
  const am = G.rebel.leadersOnMissions.find((m) => m.missionId === target);
  check('mission keeps just Leia', am?.leaderIds.length === 1 && am.leaderIds[0] === 'princess-leia');
  check('pool unchanged on decline', G.rebel.leaderPool.length === poolBefore);
}

console.log('\n[ #309 no pool leaders → no second-leader prompt ]');
{
  const G = createGame(data, opts(3));
  // Empty the Rebel pool except Leia (who gets placed).
  G.rebel.leaderPool = ['princess-leia'];
  const target = G.rebel.missionDeck[0];
  G.pendingChoice = { kind: 'OurMostDesperateHourPick', side: 'Rebel', candidates: [target] };
  phases.resolveOurMostDesperateHourPick(G, target);
  check('no AssignSecondLeaderPick when pool is empty after Leia',
    G.pendingChoice === undefined, G.pendingChoice?.kind);
}

console.log('\n[ #309 duplicate-mission soft-lock: second copy fetched while the first is assigned ]');
{
  // The mission deck has duplicate copies. If one copy is already assigned (with
  // two leaders), OMDH fetching the OTHER copy used to make the second-leader
  // resolver find the wrong (full) entry by missionId, reject the pick, and
  // leave the prompt open forever — soft-locking the player (forum report: bobbi).
  const G = createGame(data, opts(7));
  const f = G.rebel;
  for (const list of Object.values(f.leadersOnBoard)) list.length = 0;
  f.leadersOnMissions = [];
  f.leaderPool = ['general-rieekan', 'jan-dodonna', 'mon-mothma', 'princess-leia'];
  // Find a mission that appears at least twice in the deck.
  const counts = {};
  for (const m of f.missionDeck) counts[m] = (counts[m] || 0) + 1;
  const dup = Object.keys(counts).find((m) => counts[m] >= 2);
  check('a duplicate mission exists in the deck', !!dup, JSON.stringify(counts));
  // Pre-assign one copy with TWO leaders (full).
  f.leadersOnMissions.push({ missionId: dup, leaderIds: ['mon-mothma', 'jan-dodonna'] });
  // OMDH fetches the other copy and places Leia.
  G.pendingChoice = { kind: 'OurMostDesperateHourPick', side: 'Rebel', candidates: [dup] };
  phases.resolveOurMostDesperateHourPick(G, dup);
  check('second-leader prompt posted', G.pendingChoice?.kind === 'AssignSecondLeaderPick');
  const r = phases.resolveAssignSecondLeader(G, 'general-rieekan');
  check('assigning the second leader succeeds (no soft-lock)', r.ok, r.reason);
  check('the prompt is cleared (player not stranded)', G.pendingChoice === undefined, G.pendingChoice?.kind);
  // The leader must land on the OMDH (Leia) entry, not the already-full copy.
  const leiaEntry = f.leadersOnMissions.find((m) => m.missionId === dup && m.leaderIds.includes('princess-leia'));
  check('second leader joined the LEIA copy', !!leiaEntry && leiaEntry.leaderIds.includes('general-rieekan'),
    JSON.stringify(f.leadersOnMissions));
  const fullEntry = f.leadersOnMissions.find((m) => m.missionId === dup && !m.leaderIds.includes('princess-leia'));
  check('the already-full copy is untouched (still 2 leaders)', fullEntry?.leaderIds.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
