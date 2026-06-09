// Phase machinery smoke tests. Run: node scripts/test-phases.mjs

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
function check(name, ok, extra = '') {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
}

// The Refresh phase is now interactive: it pauses on RecruitActionCardPick
// (and RecruitLeaderPick when a card lists 2+ leaders), then on BuildPick for
// completed builds. The phase only advances to the next round's Assignment once
// those resolve. Drain them with sensible defaults (keep the first drawn card /
// first leader / first legal unit type) so the test can observe the round
// rollover. Engine behavior is correct; the test predates the interactive steps.
function drainRefreshChoices(G) {
  for (let i = 0; i < 50 && G.phase === 'Refresh' && G.pendingChoice; i++) {
    const c = G.pendingChoice;
    if (c.kind === 'RecruitActionCardPick') phases.resolveRecruitActionCardPick(G, c.drawnIds[0]);
    else if (c.kind === 'RecruitLeaderPick') phases.resolveRecruitLeaderPick(G, c.candidates[0]);
    else if (c.kind === 'BuildPick') phases.resolveBuildPicks(G, c.picks.map((p) => p.legalUnitTypes[0]));
    else if (c.kind === 'DeployUnitPick') phases.resolveDeployUnitPick(G, c.candidates[0]);
    else break; // unknown refresh choice — let the assertion surface it
  }
}

// ---------- Assignment Phase ----------
console.log('\n[ Assignment Phase ]');
{
  const G = createGame(data, { seed: 100 });
  check('starts in Assignment, Rebel first', G.phase === 'Assignment' && G.currentPlayer === 'Rebel');

  // Find a Rebel starting mission and assign Mon Mothma to it.
  const rebelMissions = G.rebel.missionHand;
  const m = rebelMissions[0];
  const r1 = phases.assignLeader(G, 'Rebel', m, ['mon-mothma']);
  check('Rebel can assign a leader', r1.ok);

  // Empire trying to assign on Rebel's turn fails.
  const r2 = phases.assignLeader(G, 'Empire', G.empire.missionHand[0], ['darth-vader']);
  check('Empire blocked on Rebel turn', !r2.ok && r2.reason === 'not-your-turn');

  // Rebel skips assignment; turn passes to Empire.
  phases.skipAssignment(G, 'Rebel');
  check('after Rebel skip, currentPlayer = Empire', G.currentPlayer === 'Empire' && G.phase === 'Assignment');

  // Empire assigns Vader.
  const r3 = phases.assignLeader(G, 'Empire', G.empire.missionHand[0], ['darth-vader']);
  check('Empire can assign', r3.ok);

  // Empire skips. Should now be in Command.
  phases.skipAssignment(G, 'Empire');
  check('both skipped -> Command phase, Rebel first', G.phase === 'Command' && G.currentPlayer === 'Rebel');
}

// ---------- Command Phase: pass alternation ----------
console.log('\n[ Command Phase: pass alternation ]');
{
  const G = createGame(data, { seed: 101 });
  // Skip assignment for both
  phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');
  check('in Command', G.phase === 'Command');

  phases.pass(G, 'Rebel');
  check('Rebel passes, Empire is current', G.currentPlayer === 'Empire' && G.passedThisCommand.includes('Rebel'));

  phases.pass(G, 'Empire');
  check('both passed -> Refresh', G.phase !== 'Command' && (G.phase === 'Refresh' || G.phase === 'Assignment'));
}

// ---------- Refresh Phase: time advances, leaders return ----------
console.log('\n[ Refresh Phase ]');
{
  const G = createGame(data, { seed: 102 });
  // Assign Mon Mothma to a mission; Rebel needs to verify she comes back.
  const m = G.rebel.missionHand[0];
  phases.assignLeader(G, 'Rebel', m, ['mon-mothma']);
  phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');
  // Both pass immediately.
  phases.pass(G, 'Rebel'); phases.pass(G, 'Empire');
  drainRefreshChoices(G); // resolve interactive recruit picks so the round rolls over

  check('Mon Mothma back in pool after refresh', G.rebel.leaderPool.includes('mon-mothma'));
  check('mission returned to hand', G.rebel.missionHand.includes(m));
  check('timeMarker advanced to 2', G.timeMarker === 2);
  check('reputation unchanged at 14', G.reputationMarker === 14);
  check('back in Assignment for round 2', G.phase === 'Assignment' && G.currentPlayer === 'Rebel');
}

// ---------- ActivateSystem: basic flow ----------
console.log('\n[ ActivateSystem ]');
{
  const G = createGame(data, {
    seed: 103,
    forcedBaseSystem: 'kashyyyk',
    forcedRebelLoyalty: ['kashyyyk', 'mon-calamari', 'bothawui'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  // Skip assignment.
  phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');

  // Try to activate with a tactic-less leader (Mon Mothma) — should fail.
  const r1 = phases.activateSystem(G, 'Rebel', 'mon-mothma', 'kashyyyk', []);
  check('cannot activate with 0-tactic leader', !r1.ok && r1.reason === 'leader-has-no-tactic-values');

  // Activate with Jan Dodonna (space 2, ground 1) — placing without moves should succeed.
  const r2 = phases.activateSystem(G, 'Rebel', 'jan-dodonna', 'kashyyyk', []);
  check('activate with valid leader, no moves', r2.ok);
  check('leader placed in target system', (G.rebel.leadersOnBoard['kashyyyk'] ?? []).includes('jan-dodonna'));
  check('turn passed to Empire', G.currentPlayer === 'Empire');
}

// ---------- RevealMission: skill check ----------
console.log('\n[ RevealMission ]');
{
  const G = createGame(data, { seed: 104 });
  // Find a Rebel mission that needs a low diplomacy. Try Build Alliance (diplomacy 1).
  const m = G.rebel.missionHand.find((id) => id === 'build-alliance');
  if (!m) {
    check('Build Alliance is in starting hand', false, 'card not found');
  } else {
    // Assign Mon Mothma (diplomacy 3) — meets the 1 requirement.
    phases.assignLeader(G, 'Rebel', m, ['mon-mothma']);
    phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');

    // Build Alliance needs a populous system. Use Felucia (populous).
    const r = phases.revealMission(G, 'Rebel', m, 'felucia');
    check('reveal Build Alliance succeeds', r.ok);
    // Since isAttempt is true, pendingMission should be set (waiting for opposition).
    check('pending mission set when isAttempt', G.pendingMission !== undefined);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
