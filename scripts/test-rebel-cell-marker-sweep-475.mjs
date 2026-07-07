// #475 — a Rebel Cell target marker persisted on a system the Empire had fully
// occupied on the ground (no Rebel units left), so it kept wrongly scoring the
// Rebel 1 reputation each Refresh. The removal LOGIC is correct, but
// processTargetMarkerRemovals bails while any combat is pending and only the
// combat system is re-checked afterward — so a system whose occupation changed
// during a pending-combat window elsewhere keeps a stale marker. The fix is a
// full-board sweep at the start of each Refresh, before the marker scores.
// Run: node scripts/test-rebel-cell-marker-sweep-475.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const SYS = 'bothawui';
function stuckState(seed) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  const ss = G.map.systems[SYS];
  ss.loyalty = 'rebel'; ss.subjugated = true;
  // Empire fully occupies on the ground; NO Rebel units remain.
  ss.units = [
    { instanceId: 'e-atat', typeId: 'at-at', side: 'Empire', damage: 0 },
    { instanceId: 'e-st', typeId: 'stormtrooper', side: 'Empire', damage: 0 },
    { instanceId: 'e-tie', typeId: 'tie-fighter', side: 'Empire', damage: 0 },
  ];
  ss.targetMarkers = [{ source: 'rebel-cell-2', placedBy: 'Rebel', placedAt: 4 }];
  return G;
}

console.log('[ the stale marker survives the mid-combat skip but is swept at Refresh ]');
{
  const G = stuckState(2);
  // With a combat pending, the removal sweep is (correctly) skipped, so the stale
  // marker survives — this is the window in which the miss happens.
  G.pendingCombat = { systemId: SYS };
  M.sweepTargetMarkerRemovals(G); // guarded out by pendingCombat — no-op
  check('marker still present while a combat is pending (expected skip)',
    (G.map.systems[SYS].targetMarkers ?? []).some((m) => m.source === 'rebel-cell-2'));
  G.pendingCombat = undefined;

  // Now the Refresh pre-steps run. The new sweep must clear it BEFORE Rebel Cell
  // would score on it.
  G.rebel.objectiveHand = ['rebel-cell-2', 'sabotage']; // rebel-cell + a discardable
  const repBefore = G.reputationMarker;
  phases.advanceRefreshPreSteps(G, G.turnLog.length);
  check('the stale Rebel Cell marker was swept at Refresh start',
    !(G.map.systems[SYS].targetMarkers ?? []).some((m) => m.source === 'rebel-cell-2'),
    JSON.stringify(G.map.systems[SYS].targetMarkers ?? null));
  check('Rebel Cell did NOT wrongly score (no discard prompt raised)',
    G.pendingChoice?.kind !== 'RebelCellDiscard', `pc=${G.pendingChoice?.kind}`);
}

console.log('[ a legitimately-held marker (Rebel still present) is NOT swept ]');
{
  const G = stuckState(3);
  // Rebel keeps a ground unit there → contested → marker must stay (RAW).
  G.map.systems[SYS].units.push({ instanceId: 'r-tp', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 });
  M.sweepTargetMarkerRemovals(G);
  check('marker KEPT while the Rebel still holds ground there',
    (G.map.systems[SYS].targetMarkers ?? []).some((m) => m.source === 'rebel-cell-2'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
