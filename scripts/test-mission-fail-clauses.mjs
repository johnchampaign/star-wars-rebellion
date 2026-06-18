// Mission "if the mission fails ..." clauses (audit cluster):
//  - Critical Rescue / Break Their Will: "return this card to your hand" on fail
//    (were being discarded instead).
//  - Aggressive Negotiations: "you may destroy 1 triangle ground unit" on fail
//    (was dropped entirely).
// Run: node scripts/test-mission-fail-clauses.mjs
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

// Drive one mission attempt to resolution; returns { failed, G }.
function attemptMission({ seed, attacker, missionId, target, attackerLeaderId,
  capturedLeaderId, oppLeadersAtTarget, empireUnits }) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  const af = attacker === 'Rebel' ? G.rebel : G.empire;
  // Deploy Empire units at the target (keeps a captured leader held + provides
  // a triangle ground unit for Aggressive Negotiations).
  for (const u of empireUnits ?? []) M.deployUnit(G, 'Empire', u, target);
  // Capture the Rebel leader at the target.
  if (capturedLeaderId) {
    if (!G.rebel.leaderPool.includes(capturedLeaderId)) G.rebel.leaderPool.push(capturedLeaderId);
    M.placeLeader(G, 'Rebel', capturedLeaderId, target);
    M.captureLeader(G, capturedLeaderId);
  }
  // Strong opposing leaders already at the target.
  for (const lid of oppLeadersAtTarget ?? []) {
    const oppSide = attacker === 'Rebel' ? 'Empire' : 'Rebel';
    const of = oppSide === 'Rebel' ? G.rebel : G.empire;
    if (!of.leaderPool.includes(lid)) of.leaderPool.push(lid);
    (of.leadersOnBoard[target] ??= []).push(lid);
  }
  // Assign the (weak) attacking leader and reveal.
  G.phase = 'Assignment';
  G.currentPlayer = attacker;
  G.passedThisCommand = [];
  if (!af.leaderPool.includes(attackerLeaderId)) af.leaderPool.push(attackerLeaderId);
  af.missionHand = [missionId];
  const asg = phases.assignLeader(G, attacker, missionId, [attackerLeaderId]);
  if (!asg.ok) return { error: `assign:${asg.reason}`, G };
  G.phase = 'Command';
  const rv = phases.revealMission(G, attacker, missionId, target);
  if (!rv.ok) return { error: `reveal:${rv.reason}`, G };
  const countStormtroopers = () =>
    (G.map.systems[target].units ?? []).filter((u) => u.typeId === 'stormtrooper').length;
  const stormtroopersBefore = countStormtroopers();
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null, true);
  const rep = (G.missionReports ?? [])[(G.missionReports ?? []).length - 1];
  return { failed: rep?.result === 'failure', G, stormtroopersBefore, stormtroopersAfter: countStormtroopers() };
}

console.log('\n[ Critical Rescue: returns to the Rebel hand on failure ]');
{
  let done = false;
  for (let seed = 1; seed <= 80 && !done; seed++) {
    const { failed, G, error } = attemptMission({
      seed, attacker: 'Rebel', missionId: 'critical-rescue', target: 'corellia',
      attackerLeaderId: 'obi-wan-kenobi', capturedLeaderId: 'princess-leia',
      oppLeadersAtTarget: ['colonel-yularen', 'admiral-piett', 'emperor-palpatine', 'jabba'],
      empireUnits: ['stormtrooper'],
    });
    if (error) { console.log('  setup error:', error); break; }
    if (!failed) continue;
    done = true;
    check(`(seed ${seed}) critical-rescue failed as set up`, true);
    check('card returned to the Rebel hand', (G.rebel.missionHand ?? []).includes('critical-rescue'));
    check('card NOT in the discard pile', !(G.rebel.missionDiscard ?? []).includes('critical-rescue'));
  }
  check('found a failing seed for critical-rescue', done);
}

console.log('\n[ Break Their Will: returns to the Empire hand on failure ]');
{
  let done = false;
  for (let seed = 1; seed <= 80 && !done; seed++) {
    const { failed, G, error } = attemptMission({
      seed, attacker: 'Empire', missionId: 'break-their-will', target: 'corellia',
      attackerLeaderId: 'darth-vader', capturedLeaderId: 'princess-leia',
      oppLeadersAtTarget: ['han-solo', 'general-madine', 'luke-skywalker-jedi'],
      empireUnits: ['stormtrooper'],
    });
    if (error) { console.log('  setup error:', error); break; }
    if (!failed) continue;
    done = true;
    check(`(seed ${seed}) break-their-will failed as set up`, true);
    check('card returned to the Empire hand', (G.empire.missionHand ?? []).includes('break-their-will'));
    check('card NOT in the Empire discard', !(G.empire.missionDiscard ?? []).includes('break-their-will'));
  }
  check('found a failing seed for break-their-will', done);
}

console.log('\n[ Aggressive Negotiations: destroys a triangle ground unit on failure ]');
{
  let done = false;
  for (let seed = 1; seed <= 120 && !done; seed++) {
    const { failed, G, error, stormtroopersBefore, stormtroopersAfter } = attemptMission({
      seed, attacker: 'Rebel', missionId: 'aggressive-negotiations', target: 'corellia',
      attackerLeaderId: 'admiral-ackbar', capturedLeaderId: 'princess-leia',
      oppLeadersAtTarget: ['emperor-palpatine', 'grand-moff-tarkin', 'janus-greejatus'],
      empireUnits: ['stormtrooper', 'at-st'],
    });
    if (error) { console.log('  setup error:', error); break; }
    if (!failed) continue;
    done = true;
    check(`(seed ${seed}) aggressive-negotiations failed as set up`, true);
    check('exactly one triangle ground unit (stormtrooper) was destroyed',
      stormtroopersAfter === stormtroopersBefore - 1,
      `before=${stormtroopersBefore} after=${stormtroopersAfter}`);
    // The non-triangle AT-ST should NOT be touched by this clause.
    check('the non-triangle AT-ST survived', (G.map.systems.corellia.units ?? []).some((u) => u.typeId === 'at-st'));
  }
  check('found a failing seed for aggressive-negotiations', done);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
