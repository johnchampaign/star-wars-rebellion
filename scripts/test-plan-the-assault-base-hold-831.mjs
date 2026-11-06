// #831 — the Rebel AI resolved Plan the Assault by sending EVERY ship out of
// its revealed base while an Imperial ground unit sat there with no Rebel
// ground. The base was left with Imperial units and no Rebel units — the
// Empire's instant win (RR "Winning the Game"). The AI now holds one ship home
// in that case, and still sends everything when the base is safe.
// Run: node scripts/test-plan-the-assault-base-hold-831.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

let n = 0;
function run(baseRebel, baseEmpire) {
  ai.seedAI(1);
  const G = createGame(data, { seed: 7, autoSetupUnits: true });
  G.phase = 'Command'; G.currentPlayer = 'Rebel';
  const mk = (t, side) => ({ instanceId: `t831-${n++}`, typeId: t, side, damage: 0 });
  const base = 'endor', tgt = 'coruscant';
  G.rebelBaseSystemId = base; G.rebelBaseRevealed = true;
  G.map.rebelBaseSpace.units = [];
  G.map.systems[base].units = [...baseRebel.map((t) => mk(t, 'Rebel')), ...baseEmpire.map((t) => mk(t, 'Empire'))];
  const ships = G.map.systems[base].units
    .filter((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'space').map((u) => u.instanceId);
  G.pendingChoice = { kind: 'PlanTheAssaultShips', side: 'Rebel', targetSystemId: tgt, availableShipIds: ships, sourceSystemId: base };
  ai.stepOnce(G, 'Rebel');
  const left = G.map.systems[base].units.filter((u) => u.side === 'Rebel').length;
  return { G, left, sent: ships.length - G.map.systems[base].units.filter((u) => ships.includes(u.instanceId)).length };
}

console.log('[ #831 — Plan the Assault never empties a held base ]');
// The reporter's board: corvette + transport at the revealed base, Imperial
// AT-ST there, no Rebel ground.
const a = run(['corellian-corvette', 'rebel-transport'], ['at-st']);
check('choice resolved', a.G.pendingChoice?.kind !== 'PlanTheAssaultShips', `pending=${a.G.pendingChoice?.kind}`);
check('Empire did NOT win by base capture', a.G.winReason !== 'base-captured', `winReason=${a.G.winReason}`);
check('one Rebel ship stays home', a.left === 1, `left=${a.left}`);
check('the other ship still goes', a.sent === 1, `sent=${a.sent}`);
// Rebel ground holds the base — every ship may go.
const b = run(['corellian-corvette', 'rebel-transport', 'rebel-trooper'], ['at-st']);
check('with Rebel ground at home, every ship goes', b.sent === 2, `sent=${b.sent}`);
// No Imperial units at the base — every ship may go.
const c = run(['corellian-corvette', 'rebel-transport'], []);
check('with no Imperial units at the base, every ship goes', c.sent === 2, `sent=${c.sent}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
