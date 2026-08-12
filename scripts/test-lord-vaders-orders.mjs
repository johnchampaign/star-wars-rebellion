// Regression test for issues #203 and #713.
//
// #203: Lord Vader's Orders should post the StolenPlansReorder choice to
// Empire, not Rebel, because the Empire player is the one peeking/reordering
// the Rebel objective deck.
//
// #713: the card is printed "Immediate", so it must resolve when the Empire
// GAINS it, not sit in hand as an at-will Assignment play. It was reclassified
// to Assignment as an implementation shortcut before the Immediate dispatch
// path existed. This pins (a) the declared timing, (b) that it dispatches
// through the Immediate path, and (c) that its StolenPlansReorder sub-choice
// resumes the paused flow instead of stranding it — the reorder resolver had
// no autoFlush/viaRecruit handling, so a flush-fired card would freeze the
// Command phase once the reorder finished.

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

// --- #713: the card's declared timing must match the printed card ----------
const card = data.actions.actions.find((c) => c.id === 'lord-vader-s-orders');
if (!card) fail('lord-vader-s-orders missing from actions.json');
if (card.timing !== 'Immediate') {
  fail(`Lord Vader's Orders timing is "${card.timing}", expected "Immediate" (#713)`);
}

const G = createGame(data, { seed: 203, autoSetupUnits: true });
G.rebel.objectiveDeck = [
  'death-star-plans-2',
  'a-time-for-peace-2',
  'rebel-cell-2',
  'uprising-3',
];

// The card fires from hand with Krennic available; put both in place.
if (!G.empire.actionHand.includes('lord-vader-s-orders')) {
  G.empire.actionHand.push('lord-vader-s-orders');
}
if (!G.empire.leaderPool.includes('krennic')) G.empire.leaderPool.push('krennic');

// --- #713: it must dispatch through the Immediate path, not Assignment -----
if (!phases.playableImmediateActionCards(G, 'Empire').includes('lord-vader-s-orders')) {
  fail('Lord Vader\'s Orders is not offered by the Immediate path (#713)');
}

G.currentPlayer = 'Empire';
const req = phases.requestImmediateActionCardPlay(G, 'Empire');
if (!req.ok) fail(`could not request an Immediate play (${req.reason ?? 'unknown'})`);

const play = phases.playImmediateActionCard(G, 'lord-vader-s-orders');
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

// --- #713: the reorder sub-choice must resume the flow that posted it ------
// An Immediate card fired by the Command-phase flush has no pendingMission, so
// the old resolver (mission-resume only) did nothing at all when the reorder
// finished — pendingChoice cleared, nothing scheduled, Command phase frozen.
// Finishing an autoFlush-tagged reorder must hand the turn on.
{
  const G2 = createGame(data, { seed: 713, autoSetupUnits: true });
  G2.phase = 'Command';
  G2.currentPlayer = 'Empire';
  G2.rebel.objectiveDeck = ['death-star-plans-2', 'a-time-for-peace-2', 'rebel-cell-2'];
  if (!G2.empire.actionHand.includes('lord-vader-s-orders')) {
    G2.empire.actionHand.push('lord-vader-s-orders');
  }
  if (!G2.empire.leaderPool.includes('krennic')) G2.empire.leaderPool.push('krennic');

  if (!phases.flushImmediateActionCards(G2)) {
    fail('the Command-phase flush did not fire Lord Vader\'s Orders (#713)');
  }
  const pc = G2.pendingChoice;
  if (!pc || pc.kind !== 'StolenPlansReorder') {
    fail('flush did not post the reorder choice');
  }
  if (!pc.autoFlush) fail('flush-fired reorder choice is not tagged autoFlush (#713)');

  // Pick every card but the last without triggering the finish.
  while (G2.pendingChoice?.kind === 'StolenPlansReorder'
         && G2.pendingChoice.remaining.length > 1) {
    phases.resolveStolenPlansPick(G2, G2.pendingChoice.remaining[0]);
  }
  phases.resolveStolenPlansPick(G2, G2.pendingChoice.remaining[0]);
  if (G2.rebel.objectiveDeck.length !== 3) {
    fail(`objective deck should be restored to 3, got ${G2.rebel.objectiveDeck.length}`);
  }
  // Neither side has passed, so resuming hands the turn to the Rebel. Without
  // the autoFlush branch the resolver falls through to mission-resume, which
  // no-ops with no pendingMission — currentPlayer stays Empire forever.
  if (G2.pendingChoice) fail(`unexpected pending choice ${G2.pendingChoice.kind}`);
  if (G2.currentPlayer !== 'Rebel') {
    fail('finishing a flush-fired reorder stranded the Command phase (#713)');
  }
}
console.log('OK: a flush-fired reorder resumes the Command phase.');

console.log('PASS: issues #203 + #713 regression test');
