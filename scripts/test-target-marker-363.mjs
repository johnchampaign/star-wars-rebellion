// Issue #363 — Target markers must be removed the moment a side holds the
// system's ground with no opposing ground units, NOT deferred to Refresh.
// Removal is intentionally suppressed mid-combat (transient ground counts), so
// after a CONQUERING combat the engine must re-run invariants at combat end —
// otherwise the loser's marker (and its reputation, e.g. Raid Outposts) lingers
// until some unrelated later move. This guards that combat-end sweep.
// Run: node scripts/test-target-marker-363.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const handlers = await import('../src/engine/handlers/index.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
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
const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true } });
handlers.registerAll();

const SYS = 'dantooine';
const hasMarker = (G) => M.hasTargetMarker(G, SYS, 'raid-outposts-2');

console.log('\n[ #363 marker held off DURING combat, then stripped at combat end ]');
{
  const G = createGame(data, opts(1));
  const ss = G.map.systems[SYS];
  ss.units = [];
  // Raid Outposts marker: placedBy Empire, removed by the Rebel holding ground.
  M.placeTargetMarker(G, SYS, 'raid-outposts-2', 'Empire');
  // Both sides have ground (a contested system, mid-battle).
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  const repBefore = G.reputationMarker;
  check('marker present at setup', hasMarker(G));

  // Simulate combat: the Empire trooper is destroyed, but a combat is pending.
  G.pendingCombat = { systemId: SYS, removed: [] };
  const imp = ss.units.find((u) => u.side === 'Empire');
  M.destroyUnit(G, imp.instanceId, 'combat');
  check('marker NOT stripped mid-combat (pendingCombat guard holds)', hasMarker(G));
  check('reputation not banked yet', G.reputationMarker === repBefore);

  // Combat ends: finishCombatTail clears pendingCombat then re-runs invariants.
  G.pendingCombat = undefined;
  M.postCombatInvariants(G, SYS);
  check('marker stripped at combat end (Rebel holds ground, no Imperial ground)', !hasMarker(G));
  check('reputation banked immediately (marker moved 1 toward Rebel win)',
    G.reputationMarker === repBefore - 1, `before=${repBefore} after=${G.reputationMarker}`);
}

console.log('\n[ #363 marker stays if the conquering side does NOT clear opposing ground ]');
{
  const G = createGame(data, opts(2));
  const ss = G.map.systems[SYS];
  ss.units = [];
  M.placeTargetMarker(G, SYS, 'raid-outposts-2', 'Empire');
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS); // Imperial ground survives
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  M.postCombatInvariants(G, SYS);
  check('marker stays while Imperial ground remains', hasMarker(G));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
