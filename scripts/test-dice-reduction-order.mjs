// Audit #9: an ability that reduces dice applies BEFORE the 5-die cap (RoE p.9).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
const baseOpts = (seed) => ({ seed, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo','corellia','kashyyyk'], forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'], expansion: { enabled: true, cinematicCombat: true } });
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };

console.log('[ #9: prevent reduces dice BEFORE the 5-die cap ]');
{
  const G = createGame(data, baseOpts(950));
  // 4 Star Destroyers = 8 raw red attack (each 2 red). Cap is 5.
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'space'; c.theaterStaged = []; c.theaterAttackersDone = [];
  // Opponent's tactic card prevented 2 red against the Empire this attack.
  c.cinematicPrevent = { Empire: { red: 2, black: 0, special: 0 } };
  combat.beginAttack(G, c, 'Empire', 'space');
  const redDice = (c.pendingAttack?.dice ?? []).filter((d) => d.color === 'red').length;
  // RAW (reduce-before-cap): 8 - 2 = 6, then cap 5 -> 5 red dice.
  // The old (cap-then-reduce) order would give min(5,8) - 2 = 3.
  check('rolls 5 red dice (8 raw − 2 prevent = 6, capped at 5)', redDice === 5, `got ${redDice}`);
  check('does NOT under-roll to 3 (the cap-then-reduce bug)', redDice !== 3);
}

console.log('[ #9: small fleet — prevent still applies normally ]');
{
  const G = createGame(data, baseOpts(951));
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia'); // 2 raw red
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'space'; c.theaterStaged = []; c.theaterAttackersDone = [];
  c.cinematicPrevent = { Empire: { red: 1, black: 0, special: 0 } };
  combat.beginAttack(G, c, 'Empire', 'space');
  const redDice = (c.pendingAttack?.dice ?? []).filter((d) => d.color === 'red').length;
  check('2 raw − 1 prevent = 1 red die (cap does not bind)', redDice === 1, `got ${redDice}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #9 dice-reduction-order tests passed');
process.exit(fail ? 1 : 0);
