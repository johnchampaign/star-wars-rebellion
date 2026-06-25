// #391 — Overrun (cinematic Empire ground, "Deal 2 damage.") must let the player
// SPLIT the damage across different targets, not force all of it onto one unit.
// The plain-deal CinematicTargetPick now applies ONE point per pick and re-prompts.
// Run: node scripts/test-overrun-split-391.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const SYS = 'felucia';
function setup() {
  const G = createGame(data, { seed: 3, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true } });
  // Three Rebel ground units (1 health each) so the player has a real split choice.
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  const ids = G.map.systems[SYS].units.filter((u) => u.side === 'Rebel').map((u) => u.instanceId);
  // Build a minimal combat state mid-resolution, with an Overrun plain-deal pick pending.
  G.pendingCombat = {
    systemId: SYS, attackerSide: 'Empire', step: 'done', round: 1,
    attackerHand: [], defenderHand: [], retreated: [], cinematicTacticDoneThisRound: [],
    theaterStaged: [], flags: { cinematicTargetPick: { side: 'Empire', theater: 'ground', cardId: 'cin-empire-ground-overrun', useTop: true, amount: 2 } },
    report: { systemId: SYS, attackerSide: 'Empire', rounds: [], structureDestructions: [], retreatDestructions: [], winner: null, totalRounds: 0 },
  };
  G.pendingChoice = { kind: 'CinematicTargetPick', side: 'Empire', theater: 'ground', systemId: SYS, amount: 2, candidates: ids };
  return { G, ids };
}

console.log('\n[ #391 Overrun (deal 2) — player assigns 1 point, then is re-prompted to split the 2nd ]');
{
  const { G, ids } = setup();
  const dmg = (id) => G.map.systems[SYS].units.find((u) => u.instanceId === id)?.damage ?? -1;
  // Assign the first point to unit A.
  const r = combat.resolveCinematicTargetPick(G, ids[0]);
  check('first pick ok', r.ok, r.reason);
  check('unit A took 1 damage', dmg(ids[0]) === 1, `dmg=${dmg(ids[0])}`);
  check('units B and C are untouched so far', dmg(ids[1]) === 0 && dmg(ids[2]) === 0);
  check('a SECOND pick is offered (player may split)', G.pendingChoice?.kind === 'CinematicTargetPick');
  check('the second pick is for the remaining 1 point', G.pendingChoice?.amount === 1, JSON.stringify(G.pendingChoice?.amount));
  check('the doomed unit A is no longer a candidate', !(G.pendingChoice?.candidates ?? []).includes(ids[0]));
  check('B and C are still both choosable for the 2nd point (free split)',
    (G.pendingChoice?.candidates ?? []).includes(ids[1]) && (G.pendingChoice?.candidates ?? []).includes(ids[2]));
  // The split is proven: the 1st point landed exactly where directed (A, 1 dmg,
  // not the whole 2) and the player is now choosing the 2nd point's target
  // independently. The OLD behavior dumped all 2 onto one unit with no 2nd pick.
}

console.log('\n[ #391 control: dealing the 1st point applies exactly ONE, not the whole amount ]');
{
  const { G, ids } = setup();
  const dmg = (id) => G.map.systems[SYS].units.find((u) => u.instanceId === id)?.damage ?? -1;
  combat.resolveCinematicTargetPick(G, ids[0]);
  const totalDealt = ids.reduce((s, id) => s + Math.max(0, dmg(id)), 0);
  check('exactly 1 damage was applied on the first pick (the rest is still the player\'s to place)', totalDealt === 1, `total=${totalDealt}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
