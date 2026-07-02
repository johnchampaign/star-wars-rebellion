// Three RAW rulings implemented 2026-07-01 (John verified against the rulebook):
//  #456 — retreat destinations follow RR p.5 for BOTH sides: adjacent, never into
//         opponent units; prefer own-units/loyalty if able, else any adjacent
//         EMPTY system; the opponent's-initiating-source ban binds the DEFENDER
//         only. (The old code locked the attacker to its single source system —
//         so a blocked source, or a mission-triggered combat with no source,
//         meant no retreat option at all.)
//  #452 — Seize Control's "you may then remove the marker" clause now applies on
//         scoring (auto-remove, RotJ-clause precedent).
//  #449 — cinematic MDTYR: "draw 3 tactic cards" = RETRIEVE up to 3 of your
//         choice from your cinematic discard back to your deck (RoE rulebook),
//         with a pick when more than 3 qualify; never retrieves eliminated cards.
// Run: node scripts/test-raw-calls-456-452-449.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { stepOnce, seedAI } = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

/** Drive the game with the AI until a RetreatDecision appears (or cap). */
function driveToRetreat(G, forSide = null, cap = 400) {
  for (let i = 0; i < cap; i++) {
    const pc = G.pendingChoice;
    if (pc?.kind === 'RetreatDecision' && (!forSide || pc.side === forSide)) return pc;
    if (pc?.kind === 'RetreatDecision') {
      // Not the side under test — decline (stay) and continue.
      const r = combat.resolveRetreatDecision(G, null, [], null);
      if (!r.ok) return null;
      continue;
    }
    if (G.isGameOver || !G.pendingCombat) return null;
    if (stepOnce(G, G.currentPlayer)) continue;
    const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
    if (!stepOnce(G, o)) return null;
  }
  return null;
}

console.log('\n[ #456 attacker CAN retreat vs a Death Star even with its source blocked ]');
{
  seedAI(21);
  const G = createGame(data, { seed: 21, autoSetupUnits: true });
  const SYS = 'mustafar';
  // Big healthy fleets both sides so round 1 can't wipe anyone.
  G.map.systems[SYS].units = [];
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', SYS);
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  M.deployUnit(G, 'Empire', 'death-star', SYS);
  for (let i = 0; i < 2; i++) M.deployUnit(G, 'Empire', 'star-destroyer', SYS);
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  // Rebel leader present (retreat needs one); attack "from" kessel — then BLOCK
  // kessel with Empire units (the old source-only rule → zero destinations).
  G.rebel.leadersOnBoard[SYS] = ['admiral-ackbar'];
  const SRC = 'kessel';
  M.deployUnit(G, 'Empire', 'tie-fighter', SRC);
  // Make one adjacent system Rebel-loyal so the preference tier has a target.
  const adj = (G.catalog.adjacency[SYS] ?? []).filter((s) => s !== SRC);
  const preferredSys = adj.find((s) => (G.map.systems[s]?.units.length ?? 0) === 0);
  if (preferredSys) G.map.systems[preferredSys].loyalty = 'rebel';
  combat.beginCombat(G, 'Rebel', SRC, SYS);
  const pc = driveToRetreat(G, 'Rebel');
  check('Rebel (attacker) IS offered a retreat decision', !!pc, `pc=${G.pendingChoice?.kind}`);
  if (pc) {
    check('destinations are NOT the blocked source', !pc.legalDestinations.includes(SRC), JSON.stringify(pc.legalDestinations));
    check('destinations exist (old code returned none)', pc.legalDestinations.length > 0);
    if (preferredSys) {
      check('preference tier: the Rebel-loyal adjacent is offered',
        pc.legalDestinations.includes(preferredSys), JSON.stringify(pc.legalDestinations));
      check('preference tier: only own-units/loyalty systems offered (RR "must ... if able")',
        pc.legalDestinations.every((sid) =>
          G.map.systems[sid].loyalty === 'rebel' || G.map.systems[sid].units.some((u) => u.side === 'Rebel')),
        JSON.stringify(pc.legalDestinations));
    }
  }
}

console.log('\n[ #456 the Empire with a Death Star in the combat is NEVER offered retreat ]');
{
  seedAI(22);
  const G = createGame(data, { seed: 22, autoSetupUnits: true });
  const SYS = 'mustafar';
  G.map.systems[SYS].units = [];
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', SYS);
  M.deployUnit(G, 'Empire', 'death-star', SYS);
  for (let i = 0; i < 2; i++) M.deployUnit(G, 'Empire', 'star-destroyer', SYS);
  G.rebel.leadersOnBoard[SYS] = [];
  G.empire.leadersOnBoard[SYS] = ['general-tagge']; // Empire leader — would enable retreat if legal
  combat.beginCombat(G, 'Rebel', 'kessel', SYS);
  const pc = driveToRetreat(G, 'Empire', 300);
  check('no RetreatDecision for the Empire (DS in combat, RR p.6)', !pc, pc && JSON.stringify(pc));
}

