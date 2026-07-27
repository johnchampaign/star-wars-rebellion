// Regression test for issue #648:
// Start The Evacuation — RAW: "Place this leader in any system that does not
// contain Imperial units. Then move any of your units from the 'Rebel Base'
// space to this system as if they were adjacent."
// The engine moved the units but left Rieekan in the leader pool; he must be
// placed in the chosen system.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

function loadJson(p) {
  return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
}

const data = {
  systems: loadJson('systems.json'),
  adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'),
  missions: loadJson('missions.json'),
  objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'),
  probes: loadJson('probes.json'),
};

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

const G = createGame(data, { seed: 648, autoSetupUnits: true });

// Put the card in hand and Rieekan in the pool regardless of setup variant.
if (!G.rebel.actionHand.includes('start-the-evacuation')) {
  G.rebel.actionHand.push('start-the-evacuation');
}
if (!G.rebel.leaderPool.includes('general-rieekan')) {
  G.rebel.leaderPool.push('general-rieekan');
}

G.pendingChoice = {
  kind: 'PlayAssignmentActionCard',
  side: 'Rebel',
  candidates: ['start-the-evacuation'],
};

const play = phases.playAssignmentActionCard(G, 'start-the-evacuation');
if (!play.ok) fail(`could not play Start The Evacuation (${play.reason ?? 'unknown'})`);

if (!G.pendingChoice || G.pendingChoice.kind !== 'StartEvacuationPick') {
  fail(`expected StartEvacuationPick, got ${G.pendingChoice?.kind ?? 'none'}`);
}

const { candidateSystemIds, candidateUnitIds } = G.pendingChoice;
if (candidateSystemIds.length === 0) fail('no candidate systems');

// Every candidate must be Imperial-unit-free (card text).
for (const sid of candidateSystemIds) {
  if (G.map.systems[sid].units.some((u) => u.side === 'Empire')) {
    fail(`candidate ${sid} contains Imperial units`);
  }
}

const target = candidateSystemIds[0];

// Move one space unit if one is available (space units carry themselves, so
// transport validation can't reject the pick); otherwise move nothing — the
// leader placement is the point of this test.
const spaceUnit = candidateUnitIds.find((uid) => {
  const u = G.map.rebelBaseSpace.units.find((x) => x.instanceId === uid);
  return u && G.catalog.unitTypes[u.typeId]?.theater === 'space';
});
const moved = spaceUnit ? [spaceUnit] : [];

const res = phases.resolveStartEvacuationPick(G, target, moved);
if (!res.ok) fail(`resolveStartEvacuationPick failed (${res.reason ?? 'unknown'})`);

// #648: Rieekan must be placed in the target system, not left in the pool.
if (G.rebel.leaderPool.includes('general-rieekan')) {
  fail('Rieekan is still in the leader pool after Start The Evacuation');
}
if (!(G.rebel.leadersOnBoard[target] ?? []).includes('general-rieekan')) {
  fail(`Rieekan is not in the target system ${target}`);
}

// Units chosen must actually arrive.
for (const uid of moved) {
  if (!G.map.systems[target].units.some((u) => u.instanceId === uid)) {
    fail(`unit ${uid} did not arrive in ${target}`);
  }
  if (G.map.rebelBaseSpace.units.some((u) => u.instanceId === uid)) {
    fail(`unit ${uid} still in rebel-base-space`);
  }
}

console.log(`PASS: Rieekan placed at ${target}; ${moved.length} unit(s) evacuated with him`);
