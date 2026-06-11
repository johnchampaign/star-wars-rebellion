// Regression test for issue #203:
// Lord Vader's Orders should post the StolenPlansReorder choice to Empire,
// not Rebel, because the Empire player is the one peeking/reordering the
// Rebel objective deck.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { pendingChoiceOwner } = await import('../src/engine/choiceOwner.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');

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

const G = createGame(data, { seed: 203, autoSetupUnits: true });
G.rebel.objectiveDeck = [
  'death-star-plans-2',
  'a-time-for-peace-2',
  'rebel-cell-2',
  'uprising-3',
];

G.pendingChoice = {
  kind: 'PlayAssignmentActionCard',
  side: 'Empire',
  candidates: ['lord-vader-s-orders'],
};

const play = phases.playAssignmentActionCard(G, 'lord-vader-s-orders');
if (!play.ok) fail(`could not play Lord Vader's Orders (${play.reason ?? 'unknown'})`);

if (!G.pendingChoice || G.pendingChoice.kind !== 'StolenPlansReorder') {
  fail('Lord Vader\'s Orders did not post a StolenPlansReorder choice');
}

if (G.pendingChoice.side !== 'Empire') {
  fail(`expected StolenPlansReorder owner Empire, got ${G.pendingChoice.side}`);
}

if (!pendingChoiceOwner(G, 'Empire') || pendingChoiceOwner(G, 'Rebel')) {
  fail('pendingChoiceOwner does not assign the reorder choice to Empire');
}

seedAI(203);
const before = G.pendingChoice.orderedTop.length;
const aiMoved = aiStep(G, 'Empire');
const afterChoice = G.pendingChoice && G.pendingChoice.kind === 'StolenPlansReorder' ? G.pendingChoice.orderedTop.length : 3;

if (!aiMoved) fail('Empire AI did not act on the reorder choice');
if (afterChoice <= before) fail('Empire AI did not advance the reorder choice');

console.log('OK: Lord Vader\'s Orders assigns reorder ownership to Empire.');
console.log('PASS: issue #203 regression test');
