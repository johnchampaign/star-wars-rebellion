// #680 — RoE Shield Bunker "Local Reinforcement": "When a Shield Bunker is in a
// remote system that does not contain any Rebel units, the Imperial player may
// deploy units to that system as if it were a loyal system. This CANNOT be used
// during the build step in which the Shield Bunker is deployed."
// So a Bunker that lands this Refresh must not open its own system for the rest
// of that same deploy step; a Bunker already on the board still does.
// Run: node scripts/test-shield-bunker-local-reinforcement-680.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const M = await import('../src/engine/mechanics.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const SYS = 'dagobah'; // remote (no loyalty space), so only a Bunker can open it
const ROE = { enabled: true, roeUnits: true, roeMissions: true };

/** Fresh game with an Imperial ground unit on the remote system (so Easy
 *  Deployment can put a Bunker there) and no Rebel units anywhere near it. */
const setup = () => {
  const G = createGame(data, { seed: 7, expansion: ROE });
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.side !== 'Rebel');
  G.map.systems[SYS].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  return G;
};

/** Put the game into a live Refresh deploy step with `queue` pending. */
const startDeployStep = (G, queue) => {
  G.refreshPaused = { logStart: G.turnLog.length, pendingBuildPicks: [], pendingDeployPicks: queue.slice(), deployedThisPhase: {}, bunkersDeployedThisPhase: {} };
  phases.promoteNextDeployPick(G);
};

console.log('\n[ #680 baseline: a remote system is closed without a Bunker, open to a Bunker ]');
{
  const G = setup();
  G.refreshPaused = { logStart: 0, pendingBuildPicks: [], deployedThisPhase: {}, bunkersDeployedThisPhase: {} };
  check('TIE Fighter cannot deploy to the remote system', !phases.legalDeployTargets(G, 'Empire', 'tie-fighter').includes(SYS));
  check('Shield Bunker CAN (Easy Deployment — Imperial ground unit present)', phases.legalDeployTargets(G, 'Empire', 'shield-bunker').includes(SYS));
}

console.log('\n[ #680 the bug: Bunker deployed this step must NOT open its own system ]');
{
  const G = setup();
  startDeployStep(G, [{ side: 'Empire', typeId: 'shield-bunker' }, { side: 'Empire', typeId: 'tie-fighter' }]);
  check('first pick is the Shield Bunker, offering the remote system', G.pendingChoice?.kind === 'DeployUnitPick' && G.pendingChoice.typeId === 'shield-bunker' && G.pendingChoice.candidates.includes(SYS), JSON.stringify(G.pendingChoice?.typeId));
  const r = phases.resolveDeployUnitPick(G, SYS);
  check('Bunker deploys ok', r.ok, r.reason);
  check('Bunker is on the board', G.map.systems[SYS].units.some((u) => u.typeId === 'shield-bunker'));
  check('next pick is the TIE Fighter', G.pendingChoice?.kind === 'DeployUnitPick' && G.pendingChoice.typeId === 'tie-fighter', JSON.stringify(G.pendingChoice?.typeId));
  check('TIE Fighter is NOT offered the remote system (same-step lockout)', !(G.pendingChoice?.candidates ?? []).includes(SYS), JSON.stringify(G.pendingChoice?.candidates));
  check('and submitting it anyway is rejected', phases.resolveDeployUnitPick(G, SYS).ok === false);
}

console.log('\n[ #680 a Bunker already on the board still opens the system ]');
{
  const G = setup();
  M.deployUnit(G, 'Empire', 'shield-bunker', SYS); // arrived on an earlier turn
  startDeployStep(G, [{ side: 'Empire', typeId: 'tie-fighter' }]);
  check('TIE Fighter IS offered the remote system', (G.pendingChoice?.candidates ?? []).includes(SYS), JSON.stringify(G.pendingChoice?.candidates));
  check('and it deploys', phases.resolveDeployUnitPick(G, SYS).ok);
}

console.log('\n[ #680 an established Bunker keeps working even if a second one lands beside it ]');
{
  const G = setup();
  M.deployUnit(G, 'Empire', 'shield-bunker', SYS); // established
  startDeployStep(G, [{ side: 'Empire', typeId: 'shield-bunker' }, { side: 'Empire', typeId: 'tie-fighter' }]);
  phases.resolveDeployUnitPick(G, SYS); // second Bunker lands this step
  check('two Bunkers present', G.map.systems[SYS].units.filter((u) => u.typeId === 'shield-bunker').length === 2);
  check('TIE Fighter still offered the system (the established Bunker enables it)', (G.pendingChoice?.candidates ?? []).includes(SYS), JSON.stringify(G.pendingChoice?.candidates));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
