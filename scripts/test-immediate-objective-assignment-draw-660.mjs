// #660 — "Used Jan Dodonna's action card, rebel-planning, and picked up rebel
// cell, its immediate action did not resolve, and I was unable to select a
// system for the rebel cell marker."
//
// RoE p.8: an Immediate objective resolves WHEN DRAWN. Rebel Planning draws an
// objective during the ASSIGNMENT phase, but the only flush sites were
// advanceCommandTurn and the Refresh draw — neither runs on the
// Assignment→Command transition. So the drawn Rebel Cell just sat in hand with
// no way to place its marker.
//
// Run: node scripts/test-immediate-objective-assignment-draw-660.mjs
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

const opts = (seed) => ({
  seed, autoSetupUnits: true,
  expansion: { enabled: true, roeUnits: true, roeMissions: true, roeObjectives: true },
});

/** Play Rebel Planning during Assignment with `top` stacked on the objective
 *  deck, then close Assignment so the round enters the Command phase. */
function playRebelPlanning(seed, top) {
  const G = createGame(data, opts(seed));
  G.rebel.actionHand = ['rebel-planning'];
  if (!G.rebel.leaderPool.includes('jan-dodonna')) G.rebel.leaderPool.push('jan-dodonna');
  G.rebel.objectiveDeck = [top, ...(G.rebel.objectiveDeck || []).filter((c) => c !== top)];
  G.rebel.objectiveHand = [];
  G.pendingChoice = { kind: 'PlayAssignmentActionCard', side: 'Rebel', candidates: ['rebel-planning'] };
  const r = phases.playAssignmentActionCard(G, 'rebel-planning');
  if (!r.ok) throw new Error(`could not play rebel-planning: ${r.reason}`);
  phases.skipAssignment(G, 'Rebel');
  phases.skipAssignment(G, 'Empire');
  return G;
}
const markedSystems = (G) => Object.entries(G.map.systems)
  .filter(([, s]) => (s.targetMarkers ?? []).length > 0).map(([k]) => k);

console.log('\n[ #660 Rebel Cell drawn by Rebel Planning gets its placement ]');
{
  const G = playRebelPlanning(660, 'rebel-cell-2');
  check('the objective was drawn into hand', (G.rebel.objectiveHand ?? []).includes('rebel-cell-2'),
    JSON.stringify(G.rebel.objectiveHand));
  check('the Command phase was reached', G.phase === 'Command', G.phase);
  check('the marker placement is offered', G.pendingChoice?.kind === 'RebelCellPlace',
    `pendingChoice=${G.pendingChoice?.kind ?? 'none'} (the bug left this undefined)`);
  const legal = G.pendingChoice?.legal ?? [];
  check('it offers Rebel-loyalty systems to place in', legal.length > 0, `legal=${legal.length}`);
  if (legal.length > 0) {
    const r = phases.resolveRebelCellPlace(G, legal[0]);
    check('placement resolves', r.ok, r.reason);
    check('the marker is on the board', markedSystems(G).includes(legal[0]),
      JSON.stringify(markedSystems(G)));
  }
}

console.log('\n[ Raid Outposts drawn the same way also resolves ]');
{
  const G = playRebelPlanning(661, 'raid-outposts-2');
  check('the Imperial marker placement is offered',
    G.pendingChoice?.kind === 'RaidOutpostsPlace',
    `pendingChoice=${G.pendingChoice?.kind ?? 'none'}`);
  if (G.pendingChoice?.kind === 'RaidOutpostsPlace') {
    const legal = [...G.pendingChoice.legal].slice(0, 2);
    phases.resolveRaidOutpostsPlace(G, legal);
    check('both markers are on the board',
      M.systemsWithTargetMarker(G, 'raid-outposts-2').length === 2,
      `placed=${M.systemsWithTargetMarker(G, 'raid-outposts-2').length}`);
  }
}

console.log('\n[ a NON-immediate objective still draws quietly ]');
{
  const G = playRebelPlanning(662, 'the-long-war-1');
  check('drawn into hand', (G.rebel.objectiveHand ?? []).includes('the-long-war-1'));
  check('no placement choice posted', G.pendingChoice?.kind !== 'RebelCellPlace'
    && G.pendingChoice?.kind !== 'RaidOutpostsPlace', `got ${G.pendingChoice?.kind}`);
  check('no markers placed', markedSystems(G).length === 0, JSON.stringify(markedSystems(G)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
