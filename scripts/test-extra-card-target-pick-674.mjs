// #674 — a card played as the SECOND card off a "you may play an extra card"
// effect must get the same interactive target pick a normal play gets.
//
// THE BUG: resolveCinematicTacticSelect's extra-play branch called
// applyCinematicAbility directly, bypassing the target/destroy/gain pick that
// runTheater posts for a base play. So "deal N damage" played as an extra card
// silently auto-assigned its damage to the cheapest-to-kill enemy unit — the
// reporter played Ion Blast and watched 1 damage land on a TIE Fighter with no
// prompt. RoE p.9: "If a player's card deals damage, he places a damage token
// on a unit of his choice."
//
// Run: node scripts/test-extra-card-target-pick-674.mjs
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
const { stepOnce } = await import('../src/play/randomAI.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const baseOpts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true },
});

// Restrict the Rebel space cinematic deck to the listed cards.
function onlyRebelSpaceCards(G, keep) {
  G.rebel.cinematicTacticDiscard = Object.values(G.catalog.tactics)
    .filter((t) => t.cinematic && t.side === 'Rebel' && t.theater === 'space'
      && !keep.includes(t.id))
    .map((t) => t.id);
}

// Drive the combat until `want(pendingChoice)` is true, answering the Rebel's
// tactic selections from `plays` (in order) and letting the AI take everything
// else. Returns the pendingChoice that matched, or null.
function driveTo(G, plays, want, guardMax = 400) {
  const queue = [...plays];
  let guard = 0;
  while (G.pendingCombat && G.pendingChoice && guard++ < guardMax) {
    const pc = G.pendingChoice;
    if (want(pc)) return pc;
    if (pc.kind === 'CinematicTacticSelect' && pc.side === 'Rebel' && queue.length > 0) {
      const next = queue.shift();
      const r = combat.resolveCinematicTacticSelect(G, next.cardId, next.useTop);
      if (!r.ok) { check(`play ${next.cardId} accepted`, false, r.reason); return null; }
      continue;
    }
    if (!stepOnce(G, pc.side)) return null;
  }
  return null;
}

console.log('\n[ #674 an EXTRA card that deals damage posts a target pick ]');
{
  const G = createGame(data, baseOpts(4210));
  // Fleet Logistics grants the extra play; Bombing Run is the extra card.
  onlyRebelSpaceCards(G, ['cin-rebel-space-fleet-logistics', 'cin-rebel-space-bombing-run']);
  G.map.systems['felucia'].units = [];
  // Two red-health Star Destroyers → a real choice of target.
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia'); // Fleet Logistics primary unit
  M.deployUnit(G, 'Rebel', 'y-wing', 'felucia');           // Bombing Run primary unit
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);

  const pick = driveTo(
    G,
    [
      { cardId: 'cin-rebel-space-fleet-logistics', useTop: true }, // base: prevent + extra
      { cardId: 'cin-rebel-space-bombing-run', useTop: true },     // EXTRA: deal 2 red
    ],
    (pc) => pc.kind === 'CinematicTargetPick' && pc.side === 'Rebel',
  );

  check('the extra card posted a target pick instead of auto-assigning', !!pick,
    'no CinematicTargetPick was ever posted');
  if (pick) {
    check('both Star Destroyers offered', pick.candidates.length === 2,
      `got ${pick.candidates.length}`);
    check("Bombing Run's primary deals 2", pick.amount === 2, `amount=${pick.amount}`);
    const chosen = pick.candidates[1];
    const r = combat.resolveCinematicTargetPick(G, chosen);
    check('resolve ok', r.ok, r.reason);
    const dmgOf = (id) => G.map.systems['felucia'].units
      .find((x) => x.instanceId === id)?.damage ?? 0;
    check('the damage landed on the ship the player chose', dmgOf(chosen) >= 1,
      `dmg=${dmgOf(chosen)}`);
  }
}

console.log('\n[ #674 the reported case: Ion Blast as an extra card ]');
{
  const G = createGame(data, baseOpts(4211));
  onlyRebelSpaceCards(G, ['cin-rebel-space-fleet-logistics', 'cin-rebel-space-ion-blast']);
  G.map.systems['felucia'].units = [];
  // A Star Destroyer plus TIE Fighters: the auto-picker's "cheapest to kill"
  // rule would dump the damage on a TIE without asking. No Ion Cannon present,
  // so Ion Blast's primary is unusable and the SECONDARY ("Deal 1 damage") is
  // what the player has — exactly the reported situation.
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Empire', 'tie-fighter', 'felucia');
  M.deployUnit(G, 'Empire', 'tie-fighter', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia'); // Fleet Logistics primary unit
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);

  const pick = driveTo(
    G,
    [
      { cardId: 'cin-rebel-space-fleet-logistics', useTop: true },
      { cardId: 'cin-rebel-space-ion-blast', useTop: false }, // EXTRA: "Deal 1 damage"
    ],
    (pc) => pc.kind === 'CinematicTargetPick' && pc.side === 'Rebel',
  );

  check('Ion Blast played as an extra card asks who takes the hit', !!pick,
    'damage was auto-assigned with no prompt');
  if (pick) {
    check('all 3 enemy ships offered, not just the cheapest',
      pick.candidates.length === 3, `got ${pick.candidates.length}`);
    // The player can put it on the Star Destroyer — the whole point of the fix.
    const sd = G.map.systems['felucia'].units
      .find((u) => u.side === 'Empire' && u.typeId === 'star-destroyer');
    check('the Star Destroyer is a legal target',
      !!sd && pick.candidates.includes(sd.instanceId));
    if (sd) {
      const r = combat.resolveCinematicTargetPick(G, sd.instanceId);
      check('resolve ok', r.ok, r.reason);
      const dmg = G.map.systems['felucia'].units
        .find((x) => x.instanceId === sd.instanceId)?.damage ?? 0;
      check('the Star Destroyer took the damage', dmg >= 1, `dmg=${dmg}`);
    }
  }
}

console.log('\n[ #674 a base play still posts its pick (no regression) ]');
{
  const G = createGame(data, baseOpts(4212));
  onlyRebelSpaceCards(G, ['cin-rebel-space-bombing-run']);
  G.map.systems['felucia'].units = [];
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Rebel', 'y-wing', 'felucia');
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);

  const pick = driveTo(
    G,
    [{ cardId: 'cin-rebel-space-bombing-run', useTop: true }],
    (pc) => pc.kind === 'CinematicTargetPick' && pc.side === 'Rebel',
  );
  check('base Bombing Run still prompts', !!pick);
  check('with both Star Destroyers offered', !!pick && pick.candidates.length === 2,
    pick ? `got ${pick.candidates.length}` : '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
