// #519 — VARIANT: deploy BASE-game starting units at setup while keeping the full
// expansion unit roster available to build during the game. A commonly-played
// house option. Controlled by expansion.baseSetupUnits (only meaningful when
// roeUnits is on). Must NOT double the Death Star (base deploys one directly; the
// RoE build-queue Death Star is skipped) and must keep expansion units buildable.
// Run: node scripts/test-base-setup-units-variant-519.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const empUnits = (G) => { const m = {}; for (const ss of Object.values(G.map.systems)) for (const u of ss.units) if (u.side === 'Empire') m[u.typeId] = (m[u.typeId] || 0) + 1; return m; };

console.log('[ #519 base-setup-units variant: base forces at setup, expansion units in-game ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, baseSetupUnits: true } });
  const u = empUnits(G);
  check('variant flag recorded', G.expansion.roeUnits === true && G.expansion.baseSetupUnits === true);
  check('NO Death Star Under Construction on the board (RoE-only)', !(u['death-star-under-construction'] > 0));
  check('one completed Death Star deployed (base list)', u['death-star'] === 1, `count=${u['death-star']}`);
  check('no queued Death Star (would be a second one)', !(G.empire.buildQueue?.[3] ?? []).includes('death-star'), JSON.stringify(G.empire.buildQueue?.[3]));
  check('no RoE-only starting units (tie-striker / assault-tank) on the board', !u['tie-striker'] && !u['assault-tank']);
  // The expansion roster is still available to BUILD during the game.
  check('expansion unit types remain in the catalog (buildable in-game)', !!G.catalog.unitTypes['rebel-vanguard'] && !!G.catalog.unitTypes['tie-striker']);
}

console.log('[ default RoE game is unchanged (no variant) ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  const u = empUnits(G);
  check('baseSetupUnits defaults to false', G.expansion.baseSetupUnits === false);
  check('DSUC on the board (normal RoE)', u['death-star-under-construction'] === 1);
  check('queued Death Star present (normal RoE)', (G.empire.buildQueue?.[3] ?? []).includes('death-star'));
}

console.log('[ base game (roeUnits off) unaffected — no queued Death Star ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: true, expansion: { enabled: false } });
  check('no queued Death Star in the base game', !(G.empire.buildQueue?.[3] ?? []).includes('death-star'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
