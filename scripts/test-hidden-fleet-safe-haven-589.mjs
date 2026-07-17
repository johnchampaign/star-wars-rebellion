// #589/#590: AI Rebel ran Hidden Fleet on a base of X-wings and moved NOTHING —
// self-moving fighters (space, capacity 0, restriction false) fell through the
// resolver's cap-ship/restriction/ground buckets and were never picked.
// #594: AI Rebel ran Safe Haven with an empty build queue (a pure no-op).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { missionRevealIsPointless } = await import('../src/engine/missionTargets.ts');
const ai = await import('../src/play/randomAI.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

function newGame(seed) {
  return createGame(data, { seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
}

// ---- Fix 1: Hidden Fleet AI resolver moves self-moving X/Y-wings -------------
{
  const G = newGame(11);
  ai.seedAI(11);
  // Isolate a base holding ONLY self-moving fighters (X-/Y-wing) + a structure.
  const catalog = G.catalog.unitTypes;
  let n = 5000;
  const mk = (typeId) => ({ instanceId: `test-u${n++}`, typeId, side: 'Rebel' });
  G.map.rebelBaseSpace.units = [
    mk('x-wing'), mk('x-wing'), mk('y-wing'),
    { instanceId: 'test-struct', typeId: 'shield-generator', side: 'Rebel' }, // immobile, not a candidate
  ];
  // Sanity: X/Y-wings are space, capacity 0, restriction false (self-moving).
  const xw = catalog['x-wing'];
  check('x-wing is a self-moving space fighter (cap 0, restriction false)',
    xw.theater === 'space' && xw.transport.capacity === 0 && xw.transport.restriction === false);

  const candidateUnitIds = G.map.rebelBaseSpace.units
    .filter((u) => !catalog[u.typeId].transport.immobile).map((u) => u.instanceId);
  const target = 'dagobah';
  G.pendingChoice = { kind: 'HiddenFleetUnitPick', side: 'Rebel', targetSystemId: target, candidateUnitIds };

  const before = (G.map.systems[target]?.units ?? []).length;
  const ok = ai.stepOnce(G, 'Rebel');
  const moved = (G.map.systems[target]?.units ?? []).length - before;
  ai.unseedAI();
  check('AI resolved the Hidden Fleet pick', ok);
  check('AI moved all 3 self-moving fighters (was 0 before the fix)', moved === 3, `moved=${moved}`);
  check('pendingChoice cleared', !G.pendingChoice);
}

// ---- Fix 2: Safe Haven is pointless with an empty build queue ----------------
{
  const G = newGame(22);
  G.rebel.buildQueue = { 1: [], 2: [], 3: [] };
  check('Safe Haven pointless when build queue empty',
    missionRevealIsPointless(G, 'Rebel', 'safe-haven', 'kessel') === true);
  G.rebel.buildQueue = { 1: ['x-wing'], 2: [], 3: [] };
  check('Safe Haven NOT pointless once a unit is queued',
    missionRevealIsPointless(G, 'Rebel', 'safe-haven', 'kessel') === false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
