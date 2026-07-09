// #485 — Immediate starting action cards (Early Promotion, Rebel Extremist) must
// auto-fire at game start (RAW: an Immediate card "must be used as soon as the
// player gains the card"; the opening hand is gained at setup). The engine only
// auto-flushed droid rings, so Rebel Extremist sat unplayed and the player
// thought it was broken. flushStartingImmediateCards now drains them the same
// way, chaining through both sides' cards.
// Run: node scripts/test-starting-immediate-autofire-485.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { pendingChoiceOwner } = await import('../src/engine/choiceOwner.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

function setup() {
  const G = createGame(data, { seed: 4, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  // Ensure both Immediate starting cards are in the opening hands, with a
  // non-empty starting-action draw pile so the draw/recruit branch is offered.
  for (const cid of ['early-promotion']) if (!G.empire.actionHand.includes(cid)) G.empire.actionHand.push(cid);
  for (const cid of ['rebel-extremist']) if (!G.rebel.actionHand.includes(cid)) G.rebel.actionHand.push(cid);
  (G.empire.startingActionDeck ??= []).push('probe-droid' in G.catalog.actions ? 'probe-droid' : G.empire.actionHand[0]);
  (G.rebel.startingActionDeck ??= []).push(G.rebel.actionHand[0]);
  G.pendingChoice = undefined;
  return G;
}

console.log('[ #485 — opening-hand Immediate starting cards auto-fire + chain ]');
{
  const G = setup();
  const posted = phases.flushStartingImmediateCards(G);
  check('flush posts a StartingCardBranch', posted && G.pendingChoice?.kind === 'StartingCardBranch', `pc=${G.pendingChoice?.kind}`);
  // Empire is iterated first → Early Promotion fires first.
  check('Empire (Early Promotion) fires first', G.pendingChoice?.side === 'Empire' && G.pendingChoice.cardId === 'early-promotion', `side=${G.pendingChoice?.side} card=${G.pendingChoice?.cardId}`);
  check('the choice is owned by the Empire (correct seat online)', pendingChoiceOwner(G, 'Empire') === true && pendingChoiceOwner(G, 'Rebel') === false);
  check('Early Promotion left the Empire hand', !G.empire.actionHand.includes('early-promotion'));

  // Resolve it (recruit branch) → should CHAIN to the Rebel's Rebel Extremist.
  const r1 = phases.resolveStartingCardBranch(G, 'recruit');
  // Early Promotion's recruit branch interposes a "place Motti & Tarkin" system
  // pick (#524) before the chain continues. Resolve it (first Imperial system).
  check('recruit interposes the Early Promotion placement pick', r1.ok && G.pendingChoice?.kind === 'Choice' && G.pendingChoice.tag === 'early-promotion-place', `pc=${G.pendingChoice?.kind}/${G.pendingChoice?.tag}`);
  const choices = await import('../src/engine/choices.ts');
  choices.resolveGenericChoice(G, [G.pendingChoice.candidates[0].id]);
  check('after placing, the flush chains to the next card', G.pendingChoice?.kind === 'StartingCardBranch', `pc=${G.pendingChoice?.kind}`);
  check('Rebel Extremist fires next', G.pendingChoice?.side === 'Rebel' && G.pendingChoice.cardId === 'rebel-extremist', `side=${G.pendingChoice?.side} card=${G.pendingChoice?.cardId}`);
  check('Rebel Extremist left the Rebel hand', !G.rebel.actionHand.includes('rebel-extremist'));

  const r2 = phases.resolveStartingCardBranch(G, 'draw');
  check('resolving the last one leaves NO pending choice', r2.ok && !G.pendingChoice, `pc=${G.pendingChoice?.kind}`);
}

console.log('[ no Immediate starting cards → nothing posted ]');
{
  const G = createGame(data, { seed: 4, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.empire.actionHand = G.empire.actionHand.filter((c) => c !== 'early-promotion');
  G.rebel.actionHand = G.rebel.actionHand.filter((c) => c !== 'rebel-extremist');
  G.pendingChoice = undefined;
  check('flush returns false and posts nothing', phases.flushStartingImmediateCards(G) === false && !G.pendingChoice);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
