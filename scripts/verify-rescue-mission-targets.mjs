// Verifier: rescue-mission target validation finds systems with captured
// leaders. Michael Knauss (BGG playtest) reported "tried to rescue a
// captive but the system said I had no potential targets" — could be a
// timing artifact (mission revealed before any capture this turn) or a
// real engine bug. This verifier confirms the engine path is correct in
// isolation.
//
// Usage: node scripts/verify-rescue-mission-targets.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

{
  const mod = await import('tsx/esm/api');
  mod.register();
}

const { createGame } = await import('../src/engine/setup.ts');
const missionTargets = await import('../src/engine/missionTargets.ts');

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

// PART 1: With a captured leader, rescue missions find that system.
console.log('PART 1: rescue missions find captured-leader systems');
const G = createGame(data, { seed: 'verify-rescue' });
G.empire.capturedLeaders = [
  { leaderId: 'han-solo', ring: 'captured', systemId: 'bothawui' },
];
const dr = missionTargets.missionTargets(G, 'Rebel', 'daring-rescue');
check('daring-rescue targets includes bothawui', dr.systemIds.includes('bothawui'),
  `got ${JSON.stringify(dr.systemIds)}`);
const fg = missionTargets.missionTargets(G, 'Rebel', 'for-the-greater-good');
check('for-the-greater-good targets includes bothawui', fg.systemIds.includes('bothawui'),
  `got ${JSON.stringify(fg.systemIds)}`);

// PART 2: With NO captured leaders, rescue missions return empty.
console.log('\nPART 2: rescue missions return empty when nobody is captured');
const G2 = createGame(data, { seed: 'verify-rescue-2' });
G2.empire.capturedLeaders = [];
const dr2 = missionTargets.missionTargets(G2, 'Rebel', 'daring-rescue');
check('daring-rescue targets empty when no captives',
  dr2.systemIds.length === 0, `got ${JSON.stringify(dr2.systemIds)}`);

// PART 3: Multiple captives → multiple target systems.
console.log('\nPART 3: multiple captives → multiple target systems');
const G3 = createGame(data, { seed: 'verify-rescue-3' });
G3.empire.capturedLeaders = [
  { leaderId: 'han-solo', ring: 'captured', systemId: 'bothawui' },
  { leaderId: 'princess-leia', ring: 'carbonite', systemId: 'bespin' },
];
const dr3 = missionTargets.missionTargets(G3, 'Rebel', 'daring-rescue');
check('daring-rescue includes both bothawui and bespin',
  dr3.systemIds.includes('bothawui') && dr3.systemIds.includes('bespin'),
  `got ${JSON.stringify(dr3.systemIds)}`);

// PART 4: Captured leader with invalid systemId — defensive check.
console.log('\nPART 4: defensive — invalid systemId on captive should not crash');
const G4 = createGame(data, { seed: 'verify-rescue-4' });
G4.empire.capturedLeaders = [
  { leaderId: 'han-solo', ring: 'captured', systemId: 'nonexistent-system' },
];
const dr4 = missionTargets.missionTargets(G4, 'Rebel', 'daring-rescue');
// Whether this returns the bad system or filters it — neither would crash.
check('handles bad systemId without crashing', typeof dr4.systemIds !== 'undefined',
  `got ${JSON.stringify(dr4.systemIds)}`);

console.log();
if (failures === 0) {
  console.log('ALL PASS — rescue mission target validation works correctly.');
  process.exit(0);
}
console.log(`FAILED — ${failures} failure(s).`);
process.exit(1);
