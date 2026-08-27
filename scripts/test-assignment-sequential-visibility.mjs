// @timeout 60000
// "I think the rule about 'assigning in secret' might be incorrect." — Daniel
// Zhou (@danithaca), BGG. He was right, and quoted the rule exactly.
//
// RR p.3, Assignment Phase:
//   "To assign a leader to a mission, the player takes a mission card from his
//    hand and places it FACEDOWN near his faction sheet. Then he chooses one or
//    two leaders from his leader pool and places them ON TOP of that card.
//    The Rebel player starts by assigning any of his leaders to missions. When
//    the Rebel player is finished, the Imperial player assigns any of his
//    leaders to missions."
//   "Mission cards are not revealed during the Assignment Phase."
//
// So assignment is SEQUENTIAL with PARTIAL concealment, not simultaneous and
// secret. The Imperial player assigns second and can therefore see which Rebel
// leaders are committed, how many sit on each card, and who is left in the
// pool — but not WHICH missions. Leaders are physical pieces in the open.
//
// The UI hid all of it behind "(assigning in secret)", above a comment reading
// "RAW: assignment is simultaneous and SECRET". That concealment was added for
// player report #87 — a REBEL player who said "I'm still deploying leaders to
// mission and I already see what the empire is doing". Under correct ordering
// that is impossible: the Rebel goes first and assignLeader is turn-gated. The
// actual defect was that unassignLeader was NOT turn-gated, so a Rebel who had
// already passed could keep undoing while the Empire assigned. #87 was a real
// bug about an ungated ACTION, mis-diagnosed as an information leak.
//
// This pins both halves: the ordering/gating, and the information model.
//
// Run: node scripts/test-assignment-sequential-visibility.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const board = () => createGame(data, { seed: 4242, autoSetupUnits: true });

console.log('\n[ ordering: the Rebel assigns first, and the Empire must wait (rr p.3) ]');
{
  const G = board();
  check('the phase opens on Assignment', G.phase === 'Assignment', G.phase);
  check('with the REBEL to act, never the Empire', G.currentPlayer === 'Rebel', G.currentPlayer);

  const em = G.empire.missionHand[0];
  const el = G.empire.leaderPool[0];
  const early = phases.assignLeader(G, 'Empire', em, [el]);
  check('the Empire cannot assign before the Rebel finishes',
    !early.ok && early.reason === 'not-your-turn', JSON.stringify(early));
}

console.log('\n[ #87: un-assigning is turn-gated too — the real defect ]');
{
  const G = board();
  const rm = G.rebel.missionHand[0];
  const rl = G.rebel.leaderPool[0];
  check('the Rebel can assign on its own turn', phases.assignLeader(G, 'Rebel', rm, [rl]).ok);

  // POSITIVE half: on your own turn the undo works. Without this the gate below
  // could pass simply because un-assigning never works at all.
  const ownTurn = phases.unassignLeader(G, 'Rebel', rm);
  check('and can UNDO it while still on its own turn', ownTurn.ok, JSON.stringify(ownTurn));

  // Re-assign, then pass, so the Empire is now the active player.
  phases.assignLeader(G, 'Rebel', rm, [rl]);
  check('passing hands the turn to the Empire',
    phases.skipAssignment(G, 'Rebel').ok && G.currentPlayer === 'Empire', G.currentPlayer);

  // NEGATIVE half: the same call, now out of turn, must be refused.
  const afterPass = phases.unassignLeader(G, 'Rebel', rm);
  check('but NOT after passing, while the Empire is assigning (#87)',
    !afterPass.ok && afterPass.reason === 'not-your-turn', JSON.stringify(afterPass));
  check('so a passed player cannot strand leaders it can no longer re-assign',
    G.rebel.leadersOnMissions.some((m) => m.missionId === rm));
}

console.log('\n[ information model: committed leaders are public, the mission is not ]');
{
  const G = board();
  const rm = G.rebel.missionHand[0];
  const rl = G.rebel.leaderPool[0];
  phases.assignLeader(G, 'Rebel', rm, [rl]);
  phases.skipAssignment(G, 'Rebel');

  const entry = G.rebel.leadersOnMissions.find((m) => m.missionId === rm);
  check('the Empire can see WHICH leaders the Rebel committed',
    !!entry && entry.leaderIds.includes(rl), JSON.stringify(entry));
  check('and how many leaders sit on that card', entry.leaderIds.length === 1);
  check('and that the leader left the public pool', !G.rebel.leaderPool.includes(rl));
  check('while the mission itself stays facedown (not revealed in Assignment)',
    G.phase === 'Assignment' && !(G.turnLog ?? []).some((e) => e.kind === 'reveal-mission'));
}

console.log('\n[ the UI no longer claims assignment is secret ]');
{
  const ui = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
  check('the "(assigning in secret)" placeholder is gone', !ui.includes('assigning in secret'));
  check('and the false "simultaneous and SECRET" premise with it',
    !ui.includes('assignment is simultaneous and SECRET'));
  check('opponent missions still render FACEDOWN, not by name',
    ui.includes('Facedown mission'));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
