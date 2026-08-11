// #710 — jocke01: "The empire activated first in the command phase. I did use
// to[wo] assignment cards, so it might have triggered a bug of some sort."
//
// RR p.6 is explicit: "The Rebel player takes the first turn during the Command
// Phase, followed by the Imperial player." His own log shows otherwise:
//
//   t3  phase {"phase":"Command"}
//   t3 Rebel choice-request {"kind":"RebelCellPlace"}
//   t3 Rebel target-marker-place {"systemId":"ryloth","source":"rebel-cell-2"}
//   t3 Empire place-leader {"leaderId":"emperor-palpatine",...}   <-- Empire acts
//
// Cause: enterCommandPhase flushes Immediate objectives before the first turn
// (a Rebel Planning played during Assignment draws one), and the placement's
// resolver resumed via advanceCommandTurn — which flips the current player. So
// resolving the marker handed the Empire the Rebel's first turn. Fixed with a
// distinct 'command-start' resume that chains further objectives and makes the
// Under the Radar offer, but does NOT advance the turn.
//
// WHY THIS NEEDS THE ACTION HANDS CLEARED, and why the first repro attempt
// wrongly reported "no bug": advanceCommandTurn returns EARLY when the current
// player holds Immediate action cards (flushImmediateActionCards). With cards
// in hand the turn never flips and the bug is invisible. The reporter's game
// had none pending. A fixture that forgets this passes against the broken code.
//
// Run: node scripts/test-command-first-turn-710.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

/** Enter the Command phase with `objectiveId` sitting in the Rebel's hand, as
 *  Rebel Planning would have left it after Assignment. */
function enterCommand(seed, objectiveId) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  G.rebel.objectiveHand = [objectiveId];
  // Rebel Cell needs a Rebel-loyalty system to mark; Raid Outposts needs remotes.
  G.map.systems[Object.keys(G.map.systems)[0]].loyalty = 'rebel';
  // See the header: Immediate action cards make advanceCommandTurn bail out
  // early, which hides the turn flip entirely.
  G.rebel.actionHand = [];
  G.empire.actionHand = [];
  G.phase = 'Assignment';
  phases.skipAssignment(G, 'Rebel');
  phases.skipAssignment(G, 'Empire');
  return G;
}

console.log('\n[ the setup really does reach Command with a placement pending ]');
{
  const G = enterCommand(710, 'rebel-cell-2');
  check('phase is Command', G.phase === 'Command', G.phase);
  check('a Rebel placement is pending', G.pendingChoice?.kind === 'RebelCellPlace',
    String(G.pendingChoice?.kind));
  check('and it is still the Rebel on turn', G.currentPlayer === 'Rebel', G.currentPlayer);
}

console.log('\n[ #710 resolving it must NOT hand the Empire the first turn ]');
for (const [objective, resolve] of [
  ['rebel-cell-2', (G) => phases.resolveRebelCellPlace(G, G.pendingChoice.legal[0])],
  ['raid-outposts-2', (G) => phases.resolveRaidOutpostsPlace(G,
    [G.pendingChoice.legal[0], G.pendingChoice.legal[1]])],
]) {
  const G = enterCommand(711, objective);
  if (!G.pendingChoice) { check(`${objective}: placement posted`, false, 'no pending choice'); continue; }
  const r = resolve(G);
  check(`${objective}: the placement resolved`, r.ok === true, JSON.stringify(r));
  check(`${objective}: the REBEL still has the first Command turn (RR p.6)`,
    G.currentPlayer === 'Rebel', `currentPlayer=${G.currentPlayer}`);
}

console.log('\n[ mid-phase advancing is untouched — that SHOULD flip the turn ]');
{
  // The fix must only affect the phase-start flush. A normal pass mid-phase
  // still hands over, or the Empire would never get a turn at all.
  const G = enterCommand(712, 'rebel-cell-2');
  if (G.pendingChoice) phases.resolveRebelCellPlace(G, G.pendingChoice.legal[0]);
  check('Rebel is on turn before passing', G.currentPlayer === 'Rebel', G.currentPlayer);
  const r = phases.pass(G, 'Rebel');
  check('the pass was accepted', r.ok === true, JSON.stringify(r));
  check('and the turn moved to the Empire', G.currentPlayer === 'Empire', G.currentPlayer);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
