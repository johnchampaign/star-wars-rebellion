// END-TO-END verifier for issue #39 (Regional Support not firing).
//
// The earlier verifier (verify-regional-support-fires.mjs) only tested
// objectiveConditionMet() in isolation and explicitly SKIPPED the actual
// Refresh auto-play path. This one closes that gap: it builds a game with
// Region 4 (Bespin + Mustafar) fully Rebel-loyal and regional-support-1 in
// the Rebel hand, drives a real Command->Refresh transition via the public
// pass() function, and asserts the objective auto-plays and reputation is
// gained.
//
// Usage: node scripts/verify-regional-support-e2e.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

{
  const mod = await import('tsx/esm/api');
  mod.register();
}

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log('  PASS', label);
  else { console.error('  FAIL', label, detail); failures++; }
}

const G = createGame(data, { seed: 'verify-rs-e2e' });

// Force Region 4 (Bespin + Mustafar populous) both Rebel-loyal, unsubjugated.
for (const sid of ['bespin', 'mustafar']) {
  G.map.systems[sid].loyalty = 'rebel';
  G.map.systems[sid].subjugated = false;
}

// Put regional-support-1 in the Rebel objective hand; strip higher-rep
// StartOfRefresh competitors so the tiebreak picks ours.
G.rebel.objectiveHand = (G.rebel.objectiveHand ?? []).filter((oid) => {
  const c = G.catalog.objectives[oid];
  return c?.timing !== 'StartOfRefresh';
});
G.rebel.objectiveHand.push('regional-support-1');

// Drive to a real Refresh: set Command phase, both sides pass.
G.phase = 'Command';
G.currentPlayer = 'Rebel';
G.passedThisCommand = [];
G.pendingMission = undefined;
G.pendingChoice = undefined;
G.pendingCombat = undefined;

// Reputation lives on G.reputationMarker (starts 14, DECREASES toward the
// time marker as the Rebel gains rep; Rebel wins when it meets timeMarker).
const repBefore = G.reputationMarker;
console.log('reputationMarker before:', repBefore, '| hand:', G.rebel.objectiveHand);

const r1 = phases.pass(G, 'Rebel');
check('Rebel pass ok', r1.ok, JSON.stringify(r1));
const r2 = phases.pass(G, 'Empire');
check('Empire pass ok', r2.ok, JSON.stringify(r2));

// After both pass, enterRefreshPhase runs the StartOfRefresh pre-step.
const played = G.turnLog.some((e) =>
  e.kind === 'play-objective' && e.payload?.objectiveId === 'regional-support-1');
check('play-objective logged for regional-support-1', played);

const repAfter = G.reputationMarker;
check('reputation gained (marker decreased by >=1)', repAfter <= repBefore - 1,
  `before=${repBefore} after=${repAfter}`);

const goneFromHand = !(G.rebel.objectiveHand ?? []).includes('regional-support-1');
check('regional-support-1 removed from hand after scoring', goneFromHand,
  `hand=${JSON.stringify(G.rebel.objectiveHand)}`);

console.log('reputationMarker after:', repAfter, '| phase now:', G.phase);
console.log();
if (failures === 0) {
  console.log('ALL PASS — Regional Support auto-plays end-to-end at Refresh.');
  process.exit(0);
}
console.log(`FAILED — ${failures} failure(s).`);
process.exit(1);
