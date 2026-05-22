// Smoke test for src/engine/setup.ts. Loads the JSON data, builds an initial
// GameState, and prints a summary. Run: `node scripts/test-setup.mjs`.
//
// Uses tsx to compile TS on the fly. Install with: npm i -D tsx (or use the
// vite dev server's bundling instead — see below).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Use tsx loader if available; otherwise inform the user.
let createGame;
try {
  const mod = await import('tsx/esm/api');
  mod.register();
  ({ createGame } = await import('../src/engine/setup.ts'));
} catch {
  console.error('This script needs tsx. Run: npm i -D tsx');
  process.exit(1);
}

function loadJson(path) {
  return JSON.parse(readFileSync(join(ROOT, 'assets', path), 'utf-8'));
}

const data = {
  systems:    loadJson('systems.json'),
  adjacency:  loadJson('adjacency.json'),
  leaders:    loadJson('leaders.json'),
  actions:    loadJson('actions.json'),
  missions:   loadJson('missions.json'),
  objectives: loadJson('objectives.json'),
  tactics:    loadJson('tactics.json'),
  probes:     loadJson('probes.json'),
};

const G = createGame(data, { seed: 12345 });

console.log('=== Initial GameState ===');
console.log(`Time marker:           ${G.timeMarker}`);
console.log(`Reputation marker:     ${G.reputationMarker}`);
console.log(`Phase:                 ${G.phase}`);
console.log(`Current player:        ${G.currentPlayer}`);
console.log(`Rebel base (secret):   ${G.rebelBaseSystemId}`);
console.log(`Rebel base revealed:   ${G.rebelBaseRevealed}`);
console.log();
console.log('Loyalty:');
const loyalSystems = Object.entries(G.map.systems).filter(([, s]) => s.loyalty !== 'neutral' || s.subjugated);
for (const [id, s] of loyalSystems) {
  const flags = [];
  if (s.loyalty !== 'neutral') flags.push(s.loyalty);
  if (s.subjugated) flags.push('subjugated');
  console.log(`  ${id.padEnd(20)} ${flags.join(' + ')}`);
}
console.log();
console.log('Units on board:');
let totalUnits = 0;
for (const [id, s] of Object.entries(G.map.systems)) {
  if (s.units.length === 0) continue;
  const summary = {};
  for (const u of s.units) summary[u.typeId] = (summary[u.typeId] ?? 0) + 1;
  console.log(`  ${id.padEnd(20)} ${Object.entries(summary).map(([t, c]) => `${c}× ${t}`).join(', ')}`);
  totalUnits += s.units.length;
}
console.log(`  rebel-base-space    ${Object.entries(G.map.rebelBaseSpace.units.reduce((acc, u) => { acc[u.typeId]=(acc[u.typeId]??0)+1; return acc; }, {})).map(([t, c]) => `${c}× ${t}`).join(', ')}`);
totalUnits += G.map.rebelBaseSpace.units.length;
console.log(`(total on board: ${totalUnits} units)`);
console.log();
console.log('Factions:');
for (const f of [G.rebel, G.empire]) {
  console.log(`  ${f.side}:`);
  console.log(`    leaderPool:    [${f.leaderPool.join(', ')}]`);
  console.log(`    actionHand:    ${f.actionHand.length} cards`);
  console.log(`    actionDeck:    ${f.actionDeck.length} cards`);
  console.log(`    missionHand:   ${f.missionHand.length} cards`);
  console.log(`    missionDeck:   ${f.missionDeck.length} cards`);
  if (f.objectiveDeck) console.log(`    objectiveDeck: ${f.objectiveDeck.length} cards`);
  if (f.objectiveHand) console.log(`    objectiveHand: ${f.objectiveHand.length} cards (${f.objectiveHand.join(', ')})`);
  if (f.projectDeck)   console.log(`    projectDeck:   ${f.projectDeck.length} cards`);
}
console.log();
console.log(`Probe deck:           ${G.probeDeck.length} cards`);
console.log(`Space tactic deck:    ${G.spaceTacticDeck.length} cards`);
console.log(`Ground tactic deck:   ${G.groundTacticDeck.length} cards`);
console.log();
console.log('Determinism check (rerun with same seed):');
const G2 = createGame(data, { seed: 12345 });
const match = G2.rebelBaseSystemId === G.rebelBaseSystemId
  && G2.rebel.actionHand.join(',') === G.rebel.actionHand.join(',')
  && G2.empire.missionHand.join(',') === G.empire.missionHand.join(',');
console.log(`  Same seed produces same setup: ${match ? '✓' : '✗ FAIL'}`);
