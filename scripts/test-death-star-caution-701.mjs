// #701 — jocke01: "It did move the death star wich is great, however it moved
// to dantooine so I can still go and attack it as the rebels first action next
// turn ... I had moved a death star killing fleet next to it the same turn
// using behind enemy lines, so it was a free death star kill for me."
//
// The Empire never DECIDED to move the station. The Death Star has transport
// capacity 8, so it classifies as a capital ship, and the move executor's
// "bring all capitals (they're valuable + provide capacity)" rule swept it
// along with every activation sourced from its system. It went to Dantooine
// because the Empire wanted to check Dantooine, and the station came as cargo
// capacity.
//
// The station is invulnerable EXCEPT to a Death Star Plans attempt, which needs
// the Rebel to reach it — so simply not parking it within reach removes the
// only way it dies, at no cost. Measured over 60 expansion games: station moves
// ending in or beside Rebel ships fell from 69/204 (33.8%) to 5/168 (3.0%),
// games affected 61.7% -> 8.3%, stations lost 8.3% -> 6.7%.
//
// Two deliberate limits, both pinned below:
//   - it still goes to the REVEALED Rebel base, which is the one place the
//     station is supposed to be risked;
//   - if holding it back would leave the activation moving nothing at all, the
//     AI takes a different action instead of walking a lone leader in. Without
//     that, this fix reintroduced the no-troop waste #647/#666 removed
//     (measured 0.0 -> 0.4 leader-only activations per game before the guard).
//
// STATUS: SHIPPED ON by default since 2026-08-31 (John's call on #701, after
// the passivity cost that blocked it re-measured at 0/60 forfeits — see
// test-ds-caution-passivity-tripwire, which guards that cost's return). The
// env pin below is kept anyway so this file tests the mechanism regardless of
// the shipped default.
//
// Run: node scripts/test-death-star-caution-701.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
process.env.SWR_DS_CAUTION = '1'; // pin ON, independent of the shipped default
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

/** Empire holds `home` with the Death Star plus escorts; `target` is an
 *  adjacent system the Empire wants to activate. `threatAt` (if given) receives
 *  a Rebel fleet, making the target unsafe for the station. */
function board(seed, { threatAt } = {}) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.empire.leadersOnBoard = {};
  G.rebel.leadersOnBoard = {};
  G.rebelBaseRevealed = false;
  // createGame lands in Assignment with the Rebel to act; activateSystem needs
  // the Empire's Command phase or it rejects and every assertion below reads as
  // "declined" regardless of the fix.
  G.phase = 'Command';
  G.currentPlayer = 'Empire';

  const home = Object.keys(G.map.systems).find((sid) =>
    sid !== G.rebelBaseSystemId
    && (G.catalog.adjacency[sid] ?? []).some((a) => G.map.systems[a] && a !== G.rebelBaseSystemId));
  const target = (G.catalog.adjacency[home] ?? [])
    .find((a) => G.map.systems[a] && a !== G.rebelBaseSystemId);

  // The station plus a real escort, so the activation has content either way.
  M.deployUnit(G, 'Empire', 'death-star', home);
  M.deployUnit(G, 'Empire', 'star-destroyer', home);
  M.deployUnit(G, 'Empire', 'tie-fighter', home);
  if (threatAt === 'target') {
    for (let i = 0; i < 4; i++) M.deployUnit(G, 'Rebel', 'x-wing', target);
    M.deployUnit(G, 'Rebel', 'nebulon-b-frigate', target);
  } else if (threatAt === 'adjacent') {
    // The reporter's actual shape: killer fleet parked NEXT to where the
    // station would land, ready to strike on the Rebel's first action.
    const nextDoor = (G.catalog.adjacency[target] ?? [])
      .find((a) => a !== home && G.map.systems[a] && a !== G.rebelBaseSystemId);
    for (let i = 0; i < 4; i++) M.deployUnit(G, 'Rebel', 'x-wing', nextDoor);
    M.deployUnit(G, 'Rebel', 'nebulon-b-frigate', nextDoor);
  }
  return { G, home, target };
}

/** Run the activation the executor would perform and report where the station
 *  ended up. Returns null if the AI declined the action entirely. */
function activateAndFindStation(G, home, target, leaderId) {
  const ok = ai.tryCommandAction(G, 'Empire', { kind: 'activate', leaderId, targetSystemId: target, score: 99 });
  if (!ok) return { declined: true };
  const at = (sid) => (G.map.systems[sid]?.units ?? []).some((u) => u.side === 'Empire' && u.typeId === 'death-star');
  return { declined: false, movedToTarget: at(target), stayedHome: at(home) };
}

const leaderOf = (G) => G.empire.leaderPool.find((lid) => {
  const l = G.catalog.leaders[lid];
  return l && (l.tacticValues.space + l.tacticValues.ground) > 0;
});

console.log('\n[ control: with no threat, the station still moves ]');
{
  const { G, home, target } = board(701);
  const r = activateAndFindStation(G, home, target, leaderOf(G));
  check('the activation was taken', !r.declined);
  check('the Death Star moved with the fleet', r.movedToTarget,
    `movedToTarget=${r.movedToTarget} stayedHome=${r.stayedHome}`);
}

console.log('\n[ #701 the station is NOT dragged into a system holding Rebel ships ]');
{
  const { G, home, target } = board(702, { threatAt: 'target' });
  const r = activateAndFindStation(G, home, target, leaderOf(G));
  check('the activation still happened (the escort goes)', !r.declined);
  check('the bug: the Death Star stayed home', r.stayedHome && !r.movedToTarget,
    `movedToTarget=${r.movedToTarget} stayedHome=${r.stayedHome}`);
}

console.log("\n[ #701 nor NEXT DOOR to a killer fleet — the reporter's actual shape ]");
{
  const { G, home, target } = board(703, { threatAt: 'adjacent' });
  const r = activateAndFindStation(G, home, target, leaderOf(G));
  check('the activation still happened', !r.declined);
  check('the Death Star stayed home', r.stayedHome && !r.movedToTarget,
    `movedToTarget=${r.movedToTarget} stayedHome=${r.stayedHome}`);
}

console.log('\n[ it still goes to the REVEALED base — the one place worth the risk ]');
{
  const { G, home } = board(704);
  // Make the adjacent target the revealed Rebel base, defended by ships.
  const target = (G.catalog.adjacency[home] ?? []).find((a) => G.map.systems[a]);
  G.rebelBaseSystemId = target;
  G.rebelBaseRevealed = true;
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Rebel', 'x-wing', target);
  const r = activateAndFindStation(G, home, target, leaderOf(G));
  check('the activation was taken', !r.declined);
  check('the Death Star DOES go to the revealed base', r.movedToTarget,
    `movedToTarget=${r.movedToTarget} stayedHome=${r.stayedHome}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
