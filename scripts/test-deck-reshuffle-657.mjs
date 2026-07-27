// #657 — a depleted deck must reshuffle its discard pile into a new deck
// (RR "Discarding": "If a deck is depleted, shuffle the discard pile and place
// it facedown to create a new deck"). drawMission already did this; drawAction
// did not, so an exhausted action deck stayed exhausted for the rest of the
// game and its discard was dead.
//
// The objective deck is deliberately EXCLUDED and this pins that too, because
// it is the tempting "completion" that would break the game: objectives carry
// an explicit reuse prohibition (RR "cannot be used again this game", RoE FAQ
// "unless an ability allows"), and objectiveDiscard mixes never-scored
// discards with cards that already paid out reputation. Recycling it would let
// the Rebel re-score the same objective.
//
// NOTE: the action-deck assertions here go through mechanics.drawAction, which
// has NO callers in src/ — it delegates to refillActionDeckFromDiscard, so they
// cover the helper, not the running game. The real recruit path is covered by
// test-action-deck-reshuffle-657. Keep both: this one pins the objective
// exclusion, which is the part that would be dangerous to get wrong.
//
// Run: node scripts/test-deck-reshuffle-657.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };
const newGame = (seed) => createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

console.log('\n[ #657 a depleted action deck recycles its discard ]');
{
  const G = newGame(657);
  const e = G.empire;
  e.actionDeck = [];
  e.actionHand = [];
  e.actionDiscard = ['early-promotion', 'brilliant-administrator', 'ambitions-of-power'];

  const drawn = M.drawAction(G, 'Empire', 1);
  check('a card was drawn from the recycled deck', drawn.length === 1, `drawn=${JSON.stringify(drawn)}`);
  check('the drawn card came from the old discard',
    ['early-promotion', 'brilliant-administrator', 'ambitions-of-power'].includes(drawn[0]), drawn[0]);
  check('discard pile is now empty', e.actionDiscard.length === 0, JSON.stringify(e.actionDiscard));
  check('remaining cards are back in the deck', e.actionDeck.length === 2, `deck=${e.actionDeck.length}`);
  check('no card was duplicated or lost',
    [...e.actionDeck, ...e.actionHand, ...e.actionDiscard].sort().join() ===
    ['early-promotion', 'brilliant-administrator', 'ambitions-of-power'].sort().join(),
    JSON.stringify({ deck: e.actionDeck, hand: e.actionHand, disc: e.actionDiscard }));
  check('the reshuffle was logged',
    G.turnLog.some((l) => l.kind === 'action-deck-reshuffled' && l.side === 'Empire'));
}

console.log('\n[ an empty deck AND empty discard still just returns nothing ]');
{
  const G = newGame(658);
  G.rebel.actionDeck = [];
  G.rebel.actionDiscard = [];
  const before = G.rebel.actionHand.length;
  const drawn = M.drawAction(G, 'Rebel', 2);
  check('no crash, nothing drawn', drawn.length === 0);
  check('hand unchanged', G.rebel.actionHand.length === before);
  check('no spurious reshuffle logged',
    !G.turnLog.some((l) => l.kind === 'action-deck-reshuffled'));
}

console.log('\n[ a deck that is NOT empty is left alone ]');
{
  const G = newGame(659);
  const e = G.empire;
  e.actionDeck = ['post-bounty'];
  e.actionDiscard = ['early-promotion'];
  M.drawAction(G, 'Empire', 1);
  check('drew from the top of the existing deck', e.actionHand.includes('post-bounty'));
  check('discard was NOT recycled', e.actionDiscard.length === 1, JSON.stringify(e.actionDiscard));
  check('no reshuffle logged', !G.turnLog.some((l) => l.kind === 'action-deck-reshuffled'));
}

console.log('\n[ the objective deck is deliberately NOT recycled ]');
{
  const G = newGame(660);
  G.rebel.objectiveDeck = [];
  // A pile mixing a never-scored discard with cards that already paid out.
  G.rebel.objectiveDiscard = ['the-long-war-1', 'rebel-cell-2', 'raid-outposts-2'];
  const handBefore = [...(G.rebel.objectiveHand ?? [])];
  const drawn = M.drawObjective(G, 1);
  check('nothing is drawn from a depleted objective deck', drawn.length === 0,
    `drawn=${JSON.stringify(drawn)}`);
  check('scored objectives stay in the discard, not back in the deck',
    G.rebel.objectiveDiscard.length === 3 && G.rebel.objectiveDeck.length === 0,
    `disc=${G.rebel.objectiveDiscard.length} deck=${G.rebel.objectiveDeck.length}`);
  check('hand unchanged', (G.rebel.objectiveHand ?? []).join() === handBefore.join());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
