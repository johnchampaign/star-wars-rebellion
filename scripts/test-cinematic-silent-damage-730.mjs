// #730 — "I won the space battle as empire ... all my space units disappeared."
//
// Tripwire for SILENT cinematic damage. A splittable "deal N" cinematic tactic
// prompts the player for each point only while 2+ targets remain; once one
// target is left the engine auto-assigns the rest. Those auto-assigned points
// used to land with NO log entry, so a second unit died at end of round with
// nothing in the log or the in-game activity feed to explain it.
//
// The check is a conservation law over the combat log: for each side, the total
// health of its units destroyed with cause 'combat' can never exceed the damage
// the OPPONENT is logged as having dealt (rolled hits + every logged card deal).
// Any unlogged damage source breaks it. Before the fix this fired on ~1% of
// randomly-generated cinematic combats (4 of 400 seeds).
//
// Run: node scripts/test-cinematic-silent-damage-730.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
const baseOpts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true },
});

function driveCombat(G) {
  combat.runCombat(G);
  let guard = 0;
  while (G.pendingCombat && G.pendingChoice && guard++ < 800) {
    if (!stepOnce(G, G.pendingChoice.side)) break;
  }
}

const EMP = ['assault-carrier', 'tie-fighter', 'tie-striker', 'star-destroyer',
  'at-at', 'at-st', 'stormtrooper', 'assault-tank'];
const REB = ['corellian-corvette', 'x-wing', 'y-wing', 'nebulon-b-frigate',
  'rebel-trooper', 'airspeeder', 'golan-arms-turret'];

console.log('[ #730 — every point of cinematic tactic damage is logged ]');

let runs = 0;
const violations = [];
for (let seed = 1; seed <= 400; seed++) {
  const G = createGame(data, baseOpts(seed));
  const pick = (arr, n) =>
    arr[Math.floor(((Math.sin(seed * 7919 + n * 104729) + 1) / 2) * 1e6) % arr.length];
  for (let i = 0; i < 3 + (seed % 3); i++) M.deployUnit(G, 'Empire', pick(EMP, i), 'felucia');
  for (let i = 0; i < 3 + (seed % 4); i++) M.deployUnit(G, 'Rebel', pick(REB, i + 50), 'felucia');

  const before = G.turnLog.length;
  try {
    combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
    driveCombat(G);
  } catch { continue; }
  runs++;

  const dealt = { Rebel: 0, Empire: 0 };
  const lostHp = { Rebel: 0, Empire: 0 };
  for (const e of G.turnLog.slice(before)) {
    const p = e.payload ?? {};
    if (e.kind === 'combat-attack') {
      dealt[e.side] += (p.dice ?? []).filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
    } else if (e.kind === 'cinematic-tactic-play') {
      dealt[e.side] += (p.dealt ?? 0) + (p.condDealt ?? 0) + (p.targetDealt ?? 0);
    } else if (e.kind === 'combat-action-card-applied') {
      dealt[e.side] += (p.bonusDamage ?? 0);
    } else if (e.kind === 'destroy-unit' && p.cause === 'combat') {
      const t = G.catalog.unitTypes[p.typeId];
      if (t && t.health.color !== null) lostHp[e.side] += t.health.value;
    }
  }
  for (const side of ['Rebel', 'Empire']) {
    const foe = side === 'Rebel' ? 'Empire' : 'Rebel';
    if (lostHp[side] > dealt[foe]) {
      violations.push(`seed ${seed}: ${side} lost ${lostHp[side]} HP but ${foe} is logged dealing only ${dealt[foe]}`);
    }
  }
}

for (const v of violations) console.log(`  ✗ ${v}`);
const ok = violations.length === 0;
console.log(`  ${ok ? '✓' : '✗'} ${runs} cinematic combats: logged damage accounts for every combat destruction`);
console.log(`\n${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);
process.exit(ok ? 0 : 1);
