// #811 (eu46ho, playing Empire): "Should only be able to deploy 2 units per
// system. When deploying the Death Star when it was finally constructed, I was
// allowed to place the Death Star and 2 additional units in Dathomir (units
// allowed to be placed due to a shield bunker there)."
//
// RoE (Shield Bunker — Local Reinforcement): "Note that deploying a Death Star
// to this system counts toward the limit of deploying 2 units during the
// Refresh Phase." The completed Death Star was placed straight onto its marker
// without being counted, so both normal deploy slots stayed open behind it.
//
// Pins: the Death Star counts as one of the system's two deploys, it is placed
// first even when queued behind other units, and the cap then lets exactly one
// more unit in. Elsewhere on the board the cap is unchanged.
// Run: node scripts/test-death-star-deploy-cap-811.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const M = await import('../src/engine/mechanics.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const SYS = 'dathomir'; // remote: only an established Shield Bunker opens it
const ROE = { enabled: true, roeUnits: true, roeMissions: true };

/** The reporter's Dathomir: a Death Star under construction, a Shield Bunker
 *  that has been there since an earlier turn, an Imperial trooper, no Rebels. */
function setup() {
  const G = createGame(data, { seed: 811, expansion: ROE });
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.typeId !== 'death-star' && u.typeId !== 'death-star-under-construction');
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.side !== 'Rebel');
  G.map.systems[SYS].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  M.deployUnit(G, 'Empire', 'shield-bunker', SYS);
  M.deployUnit(G, 'Empire', 'death-star-under-construction', SYS);
  return G;
}
const startDeployStep = (G, queue) => {
  G.refreshPaused = { logStart: G.turnLog.length, pendingBuildPicks: [], pendingDeployPicks: queue.slice(), deployedThisPhase: {}, bunkersDeployedThisPhase: {} };
  phases.promoteNextDeployPick(G);
};
const here = (G, typeId) => G.map.systems[SYS].units.filter((u) => u.typeId === typeId).length;

console.log('[ the board ]');
{
  const G = setup();
  check('Dathomir is remote', !!G.catalog.systems[SYS].isRemote);
  G.refreshPaused = { logStart: 0, pendingBuildPicks: [], deployedThisPhase: {}, bunkersDeployedThisPhase: {} };
  check('the established Shield Bunker opens it to normal deploys', phases.legalDeployTargets(G, 'Empire', 'tie-fighter').includes(SYS));
}

console.log('[ the reported deploy: Death Star queued behind two TIE Fighters ]');
{
  const G = setup();
  startDeployStep(G, [{ side: 'Empire', typeId: 'tie-fighter' }, { side: 'Empire', typeId: 'tie-fighter' }, { side: 'Empire', typeId: 'death-star' }]);
  check('the Death Star is placed first, on its marker', here(G, 'death-star') === 1 && here(G, 'death-star-under-construction') === 0);
  check('it counts as one of Dathomir\'s two deploys', G.refreshPaused.deployedThisPhase?.Empire?.[SYS] === 1, JSON.stringify(G.refreshPaused.deployedThisPhase));
  check('the first TIE may still go to Dathomir', G.pendingChoice?.kind === 'DeployUnitPick' && G.pendingChoice.candidates.includes(SYS), JSON.stringify(G.pendingChoice?.candidates));
  check('…and deploys', phases.resolveDeployUnitPick(G, SYS).ok);
  check('the second TIE is NOT offered Dathomir (Death Star + 1 = the limit)', G.pendingChoice?.kind === 'DeployUnitPick' && !G.pendingChoice.candidates.includes(SYS), JSON.stringify(G.pendingChoice?.candidates));
  check('…and submitting it anyway is refused', phases.resolveDeployUnitPick(G, SYS).ok === false);
  check('Dathomir received exactly two units this Refresh', here(G, 'death-star') + here(G, 'tie-fighter') === 2);
}

console.log('[ controls ]');
{
  const G = setup();
  startDeployStep(G, [{ side: 'Empire', typeId: 'tie-fighter' }, { side: 'Empire', typeId: 'tie-fighter' }]);
  phases.resolveDeployUnitPick(G, SYS);
  check('without a Death Star, two TIEs may both deploy to Dathomir', G.pendingChoice?.kind === 'DeployUnitPick' && G.pendingChoice.candidates.includes(SYS));
  check('…and the second one does', phases.resolveDeployUnitPick(G, SYS).ok && here(G, 'tie-fighter') === 2);
}
{
  const G = setup();
  startDeployStep(G, [{ side: 'Empire', typeId: 'death-star' }, { side: 'Empire', typeId: 'tie-fighter' }]);
  const other = G.pendingChoice?.candidates?.find((s) => s !== SYS);
  check('the Death Star does not use up another system\'s slots', !!other && phases.resolveDeployUnitPick(G, other).ok, JSON.stringify(G.pendingChoice?.candidates));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
