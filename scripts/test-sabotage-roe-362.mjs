// Sabotage RoE upgrade (#362): "Attempt in any system. Destroy a Shield Bunker
// OR, if populous, place a sabotage marker." Base game keeps the place-marker-
// anywhere behavior. Run: node scripts/test-sabotage-roe-362.mjs
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

// Drive an unopposed (auto-success) Sabotage at `target`.
function attemptSabotage({ seed = 1, target, withBunker, enabled = true }) {
  const G = createGame(data, { seed, expansion: { enabled, roeUnits: true, roeMissions: true } });
  const ss = G.map.systems[target];
  // Clear any Empire leaders at the target so the mission is unopposed.
  delete G.empire.leadersOnBoard[target];
  if (withBunker) M.deployUnit(G, 'Empire', 'shield-bunker', target);
  G.phase = 'Assignment';
  G.currentPlayer = 'Rebel';
  G.passedThisCommand = [];
  if (!G.rebel.leaderPool.includes('han-solo')) G.rebel.leaderPool.push('han-solo');
  G.rebel.missionHand = ['sabotage'];
  const asg = phases.assignLeader(G, 'Rebel', 'sabotage', ['han-solo']);
  if (!asg.ok) return { error: `assign:${asg.reason}`, G };
  G.phase = 'Command';
  const rv = phases.revealMission(G, 'Rebel', 'sabotage', target);
  if (!rv.ok) return { error: `reveal:${rv.reason}`, G };
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null, false);
  return { G, ss };
}
const hasBunker = (G, sys) => (G.map.systems[sys].units ?? []).some((u) => u.typeId === 'shield-bunker');
const hasMarker = (G, sys) => !!G.map.systems[sys].sabotage;

console.log('\n[ RoE: populous + Shield Bunker → choice; destroy-bunker ]');
{
  const { G, error } = attemptSabotage({ target: 'alderaan', withBunker: true });
  check('no setup error', !error, error);
  check('posted a SabotageChoice', G.pendingChoice?.kind === 'SabotageChoice', G.pendingChoice?.kind);
  const r = phases.resolveSabotageChoice(G, 'destroy-bunker');
  check('destroy-bunker resolved', r.ok, r.reason);
  check('Shield Bunker destroyed', !hasBunker(G, 'alderaan'));
  check('no sabotage marker placed', !hasMarker(G, 'alderaan'));
}

console.log('\n[ RoE: populous + Shield Bunker → choice; place-marker ]');
{
  const { G, error } = attemptSabotage({ target: 'alderaan', withBunker: true });
  check('no setup error', !error, error);
  check('posted a SabotageChoice', G.pendingChoice?.kind === 'SabotageChoice');
  const r = phases.resolveSabotageChoice(G, 'place-marker');
  check('place-marker resolved', r.ok, r.reason);
  check('sabotage marker placed', hasMarker(G, 'alderaan'));
  check('Shield Bunker survived', hasBunker(G, 'alderaan'));
}

console.log('\n[ RoE: remote + Shield Bunker → auto-destroy, no choice, no marker ]');
{
  const { G, error } = attemptSabotage({ target: 'dagobah', withBunker: true });
  check('no setup error', !error, error);
  check('no choice posted', G.pendingChoice?.kind !== 'SabotageChoice', G.pendingChoice?.kind);
  check('Shield Bunker destroyed', !hasBunker(G, 'dagobah'));
  check('no marker on a remote system', !hasMarker(G, 'dagobah'));
}

console.log('\n[ RoE: populous, no bunker → place marker, no choice ]');
{
  const { G, error } = attemptSabotage({ target: 'alderaan', withBunker: false });
  check('no setup error', !error, error);
  check('no choice posted', G.pendingChoice?.kind !== 'SabotageChoice');
  check('sabotage marker placed', hasMarker(G, 'alderaan'));
}

console.log('\n[ RoE: remote, no bunker → no effect ]');
{
  const { G, error } = attemptSabotage({ target: 'dagobah', withBunker: false });
  check('no setup error', !error, error);
  check('no choice posted', G.pendingChoice?.kind !== 'SabotageChoice');
  check('no marker placed on a non-populous system without a bunker', !hasMarker(G, 'dagobah'));
}

console.log('\n[ Base game: place a marker in ANY system (remote included) ]');
{
  const { G, error } = attemptSabotage({ target: 'dagobah', withBunker: false, enabled: false });
  check('no setup error', !error, error);
  check('no choice in base game', G.pendingChoice?.kind !== 'SabotageChoice');
  check('marker placed even on a remote system (base behavior)', hasMarker(G, 'dagobah'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
