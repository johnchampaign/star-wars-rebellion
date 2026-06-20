// Rescuer return-to-base (#346, RR p.12): after a rescue mission, the RESCUING
// leaders may move to the Rebel Base too (the prisoner already does). The engine
// previously left them in the mission system with no choice. For the Greater
// Good is the exception (its leaders are forced to stay).
// Run: node scripts/test-rescuer-return-346.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
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

// Drive an unopposed rescue mission to success at `target` with `rescuer`.
function rescue({ seed = 1, missionId, target = 'corellia', rescuer }) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  // Empire units (no leaders) at the target: keeps Leia captured + unopposed.
  delete G.empire.leadersOnBoard[target];
  M.deployUnit(G, 'Empire', 'stormtrooper', target);
  // Capture Leia at the target.
  if (!G.rebel.leaderPool.includes('princess-leia')) G.rebel.leaderPool.push('princess-leia');
  M.placeLeader(G, 'Rebel', 'princess-leia', target);
  M.captureLeader(G, 'princess-leia');
  // Assign the rescuer and reveal.
  G.phase = 'Assignment';
  G.currentPlayer = 'Rebel';
  G.passedThisCommand = [];
  if (!G.rebel.leaderPool.includes(rescuer)) G.rebel.leaderPool.push(rescuer);
  G.rebel.missionHand = [missionId];
  const asg = phases.assignLeader(G, 'Rebel', missionId, [rescuer]);
  if (!asg.ok) return { error: `assign:${asg.reason}`, G };
  G.phase = 'Command';
  const rv = phases.revealMission(G, 'Rebel', missionId, target);
  if (!rv.ok) return { error: `reveal:${rv.reason}`, G };
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null, false);
  return { G, target };
}
const atBase = (G, lid) => {
  const key = G.rebelBaseRevealed ? G.rebelBaseSystemId : 'rebel-base-space';
  return (G.rebel.leadersOnBoard[key] ?? []).includes(lid);
};

console.log('\n[ Daring Rescue: prisoner freed, rescuer offered the return choice ]');
{
  const { G, error, target } = rescue({ missionId: 'daring-rescue', rescuer: 'cassian-andor' });
  check('no setup error', !error, error);
  check('Leia was rescued (no longer captured)',
    !(G.empire.capturedLeaders ?? []).some((c) => c.leaderId === 'princess-leia'));
  check('Leia is at the Rebel base', atBase(G, 'princess-leia'));
  check('a RescuerReturn choice is posted', G.pendingChoice?.kind === 'RescuerReturn', G.pendingChoice?.kind);
  check('the choice lists the rescuing leader', (G.pendingChoice?.leaderIds ?? []).includes('cassian-andor'));
}

console.log('\n[ choose to return the rescuer → moves to base ]');
{
  const { G } = rescue({ missionId: 'daring-rescue', rescuer: 'cassian-andor' });
  const r = phases.resolveRescuerReturn(G, ['cassian-andor']);
  check('return resolved', r.ok, r.reason);
  check('rescuer moved to the base', atBase(G, 'cassian-andor'));
  check('rescuer no longer in the mission system', !(G.rebel.leadersOnBoard['corellia'] ?? []).includes('cassian-andor'));
}

console.log('\n[ choose to keep the rescuer in the system ]');
{
  const { G, target } = rescue({ missionId: 'daring-rescue', rescuer: 'cassian-andor' });
  const r = phases.resolveRescuerReturn(G, []); // stay
  check('stay resolved', r.ok, r.reason);
  check('rescuer stayed in the mission system', (G.rebel.leadersOnBoard[target] ?? []).includes('cassian-andor'));
  check('rescuer NOT at base', !atBase(G, 'cassian-andor'));
}

console.log('\n[ For the Greater Good forces a stay — no return choice ]');
{
  const { G, error, target } = rescue({ missionId: 'for-the-greater-good', rescuer: 'obi-wan-kenobi' });
  check('no setup error', !error, error);
  check('Leia rescued', !(G.empire.capturedLeaders ?? []).some((c) => c.leaderId === 'princess-leia'));
  check('NO RescuerReturn choice posted', G.pendingChoice?.kind !== 'RescuerReturn', G.pendingChoice?.kind);
  check('rescuer stays in the mission system', (G.rebel.leadersOnBoard[target] ?? []).includes('obi-wan-kenobi'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
