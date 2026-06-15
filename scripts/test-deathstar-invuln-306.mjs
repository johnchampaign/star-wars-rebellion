// #306/#307 — a completed Death Star cannot be damaged, staged, or destroyed by
// dice / cinematic tactics in space combat; only Death Star Plans removes it.
// Run: node scripts/test-deathstar-invuln-306.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');

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

const opts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, roeUnits: true, cinematicCombat: true },
});

let everStaged = false, everDestroyed = false, ran = 0;
for (let s = 700; s < 712; s++) {
  const G = createGame(data, opts(s));
  G.map.systems['felucia'].units = [];
  // Empire: a completed Death Star + a couple of escorts (real dice targets).
  M.deployUnit(G, 'Empire', 'death-star', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  // Rebel: a heavy fighter/capital force to throw lots of dice at the Empire.
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  const dsId = G.map.systems['felucia'].units.find((u) => u.typeId === 'death-star')?.instanceId;

  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);
  ran++;
  let guard = 0;
  while (G.pendingCombat && G.pendingChoice && guard++ < 400) {
    // Whenever a Death Star Plans attempt is offered, DECLINE it — we only want
    // to test that NORMAL dice/cards can't kill the DS.
    if (G.pendingChoice.kind === 'DeathStarPlansAttempt') {
      combat.resolveDsPlansAttempt(G, false);
      continue;
    }
    // Track staging mid-combat.
    if (G.pendingCombat?.theaterStaged?.includes(dsId)) everStaged = true;
    if (!stepOnce(G, G.pendingChoice.side)) break;
  }
  // Did the Death Star survive the whole combat (we never played DS Plans)?
  const ssAfter = G.map.systems['felucia'];
  const dsAlive = (ssAfter?.units ?? []).some((u) => u.instanceId === dsId);
  if (!dsAlive) everDestroyed = true;
}

console.log('\n[ #306/#307 Death Star invulnerability in cinematic space combat ]');
check(`ran ${ran} combats`, ran > 0);
check('Death Star was NEVER staged for destruction by dice/cards', !everStaged);
check('Death Star was NEVER destroyed without Death Star Plans', !everDestroyed);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
