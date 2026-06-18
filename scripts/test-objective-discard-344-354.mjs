// RoE objective-discard model (#344, #354). Per the official FAQ (sw03 v2.1 p.6):
//   - "An immediate objective stays in play while at least one of its target
//     markers is on the board. When all of its target markers are removed,
//     discard the objective card." (#354: Raid Outposts must leave the hand once
//     fully raided, so Exploit Weakness can't grab it as if it were unused.)
//   - "All objective cards are discarded after use. They cannot be used again
//     unless an ability allows." (#344: a SCORED objective is in the discard
//     pile and CAN be retrieved by "Something to Fight For".)
// Run: node scripts/test-objective-discard-344-354.mjs
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
const newGame = (seed = 1) =>
  createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

console.log('\n[ #354: a fully-raided Raid Outposts is discarded out of the hand ]');
{
  const G = newGame(11);
  G.rebel.objectiveHand = ['raid-outposts-2'];
  G.rebel.objectiveDiscard = [];
  // Place the card's two target markers in two systems.
  const sysIds = Object.keys(G.map.systems).slice(0, 2);
  for (const sid of sysIds) M.placeTargetMarker(G, sid, 'raid-outposts-2', 'Empire');
  check('two markers placed', M.systemsWithTargetMarker(G, 'raid-outposts-2').length === 2);

  // Raid the first outpost: card still in play (1 marker remains).
  M.removeRaidOutpostMarker(G, sysIds[0]);
  check('after 1 raid, card still in hand', (G.rebel.objectiveHand ?? []).includes('raid-outposts-2'));
  check('after 1 raid, not yet discarded', !(G.rebel.objectiveDiscard ?? []).includes('raid-outposts-2'));

  // Raid the last outpost: all markers gone -> the card is discarded.
  M.removeRaidOutpostMarker(G, sysIds[1]);
  check('after final raid, card left the hand', !(G.rebel.objectiveHand ?? []).includes('raid-outposts-2'));
  check('after final raid, card is in the discard pile', (G.rebel.objectiveDiscard ?? []).includes('raid-outposts-2'));
  check('no markers remain', M.systemsWithTargetMarker(G, 'raid-outposts-2').length === 0);
}

console.log('\n[ #344: "Something to Fight For" can retrieve a SCORED objective ]');
{
  const combat = await import('../src/engine/combat.ts');
  const G = newGame(12);
  // A previously-scored objective lives in the scored-objectives list (the RoE
  // "discard pile" for used objectives), NOT in objectiveDiscard.
  G.rebel.objectiveDiscard = [];
  G.rebel.scoredObjectives = [{ objectiveId: 'crippling-blow', reputation: 1, turn: 3 }];
  G.rebel.objectiveDeck = [];
  G.rebel.actionHand = ['something-to-fight-for'];
  G.rebel.actionDiscard = [];

  // Drive the resolver directly with the scored objective as a candidate.
  const sysId = Object.keys(G.map.systems)[0];
  G.pendingCombat = { systemId: sysId, report: { winner: 'Rebel' } };
  G.pendingChoice = {
    kind: 'SomethingToFightForOffer', side: 'Rebel',
    candidates: ['crippling-blow'],
  };
  const r = combat.resolveSomethingToFightForOffer(G, 'crippling-blow');
  check('resolver accepted the scored objective', r.ok, r.reason);
  check('scored objective placed on top of the deck',
    (G.rebel.objectiveDeck ?? [])[0] === 'crippling-blow');
  check('scored objective removed from the scored pile (no double-retrieve)',
    !(G.rebel.scoredObjectives ?? []).some((s) => s.objectiveId === 'crippling-blow'));
  check('the action card was discarded',
    (G.rebel.actionDiscard ?? []).includes('something-to-fight-for')
    && !(G.rebel.actionHand ?? []).includes('something-to-fight-for'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
