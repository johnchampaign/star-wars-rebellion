// #225 — Draw Their Fire's heal is reactive: it now resolves AFTER the
// Imperial attack (not at round start), so it can save a just-damaged ship.
// Run: node scripts/test-draw-their-fire-225.mjs
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
const cin = await import('../src/engine/cinematicTactics.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const G = createGame(data, {
  seed: 11, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true },
});
M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
const c = G.pendingCombat;
const mc = G.map.systems['felucia'].units.find((u) => u.typeId === 'mon-cala-cruiser');
const maxHp = G.catalog.unitTypes['mon-cala-cruiser'].health.value;

// Simulate the Imperial attack having just dealt LETHAL damage to the cruiser:
// it's staged for end-of-theatre destruction.
mc.damage = maxHp;
(c.theaterStaged ??= []).push(mc.instanceId);
check('cruiser staged at lethal damage', mc.damage >= maxHp && c.theaterStaged.includes(mc.instanceId));

// Rebel resolves Draw Their Fire (primary). With the fix this DEFERS the heal.
cin.applyCinematicAbility(G, c, 'Rebel', 'space', 'cin-rebel-space-draw-their-fire', true);
check('heal deferred, not applied at resolve time', mc.damage === maxHp,
  `damage=${mc.damage} (should still be ${maxHp} until after attacks)`);
check('deferred-heal queued', (c.cinematicDeferredHeal ?? []).length === 1);

// After the theatre's attacks, the reactive heal drains (combat.ts does this
// right before finalizeTheaterDestructions).
cin.applyDeferredCinematicHeals(G, c, 'space');
check('cruiser healed below lethal', mc.damage < maxHp, `damage=${mc.damage}`);
check('cruiser un-staged (saved)', !c.theaterStaged.includes(mc.instanceId));

// The destruction step now spares it.
combat.finalizeTheaterDestructions(G, c, 'space');
const stillThere = G.map.systems['felucia'].units.some((u) => u.instanceId === mc.instanceId);
check('cruiser survives the destruction step', stillThere);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
