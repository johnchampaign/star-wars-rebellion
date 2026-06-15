import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass=0,fail=0; const check=(n,ok,x='')=>{console.log(`  ${ok?'✓':'✗'} ${n}${ok?'':' — '+x}`);ok?pass++:fail++;};

// #280: unassigning a deck-fetched (OMDH) mission returns it to the DECK, not hand.
{
  const G = createGame(data, { seed: 2, roeMissions: true, roeUnits: true });
  G.phase = 'Assignment';
  const mid = 'behind-enemy-lines';
  if (!G.rebel.missionDeck.includes(mid)) G.rebel.missionDeck.push(mid);
  // simulate OMDH: pull from deck onto a mission with Leia (fromDeck)
  G.rebel.missionDeck = G.rebel.missionDeck.filter(m => m !== mid);
  G.rebel.leaderPool = G.rebel.leaderPool.filter(l => l !== 'princess-leia');
  // OMDH card was discarded when played; track it via viaCard (#279)
  (G.rebel.actionDiscard ??= []).push('our-most-desperate-hour');
  G.rebel.leadersOnMissions.push({ missionId: mid, leaderIds: ['princess-leia'], fromDeck: true, viaCard: 'our-most-desperate-hour' });
  const r = phases.unassignLeader(G, 'Rebel', mid);
  check('unassign ok', r.ok, r.reason);
  check('fetched mission returned to DECK (not hand)', G.rebel.missionDeck.includes(mid) && !(G.rebel.missionHand ?? []).includes(mid));
  check('Leia returned to pool', G.rebel.leaderPool.includes('princess-leia'));
  check('OMDH action card returned to HAND (#279)', (G.rebel.actionHand ?? []).includes('our-most-desperate-hour') && !(G.rebel.actionDiscard ?? []).includes('our-most-desperate-hour'));
}

// #280 control: a normally-assigned mission still returns to HAND.
{
  const G = createGame(data, { seed: 2 });
  G.phase = 'Assignment';
  const mid = G.rebel.missionHand[0];
  phases.assignLeader(G, 'Rebel', mid, ['mon-mothma']);
  const r = phases.unassignLeader(G, 'Rebel', mid);
  check('normal mission returns to HAND', r.ok && (G.rebel.missionHand ?? []).includes(mid) && !(G.rebel.missionDeck ?? []).includes(mid));
}

// #281: Behind Enemy Lines respects transport — ground needs a carrier.
function belChoice(G, ids) {
  G.pendingChoice = { kind: 'BehindEnemyLinesUnits', side: 'Rebel', targetSystemId: 'felucia',
    sourceSystemId: 'rebel-base-space', availableUnitIds: ids, max: 5 };
}
{
  const G = createGame(data, { seed: 2, roeUnits: true, roeMissions: true });
  G.map.rebelBaseSpace.units = []; // start from an empty base for a clean count
  // base space: 2 ground troopers, NO ship
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'rebel-base-space');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'rebel-base-space');
  const ids = G.map.rebelBaseSpace.units.filter(u=>u.typeId==='rebel-trooper').map(u=>u.instanceId);
  belChoice(G, ids);
  const r = phases.resolveBehindEnemyLinesUnits(G, ids);
  check('2 ground + no ship is REJECTED (transport)', !r.ok && /transport/.test(r.reason||''), r.reason);
}
{
  const G = createGame(data, { seed: 2, roeUnits: true, roeMissions: true });
  G.map.rebelBaseSpace.units = [];
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'rebel-base-space');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'rebel-base-space');
  M.deployUnit(G, 'Rebel', 'rebel-transport', 'rebel-base-space'); // capacity carrier
  const ids = G.map.rebelBaseSpace.units.filter(u=>['rebel-trooper','rebel-transport'].includes(u.typeId)).map(u=>u.instanceId);
  belChoice(G, ids);
  const r = phases.resolveBehindEnemyLinesUnits(G, ids);
  check('2 ground + 1 transport is ACCEPTED', r.ok, r.reason);
  check('units left the base', G.map.rebelBaseSpace.units.filter(u=>u.typeId==='rebel-trooper').length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
