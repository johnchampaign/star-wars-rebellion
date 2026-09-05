// @timeout 120000
// SWR_POSTREVEAL_HEURISTIC — once the Rebel base is revealed, the Empire's
// Command decisions go to the heuristic (the search declines and every caller
// falls back). Measured 2026-09-04 on 43 real reveals: heuristic Empire 12/43
// captures vs MCTS 7/43, paired 6-1. This pins the mechanism: with the lever
// on, searchMctsCommand returns null for the Empire on a revealed board and
// still searches on a hidden one and for the Rebel; with it off (child), the
// same revealed board is searched.
// Run: node scripts/test-postreveal-heuristic.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = process.env.PR_CHILD === '1';
if (!CHILD) process.env.SWR_POSTREVEAL_HEURISTIC = '1';
process.env.SWR_MCTS_BUDGET = '4'; process.env.SWR_MCTS_MS = '600000';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const mcts = await import('../src/play/mctsAI.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** A Command-phase board with the Empire to act. */
function board(seed, revealed) {
  const G = createGame(data, { seed, autoSetupUnits: true });
  // play through to the Empire's first Command decision
  let guard = 0;
  while (guard++ < 400 && !(G.phase === 'Command' && G.currentPlayer === 'Empire' && !G.pendingChoice && !G.pendingMission && !G.pendingCombat)) {
    const s = G.currentPlayer; if (!AI.stepOnce(G, s)) { const o = s === 'Rebel' ? 'Empire' : 'Rebel'; if (!AI.stepOnce(G, o)) break; }
  }
  G.rebelBaseRevealed = revealed;
  return G;
}
const searched = (G, side) => { AI.seedAI(1); mcts.seedMCTS(1); return mcts.searchMctsCommand(G, side) !== null; };

if (CHILD) {
  const G = board(11, true);
  console.log(JSON.stringify({ empireRevealedSearched: G.phase === 'Command' ? searched(G, 'Empire') : null }));
  process.exit(0);
}
console.log('[ with the switch on ]');
{
  const G = board(11, true);
  check('the fixture reaches an Empire Command decision', G.phase === 'Command' && G.currentPlayer === 'Empire', `${G.phase}/${G.currentPlayer}`);
  check('the lever reads on', mcts.isPostRevealHeuristic());
  check('Empire on a REVEALED board: the search declines (heuristic takes it)', !searched(G, 'Empire'));
  const H = board(11, false);
  check('Empire on a HIDDEN board: still searched', searched(H, 'Empire'));
  mcts.setPostRevealHeuristic(false);
  check('runtime setter off: the revealed board is searched again', searched(board(11, true), 'Empire'));
  mcts.setPostRevealHeuristic(true);
}
console.log('[ control: the switch off (child process) searches the same revealed board ]');
{
  const out = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, PR_CHILD: '1', SWR_POSTREVEAL_HEURISTIC: '0' }, encoding: 'utf8' }).trim().split('\n').pop());
  check('legacy: Empire searches on the revealed board', out.empireRevealedSearched === true, JSON.stringify(out));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
