// Regression #757 — "auto-fill remaining" pressed repeatedly during Setup.
//
// THE BUG: setupAutoFill() logged a fresh `setup-auto-fill` entry and returned
// ok:true on EVERY call, even when the side had nothing left to place. A player
// who clicked the button a few times watched the game log fill with phantom
// turn-1 actions ("the turn counter continues to go up"). The always-true
// return was also wrong for the AI, whose Setup step returns it: a Setup that
// could not advance (e.g. still waiting on the Rebel base pick) would spin.
//
// Run: node scripts/test-setup-autofill-757.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce, seedAI } = await import('../src/play/randomAI.ts');

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

const fills = (G) => G.turnLog.filter((e) => e.kind === 'setup-auto-fill').length;

console.log('\n[ #757 repeated auto-fill presses are no-ops, not extra log entries ]');
{
  // autoSetupUnits:false is what a real game uses — units start in the pending
  // pool and the player places (or auto-fills) them.
  const G = createGame(data, { seed: 7, autoSetupUnits: false });

  const first = phases.setupAutoFill(G, G.currentPlayer);
  check('first press places the Empire and reports ok', first.ok);
  check('Empire pool emptied', G.pendingDeployment.Empire.length === 0);

  const second = phases.setupAutoFill(G, G.currentPlayer);
  check('second press places the Rebel and reports ok', second.ok);
  check('Rebel pool emptied', G.pendingDeployment.Rebel.length === 0);

  const logLen = G.turnLog.length;
  const fillsAfterPlacement = fills(G);
  check('exactly one auto-fill entry per side so far', fillsAfterPlacement === 2,
    `saw ${fillsAfterPlacement}`);

  // The reporter's sequence: keep clicking once everything is already placed.
  const reasons = new Set();
  for (let i = 0; i < 8; i++) {
    const r = phases.setupAutoFill(G, G.currentPlayer);
    if (r.ok) reasons.add('ok');
    else reasons.add(r.reason);
  }
  check('extra presses report failure, not success', !reasons.has('ok'),
    `reasons: ${[...reasons].join(',')}`);
  check('extra presses add no log entries', G.turnLog.length === logLen,
    `log grew ${logLen} -> ${G.turnLog.length}`);
  check('still exactly two auto-fill entries', fills(G) === 2, `saw ${fills(G)}`);
}

console.log('\n[ #757 interactive setup still completes a full AI-vs-AI game ]');
{
  for (const seed of [1, 2, 3]) {
    const G = createGame(data, { seed, autoSetupUnits: false });
    seedAI(seed);
    let steps = 0;
    while (!G.isGameOver && steps < 200000) {
      const side = G.currentPlayer;
      if (stepOnce(G, side)) { steps++; continue; }
      const other = side === 'Rebel' ? 'Empire' : 'Rebel';
      if (stepOnce(G, other)) { steps++; continue; }
      break;
    }
    check(`seed ${seed}: game left Setup and reached a conclusion`,
      G.phase !== 'Setup' && G.isGameOver, `phase=${G.phase} over=${G.isGameOver}`);
    check(`seed ${seed}: no runaway auto-fill entries`, fills(G) <= 2, `saw ${fills(G)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
