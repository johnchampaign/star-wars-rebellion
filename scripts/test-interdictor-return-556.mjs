// #556 — Interdictor Development resolved with 2 leaders must RETURN to the
// Imperial mission hand, not the discard pile. Card text: "Place 1 Interdictor
// on build space 2. If 2 leaders are assigned, place on space 1 and return the
// card." Previously the 2-leader case placed on space 1 correctly but still
// discarded the card (the return-to-hand intent was only logged, never applied).
// Run: node scripts/test-interdictor-return-556.mjs
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
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

// Resolve Interdictor Development at `target` (must have an Imperial unit, no
// Rebel units, no sabotage) with `leaderIds` assigned. Returns the game.
function runInterdictor({ seed, target, leaderIds }) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  // Guarantee the resolve preconditions: an Imperial unit at the target, and
  // no Rebel units / sabotage marker there.
  M.deployUnit(G, 'Empire', 'stormtrooper', target);
  const ss = G.map.systems[target];
  ss.units = ss.units.filter((u) => u.side !== 'Rebel');
  ss.sabotageMarkers = [];
  // Clear any Empire leaders already sitting at the target (they'd block/skew).
  for (const sid of Object.keys(G.empire.leadersOnBoard)) G.empire.leadersOnBoard[sid] = [];

  G.phase = 'Assignment';
  G.currentPlayer = 'Empire';
  G.passedThisCommand = [];
  for (const lid of leaderIds) if (!G.empire.leaderPool.includes(lid)) G.empire.leaderPool.push(lid);
  G.empire.missionHand = ['interdictor-development'];
  G.empire.missionDiscard = [];
  const asg = phases.assignLeader(G, 'Empire', 'interdictor-development', leaderIds);
  if (!asg.ok) return { error: `assign:${asg.reason}`, G };
  G.phase = 'Command';
  const rv = phases.revealMission(G, 'Empire', 'interdictor-development', target);
  if (!rv.ok) return { error: `reveal:${rv.reason}`, G };
  return { G };
}

const inQueue = (G, slot) => (G.empire.buildQueue?.[slot] ?? []).includes('interdictor');

console.log('\n[ #556 two leaders → build space 1 AND card returns to hand ]');
{
  const { G, error } = runInterdictor({ seed: 7, target: 'corellia', leaderIds: ['general-veers', 'grand-moff-tarkin'] });
  if (error) { check('setup ok', false, error); }
  else {
    check('Interdictor placed on build space 1', inQueue(G, 1), JSON.stringify(G.empire.buildQueue));
    check('card RETURNED to the Imperial mission hand', (G.empire.missionHand ?? []).includes('interdictor-development'));
    check('card NOT in the discard pile', !(G.empire.missionDiscard ?? []).includes('interdictor-development'));
    check('override flag cleared after use', !G.missionReturnToHandOverride);
  }
}

console.log('\n[ #556 one leader → build space 2 AND card discarded (unchanged) ]');
{
  const { G, error } = runInterdictor({ seed: 7, target: 'corellia', leaderIds: ['grand-moff-tarkin'] });
  if (error) { check('setup ok', false, error); }
  else {
    check('Interdictor placed on build space 2', inQueue(G, 2), JSON.stringify(G.empire.buildQueue));
    check('card DISCARDED (not returned)', (G.empire.missionDiscard ?? []).includes('interdictor-development'));
    check('card NOT in the mission hand', !(G.empire.missionHand ?? []).includes('interdictor-development'));
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
