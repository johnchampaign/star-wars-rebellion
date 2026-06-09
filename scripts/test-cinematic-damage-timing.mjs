// Audit #2/#3: RoE cinematic combat defers unit destruction to the end of the
// theatre round, so a Remove-Damage heal can save a lethally-damaged unit.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { applyCinematicAbility, applyCinematicSpecialHeal } = await import('../src/engine/cinematicTactics.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
const baseOpts = (seed) => ({ seed, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo','corellia','kashyyyk'], forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'], expansion: { enabled: true, cinematicCombat: true } });
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };
const alive = (G, id) => (G.map.systems['felucia'].units ?? []).some((u) => u.instanceId === id);

// #3: tactic deal-damage stages the unit (doesn't destroy it immediately).
console.log('[ #3: cinematic deal-damage stages, does not destroy immediately ]');
{
  const G = createGame(data, baseOpts(800));
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia'); // 1-health ground, gets killed by Overrun's deal-2
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'ground'; c.theaterStaged = []; // simulate being mid-ground-theatre
  const target = G.map.systems['felucia'].units.find((u) => u.side === 'Rebel' && u.typeId === 'airspeeder');
  applyCinematicAbility(G, c, 'Empire', 'ground', 'cin-empire-ground-overrun', true); // top = deal 2
  check('damaged Rebel unit is STILL present (not destroyed now)', alive(G, target.instanceId));
  check('it is at lethal damage', target.damage >= G.catalog.unitTypes['airspeeder'].health.value);
  check('it is staged for end-of-round destruction', (c.theaterStaged ?? []).includes(target.instanceId));
}

// #2: a healed unit survives end-of-round; an un-healed lethal unit dies.
console.log('[ #2: end-of-round destruction respects a heal ]');
{
  const G = createGame(data, baseOpts(801));
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia'); // red, 2 health
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'space';
  const [a, b] = G.map.systems['felucia'].units.filter((u) => u.typeId === 'mon-cala-cruiser');
  const hp = G.catalog.unitTypes['mon-cala-cruiser'].health.value;
  a.damage = hp; b.damage = hp;            // both at lethal
  c.theaterStaged = [a.instanceId, b.instanceId];
  // The Rebel spends a red ★ to heal unit `a` below lethal (RAW Remove Damage).
  applyCinematicSpecialHeal(G, c, 'Rebel', 'space', { red: 1, black: 0 });
  check('heal pulled unit a below lethal', a.damage < hp);
  combat.finalizeTheaterDestructions(G, c, 'space');
  check('healed unit a SURVIVES end-of-round', alive(G, a.instanceId));
  check('un-healed unit b is destroyed', !alive(G, b.instanceId));
}

// standard combat still destroys staged (lethal) units (no heals).
console.log('[ standard combat: staged lethal units still destroyed ]');
{
  const G = createGame(data, { ...baseOpts(802), expansion: { enabled: true, cinematicCombat: false } });
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat; c.activeTheater = 'space';
  const u = G.map.systems['felucia'].units.find((x) => x.typeId === 'mon-cala-cruiser');
  u.damage = G.catalog.unitTypes['mon-cala-cruiser'].health.value;
  c.theaterStaged = [u.instanceId];
  combat.finalizeTheaterDestructions(G, c, 'space');
  check('standard: lethal staged unit destroyed', !alive(G, u.instanceId));
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #2/#3 damage-timing tests passed');
process.exit(fail ? 1 : 0);
