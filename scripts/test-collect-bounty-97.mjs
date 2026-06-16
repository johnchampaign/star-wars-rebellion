// Audit #97 — Collect Bounty: on success, capture the Rebel leader, then move
// BOTH that leader and the bounty hunter to the closest system containing an
// Imperial UNIT. Verifies the relocation end-to-end (handler path).
// Run: node scripts/test-collect-bounty-97.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');

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

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true } });
handlers.registerAll();

function placeLeaderOn(G, side, lid, sysId) {
  (side === 'Empire' ? G.empire : G.rebel).leaderPool =
    (side === 'Empire' ? G.empire : G.rebel).leaderPool.filter((l) => l !== lid);
  (G[side === 'Empire' ? 'empire' : 'rebel'].leadersOnBoard[sysId] ??= []).push(lid);
}
function fire(G, targetSys, hunters, targetLeader) {
  const card = G.catalog.missions['collect-bounty'];
  const ctx = registry.makeContext('Empire', card,
    { targetSystemId: targetSys, leaderIds: hunters, targetLeaderId: targetLeader });
  registry.invokeByKey(G, 'collect-bounty', ctx);
}
function capturedAt(G, lid) {
  return (G.empire.capturedLeaders ?? []).find((c) => c.leaderId === lid)?.systemId;
}
function onBoard(G, side, lid) {
  for (const [sid, list] of Object.entries((side === 'Empire' ? G.empire : G.rebel).leadersOnBoard)) {
    if (list.includes(lid)) return sid;
  }
  return null;
}

const X = 'felucia';                 // capture system (no Imperial UNIT — only leaders)
const Y = 'mandalore';               // adjacent system WITH an Imperial unit

console.log('\n[ #97 capture + relocate both leaders to nearest Imperial-unit system ]');
{
  const G = createGame(data, opts(1));
  for (const s of [X, Y]) G.map.systems[s].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', Y); // the only nearby Imperial UNIT
  // Rebel target leader + Empire bounty hunter both at X (post-reveal placement).
  placeLeaderOn(G, 'Rebel', 'luke-skywalker', X);
  placeLeaderOn(G, 'Empire', 'boba-fett', X);

  fire(G, X, ['boba-fett'], 'luke-skywalker');

  check('Rebel leader captured', (G.empire.capturedLeaders ?? []).some((c) => c.leaderId === 'luke-skywalker'));
  check('captured leader relocated to the Imperial-unit system (Y)',
    capturedAt(G, 'luke-skywalker') === Y, `at ${capturedAt(G, 'luke-skywalker')}`);
  check('captured leader NOT left at the capture system (X)', capturedAt(G, 'luke-skywalker') !== X);
  check('bounty hunter (Boba Fett) moved to Y', onBoard(G, 'Empire', 'boba-fett') === Y,
    `at ${onBoard(G, 'Empire', 'boba-fett')}`);
  check('bounty hunter no longer at X', onBoard(G, 'Empire', 'boba-fett') !== X);
}

console.log('\n[ #97 capture system already has an Imperial unit → stays put (distance 0) ]');
{
  const G = createGame(data, opts(2));
  G.map.systems[X].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', X); // Imperial unit right here
  placeLeaderOn(G, 'Rebel', 'han-solo', X);
  placeLeaderOn(G, 'Empire', 'boba-fett', X);
  fire(G, X, ['boba-fett'], 'han-solo');
  check('captured leader held at X (closest = distance 0)', capturedAt(G, 'han-solo') === X);
  check('bounty hunter stays at X', onBoard(G, 'Empire', 'boba-fett') === X);
}

console.log('\n[ #97 no Imperial unit anywhere → captured leader auto-rescued (RR p.3) ]');
{
  const G = createGame(data, opts(3));
  // Strip every Imperial unit from the board so relocation is impossible.
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.side !== 'Empire');
  G.map.rebelBaseSpace.units = G.map.rebelBaseSpace.units.filter((u) => u.side !== 'Empire');
  placeLeaderOn(G, 'Rebel', 'princess-leia', X);
  placeLeaderOn(G, 'Empire', 'boba-fett', X);
  fire(G, X, ['boba-fett'], 'princess-leia');
  check('captured leader auto-rescued (no Imperial unit to guard them)',
    !(G.empire.capturedLeaders ?? []).some((c) => c.leaderId === 'princess-leia'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
