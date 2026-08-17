// "It still never uses the shield bunker to try and protect the death star."
//   — jocke01, BGG
//
// He was right, and the numbers were stark. With the behaviour off, across 300
// games the Empire deployed 288 Shield Bunkers and only 22 of them (7.6%) ever
// reached a system containing a Death Star — the one place the unit does
// anything. Meanwhile the Rebel destroyed 21 Death Stars with the Death Star
// Plans objective and the Empire blocked exactly ZERO of them.
//
// A Shield Bunker's headline job is that immunity: while one is in the system,
// a Death Star / DSUC cannot be destroyed by Death Star Plans (RoE p.8, and
// finalizeDsPlans enforces it). Anywhere else on the map it is an immobile
// structure with no attack doing nothing at all.
//
// WHY THIS WAS OFF, WHY IT WAS BRIEFLY ON, AND WHY IT IS OFF AGAIN. (Read
// with the SWR_BUNKERS row in docs/ab-levers.md — the strong-opponent re-test
// on 2026-08-16 found the placement rule fires too rarely to matter and blocked
// zero Plans rolls in 120 games; the lever is opt-in and this test guards it.) The 2026-08-06 A/B rejected it at
// −2.5pp, but recorded WHY the verdict was untrustworthy: the Rebel of that era
// "enters the Death Star's system in 3.3% of games and has never destroyed a
// DSUC", so the protection had nothing to protect against, and the entry asked
// for a re-test against a stronger opponent. That re-test is now done. The
// modern bench sees the Rebel destroy 21 Death Stars and 5 DSUCs, and with the
// behaviour on: bunkers reaching the station 22 → 111, Plans attempts blocked
// 0 → 11, Death Stars lost 21 → 17, win rate −2.5pp → +2.0pp (still noise, but
// the sign flipped as predicted).
//
// This test pins the PLACEMENT rule, which is the part that was broken. It does
// not assert a win rate — see docs/ab-levers.md for why that instrument cannot
// resolve this one.
//
// Run: node scripts/test-shield-bunker-guards-death-star.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The lever is OFF by default again (see the header history and
// docs/ab-levers.md, SWR_BUNKERS). This test pins the PLACEMENT rule for the
// opt-in path, so it sets the env itself before the AI module loads.
process.env.SWR_BUNKERS = '1';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');
const combat = await import('../src/engine/combat.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** A board with the Death Star parked somewhere, several Imperial systems that
 *  would otherwise be attractive deploy targets, and a pending Shield Bunker. */
function board(seed, dsType = 'death-star') {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  // Pick systems from the board rather than naming them: a hardcoded name can
  // land on the hidden Rebel base, where an Imperial deploy is refused and the
  // fixture silently places nothing.
  const usable = Object.keys(G.map.systems).filter((s) =>
    G.catalog.systems[s]?.isRemote !== true && s !== G.rebelBaseSystemId);
  const dsSystem = usable[0];
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  // The Empire may only deploy into systems it owns (Imperial loyalty or
  // subjugated) and never into a remote it did not claim at setup. A fixture
  // that skips this silently deploys NOTHING and reads as a placement failure.
  const others = usable.filter((s) => s !== dsSystem).slice(0, 4);
  for (const s of [dsSystem, ...others]) {
    G.map.systems[s].loyalty = 'imperial';
    G.map.systems[s].subjugated = false;
  }
  // Place the station DIRECTLY rather than via deployUnit: both stations are
  // unique units already consumed by autoSetupUnits, so the supply is empty and
  // deployUnit is a silent no-op — which left the board with no station at all
  // and made this read as a placement bug rather than a fixture bug.
  G.map.systems[dsSystem].units.push({
    instanceId: `${dsType}-fixture`, typeId: dsType, side: 'Empire', damage: 0,
  });
  // Rival destinations: normal Imperial forces elsewhere, the sort of system
  // that won the bunker 92% of the time before this change.
  for (const s of others) {
    M.deployUnit(G, 'Empire', 'stormtrooper', s);
    M.deployUnit(G, 'Empire', 'assault-carrier', s);
  }
  return { G, others, dsSystem };
}

/** Where the AI sends a pending Shield Bunker. */
function bunkerGoesTo(G, candidates) {
  G.pendingChoice = { kind: 'DeployUnitPick', side: 'Empire', typeId: 'shield-bunker', candidates };
  ai.stepOnce(G, 'Empire');
  const at = Object.entries(G.map.systems).find(([, ss]) =>
    (ss.units ?? []).some((u) => u.side === 'Empire' && u.typeId === 'shield-bunker'));
  return at?.[0];
}

console.log('\n[ a Shield Bunker goes to the Death Star, not to a spare planet ]');
{
  const { G, others, dsSystem } = board(1);
  const dest = bunkerGoesTo(G, [dsSystem, ...others]);
  check('the bunker is deployed to the Death Star\'s system', dest === dsSystem,
    `went to ${dest}, wanted ${dsSystem}`);
}
{
  // Same for the under-construction station — it is equally a Plans target.
  // Must be a NON-REMOTE system: Empire deploys to remotes are gated on
  // empireDeployTarget (RoE p.4/p.8), so a remote destination is simply
  // rejected and nothing is placed — which is what a first draft of this test
  // did, reporting "went to undefined" and looking like a placement failure.
  const { G, others, dsSystem } = board(2, 'death-star-under-construction');
  const dest = bunkerGoesTo(G, [dsSystem, ...others]);
  check('and to the DSUC\'s system too', dest === dsSystem, `went to ${dest}, wanted ${dsSystem}`);
}
{
  // The Death Star should win even when it is NOT the first candidate offered.
  const { G, others, dsSystem } = board(3);
  const dest = bunkerGoesTo(G, [...others, dsSystem]);
  check('it wins even when listed last among candidates', dest === dsSystem,
    `went to ${dest}, wanted ${dsSystem}`);
}

console.log('\n[ with no station on the board it falls back to normal placement ]');
{
  const G = createGame(data, { seed: 4, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  const others = Object.keys(G.map.systems)
    .filter((s) => G.catalog.systems[s]?.isRemote !== true).slice(0, 4);
  for (const s of others) {
    G.map.systems[s].loyalty = 'imperial';
    M.deployUnit(G, 'Empire', 'stormtrooper', s);
  }
  const dest = bunkerGoesTo(G, others);
  check('a bunker is still placed somewhere legal', !!dest && others.includes(dest),
    `went to ${dest}`);
}

console.log('\n[ and the placement actually does its job ]');
{
  // End to end: the bunker at the station must make Death Star Plans bounce.
  const G = createGame(data, { seed: 5, expansion: { enabled: true, roeUnits: true } });
  G.map.systems['corellia'].units = [
    { instanceId: 'ds1', typeId: 'death-star', side: 'Empire', damage: 0 },
    { instanceId: 'sb1', typeId: 'shield-bunker', side: 'Empire', damage: 0 },
    { instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 },
  ];
  G.rebel.objectiveHand = ['death-star-plans-2'];
  G.rebel.actionHand = (G.rebel.actionHand ?? []).filter((c) => c !== 'one-in-a-million');
  G.yodaRerollUsedThisRound = true;
  let blocked = false, destroyed = false;
  for (let seed = 1; seed <= 200 && !blocked; seed++) {
    const g = createGame(data, { seed, expansion: { enabled: true, roeUnits: true } });
    g.map.systems['corellia'].units = JSON.parse(JSON.stringify(G.map.systems['corellia'].units));
    g.rebel.objectiveHand = ['death-star-plans-2'];
    g.rebel.actionHand = []; g.yodaRerollUsedThisRound = true;
    g.pendingChoice = {
      kind: 'DeathStarPlansAttempt', side: 'Rebel',
      objectiveId: 'death-star-plans-2', systemId: 'corellia', deathStarInstanceIds: ['ds1'],
    };
    const r = combat.resolveDeathStarPlansAttempt(g, true, 'ds1');
    if (!r.ok || g.dsPlansAttempt) continue;
    if ((g.turnLog ?? []).some((e) => e.kind === 'death-star-plans-blocked-by-shield-bunker')) {
      blocked = true;
      destroyed = !g.map.systems['corellia'].units.some((u) => u.typeId === 'death-star');
    }
  }
  check('a direct hit at a bunkered station is blocked', blocked, 'no blocked roll in 200 seeds');
  check('and the Death Star survives it', blocked && !destroyed);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
