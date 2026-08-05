// #691 — "Retreated and lost all my ground units from a destroyed system
// (destroyed in an earlier round)." The Rebel retreated a Nebulon-B frigate and
// two Airspeeders out of a Death-Star'd Saleucami; the frigate arrived, the
// Airspeeders were logged as `destroyed-system-overflow` and never made it.
//
// Same root cause as #532, in a different code path. In a DESTROYED system the
// invariants cull ground units that exceed the transport capacity PRESENT in
// that system, and the invariants re-run after every single unit move. The
// retreat moves carriers first (they are force-included and pushed onto the
// move list ahead of the cargo), so the moment the frigate stepped out the
// in-system capacity hit 0 and the cull ate the two Airspeeders that were
// queued to leave with it. The activation path had already been fixed by
// batching the cull (#532); the retreat path had not.
//
// Fix: wrap the retreat's move loop in withDeferredDestroyedCull, so the cull
// sees the finished position instead of a half-executed one.
//
// Run: node scripts/test-retreat-destroyed-system-691.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const combat = await import('../src/engine/combat.ts');
const M = await import('../src/engine/mechanics.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** A Rebel force under attack in a DESTROYED system, with one adjacent system
 *  free to retreat into. `bringGround` says whether the player selects the
 *  ground units to come along. */
function setup() {
  const G = createGame(data, { seed: 11 });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  // A system with a neighbour that is NOT one of the attacker's sources.
  const [target, [src, escape]] = Object.entries(G.catalog.adjacency)
    .find(([sid, adj]) => (adj?.length ?? 0) >= 2 && G.map.systems[sid]) ?? [];
  G.map.systems[target].destroyed = true;   // Death Star'd in an earlier round
  G.map.systems[escape].loyalty = 'rebel';  // keeps it a legal destination

  // Defender: 1 frigate (capacity 2) + 2 Airspeeders, exactly the reported shape.
  M.deployUnit(G, 'Rebel', 'nebulon-b-frigate', target);
  M.deployUnit(G, 'Rebel', 'airspeeder', target);
  M.deployUnit(G, 'Rebel', 'airspeeder', target);
  G.rebel.leadersOnBoard[target] = ['wedge-antilles'];
  // Attacker, arriving from `src`.
  M.deployUnit(G, 'Empire', 'star-destroyer', target);
  G.empire.leadersOnBoard[target] = ['darth-vader'];
  return { G, target, src, escape };
}

const unitsAt = (G, sys, typeId) =>
  G.map.systems[sys].units.filter((u) => u.typeId === typeId).length;

/** Start the combat, then post the retreat choice the way the retreat step does
 *  and hand it straight to the resolver — this exercises resolveRetreatDecision
 *  without having to roll a whole combat's worth of dice. */
function retreat(G, target, escape, bring) {
  combat.beginCombat(G, 'Empire', [target], target);
  const c = G.pendingCombat;
  if (!c) throw new Error('combat did not begin');
  const here = G.map.systems[target].units.filter((u) => u.side === 'Rebel');
  G.pendingChoice = {
    kind: 'RetreatDecision', side: 'Rebel', systemId: target,
    legalDestinations: [escape],
    availableUnits: here.map((u) => u.instanceId),
    leadersInSystem: ['wedge-antilles'],
  };
  const chosen = bring
    ? here.map((u) => u.instanceId)
    : here.filter((u) => u.typeId === 'nebulon-b-frigate').map((u) => u.instanceId);
  return combat.resolveRetreatDecision(G, escape, chosen, 'wedge-antilles');
}

console.log('\n[ #691 ground brought along on a retreat out of a destroyed system survives ]');
{
  const { G, target, escape } = setup();
  const r = retreat(G, target, escape, true);
  check('retreat succeeds', r.ok, r.reason);
  check('the frigate reached the destination', unitsAt(G, escape, 'nebulon-b-frigate') === 1);
  check('BOTH Airspeeders reached the destination (the bug: they were culled)',
    unitsAt(G, escape, 'airspeeder') === 2,
    `escape=${unitsAt(G, escape, 'airspeeder')} target=${unitsAt(G, target, 'airspeeder')}`);
  check('nothing was left stranded in the destroyed system',
    unitsAt(G, target, 'airspeeder') === 0);
  check('no overflow cull was logged',
    !G.turnLog.some((e) => e.kind === 'destroyed-system-overflow'),
    JSON.stringify(G.turnLog.filter((e) => e.kind === 'destroyed-system-overflow').map((e) => e.payload)));
}

console.log('\n[ RAW is unchanged: ground genuinely abandoned in a destroyed system is still culled ]');
{
  const { G, target, escape } = setup();
  const r = retreat(G, target, escape, false); // take the frigate, leave the ground
  check('retreat succeeds', r.ok, r.reason);
  check('the frigate reached the destination', unitsAt(G, escape, 'nebulon-b-frigate') === 1);
  check('abandoned Airspeeders are culled (0 capacity left behind)',
    unitsAt(G, target, 'airspeeder') === 0 && unitsAt(G, escape, 'airspeeder') === 0,
    `target=${unitsAt(G, target, 'airspeeder')} escape=${unitsAt(G, escape, 'airspeeder')}`);
  check('and the cull IS logged, as before',
    G.turnLog.filter((e) => e.kind === 'destroyed-system-overflow').length === 2);
}

console.log('\n[ an intact system is unaffected either way ]');
{
  const { G, target, escape } = setup();
  G.map.systems[target].destroyed = false;
  const r = retreat(G, target, escape, false); // leave the ground behind
  check('retreat succeeds', r.ok, r.reason);
  check('abandoned ground stays ALIVE on an intact planet',
    unitsAt(G, target, 'airspeeder') === 2, `target=${unitsAt(G, target, 'airspeeder')}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
