// #665 — "Heart of the Empire objective card should have returned to my hand
// when played." It DOES return to hand (playRefreshObjective honours
// objectiveReturnsToHand), but scoring it also files an entry in
// `scoredObjectives`, and two consumers read that list as "this card is in the
// discard pile":
//
//   1. The objective discard viewer listed the card as discarded — almost
//      certainly what the reporter saw when they went looking for the card.
//   2. "Something to Fight For" offered it as a retrievable discard. Taking it
//      would have put a SECOND copy of a unique card on top of the objective
//      deck while the first sat in the Rebel's hand.
//
// This pins both: a card currently in the Rebel's objective hand is never
// treated as discarded, while ordinary scored/discarded objectives stay
// retrievable (#344 must not regress).
//
// Run: node scripts/test-heart-of-the-empire-in-hand-665.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const combat = await import('../src/engine/combat.ts');
const phases = await import('../src/engine/phases.ts');
const objectives = await import('../src/engine/objectives.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const HEART = 'heart-of-the-empire-2';
const OTHER = 'the-power-of-the-force-1';

const setup = () => createGame(data, {
  seed: 665, expansion: { enabled: true, roeUnits: true, roeMissions: true },
});

/** Satisfy Heart of the Empire: Coruscant holds a Rebel unit and no Imperials. */
function rebelHoldsCoruscant(G) {
  const cor = G.map.systems['coruscant'];
  cor.units = cor.units.filter((u) => u.side !== 'Empire');
  cor.units.push({ instanceId: 'hoe-r1', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 });
}

console.log('\n[ the card itself says it comes back to hand ]');
{
  const G = setup();
  check('objectiveReturnsToHand(Heart of the Empire)', objectives.objectiveReturnsToHand(G, HEART));
  check('printed text says "return this card to your hand"',
    /return this card to your hand/i.test(G.catalog.objectives[HEART]?.rulesText ?? ''),
    JSON.stringify(G.catalog.objectives[HEART]?.rulesText));
}

console.log('\n[ scoring it in Refresh leaves it in hand AND files a scored entry ]');
let scoredG;
{
  const G = setup();
  rebelHoldsCoruscant(G);
  G.rebel.objectiveHand = [HEART];
  G.rebel.scoredObjectives = [];
  G.rebel.objectiveDiscard = [];
  const repBefore = G.reputationMarker;

  const prompted = phases.refreshPlayStartOfRefreshObjectives(G, G.turnLog.length);

  check('single free eligible objective auto-plays (no prompt)', !prompted);
  // Reputation advances the marker DOWN the time track (2 rep for this card).
  check('reputation was gained', G.reputationMarker < repBefore,
    `${repBefore} -> ${G.reputationMarker}`);
  check('card is back in the Rebel objective hand', (G.rebel.objectiveHand ?? []).includes(HEART));
  check('exactly one copy in hand',
    (G.rebel.objectiveHand ?? []).filter((id) => id === HEART).length === 1);
  check('scored history records it',
    (G.rebel.scoredObjectives ?? []).some((s) => s.objectiveId === HEART));
  check('it was NOT copied into the objective discard',
    !(G.rebel.objectiveDiscard ?? []).includes(HEART));
  scoredG = G;
}

console.log('\n[ a returned-to-hand card is not part of the discard pile ]');
{
  const G = scoredG;
  G.rebel.objectiveDiscard = [OTHER];
  const retrievable = combat.stffRetrievableObjectives(G);
  check('in-hand Heart of the Empire is not in the discard pile',
    !retrievable.includes(HEART), retrievable.join(','));
  check('an ordinary discarded objective still is (#344 intact)',
    retrievable.includes(OTHER), retrievable.join(','));
}

console.log('\n[ a scored card that did NOT return to hand stays retrievable ]');
{
  const G = setup();
  G.rebel.objectiveHand = [];
  G.rebel.objectiveDiscard = [];
  G.rebel.scoredObjectives = [{ objectiveId: OTHER, reputation: 1, turn: 3 }];
  const retrievable = combat.stffRetrievableObjectives(G);
  check('scored-and-gone objective is retrievable', retrievable.includes(OTHER), retrievable.join(','));
}

console.log('\n[ Something to Fight For refuses to retrieve a card that is in hand ]');
{
  const G = setup();
  G.rebel.objectiveHand = [HEART];
  G.rebel.scoredObjectives = [{ objectiveId: HEART, reputation: 2, turn: 3 }];
  G.rebel.objectiveDiscard = [];
  G.rebel.objectiveDeck = [];
  G.rebel.actionHand = ['something-to-fight-for'];
  G.rebel.actionDiscard = [];

  // Even if a stale or hand-built offer names it, the resolver must refuse.
  G.pendingChoice = { kind: 'SomethingToFightForOffer', side: 'Rebel', candidates: [HEART] };
  G.pendingCombat = { systemId: 'coruscant', report: { rounds: [] } };
  const r = combat.resolveSomethingToFightForOffer(G, HEART);

  check('resolver rejects retrieving an in-hand objective', !r.ok, JSON.stringify(r));
  check('reason is objective-in-hand', r.reason === 'objective-in-hand', String(r.reason));
  check('no duplicate copy reached the objective deck',
    (G.rebel.objectiveDeck ?? []).filter((id) => id === HEART).length === 0);
  check('the Rebel still holds exactly one copy',
    (G.rebel.objectiveHand ?? []).filter((id) => id === HEART).length === 1);
  check('the action card was not spent on the refused retrieval',
    G.rebel.actionHand.includes('something-to-fight-for'));
  check('the scored entry was not consumed',
    (G.rebel.scoredObjectives ?? []).some((s) => s.objectiveId === HEART));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
