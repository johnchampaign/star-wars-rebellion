// #293 — False Orders is offered at the END of the Assignment phase (after the
// Empire has assigned), not during the Rebel's own turn.
// Run: node scripts/test-false-orders-293.mjs
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

const opts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, roeUnits: true },
});

/** Put the game into a clean Assignment phase with the Rebel holding False
 *  Orders and the Empire having one lone leader assigned to a mission. */
function setupAssignment(seed) {
  const G = createGame(data, opts(seed));
  G.phase = 'Assignment';
  G.currentPlayer = 'Rebel';
  G.pendingChoice = undefined;
  G.rebel.actionHand = ['false-orders'];
  // Empire has one lone leader on a mission.
  const empLeader = G.empire.leaderPool[0];
  G.empire.leadersOnMissions = [{ missionId: 'gather-intel', leaderIds: [empLeader] }];
  // Make sure that leader is not also in the pool (it's committed).
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== empLeader);
  return { G, empLeader };
}

console.log('\n[ #293 False Orders NOT offered during the Rebel\'s own turn ]');
{
  const { G } = setupAssignment(960);
  const playable = phases.playableAssignmentActionCards(G, 'Rebel');
  check('false-orders excluded from normal assignment-turn list',
    !playable.includes('false-orders'), `got [${playable.join(',')}]`);
}

console.log('\n[ #293 window appears after BOTH sides skip; play returns leader+mission ]');
{
  const { G, empLeader } = setupAssignment(961);
  // Rebel skips → Empire's turn (no window yet).
  phases.skipAssignment(G, 'Rebel');
  check('no window before the Empire finishes',
    G.pendingChoice?.kind !== 'FalseOrdersWindow' && G.phase === 'Assignment');
  // Empire skips → end-of-phase window should appear (not Command yet).
  phases.skipAssignment(G, 'Empire');
  check('FalseOrdersWindow posted after Empire done',
    G.pendingChoice?.kind === 'FalseOrdersWindow', G.pendingChoice?.kind);
  check('still in Assignment (not advanced yet)', G.phase === 'Assignment');
  check('window lists the lone Imperial leader',
    G.pendingChoice?.candidates?.[0]?.leaderId === empLeader);

  const r = phases.resolveFalseOrders(G, empLeader);
  check('resolveFalseOrders ok', r.ok, r.reason);
  check('leader returned to Empire pool', G.empire.leaderPool.includes(empLeader));
  check('mission returned to Empire hand', G.empire.missionHand.includes('gather-intel'));
  check('Empire assignment cleared', G.empire.leadersOnMissions.length === 0);
  check('False Orders discarded', G.rebel.actionDiscard.includes('false-orders')
    && !G.rebel.actionHand.includes('false-orders'));
  check('advanced to Command', G.phase === 'Command');
}

console.log('\n[ #293 declining keeps the card and advances to Command ]');
{
  const { G } = setupAssignment(962);
  phases.skipAssignment(G, 'Rebel');
  phases.skipAssignment(G, 'Empire');
  check('window posted', G.pendingChoice?.kind === 'FalseOrdersWindow');
  const r = phases.resolveFalseOrders(G, null);
  check('decline ok', r.ok, r.reason);
  check('card still in hand', G.rebel.actionHand.includes('false-orders'));
  check('Empire assignment untouched', G.empire.leadersOnMissions.length === 1);
  check('advanced to Command', G.phase === 'Command');
}

console.log('\n[ #293 no window when there is no lone Imperial leader ]');
{
  const { G } = setupAssignment(963);
  G.empire.leadersOnMissions = []; // Empire assigned nothing lone
  phases.skipAssignment(G, 'Rebel');
  phases.skipAssignment(G, 'Empire');
  check('no window, straight to Command',
    G.pendingChoice?.kind !== 'FalseOrdersWindow' && G.phase === 'Command');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