console.log('\n[ #452 scoring Seize Control removes the sabotage marker ]');
{
  seedAI(23);
  const G = createGame(data, { seed: 23, expansion: { enabled: true, roeUnits: true, roeMissions: true }, autoSetupUnits: true });
  const SYS = 'rodia';
  G.map.systems[SYS].units = [];
  G.map.systems[SYS].sabotage = true;
  // Overwhelming Rebel ground vs 1 stormtrooper — Rebel wins the ground battle.
  for (let i = 0; i < 4; i++) M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  M.deployUnit(G, 'Rebel', 'airspeeder', SYS);
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  G.rebel.leadersOnBoard[SYS] = ['general-madine'];
  G.rebel.objectiveHand = ['seize-control-2'];
  combat.beginCombat(G, 'Rebel', 'kessel', SYS);
  let guard = 0;
  while (G.pendingCombat && !G.isGameOver && guard++ < 600) {
    if (stepOnce(G, G.currentPlayer)) continue;
    const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
    if (!stepOnce(G, o)) break;
  }
  const scored = (G.rebel.scoredObjectives ?? []).some((s) => s.objectiveId === 'seize-control-2');
  check('Seize Control scored on the win', scored, JSON.stringify(G.rebel.scoredObjectives));
  if (scored) check('the sabotage marker was removed (#452/#414)', G.map.systems[SYS].sabotage === false);
}

console.log('\n[ #449 cinematic MDTYR retrieves from the DISCARD (player choice, no eliminated) ]');
{
  const G = createGame(data, { seed: 24, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true }, autoSetupUnits: true });
  const SYS = 'mustafar';
  G.map.systems[SYS].units = [];
  M.deployUnit(G, 'Rebel', 'x-wing', SYS);
  M.deployUnit(G, 'Empire', 'tie-fighter', SYS);
  combat.beginCombat(G, 'Rebel', 'kessel', SYS);
  const c = G.pendingCombat;
  check('cinematic combat begun', !!c && !!c.cinematic, `cin=${c?.cinematic}`);
  // ---- ≤3 in the pool: auto-retrieve ----
  G.empire.cinematicTacticDiscard = ['cin-empire-space-swarm-tactics', 'cin-empire-space-tractor-beam'];
  G.empire.cinematicTacticEliminated = [];
  c.startOfCombatBatch = { side: 'Empire', remaining: [] };
  G.pendingChoice = { kind: 'MoreDangerousTheaterPick', side: 'Empire', cardId: 'more-dangerous-than-you-realize' };
  let r = combat.resolveMoreDangerousTheaterPick(G, 'space');
  check('auto-retrieve resolves ok (pool ≤ 3)', r.ok, r.reason);
  check('both space cards left the discard (returned to deck)',
    !G.empire.cinematicTacticDiscard.some((x) => x.startsWith('cin-empire-space')),
    JSON.stringify(G.empire.cinematicTacticDiscard));
  // ---- >3 in the pool: pick which 3; eliminated cards excluded ----
  G.empire.cinematicTacticDiscard = [
    'cin-empire-ground-support-of-the-501st', 'cin-empire-ground-armored-patrol',
    'cin-empire-ground-overrun', 'cin-empire-ground-target-the-generator',
    'cin-empire-ground-air-superiority',
  ];
  G.empire.cinematicTacticEliminated = ['cin-empire-ground-air-superiority'];
  c.startOfCombatBatch = { side: 'Empire', remaining: [] };
  G.pendingChoice = { kind: 'MoreDangerousTheaterPick', side: 'Empire', cardId: 'more-dangerous-than-you-realize' };
  r = combat.resolveMoreDangerousTheaterPick(G, 'ground');
  check('with 4 retrievable a pick is posted', r.ok && G.pendingChoice?.kind === 'MoreDangerousRetrievePick', G.pendingChoice?.kind);
  const pick = G.pendingChoice;
  check('eliminated card is NOT a candidate', !pick.candidates.includes('cin-empire-ground-air-superiority'), JSON.stringify(pick.candidates));
  check('exactly 3 must be picked', pick.count === 3);
  const chosen = pick.candidates.slice(0, 3);
  r = combat.resolveMoreDangerousRetrievePick(G, chosen);
  check('retrieval pick resolves ok', r.ok, r.reason);
  check('the 3 chosen cards left the discard', chosen.every((x) => !G.empire.cinematicTacticDiscard.includes(x)),
    JSON.stringify(G.empire.cinematicTacticDiscard));
  check('the unchosen (and eliminated) cards remain in the discard',
    G.empire.cinematicTacticDiscard.length === 2, JSON.stringify(G.empire.cinematicTacticDiscard));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
