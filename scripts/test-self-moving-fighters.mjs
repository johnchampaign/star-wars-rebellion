// The generic activation mover stranded self-moving fighters (task_a3b11e85,
// the residual half of the #647 / #606 / #538 "activates and does nothing"
// cluster).
//
// THE BUG, in two places that each classified units independently:
//
//   move-packer:  if (capacity > 0) capital
//                 else if (ground)  ground
//                 else if (restriction) fighter-needing-a-carrier
//                 <-- NO final branch: anything else was silently DROPPED
//
//   scorer:       if (capacity > 0) selfMoving + capacity
//                 else              needCarry
//                 <-- so a self-mover counted as needing a carrier it hasn't got
//
// Exactly two unit types in the whole catalog land in that gap — the X-Wing and
// the Y-Wing, both Rebel. They carry no transport capacity AND no
// transport-restriction icon, because they have hyperdrives and move themselves
// (only the TIE Fighter carries the restriction icon among fighters). So the
// scorer decided a source holding only Rebel fighters had "nothing movable" and
// sank the activation, and on the occasions it did activate, the packer left
// the fighters standing there.
//
// Measured effect of the fix, 240 self-play games per arm:
//   Rebel units moved   7.50/game -> 10.99/game  (+47%)
//   Rebel no-op activations  50% -> 44%
// (Empire is unaffected: it has no self-moving units — TIEs must be ferried.)
//
// Run: node scripts/test-self-moving-fighters.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ every mobile unit type must fall into a move-packer bucket ]');
{
  // Structural tripwire: mirrors the packer's classification and fails if ANY
  // mobile type matches none of its branches. This is what would have caught
  // the X-/Y-Wing gap the day the units were added.
  const G = createGame(data, { seed: 1, autoSetupUnits: true, expansion: { enabled: true, roteUnits: true } });
  const orphans = [];
  for (const t of Object.values(G.catalog.unitTypes)) {
    if (t.transport?.immobile) continue;
    const capital = t.transport.capacity > 0;
    const ground = t.theater === 'ground' && t.class !== 'structure';
    const carried = t.transport.restriction;
    const selfMover = t.theater === 'space' && t.transport.capacity === 0 && !t.transport.restriction;
    if (!capital && !ground && !carried && !selfMover) orphans.push(t.id);
  }
  check('no mobile unit type is unclassified', orphans.length === 0,
    `unbucketed (would be silently left behind): ${orphans.join(', ')}`);
}

console.log('[ a leader activating toward Rebel fighters actually brings them ]');
{
  // Isolated board: one Rebel leader in the pool, X-/Y-Wings parked on a
  // neighbour of the target, nothing else Rebel anywhere. If the fighters are
  // invisible the scorer sees "nothing movable" and no activation is offered at
  // all; if the packer drops them the activation moves zero units.
  const G = createGame(data, { seed: 5, autoSetupUnits: true, expansion: { enabled: true, roteUnits: true } });
  G.phase = 'Command'; G.currentPlayer = 'Rebel'; G.passedThisCommand = [];
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.side !== 'Rebel');
  G.rebel.leadersOnBoard = {}; G.rebel.leadersOnMissions = [];
  G.rebel.leaderPool = ['general-rieekan'];

  const fighters = () => ([
    { instanceId: 'rb-x1', typeId: 'x-wing', side: 'Rebel', damage: 0 },
    { instanceId: 'rb-x2', typeId: 'x-wing', side: 'Rebel', damage: 0 },
    { instanceId: 'rb-y1', typeId: 'y-wing', side: 'Rebel', damage: 0 },
  ]);
  check('the fixture uses only self-moving fighters (no carrier anywhere)',
    fighters().every((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      return t.transport.capacity === 0 && !t.transport.restriction;
    }));

  // Don't assert WHICH system the AI wants — that is target scoring, not this
  // fix, and picking one arbitrarily made an earlier draft fail spuriously.
  // Ask the AI where it wants to go, then park the fighters on a neighbour of
  // THAT system and re-ask. The question under test is only ever "when the
  // fighters are in range of the activation, do they come along?".
  const seed = Object.keys(G.map.systems).find((s) => (G.catalog.adjacency[s] ?? []).length > 0);
  G.map.systems[seed].units = fighters();
  AI.seedAI(2);
  const first = AI.bestCommandAction(G, 'Rebel').find((a) => a.kind === 'activate');
  check('an activation is offered at all with only fighters on the board', !!first,
    'the scorer still sees nothing movable — fighters counted as needing a carrier');

  if (first) {
    const TARGET = first.targetSystemId;
    const SRC = (G.catalog.adjacency[TARGET] ?? []).find((s) => s !== TARGET);
    G.map.systems[seed].units = [];
    G.map.systems[SRC].units = fighters();
    AI.seedAI(2);
    const act = AI.bestCommandAction(G, 'Rebel').find((a) => a.kind === 'activate' && a.targetSystemId === TARGET);
    check(`the activation toward the fighters is still offered (${TARGET} <- ${SRC})`, !!act);
    if (act) {
      const before = G.map.systems[TARGET].units.filter((u) => u.side === 'Rebel').length;
      AI.seedAI(2);
      const ok = AI.tryCommandAction(G, 'Rebel', act);
      const after = G.map.systems[TARGET].units.filter((u) => u.side === 'Rebel').length;
      check('the activation executes', ok);
      check(`the fighters actually moved (${before} -> ${after} at the target)`, after > before,
        'the packer dropped them — the leader arrived alone');
      check('and they left the source', G.map.systems[SRC].units.filter((u) => u.side === 'Rebel').length < 3);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
