// Player report #737 — "Played Rogue One rebellion tactic card to rescue a
// leader (Wedge Antilles), and had a u-wing so it should have rescued the
// leader upon a retreat. But he is still stuck on Bothawui even after
// retreating to nal hutta."
//
// ROGUE ONE (RoE cinematic, Rebel ground): "If 1 or more units retreat this
// round, rescue 1 captured leader OR remove 1 target marker from this system."
//
// The trigger is queued on `cinematicEndOfRound` and resolved by
// resolveCinematicRetreatTriggers, which runCombat calls right after the
// retreat step. That call was UNREACHABLE in the one case the card is for: the
// retreat step's own "combat is effectively over" guard (no shared theater has
// both sides any more) sets step=Ended and BREAKS out of the round loop before
// the trigger line is reached. A retreat that succeeds normally empties the
// system — so the card fired only when the retreat left units behind, and
// never in the reporter's situation.
//
// The reporter's log is exactly that order, with no rogue-one line of any kind
// between them (not even the "no retreat happened" / "nothing to rescue" ones):
//   combat-retreat bothawui -> nal-hutta, units 6
//   combat-end     bothawui, winner Empire
//
// Fix: run resolveCinematicRetreatTriggers inside that guard, before the exit.
//
// Run: node scripts/test-rogue-one-retreat-737.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const combat = await import('../src/engine/combat.ts');
const cin = await import('../src/engine/cinematicTactics.ts');
const M = await import('../src/engine/mechanics.ts');
const handlers = await import('../src/engine/handlers/index.ts');
handlers.registerAll();

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const CARD = 'cin-rebel-ground-rogue-one';

/** A Rebel force under Imperial attack, cinematic combat on, Wedge captured,
 *  and one legal system to run to. `leaveBehind` decides whether the retreat
 *  empties the system (the reported case) or leaves a straggler (the case that
 *  already worked). */
function setup({ leaveBehind }) {
  const G = createGame(data, { seed: 11 });
  G.expansion = { ...(G.expansion ?? {}), enabled: true, cinematicCombat: true };
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  const [target, [, escape]] = Object.entries(G.catalog.adjacency)
    .find(([sid, adj]) => (adj?.length ?? 0) >= 2 && G.map.systems[sid]) ?? [];
  G.map.systems[escape].loyalty = 'rebel';

  // Rebel: a U-Wing (the card's unit) to fly out with, plus a trooper. In the
  // "leaveBehind" variant a second trooper exceeds transport capacity and stays.
  M.deployUnit(G, 'Rebel', 'u-wing', target);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', target);
  if (leaveBehind) M.deployUnit(G, 'Rebel', 'rebel-trooper', target);
  G.rebel.leadersOnBoard[target] = ['saw-gerrera'];
  // Empire holds the ground so the fight is real, plus a leader of its own.
  M.deployUnit(G, 'Empire', 'stormtrooper', target);
  M.deployUnit(G, 'Empire', 'stormtrooper', target);
  G.empire.leadersOnBoard[target] = ['darth-vader'];
  // Wedge is in the Imperial dungeon — the thing the card should get back.
  G.empire.capturedLeaders = [{ leaderId: 'wedge-antilles', ring: 'captured' }];
  G.rebel.leaderPool = (G.rebel.leaderPool ?? []).filter((l) => l !== 'wedge-antilles');
  return { G, target, escape };
}

/** Open the combat and step it into round 1, declining any "add a leader"
 *  prompt. It parks on whatever tactic prompt comes first; the tests take over
 *  from there and drive the retreat directly, so that prompt is cleared. */
function beginPastLeaderPicks(G, target) {
  combat.beginCombat(G, 'Empire', [target], target);
  combat.runCombat(G);
  let guard = 0;
  while (G.pendingChoice?.kind === 'CombatAddLeaderPick' && guard++ < 10) {
    combat.resolveCombatAddLeaderPick(G, null);
  }
  G.pendingChoice = undefined;
}

/** Begin the combat, queue Rogue One the way playing the card does, then post
 *  and resolve the retreat decision — no dice needed. */
