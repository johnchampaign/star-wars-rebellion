// #858 — "Game would not permit me to 'Undo previous placement' during the
// Deployment Step."
//
// Undo works between placements, but the deploy step's LAST action (a
// placement or a "leave on build queue") ended the step on the spot: the
// picker closed, the game moved on to Assignment and that click could never be
// taken back. The play screen now holds that final action behind a
// confirmation, and asks endsDeployStep() which action is the final one.
//
// This pins endsDeployStep: false for every action that leaves this side
// another pick, true for the one that ends the step, and never a side effect
// on the live game.
// Run: node scripts/test-deploy-last-unit-confirm-858.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const { endsDeployStep } = await import('../src/play/deployFinalCheck.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

/** Drive a fresh game to the Empire's first DeployUnitPick of the turn-2
 *  Refresh, with `empireUnits` waiting to deploy. The Rebel deploys first. */
function toEmpireDeploy(seed, empireUnits) {
  const G = createGame(data, { seed, roeUnits: true, roeMissions: true });
  for (const t of empireUnits) M.buildToQueue(G, 'Empire', t, 1);
  phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');
  phases.pass(G, 'Rebel'); phases.pass(G, 'Empire');
  for (let i = 0; i < 80 && G.pendingChoice; i++) {
    const pc = G.pendingChoice;
    if (pc.kind === 'RecruitActionCardPick') { phases.resolveRecruitActionCardPick(G, pc.drawnIds[0]); continue; }
    if (pc.kind === 'BuildPick') { phases.resolveBuildPicks(G, (pc.picks ?? []).map(() => '')); continue; }
    if (pc.kind === 'DeployUnitPick' && pc.side === 'Rebel') { phases.resolveDeployUnitPick(G, pc.candidates[0]); continue; }
    break;
  }
  return G;
}
const fingerprint = (G) => { const { catalog, ...rest } = G; void catalog; return JSON.stringify(rest); };
const empirePicks = (G) => (G.refreshPaused?.pendingDeployPicks ?? []).filter((e) => e.side === 'Empire').length;

console.log('\n[ only the last unit of the step is flagged ]');
{
  const G = toEmpireDeploy(858, ['tie-fighter', 'at-st', 'star-destroyer']);
  check('reached the Empire deploy step',
    G.pendingChoice?.kind === 'DeployUnitPick' && G.pendingChoice.side === 'Empire',
    `pendingChoice=${G.pendingChoice?.kind}/${G.pendingChoice?.side}`);
  let flaggedEarly = 0, steps = 0;
  while (G.pendingChoice?.kind === 'DeployUnitPick' && G.pendingChoice.side === 'Empire' && empirePicks(G) > 1) {
    const sid = G.pendingChoice.candidates[0];
    const before = fingerprint(G);
    if (endsDeployStep(G, sid)) flaggedEarly++;
    if (endsDeployStep(G, null)) flaggedEarly++;
    check(`asking about unit ${steps + 1} leaves the live game untouched`, fingerprint(G) === before);
    phases.resolveDeployUnitPick(G, sid);
    steps++;
  }
  check('placed several units before the last', steps >= 2, `steps=${steps}`);
  check('no earlier placement or decline is flagged as the last', flaggedEarly === 0, `flagged=${flaggedEarly}`);

  check('still on a pick for the final unit', G.pendingChoice?.kind === 'DeployUnitPick' && empirePicks(G) === 1,
    `picks=${empirePicks(G)}`);
  const sid = G.pendingChoice.candidates[0];
  const before = fingerprint(G);
  check('placing the final unit is flagged', endsDeployStep(G, sid) === true);
  check('leaving the final unit on the build queue is flagged', endsDeployStep(G, null) === true);
  check('asking leaves the live game untouched', fingerprint(G) === before);
  check('the game is still waiting on that pick (Undo is still reachable)',
    G.phase === 'Refresh' && G.pendingChoice?.kind === 'DeployUnitPick');

  // And the flag is right: the real action does end the step.
  phases.resolveDeployUnitPick(G, sid);
  check('the real final placement ends the deploy step', G.pendingChoice?.kind !== 'DeployUnitPick',
    `pendingChoice=${G.pendingChoice?.kind}`);
}

console.log('\n[ the reporter\'s ending: declines on the last units ]');
{
  const G = toEmpireDeploy(859, ['stormtrooper', 'stormtrooper', 'stormtrooper']);
  let flaggedEarly = 0, declined = 0;
  while (G.pendingChoice?.kind === 'DeployUnitPick' && empirePicks(G) > 1) {
    if (endsDeployStep(G, null)) flaggedEarly++;
    phases.declineDeployUnit(G);
    declined++;
  }
  check('declined at least two units first', declined >= 2, `declined=${declined}`);
  check('no earlier decline is flagged', flaggedEarly === 0, `flagged=${flaggedEarly}`);
  check('declining the very last one is flagged', endsDeployStep(G, null) === true);
  phases.declineDeployUnit(G);
  check('and it does end the step', G.phase === 'Assignment', `phase=${G.phase}`);
}

console.log('\n[ no pending deploy pick → never flagged ]');
{
  const G = createGame(data, { seed: 1, roeUnits: true, roeMissions: true });
  check('false with no deploy pick up', endsDeployStep(G, null) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
