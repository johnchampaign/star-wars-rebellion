// #846 (mrvvfh, playing Rebel): "the empire ... just moved three star
// destroyers and a massive ground troop force to malastare in the middle of the
// map - why? it doesn't know where my base is ... they could now discover it
// and still need 3 more turns to get there with their only large fleet".
// Replayed from the reporter's own board (scripts/fixtures/fleet-spread-846.json:
// the encoded state from the report with Tagge's Malastare activation undone).
//
// The move planner brings every capital ship from each source (they carry the
// troops), so one reposition swept the Star Destroyers of Bothawui, Kashyyyk
// and Sullust into one stack. SWR_FLEET_SPREAD: while the base is hidden, a
// non-attack activation leaves at least one Star Destroyer out of the stack.
//
// Pins: the reporter's Malastare activation brings 2 of the 3 Star Destroyers;
// a Rebel unit at the target (a fight), a revealed base, or a lone Star
// Destroyer lifts the cap; every planned move still passes the transport
// validator; and SWR_FLEET_SPREAD=0 reproduces all three.
// Run: node scripts/test-fleet-spread-846.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const raw = readFileSync(join(ROOT, 'scripts/fixtures/fleet-spread-846.json'), 'utf8');
const SYS = 'malastare';
const CONTROL = process.argv[2] === '--control';
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const board = () => codec.decode(raw, setup.buildCatalog(data));
/** Star Destroyers the planner would bring to `sid`, and whether each order is legal. */
function plan(G, sid = SYS) {
  const orders = AI.plannedMoveOrders(G, 'Empire', sid);
  let sds = 0, legal = true;
  for (const o of orders) {
    const ss = G.map.systems[o.fromSystemId];
    for (const id of o.unitInstanceIds) {
      if (ss.units.find((u) => u.instanceId === id)?.typeId === 'star-destroyer') sds++;
    }
    if (!phases.validateMoveOrderTransport(G, 'Empire', o).ok) legal = false;
  }
  return { sds, legal, units: orders.reduce((a, o) => a + o.unitInstanceIds.length, 0) };
}
const withRebelAtTarget = () => {
  const G = board();
  G.map.systems[SYS].units.push({ instanceId: 'x846-reb', typeId: 'x-wing', side: 'Rebel', damage: 0 });
  return G;
};
const revealed = () => { const G = board(); G.rebelBaseRevealed = true; return G; };

if (CONTROL) {
  console.log(`SDS=${plan(board()).sds},${plan(withRebelAtTarget()).sds},${plan(revealed()).sds}`);
  process.exit(0);
}

console.log('[ the reporter\'s board: Tagge activates Malastare, base hidden ]');
const G0 = board();
check('three Star Destroyers on the board, none at Malastare',
  Object.values(G0.map.systems).flatMap((s) => s.units).filter((u) => u.typeId === 'star-destroyer').length === 3);
check('budget is 2 (one must stay out)', AI.fleetSpreadSdBudget(G0, SYS) === 2, `budget=${AI.fleetSpreadSdBudget(G0, SYS)}`);
const rep = plan(G0);
check('the activation brings 2 Star Destroyers, not 3', rep.sds === 2, `sds=${rep.sds}`);
check('every planned order is transport-legal', rep.legal);
check('it still moves a real force', rep.units >= 8, `units=${rep.units}`);

console.log('\n[ the cap lifts when concentration is the point ]');
check('Rebel unit at the target (a fight) → all 3 come', plan(withRebelAtTarget()).sds === 3);
check('base revealed → all 3 come', plan(revealed()).sds === 3);
{
  const G = board();
  for (const sid of ['kashyyyk', 'sullust']) {
    G.map.systems[sid].units = G.map.systems[sid].units.filter((u) => u.typeId !== 'star-destroyer');
  }
  check('a lone Star Destroyer is not held back', plan(G).sds === 1 && AI.fleetSpreadSdBudget(G, SYS) === Infinity);
}

console.log('\n[ counterfactual: SWR_FLEET_SPREAD=0 ]');
const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--control'], {
  env: { ...process.env, SWR_FLEET_SPREAD: '0' }, encoding: 'utf8',
});
check('flag off reproduces the report (3 / 3 / 3)', /SDS=3,3,3/.test(out), out.trim());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