function retreatWithRogueOne(G, target, escape, { bringAll = true } = {}) {
  beginPastLeaderPicks(G, target);
  const c = G.pendingCombat;
  if (!c) throw new Error('combat did not begin');
  cin.applyCinematicAbility(G, c, 'Rebel', 'ground', CARD, true);
  const here = G.map.systems[target].units.filter((u) => u.side === 'Rebel');
  const chosen = bringAll
    ? here.map((u) => u.instanceId)
    : here.filter((u) => u.typeId !== 'rebel-trooper' || here.indexOf(u) === 1).map((u) => u.instanceId);
  G.pendingChoice = {
    kind: 'RetreatDecision', side: 'Rebel', systemId: target,
    legalDestinations: [escape],
    availableUnits: here.map((u) => u.instanceId),
    leadersInSystem: ['saw-gerrera'],
  };
  return combat.resolveRetreatDecision(G, escape, chosen, 'saw-gerrera');
}

console.log('\n[ playing the card queues the post-retreat trigger ]');
{
  const { G, target } = setup({ leaveBehind: false });
  beginPastLeaderPicks(G, target);
  const c = G.pendingCombat;
  cin.applyCinematicAbility(G, c, 'Rebel', 'ground', CARD, true);
  check('Rogue One queues a rogueOne end-of-round entry',
    (c.cinematicEndOfRound ?? []).some((e) => e.kind === 'rogueOne' && e.side === 'Rebel'),
    JSON.stringify(c.cinematicEndOfRound));
}

console.log('\n[ #737 — the retreat that ENDS the combat still fires Rogue One ]');
{
  const { G, target, escape } = setup({ leaveBehind: false });
  const r = retreatWithRogueOne(G, target, escape);
  check('retreat succeeds', r.ok, r.reason);
  check('the system really was emptied of Rebels (the reported shape)',
    G.map.systems[target].units.filter((u) => u.side === 'Rebel').length === 0);
  check('a Rogue One choice is posted instead of the combat just ending',
    G.pendingChoice?.kind === 'RogueOneChoice',
    `pendingChoice=${JSON.stringify(G.pendingChoice?.kind)} step=${G.pendingCombat?.step}`);
  check('...and Wedge is offered as the rescue',
    (G.pendingChoice?.rescuable ?? []).includes('wedge-antilles'),
    JSON.stringify(G.pendingChoice?.rescuable));

  // Take the rescue and confirm it lands.
  const rr = combat.resolveRogueOneChoice(G, 'rescue:wedge-antilles');
  check('resolving the rescue succeeds', rr.ok, rr.reason);
  check('Wedge is no longer captured',
    !(G.empire.capturedLeaders ?? []).some((cl) => cl.leaderId === 'wedge-antilles'),
    JSON.stringify(G.empire.capturedLeaders));
  check('the combat then ends normally (no re-fire, no hang)',
    G.pendingChoice === undefined && !G.pendingCombat,
    `pendingChoice=${JSON.stringify(G.pendingChoice?.kind)} combat=${!!G.pendingCombat}`);
  check('the rescue was logged',
    G.turnLog.some((e) => e.kind === 'cinematic-rogue-one-rescue'));
}

console.log('\n[ the trigger fires exactly once, not once per queue pass ]');
{
  const { G, target, escape } = setup({ leaveBehind: false });
  retreatWithRogueOne(G, target, escape);
  combat.resolveRogueOneChoice(G, 'rescue:wedge-antilles');
  check('one rescue log entry, not several',
    G.turnLog.filter((e) => e.kind === 'cinematic-rogue-one-rescue').length === 1,
    String(G.turnLog.filter((e) => e.kind === 'cinematic-rogue-one-rescue').length));
}

console.log('\n[ no Rogue One played: the retreat ends the combat as before ]');
{
  const { G, target, escape } = setup({ leaveBehind: false });
  beginPastLeaderPicks(G, target);
  const here = G.map.systems[target].units.filter((u) => u.side === 'Rebel');
  G.pendingChoice = {
    kind: 'RetreatDecision', side: 'Rebel', systemId: target,
    legalDestinations: [escape],
    availableUnits: here.map((u) => u.instanceId),
    leadersInSystem: ['saw-gerrera'],
  };
  const r = combat.resolveRetreatDecision(G, escape, here.map((u) => u.instanceId), 'saw-gerrera');
  check('retreat succeeds', r.ok, r.reason);
  check('no stray Rogue One prompt appears',
    G.pendingChoice === undefined, JSON.stringify(G.pendingChoice?.kind));
  check('combat ended', !G.pendingCombat);
}

console.log(`\n${fail ? 'FAIL' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
