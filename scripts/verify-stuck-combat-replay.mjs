// Verifier: replay a stuck-combat state JSON and assert the engine
// advances pendingCombat past 'AddLeader'. Used to validate the fix for
// the freeze where a mid-combat-init mission choice (Hit And Run /
// DestroyUpToHealth) blocked the initial runCombat() call, and the
// choice-resolution path didn't re-invoke runCombat afterward.
//
// Usage: node scripts/verify-stuck-combat-replay.mjs <state.json>
//
// Imports the production engine via tsx so we exercise the same code
// path the deployed site does.

import { readFileSync } from 'node:fs';

const { runCombat } = await import('../src/engine/combat.ts');
const phases = await import('../src/engine/phases.ts');

const stateFile = process.argv[2];
if (!stateFile) {
  console.error('Usage: node scripts/verify-stuck-combat-replay.mjs <state.json>');
  process.exit(2);
}
const G = JSON.parse(readFileSync(stateFile, 'utf8'));

console.log('Initial state:');
console.log('  pendingChoice:', G.pendingChoice?.kind ?? 'none');
console.log('  pendingCombat.step:', G.pendingCombat?.step ?? 'none');
console.log('  pendingCombat.systemId:', G.pendingCombat?.systemId ?? 'none');

if (!G.pendingCombat) {
  console.error('FAIL: no pendingCombat in input state.');
  process.exit(1);
}
const initialStep = G.pendingCombat.step;

// Mimic what the fix should do: when pendingChoice is undefined and
// pendingCombat exists, runCombat should advance the combat.
try {
  runCombat(G);
} catch (e) {
  console.error('FAIL: runCombat threw:', e.message);
  process.exit(1);
}

console.log('\nAfter runCombat:');
console.log('  pendingChoice:', G.pendingChoice?.kind ?? 'none');
console.log('  pendingCombat.step:', G.pendingCombat?.step ?? 'none (combat ended)');

const advanced =
  G.pendingCombat?.step !== initialStep || // step changed
  !G.pendingCombat ||                       // combat finished
  !!G.pendingChoice;                        // posted a choice (e.g. tactic pick) — also progress

if (advanced) {
  console.log('\nPART 1 PASS — runCombat() on its own advances the stuck state.');
} else {
  console.log(`\nFAIL — combat still at step '${initialStep}', no choice posted.`);
  process.exit(1);
}

// ---------- PART 2: verify the resolveDestroyUpToHealth → resumeMissionAfterChoice
// → runCombat path that the FIX adds. Reset the state and inject a synthetic
// DestroyUpToHealth + pendingMission so the resolver's exit fires the new
// runCombat re-entry.

const G2 = JSON.parse(readFileSync(stateFile, 'utf8'));
// Pick a Rebel-owned Empire unit (anywhere) as a fake target candidate.
// In the real freeze, units at bespin (the hit-and-run target) were destroyed.
const bespin = G2.map.systems['bespin'];
if (!bespin || bespin.units.length === 0) {
  console.log('PART 2 SKIP — no bespin units to use as fake DestroyUpToHealth candidate.');
  process.exit(0);
}
const target = bespin.units.find((u) => u.side === 'Empire');
if (!target) {
  console.log('PART 2 SKIP — no Empire bespin unit available.');
  process.exit(0);
}

G2.pendingChoice = {
  kind: 'DestroyUpToHealth',
  side: 'Rebel',
  systemId: 'bespin',
  candidates: [target.instanceId],
  budget: 2,
  cardName: 'Hit And Run (synthetic)',
};
G2.pendingMission = {
  missionId: 'hit-and-run',
  resolverSide: 'Rebel',
  targetSystemId: 'bespin',
  leaderIds: ['chewbacca'],
  stage: 'effect',
};

console.log('\nPART 2 initial:');
console.log('  pendingChoice:', G2.pendingChoice.kind);
console.log('  pendingMission:', G2.pendingMission.missionId);
console.log('  pendingCombat.step:', G2.pendingCombat?.step);

try {
  const r = phases.resolveDestroyUpToHealth(G2, [target.instanceId]);
  if (!r.ok) {
    console.log(`\nFAIL — resolveDestroyUpToHealth returned not ok: ${r.reason}`);
    process.exit(1);
  }
} catch (e) {
  console.log('\nFAIL — resolveDestroyUpToHealth threw:', e.message);
  process.exit(1);
}

console.log('\nPART 2 after resolveDestroyUpToHealth:');
console.log('  pendingChoice:', G2.pendingChoice?.kind ?? 'none');
console.log('  pendingMission:', G2.pendingMission?.missionId ?? 'none');
console.log('  pendingCombat.step:', G2.pendingCombat?.step ?? 'none');

const advanced2 =
  G2.pendingCombat?.step !== 'AddLeader' ||
  !G2.pendingCombat ||
  !!G2.pendingChoice;

if (advanced2) {
  console.log('\nPART 2 PASS — resumeMissionAfterChoice woke the stranded combat.');
  process.exit(0);
}
console.log('\nFAIL — combat still stuck at AddLeader after mission resolved.');
process.exit(1);
