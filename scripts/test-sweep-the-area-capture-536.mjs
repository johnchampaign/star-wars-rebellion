// #536: Sweep the Area must relocate the captured leader to the closest
// Imperial-unit system so the capture STICKS. Previously the auto-rescue fired
// at the (Imperial-unit-free) reveal system before the relocate ran, so the
// leader was freed and a phantom "relocate" was logged.
// Run: node scripts/test-sweep-the-area-capture-536.mjs
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
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

// Pick a reveal system that has an adjacent system, then put a Rebel leader at
// the reveal system with NO Imperial units, and an Imperial unit next door.
const G = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true } });
const adj = G.catalog.adjacency;
const revealSys = Object.keys(adj).find((s) => (adj[s] ?? []).length > 0);
const neighbor = adj[revealSys][0];

// Clear both systems, then stage the scenario.
G.map.systems[revealSys].units = [];
G.map.systems[neighbor].units = [{ instanceId: 'imp-st-1', typeId: 'stormtrooper', side: 'Empire', damage: 0 }];

// Place a Rebel leader at the reveal system.
const rebelLeader = 'chewbacca';
// Make sure the leader isn't sitting anywhere else.
for (const k of Object.keys(G.rebel.leadersOnBoard)) {
  G.rebel.leadersOnBoard[k] = G.rebel.leadersOnBoard[k].filter((l) => l !== rebelLeader);
}
const poolIdx = G.rebel.leaderPool.indexOf(rebelLeader);
if (poolIdx >= 0) G.rebel.leaderPool.splice(poolIdx, 1);
G.rebel.leadersOnBoard[revealSys] = [rebelLeader];

// Arm Sweep the Area at the reveal system and drive the reveal offer.
G.empire.armedActionCards = [{ cardId: 'sweep-the-area', probeSystemId: revealSys, armedAt: G.timeMarker }];
G.pendingArmedReveals = { phase: 'command-end', remaining: [G.empire.armedActionCards[0]] };
G.pendingChoice = { kind: 'ArmedCardRevealOffer', side: 'Empire', cardId: 'sweep-the-area', systemId: revealSys };

const r = phases.resolveArmedCardRevealOffer(G, true);
check('reveal resolved ok', r.ok, r.reason);

const captured = (G.empire.capturedLeaders ?? []).find((c) => c.leaderId === rebelLeader);
check('leader is STILL captured (not auto-freed)', !!captured,
  'capturedLeaders=' + JSON.stringify(G.empire.capturedLeaders));
check('captured leader relocated to the Imperial-unit system', captured?.systemId === neighbor,
  'systemId=' + captured?.systemId);
check('leader is NOT back on the Rebel board/pool',
  !Object.values(G.rebel.leadersOnBoard).flat().includes(rebelLeader)
  && !G.rebel.leaderPool.includes(rebelLeader));

// --- Second scenario: NO Imperial units anywhere reachable -> leader IS freed.
const G2 = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true } });
// Strip every Imperial unit from the map.
for (const s of Object.values(G2.map.systems)) s.units = (s.units ?? []).filter((u) => u.side !== 'Empire');
const rs2 = Object.keys(G2.catalog.adjacency).find((s) => (G2.catalog.adjacency[s] ?? []).length > 0);
G2.map.systems[rs2].units = [];
for (const k of Object.keys(G2.rebel.leadersOnBoard)) {
  G2.rebel.leadersOnBoard[k] = G2.rebel.leadersOnBoard[k].filter((l) => l !== rebelLeader);
}
const p2 = G2.rebel.leaderPool.indexOf(rebelLeader);
if (p2 >= 0) G2.rebel.leaderPool.splice(p2, 1);
G2.rebel.leadersOnBoard[rs2] = [rebelLeader];
G2.empire.armedActionCards = [{ cardId: 'sweep-the-area', probeSystemId: rs2, armedAt: G2.timeMarker }];
G2.pendingArmedReveals = { phase: 'command-end', remaining: [G2.empire.armedActionCards[0]] };
G2.pendingChoice = { kind: 'ArmedCardRevealOffer', side: 'Empire', cardId: 'sweep-the-area', systemId: rs2 };
phases.resolveArmedCardRevealOffer(G2, true);
const cap2 = (G2.empire.capturedLeaders ?? []).find((c) => c.leaderId === rebelLeader);
check('no Imperial unit anywhere -> leader is correctly rescued (not captured)', !cap2,
  'capturedLeaders=' + JSON.stringify(G2.empire.capturedLeaders));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
