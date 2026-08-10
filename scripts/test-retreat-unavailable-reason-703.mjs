// #703 — "I cannot retreat from the fight since the start although I would like
// to - I have not seen a card that forbids me to do that for 3 turns straight."
//
// The reporter played EMPIRE and was the DEFENDER at Alderaan after the Rebels
// resolved "Behind Enemy Lines" (move 5 units from the Rebel Base, ignoring
// adjacency, then resolve combat). Their log shows RetreatDecision offered to
// the Rebel every round and NEVER to the Empire.
//
// RR p.5 "RETREATING": "To retreat from combat, the player must take one of his
// leaders from the system and place it in an adjacent system." A garrison with
// no leader in the system therefore cannot retreat — the engine was RAW-correct,
// but said nothing, which is indistinguishable from a bug.
//
// This pins BOTH halves:
//   1. the engine still refuses the illegal retreats (no regression), and
//   2. it now records a plain-language reason for each refusal, so the combat
//      board can tell the player which rule is stopping them.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');

const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'),
  actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'),
  tactics: lj('tactics.json'), probes: lj('probes.json'),
};
const opts = { seed: 703, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true } };

let fail = 0;
const check = (n, c, extra = '') => {
  console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`));
  if (!c) fail++;
};

/** Empire defends Alderaan against a Rebel attack; `empireLeader` controls
 *  whether the Imperial garrison has a leader on the spot. Runs the combat up
 *  to the first pause and reports who (if anyone) was offered the retreat. */
function defendAlderaan({ empireLeader, empireUnits = ['star-destroyer'] }) {
  const G = createGame(data, opts);
  // Alderaan starts with an Imperial garrison from setup — clear it so each
  // case tests exactly the force composition it names.
  G.map.systems['alderaan'].units = [];
  delete G.empire.leadersOnBoard['alderaan'];
  for (const t of empireUnits) M.deployUnit(G, 'Empire', t, 'alderaan');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'alderaan');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'alderaan');
  G.rebel.leadersOnBoard['alderaan'] = ['general-rieekan'];
  if (empireLeader) G.empire.leadersOnBoard['alderaan'] = ['darth-vader'];

  combat.beginCombat(G, 'Rebel', 'coruscant', 'alderaan');
  const c = G.pendingCombat;
  // Jump straight to the retreat step of round 1.
  c.step = 'Round';
  c.activeTheater = undefined;
  c.roundTheatersDone = ['space', 'ground'];
  c.dsPlansOfferedThisRound = true;
  c.retreatStepDoneThisRound = false;
  c.retreatDecidedThisRound = [];
  combat.runCombat(G);

  // The attacker (Rebel) is offered first under cinematic combat. Decline for
  // them so we actually reach the Empire's slot — otherwise every assertion
  // about the Empire passes vacuously on the Rebel's pause.
  const offered = [];
  for (let guard = 0; guard < 4; guard++) {
    if (G.pendingChoice?.kind !== 'RetreatDecision') break;
    offered.push(G.pendingChoice.side);
    if (G.pendingChoice.side === 'Empire') break; // stop here; that's the case under test
    combat.resolveRetreatDecision(G, null, null);
  }
  return { G, c, offered, offeredTo: offered.includes('Empire') ? 'Empire' : null };
}

console.log('[ #703: the game explains why retreat is unavailable ]');

// --- the reporter's board: Imperial garrison, no leader ---------------------
{
  const { c, offeredTo } = defendAlderaan({ empireLeader: false });
  check('leaderless Empire garrison is still NOT offered retreat (RR p.5)',
    offeredTo !== 'Empire', `offeredTo=${offeredTo}`);
  const reason = c.retreatBlockedReason?.Empire;
  check('...and the engine now records WHY', !!reason, `reason=${reason}`);
  check('...naming the missing leader, not something generic',
    !!reason && /leader/i.test(reason), `reason=${reason}`);
  console.log(`      → "${reason}"`);
}

// --- same board, but the Empire has a leader present -----------------------
{
  const { c, offeredTo, offered } = defendAlderaan({ empireLeader: true });
  check('with a leader present the Empire IS offered the retreat',
    offeredTo === 'Empire', `offered=${JSON.stringify(offered)} reason=${c.retreatBlockedReason?.Empire}`);
  check('...and no blocked-reason is left stale on the combat',
    !c.retreatBlockedReason?.Empire, `reason=${c.retreatBlockedReason?.Empire}`);
}

// --- a leader, but nothing that can fly itself out (TIEs only) -------------
{
  const { c } = defendAlderaan({ empireLeader: true, empireUnits: ['tie-fighter', 'tie-fighter'] });
  const reason = c.retreatBlockedReason?.Empire;
  check('TIE-only garrison is blocked and says so',
    !!reason && /on their own|fly itself/i.test(reason), `reason=${reason}`);
  console.log(`      → "${reason}"`);
}

// --- Death Star in the battle (RR p.6) -------------------------------------
{
  const { c } = defendAlderaan({ empireLeader: true, empireUnits: ['star-destroyer', 'death-star'] });
  const reason = c.retreatBlockedReason?.Empire;
  check('Death Star present is blocked and names the Death Star',
    !!reason && /death star/i.test(reason), `reason=${reason}`);
  console.log(`      → "${reason}"`);
}

// --- the reason reaches the turn log so future reports carry it ------------
{
  const { G } = defendAlderaan({ empireLeader: false });
  const logged = (G.turnLog ?? []).filter((e) => e.kind === 'combat-retreat-unavailable');
  check('a combat-retreat-unavailable entry is written to the log',
    logged.length > 0, `entries=${logged.length}`);
  check('...carrying the side and the reason',
    logged.some((e) => e.side === 'Empire' && typeof e.payload?.reason === 'string'),
    JSON.stringify(logged[0] ?? null));
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #703 retreat-reason tests passed');
process.exit(fail ? 1 : 0);
