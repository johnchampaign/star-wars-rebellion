// Cinematic combat dice rules:
//   (A) "Prevent N red/black/special" (RotE rulebook, "PREVENTING HITS") does
//       NOT reduce how many dice the opponent rolls. All dice are ROLLED; at
//       the Assign Damage step, up to N matching red/black HITS (or ★ specials)
//       are removed from the rolled dice. Reporters #401 (Escort) and #408
//       (Overwhelming Presence) caught the old code under-rolling instead.
//   (B) A genuine "roll N fewer dice" ability (According To My Design) DOES
//       reduce the roll, and per RoE p.9 that reduction applies BEFORE the
//       5-die cap (audit #9).
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

// ---------------------------------------------------------------------------
console.log('[ applyCinematicPrevent: removes matching HIT/★ results, not dice ]');
{
  const die = (color, face) => ({ color, face });
  // A roll: 2 red hits, 1 red blank, 1 black direct-hit, 1 black special, 1 red special.
  const dice = [
    die('red', 'hit'), die('red', 'hit'), die('red', 'blank'),
    die('black', 'direct-hit'), die('black', 'special'), die('red', 'special'),
  ];
  // Escort: prevent 1 red, 1 black, 1 special.
  const { kept, removed } = combat.applyCinematicPrevent(dice, { red: 1, black: 1, special: 1 });
  check('removed exactly 1 red hit', removed.red === 1, JSON.stringify(removed));
  check('removed exactly 1 black hit (the direct-hit)', removed.black === 1, JSON.stringify(removed));
  check('removed exactly 1 ★ special', removed.special === 1, JSON.stringify(removed));
  check('kept = 6 − 3 = 3 dice', kept.length === 3, `got ${kept.length}`);
  // The surviving dice should still contain a red hit, a red blank, and one ★.
  check('one red HIT survives (only 1 of 2 prevented)', kept.filter((d) => d.color === 'red' && d.face === 'hit').length === 1);
  check('the red blank is never removed', kept.some((d) => d.color === 'red' && d.face === 'blank'));
  check('one ★ survives (red ★, since black ★ taken)', kept.filter((d) => d.face === 'special').length === 1);
}

console.log('[ applyCinematicPrevent: cannot remove more hits than were rolled ]');
{
  const die = (color, face) => ({ color, face });
  // Only 1 red hit on the table, but "prevent 2 red" asked for 2.
  const dice = [die('red', 'hit'), die('red', 'blank'), die('red', 'blank')];
  const { kept, removed } = combat.applyCinematicPrevent(dice, { red: 2, black: 0, special: 0 });
  check('removes only the 1 red hit that exists', removed.red === 1, JSON.stringify(removed));
  check('the two red blanks survive', kept.length === 2 && kept.every((d) => d.face === 'blank'));
}

// ---------------------------------------------------------------------------
console.log('[ Prevent does NOT reduce the roll — all dice are rolled (#401/#408) ]');
{
  const G = createGame(data, baseOpts(950));
  // 2 Star Destroyers = 4 raw red (each 2 red), well under the 5-die cap.
  for (let i = 0; i < 2; i++) M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'space'; c.theaterStaged = []; c.theaterAttackersDone = [];
  // Opponent's tactic card prevents 2 red against the Empire this attack.
  c.cinematicPrevent = { Empire: { red: 2, black: 0, special: 0 } };
  combat.beginAttack(G, c, 'Empire', 'space');
  const redKept = (c.pendingAttack?.dice ?? []).filter((d) => d.color === 'red').length;
  // The prevent step ran during beginAttack (no leaders → reroll auto-resolves,
  // no wounded units → heal auto-resolves), removing red HITS and logging them.
  const ev = G.turnLog.filter((e) => e.kind === 'cinematic-prevent-applied').pop();
  const redRemoved = ev?.payload?.red ?? 0;
  // All 4 dice were rolled: survivors + removed-hits == the full roll of 4.
  // (The OLD under-rolling bug would roll only 4 − 2 = 2 red dice, so this sum
  //  would be 2, not 4.)
  check('all 4 red dice were rolled (kept + removed = 4)', redKept + redRemoved === 4, `kept=${redKept} removed=${redRemoved}`);
  check('removed at most the 2 prevented', redRemoved <= 2, `removed=${redRemoved}`);
}

// ---------------------------------------------------------------------------
console.log('[ #9: a genuine dice-reducer (According To My Design) reduces BEFORE the 5-cap ]');
{
  const G = createGame(data, baseOpts(951));
  // 3 Mon Cala Cruisers = 6 raw red (each 2 red). Rebel attacks; ATMD active.
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  combat.beginCombat(G, 'Rebel', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'space'; c.theaterStaged = []; c.theaterAttackersDone = [];
  c.round = 1;
  c.flags = { ...(c.flags ?? {}), accordingToMyDesignActive: true };
  combat.beginAttack(G, c, 'Rebel', 'space');
  const redDice = (c.pendingAttack?.dice ?? []).filter((d) => d.color === 'red').length;
  // reduce-before-cap: 6 − 1 = 5, cap 5 → 5 red dice ROLLED.
  // cap-then-reduce (the bug) would give min(6,5) − 1 = 4.
  check('rolls 5 red dice (6 raw − 1 ATMD = 5, cap does not cut further)', redDice === 5, `got ${redDice}`);
  check('does NOT under-roll to 4 (the cap-then-reduce bug)', redDice !== 4);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll dice-rule tests passed');
process.exit(fail ? 1 : 0);
