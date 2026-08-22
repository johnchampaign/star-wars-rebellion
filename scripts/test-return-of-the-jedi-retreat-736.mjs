// Player report #736 — "here, i won the battle, but the objective with vader
// didn't give me 2 victory points."
//
// RETURN OF THE JEDI (stage 3, 2 reputation): "After you win a battle in Darth
// Vader's or Emperor Palpatine's system."
//
// The check read the LIVE board for Vader. But a beaten Imperial leader retreats
// WITH his units, and the retreat is applied before the combat-objective check
// runs — so the single most cinematic way to win this objective (rout Vader and
// watch him run) silently scored nothing. The reporter's log shows exactly that
// order: `leader-retreat darth-vader nal-hutta -> bothawui`, then `combat-end
// winner: Rebel`.
//
// Same fix shape as the Liberation subjugation snapshot (#53) and the
// per-theater win test (#423/#567): read an at-combat-START snapshot for a
// condition that winning itself erases.
//
// The elimination half of the card ("if Luke (Jedi) is in this system, eliminate
// 1 Imperial leader in this system") deliberately does NOT get the snapshot —
// a leader who left cannot be eliminated. Only the reputation scores.
//
// Run: node scripts/test-return-of-the-jedi-retreat-736.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const objectives = await import('../src/engine/objectives.ts');
const combat = await import('../src/engine/combat.ts');
const handlers = await import('../src/engine/handlers/index.ts');
handlers.registerAll();

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const SYS = 'nal-hutta';
const NEIGHBOUR = 'bothawui';
const OID = 'return-of-the-jedi-3';

/** Board state as it stands the instant the objective check runs: the Rebel is
 *  the sole occupant of a fought-in theater. `vaderEndsUp` says where Vader is
 *  by then — 'here' (wiped out, leader stranded) or 'fled' (retreated out). */
function afterRebelWin({ vaderEndsUp, snapshot }) {
  const G = createGame(data, { seed: 5 });
  G.map.systems[SYS].units = [];
  G.rebel.objectiveHand = [OID];
  // Rebel holds the ground theater alone — the Empire's troopers are gone.
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  // Vader: either still standing in the smoking crater, or already next door.
  G.empire.leadersOnBoard = {};
  G.empire.leadersOnBoard[vaderEndsUp === 'here' ? SYS : NEIGHBOUR] = ['darth-vader'];

  const report = {
    systemId: SYS, attackerSide: 'Empire',
    // The snapshot under test. `snapshot: false` models an OLD saved report
    // written before the field existed — those must still behave sanely.
    ...(snapshot ? { imperialLeadersAtStart: ['darth-vader'] } : {}),
    addedLeaders: [],
    drawnTactics: { side: 'Empire', spaceCount: 0, groundCount: 0 },
    rounds: [{ attacks: [{ side: 'Rebel', theater: 'ground', damageApplied: 2, destroyed: [] }] }],
    structureDestructions: [], retreatDestructions: [],
    winner: 'Rebel', totalRounds: 1,
  };
  return objectives.combatObjectivesTriggered(G, report);
}

console.log('\n[ #736 — winning the battle scores whether or not Vader runs ]');
{
  check('Vader stranded in the system: scores (this always worked)',
    afterRebelWin({ vaderEndsUp: 'here', snapshot: true }).includes(OID));
  check('Vader RETREATED out: still scores — the battle was fought in his system',
    afterRebelWin({ vaderEndsUp: 'fled', snapshot: true }).includes(OID));
  check('...and that is the case the reporter hit, which used to score nothing',
    afterRebelWin({ vaderEndsUp: 'fled', snapshot: true }).length === 1);
}

console.log('\n[ it does not fire where Vader was never involved ]');
{
  const G = createGame(data, { seed: 5 });
  G.map.systems[SYS].units = [];
  G.rebel.objectiveHand = [OID];
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  G.empire.leadersOnBoard = { [NEIGHBOUR]: ['grand-moff-tarkin'] };
  const report = {
    systemId: SYS, attackerSide: 'Empire',
    imperialLeadersAtStart: ['grand-moff-tarkin'],
    addedLeaders: [],
    drawnTactics: { side: 'Empire', spaceCount: 0, groundCount: 0 },
    rounds: [{ attacks: [{ side: 'Rebel', theater: 'ground', damageApplied: 2, destroyed: [] }] }],
    structureDestructions: [], retreatDestructions: [],
    winner: 'Rebel', totalRounds: 1,
  };
  check('a win over Tarkin scores nothing',
    !objectives.combatObjectivesTriggered(G, report).includes(OID));
}

console.log('\n[ back-compat: a report saved before the snapshot field existed ]');
{
  // Old reports have no imperialLeadersAtStart. They must not crash, and they
  // must still score when Vader is on the board where he always was.
  check('no snapshot + Vader still present: scores',
    afterRebelWin({ vaderEndsUp: 'here', snapshot: false }).includes(OID));
  check('no snapshot + Vader gone: does not score (nothing to read — no crash)',
    !afterRebelWin({ vaderEndsUp: 'fled', snapshot: false }).includes(OID));
}

console.log('\n[ a leader ADDED to the combat counts too ]');
{
  // Vader can join a combat already in progress via the "add a leader" step, so
  // he is not in the at-start snapshot. He still makes it his system.
  const G = createGame(data, { seed: 5 });
  G.map.systems[SYS].units = [];
  G.rebel.objectiveHand = [OID];
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  G.empire.leadersOnBoard = { [NEIGHBOUR]: ['darth-vader'] };
  const report = {
    systemId: SYS, attackerSide: 'Empire',
    imperialLeadersAtStart: [],
    addedLeaders: [{ side: 'Empire', leaderId: 'darth-vader', tacticValue: 3 }],
    drawnTactics: { side: 'Empire', spaceCount: 0, groundCount: 0 },
    rounds: [{ attacks: [{ side: 'Rebel', theater: 'ground', damageApplied: 2, destroyed: [] }] }],
    structureDestructions: [], retreatDestructions: [],
    winner: 'Rebel', totalRounds: 1,
  };
  check('Vader added as the combat leader, then routed: scores',
    objectives.combatObjectivesTriggered(G, report).includes(OID));
}

console.log('\n[ beginCombat actually writes the snapshot ]');
{
  // Guard against the fix being half-wired: the objective logic can be perfect
  // and still never fire if nothing populates the field.
  const G = createGame(data, { seed: 5 });
  G.map.systems[SYS].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  G.empire.leadersOnBoard = { [SYS]: ['darth-vader'] };
  combat.beginCombat(G, 'Empire', NEIGHBOUR, SYS);
  const snap = G.pendingCombat?.report?.imperialLeadersAtStart;
  check('beginCombat records the Imperial leaders present',
    Array.isArray(snap) && snap.includes('darth-vader'), JSON.stringify(snap));
}

console.log(`\n${fail ? 'FAIL' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
