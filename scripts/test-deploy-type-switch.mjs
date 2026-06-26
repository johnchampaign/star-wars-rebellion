// Deploy type chooser: the player can pick WHICH queued unit type to place next,
// instead of being walked through a fixed grouped order (had to "save" every
// Stormtrooper to reach the Star Destroyer). switchDeployType moves the chosen
// type to the front and re-posts the pick for it.
// Run: node scripts/test-deploy-type-switch.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

console.log('\n[ deploy: choose which queued type to place next ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: true });
  // Give the Empire a build-queue slot-1 with grouped types: 2 stormtroopers + 1 SD.
  // Multiple loyal Imperial systems exist, so each gets a real DeployUnitPick.
  G.refreshPaused = { logStart: G.turnLog.length, pendingBuildPicks: [],
    pendingDeployPicks: [
      { side: 'Empire', typeId: 'stormtrooper' },
      { side: 'Empire', typeId: 'stormtrooper' },
      { side: 'Empire', typeId: 'star-destroyer' },
    ], deployedThisPhase: {} };
  phases.promoteNextDeployPick(G);
  let pc = G.pendingChoice;
  check('a DeployUnitPick is posted', pc?.kind === 'DeployUnitPick');
  check('the head type is offered first (stormtrooper)', pc?.typeId === 'stormtrooper', pc?.typeId);
  check('remaining lists both types with counts',
    JSON.stringify(pc?.remaining) === JSON.stringify([{ typeId: 'stormtrooper', count: 2 }, { typeId: 'star-destroyer', count: 1 }]),
    JSON.stringify(pc?.remaining));

  // Switch to the Star Destroyer without first dealing with the stormtroopers.
  const r = phases.switchDeployType(G, 'star-destroyer');
  check('switch ok', r.ok, r.reason);
  pc = G.pendingChoice;
  check('now offering the Star Destroyer', pc?.kind === 'DeployUnitPick' && pc?.typeId === 'star-destroyer', pc?.typeId);
  check('stormtroopers still queued (×2)',
    (pc?.remaining ?? []).find((e) => e.typeId === 'stormtrooper')?.count === 2);

  // Deploy the SD; the stormtroopers should remain to be placed.
  const sys = pc.candidates[0];
  const r2 = phases.resolveDeployUnitPick(G, sys);
  check('deploy SD ok', r2.ok, r2.reason);
  check('SD landed at chosen system', G.map.systems[sys].units.some((u) => u.side === 'Empire' && u.typeId === 'star-destroyer'));
  const pc3 = G.pendingChoice;
  check('next pick is back to the stormtroopers', pc3?.kind === 'DeployUnitPick' && pc3?.typeId === 'stormtrooper', pc3?.typeId);
}

console.log('\n[ switching to a non-queued type is rejected ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: true });
  G.refreshPaused = { logStart: 0, pendingBuildPicks: [],
    pendingDeployPicks: [{ side: 'Empire', typeId: 'stormtrooper' }, { side: 'Empire', typeId: 'at-at' }], deployedThisPhase: {} };
  phases.promoteNextDeployPick(G);
  const r = phases.switchDeployType(G, 'tie-fighter');
  check('rejects a type not in the queue', !r.ok, JSON.stringify(r));
  check('the pick is unchanged', G.pendingChoice?.kind === 'DeployUnitPick' && G.pendingChoice?.typeId === 'stormtrooper');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
