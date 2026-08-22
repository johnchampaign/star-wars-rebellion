// Player report #736, item 1 — "undo didn't work in the placement of units."
//
// Setup is concurrent online: each side places its own starting forces without
// waiting for the other, so the adapter carves Setup out of normal turn order
// via canAct(). That carve-out gated on "this side still has units left to
// place" — which is false the instant you place your LAST unit. So the one undo
// you most want, the one that takes back the placement you just made, was
// refused.
//
// It failed silently, too. canAct also feeds the framework's `yourTurn` flag
// (GameServer.viewResult -> mayAct -> adapter.canAct), and the online shim
// drops any action while yourTurn is false, returning {ok:true} so the UI
// closes as if it had worked. The button simply did nothing.
//
// Run: node scripts/test-setup-undo-online-736.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');

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

// autoSetupUnits:false = interactive placement, which is what online games use.
const fresh = () => createGame(data, { seed: 9, autoSetupUnits: false });

console.log('\n[ #736 — both seats can act for as long as Setup is running ]');
{
  const G = fresh();
  check('the fixture really is mid-Setup with units to place', G.phase === 'Setup'
    && (G.pendingDeployment?.Empire?.length ?? 0) > 0, `phase=${G.phase}`);
  check('Empire may act while it still has units pending',
    rebellionAdapter.canAct(G, 'Empire'));
  check('Rebel may act concurrently — it does not wait for the Empire',
    rebellionAdapter.canAct(G, 'Rebel'));
}

console.log('\n[ the seat that just placed its LAST unit can still undo ]');
{
  // Drain the Empire's queue the way a player finishing placement would.
  const G = fresh();
  let guard = 0;
  while ((G.pendingDeployment?.Empire?.length ?? 0) > 0 && guard++ < 200) {
    const before = G.pendingDeployment.Empire.length;
    const r = rebellionAdapter.applyAction(G, { kind: 'setupAutoFill' }, 'Empire');
    Object.assign(G, r);
    if ((G.pendingDeployment?.Empire?.length ?? 0) >= before) break;
  }
  check('the Empire has finished placing', (G.pendingDeployment?.Empire?.length ?? 0) === 0,
    `left=${G.pendingDeployment?.Empire?.length}`);
  check('Setup has NOT ended (the Rebel is still placing)', G.phase === 'Setup');
  check('a finished Empire may still act — this is the reported bug',
    rebellionAdapter.canAct(G, 'Empire'));

  // And the undo must actually go through, not just be permitted.
  const placed = Object.entries(G.map.systems)
    .flatMap(([sysId, ss]) => ss.units.filter((u) => u.side === 'Empire').map((u) => [sysId, u.typeId]))[0];
  check('the Empire has units on the board to take back', !!placed, JSON.stringify(placed));
  if (placed) {
    const [sysId, typeId] = placed;
    const after = rebellionAdapter.applyAction(G,
      { kind: 'setupUndoDeployUnit', typeId, systemId: sysId }, 'Empire');
    check('the undo is accepted and returns the unit to the queue',
      (after.pendingDeployment?.Empire ?? []).includes(typeId),
      JSON.stringify(after.pendingDeployment?.Empire?.slice(0, 3)));
  }
}

console.log('\n[ and it does not leak past Setup ]');
{
  // Once the phase is anything but Setup, normal turn order is back in charge.
  const G = fresh();
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  G.pendingDeployment = undefined;
  check('the side to move may act', rebellionAdapter.canAct(G, 'Rebel'));
  check('the side NOT to move may not', !rebellionAdapter.canAct(G, 'Empire'));
}

console.log(`\n${fail ? 'FAIL' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
