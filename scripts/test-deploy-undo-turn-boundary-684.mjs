// #684 — "When I clicked undo last placement it rewound me to an earlier turn!"
//
// The Refresh deploy-step undo stack added by #670 was a bare array that
// nothing ever cleared. Snapshots survived the end of the deploy step, so on a
// LATER turn, once you had undone back past the placements you made that turn,
// the next click popped a snapshot belonging to a previous turn and restored
// the whole game to it.
//
// This pins the step-scoped stack: undo may only ever walk back through
// placements made in the deploy step you are currently in.
// Run: node scripts/test-deploy-undo-turn-boundary-684.mjs
const { register } = await import('tsx/esm/api'); register();
const { DeployUndoStack, deployStepKey } = await import('../src/play/deployUndoStack.ts');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

/** Stand-in for the bits of GameState deployStepKey reads. */
const at = (timeMarker, side, phase = 'Refresh') =>
  ({ timeMarker, phase, pendingChoice: { kind: 'DeployUnitPick', side } });

console.log('\n[ #684 undo cannot reach back into a previous turn ]');
{
  const s = new DeployUndoStack();
  const t3 = deployStepKey(at(3, 'Rebel'));
  const t4 = deployStepKey(at(4, 'Rebel'));
  check('turn 3 and turn 4 deploy steps have different keys', t3 !== t4, `${t3} vs ${t4}`);

  // Turn 3: three placements, one undone — two snapshots left behind.
  s.push(t3, 'T3-a'); s.push(t3, 'T3-b'); s.push(t3, 'T3-c');
  check('undo works within turn 3', s.pop(t3) === 'T3-c');
  check('turn 3 still has 2 undos available', s.depth(t3) === 2, String(s.depth(t3)));

  // Turn 4: a single placement. This is where the bug bit.
  s.push(t4, 'T4-a');
  check('turn 4 shows exactly ONE undo, not the turn-3 leftovers',
    s.depth(t4) === 1, String(s.depth(t4)));
  check('first undo in turn 4 returns the turn-4 snapshot', s.pop(t4) === 'T4-a');
  check('second undo in turn 4 returns NOTHING (was: a turn-3 snapshot)',
    s.pop(t4) === null);
  check('button is disabled after that', s.depth(t4) === 0, String(s.depth(t4)));
}

console.log('\n[ #684 the same guard across phase and side boundaries ]');
{
  const s = new DeployUndoStack();
  const refresh = deployStepKey(at(5, 'Empire', 'Refresh'));
  const setup = deployStepKey(at(5, 'Empire', 'Setup'));
  const otherSide = deployStepKey(at(5, 'Rebel', 'Refresh'));
  check('phase is part of the key', refresh !== setup, `${refresh} vs ${setup}`);
  check('side is part of the key', refresh !== otherSide, `${refresh} vs ${otherSide}`);

  s.push(refresh, 'R1');
  check('a different phase sees no undos', s.depth(setup) === 0, String(s.depth(setup)));
  check('a different phase cannot pop it', s.pop(setup) === null);

  const s2 = new DeployUndoStack();
  s2.push(refresh, 'R1');
  check('the other side sees no undos', s2.depth(otherSide) === 0, String(s2.depth(otherSide)));
  check('the other side cannot pop it', s2.pop(otherSide) === null);
}

console.log('\n[ #684 normal same-step undo still behaves (the #670 feature) ]');
{
  const s = new DeployUndoStack();
  const k = deployStepKey(at(2, 'Empire'));
  s.push(k, 'a'); s.push(k, 'b'); s.push(k, 'c');
  check('depth counts every placement in the step', s.depth(k) === 3, String(s.depth(k)));
  check('undos come back last-in-first-out', s.pop(k) === 'c' && s.pop(k) === 'b' && s.pop(k) === 'a');
  check('empty afterwards', s.depth(k) === 0 && s.pop(k) === null);
}

console.log('\n[ #684 a missing/blank key never resurrects another step ]');
{
  const s = new DeployUndoStack();
  const k = deployStepKey(at(7, 'Rebel'));
  s.push(k, 'x');
  check('popping with a blank key yields nothing', s.pop('') === null);
  check('and it did not leave the old entry poppable', s.depth(k) === 0, String(s.depth(k)));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
