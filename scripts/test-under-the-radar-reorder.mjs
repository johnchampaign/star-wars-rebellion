// Under the Radar (#audit) — second step: "replace the others at the top or
// bottom of the deck in any order." Previously the un-kept peeked probes were
// left on top in original order; now the Rebel places each top/bottom.
// Run: node scripts/test-under-the-radar-reorder.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

console.log('\n[ Under the Radar: hold 1, then place the other 3 top/bottom ]');
{
  const G = createGame(data, { seed: 4, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  G.pendingChoice = undefined;
  if (!G.rebel.leaderPool.includes('cassian-andor')) G.rebel.leaderPool.push('cassian-andor');
  G.rebel.actionHand = ['under-the-radar'];
  G.rebel.heldProbe = undefined;
  // Known top-4 probe order; a 5th underneath to verify top/bottom placement.
  const deck = G.probeDeck;
  const top4 = deck.slice(0, 4);
  const fifth = deck[4];
  check('probe deck has at least 5 cards for the test', top4.length === 4 && !!fifth);

  const req = phases.requestImmediateActionCardPlay(G, 'Rebel');
  check('requested immediate-action play', req.ok, req.reason);
  const play = phases.playImmediateActionCard(G, 'under-the-radar');
  check('played Under the Radar', play.ok, play.reason);
  check('posted the keep choice', G.pendingChoice?.kind === 'UnderTheRadarKeep',
    G.pendingChoice?.kind);

  // Hold the FIRST peeked probe; the other three (top4[1..3]) go to reorder.
  const held = top4[0];
  const keep = phases.resolveUnderTheRadarKeep(G, held);
  check('resolved keep', keep.ok, keep.reason);
  check('held probe pulled from the deck', G.rebel.heldProbe === held && !G.probeDeck.includes(held));
  check('chained into the reorder choice', G.pendingChoice?.kind === 'UnderTheRadarReorder',
    G.pendingChoice?.kind);
  const remaining = G.pendingChoice.cards;
  check('reorder covers the 3 un-kept probes', remaining.length === 3
    && remaining.every((id) => top4.slice(1).includes(id)));

  // Place top4[1] on TOP, top4[2] and top4[3] on BOTTOM.
  const placements = [
    { cardId: top4[1], position: 'top' },
    { cardId: top4[2], position: 'bottom' },
    { cardId: top4[3], position: 'bottom' },
  ];
  const r = phases.resolveUnderTheRadarReorder(G, placements);
  check('resolved the reorder', r.ok, r.reason);
  check('choice cleared', G.pendingChoice === undefined);
  check('chosen probe is now on TOP of the deck', G.probeDeck[0] === top4[1],
    `top=${G.probeDeck[0]} expected=${top4[1]}`);
  check('the two buried probes are at the BOTTOM',
    G.probeDeck[G.probeDeck.length - 2] === top4[2] && G.probeDeck[G.probeDeck.length - 1] === top4[3],
    `tail=${G.probeDeck.slice(-2).join(',')}`);
  check('the held probe is NOT back in the deck', !G.probeDeck.includes(held));
}

console.log('\n[ rejects placements that do not cover the remaining probes ]');
{
  const G = createGame(data, { seed: 4, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.pendingChoice = { kind: 'UnderTheRadarReorder', side: 'Rebel', cards: ['a', 'b'] };
  const bad = phases.resolveUnderTheRadarReorder(G, [{ cardId: 'a', position: 'top' }]);
  check('partial placement rejected', !bad.ok && bad.reason === 'placements-must-cover-remaining-probes', bad.reason);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
