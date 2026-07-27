// #655 — Raid Outposts cleared both its target markers, was discarded, then
// returned to the deck via "Something To Fight For" and was redrawn. On the
// second draw it placed NO markers, because the one-shot activation flag
// persisted for the whole game.
//
// RAW: removing a target marker "returns the marker to the supply of unused
// tokens" (RoE rulebook, Removing Target Markers) — tokens are reusable and
// nothing removes the card from the game, so a redrawn copy is a fresh
// Immediate objective and must place its markers again.
//
// Run: node scripts/test-immediate-objective-redraw-655.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const newGame = () => createGame(data, {
  seed: 655, expansion: { enabled: true, roeUnits: true, roeMissions: true, roeObjectives: true },
});

console.log('\n[ #655 Raid Outposts places markers again after being redrawn ]');
{
  const G = newGame();
  G.rebel.objectiveHand = ['raid-outposts-2'];

  // First draw: the Immediate objective posts the Imperial placement choice.
  const posted = phases.flushImmediateObjectiveActivations(G, 'command');
  check('first draw posts the Imperial marker placement', posted === true
    && G.pendingChoice?.kind === 'RaidOutpostsPlace', `choice=${G.pendingChoice?.kind}`);

  const remotes = [...G.pendingChoice.legal].slice(0, 2);
  phases.resolveRaidOutpostsPlace(G, remotes);
  const placed = M.systemsWithTargetMarker(G, 'raid-outposts-2');
  check('two markers on the board', placed.length === 2, `placed=${placed.length}`);

  // Raid both outposts: Rebel ground unit present, no Imperial ground.
  for (const sid of [...placed]) {
    G.map.systems[sid].units = G.map.systems[sid].units.filter(
      (u) => !(u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground'));
    M.deployUnit(G, 'Rebel', 'rebel-trooper', sid);
  }
  phases.scoreRaidOutposts(G);
  check('all markers cleared', M.systemsWithTargetMarker(G, 'raid-outposts-2').length === 0);

  // Depleted → the card is discarded (RoE FAQ).
  M.maybeDiscardDepletedImmediateObjective(G, 'raid-outposts-2');
  check('card left hand for the discard pile',
    !(G.rebel.objectiveHand ?? []).includes('raid-outposts-2')
    && (G.rebel.objectiveDiscard ?? []).includes('raid-outposts-2'));

  // #655: "Something To Fight For" returns it to the deck; simulate the redraw.
  G.rebel.objectiveDiscard = (G.rebel.objectiveDiscard ?? []).filter((id) => id !== 'raid-outposts-2');
  G.rebel.objectiveHand = ['raid-outposts-2'];

  const posted2 = phases.flushImmediateObjectiveActivations(G, 'command');
  check('redraw posts the placement choice again', posted2 === true
    && G.pendingChoice?.kind === 'RaidOutpostsPlace',
    `choice=${G.pendingChoice?.kind ?? 'none'} (stale activation flag would give none)`);

  if (G.pendingChoice?.kind === 'RaidOutpostsPlace') {
    phases.resolveRaidOutpostsPlace(G, [...G.pendingChoice.legal].slice(0, 2));
  }
  check('markers are on the board a second time',
    M.systemsWithTargetMarker(G, 'raid-outposts-2').length === 2,
    `placed=${M.systemsWithTargetMarker(G, 'raid-outposts-2').length}`);
}

console.log('\n[ still activates only ONCE while it stays in hand ]');
{
  const G = newGame();
  G.rebel.objectiveHand = ['raid-outposts-2'];
  phases.flushImmediateObjectiveActivations(G, 'command');
  phases.resolveRaidOutpostsPlace(G, [...G.pendingChoice.legal].slice(0, 2));
  // Card is still in hand with markers out — must NOT re-post a placement.
  const again = phases.flushImmediateObjectiveActivations(G, 'command');
  check('no second placement while the card is still in hand', again === false
    && !G.pendingChoice, `choice=${G.pendingChoice?.kind ?? 'none'}`);
  check('still exactly two markers',
    M.systemsWithTargetMarker(G, 'raid-outposts-2').length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
