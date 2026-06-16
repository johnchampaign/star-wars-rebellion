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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
