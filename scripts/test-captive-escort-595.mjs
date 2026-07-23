// #595 — RAW (RR "Captured Leaders"): Imperial units moving out of a system
// holding a captured leader MAY bring the captive with them. Previously there
// was no escort path at all, so draining a prison always auto-freed the
// captive.
// Run: node scripts/test-captive-escort-595.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const PRISON = 'corellia';
const build = () => {
  const G = createGame(data, { seed: 3, autoSetupUnits: true });
  const DEST = (G.catalog.adjacency[PRISON] ?? [])[0];
  G.phase = 'Command';
  G.currentPlayer = 'Empire';
  G.passedThisCommand = [];
  G.map.systems[PRISON].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', PRISON);
  M.deployUnit(G, 'Empire', 'assault-carrier', PRISON); // transport for the trooper
  G.empire.capturedLeaders = [{ leaderId: 'princess-leia', ring: 'captured', systemId: PRISON }];
  // Strip Leia from Rebel pools so state is coherent.
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== 'princess-leia');
  const escortUnits = G.map.systems[PRISON].units.map((u) => u.instanceId);
  const empireLeader = G.empire.leaderPool[0];
  return { G, DEST, escortUnits, empireLeader };
};

console.log('[ escorted move: captive travels, no auto-rescue ]');
{
  const { G, DEST, escortUnits, empireLeader } = build();
  const r = phases.activateSystem(G, 'Empire', empireLeader, DEST,
    [{ fromSystemId: PRISON, unitInstanceIds: escortUnits }], ['princess-leia']);
  check('activation ok', r.ok, r.reason);
  const cap = G.empire.capturedLeaders.find((c) => c.leaderId === 'princess-leia');
  check('captive still captured', !!cap);
  check('captive relocated to destination', cap?.systemId === DEST, cap?.systemId);
  check('captured-leader-moved logged', G.turnLog.some((e) => e.kind === 'captured-leader-moved'));
}

console.log('\n[ unescorted drain: existing auto-rescue still fires ]');
{
  const { G, DEST, escortUnits, empireLeader } = build();
  const r = phases.activateSystem(G, 'Empire', empireLeader, DEST,
    [{ fromSystemId: PRISON, unitInstanceIds: escortUnits }]);
  check('activation ok', r.ok, r.reason);
  check('captive auto-rescued when prison drained without escort',
    !(G.empire.capturedLeaders ?? []).some((c) => c.leaderId === 'princess-leia'));
  check('auto-rescue logged', G.turnLog.some((e) => e.kind === 'auto-rescue'));
}

console.log('\n[ validation ]');
{
  const { G, DEST, empireLeader } = build();
  // Escort request without any units moving from the prison.
  const r = phases.activateSystem(G, 'Empire', empireLeader, DEST, [], ['princess-leia']);
  check('escort with no moving units rejected', !r.ok && r.reason === 'captive-escort-needs-moving-units', r.reason);
  const r2 = phases.activateSystem(G, 'Empire', empireLeader, DEST,
    [{ fromSystemId: PRISON, unitInstanceIds: G.map.systems[PRISON].units.map((u) => u.instanceId) }], ['luke-skywalker']);
  check('escorting a non-captive rejected', !r2.ok && r2.reason === 'not-a-captured-leader', r2.reason);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
