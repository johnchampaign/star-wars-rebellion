// Regression test: Lure of the Dark Side must NOT hand the turned leader to the
// Empire mid-round (player report #609 — "Leia regained the leader pool
// immediately and is available the same turn; doesn't she stay on the planet
// where she was captured?").
//
// RAW, Rules Reference p.8 (Leaders): "The Imperial card 'Lure of the Dark Side'
// gives the Imperial team control of a Rebel leader until the end of the game.
// During the Refresh Phase, this leader is placed in the Imperial leader pool."
//
// So the flip leaves her standing in the system she was held in, as an Imperial
// leader ON THE BOARD; the ordinary Refresh retrieve sweep (which drains every
// leader on the board into that side's pool) is what puts her in the Imperial
// pool, one phase later. The bug pushed her straight into empire.leaderPool,
// which let the Empire activate a system with her the same round.
//
// No test framework is installed; this follows the project's tsx-script idiom.
// Exits non-zero on failure.
//
// Usage: node scripts/test-lure-dark-side-timing-609.mjs

import { readFileSync } from 'node:fs';
const mod = await import('tsx/esm/api'); mod.register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const load = (p) => JSON.parse(readFileSync(new URL(`../assets/${p}`, import.meta.url), 'utf-8'));
const data = {
  systems: load('systems.json'), adjacency: load('adjacency.json'), leaders: load('leaders.json'),
  actions: load('actions.json'), missions: load('missions.json'), objectives: load('objectives.json'),
  tactics: load('tactics.json'), probes: load('probes.json'),
};

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }

const LEADER = 'luke-skywalker';
const SYS = 'coruscant';

const G = createGame(data, { seed: 7, autoSetupUnits: true });

// Put Luke in Imperial captivity at Coruscant, exactly as Carbon Freezing /
// Imperial Entanglements would leave him, and make sure he is nowhere else.
G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== LEADER);
G.rebel.leadersOnBoard = {};
G.rebel.leadersOnMissions = [];
G.empire.capturedLeaders = [{ leaderId: LEADER, ring: 'captured', systemId: SYS }];
// An Imperial unit holds him (no Imperial units in the system would mean an
// automatic rescue, RR p.13).
G.map.systems[SYS].units = [
  { instanceId: 'e0', typeId: 'star-destroyer', side: 'Empire', damage: 0 },
];

const poolBefore = [...G.empire.leaderPool];
if (poolBefore.includes(LEADER)) fail('setup wrong: leader already in the Empire pool');

const ok = M.flipLeaderToImperial(G, LEADER);
if (!ok) fail('flipLeaderToImperial returned false for a validly captured leader');

// ASSERT 1 (the regression): he is NOT available to the Empire this round.
if (G.empire.leaderPool.includes(LEADER)) {
  fail(`${LEADER} was placed in the Empire leader pool immediately — RR p.8 says the pool `
    + 'placement happens during the Refresh Phase, not on the flip. The #609 bug is back.');
}

// ASSERT 2: he stays on the planet he was held on, now under Imperial control.
const here = G.empire.leadersOnBoard[SYS] ?? [];
if (!here.includes(LEADER)) {
  fail(`${LEADER} is not on the board at ${SYS} after the flip — he must stay where he was held `
    + `(empire.leadersOnBoard[${SYS}] = ${JSON.stringify(here)})`);
}

// ASSERT 3: he is genuinely Imperial now — dark-side ring on, captured ring off.
if (!M.hasAttachment(G, LEADER, 'dark-side')) fail('dark-side ring was not attached');
if ((G.empire.capturedLeaders ?? []).some((c) => c.leaderId === LEADER)) {
  fail('leader is still listed as a captured leader after being turned');
}

// ASSERT 4: he is fully out of Rebel state (no ghost copy the Rebel could use).
if (G.rebel.leaderPool.includes(LEADER)) fail('leader still in the Rebel pool');
for (const [sysId, list] of Object.entries(G.rebel.leadersOnBoard)) {
  if (list.includes(LEADER)) fail(`leader still on the Rebel board at ${sysId}`);
}
for (const am of G.rebel.leadersOnMissions) {
  if (am.leaderIds.includes(LEADER)) fail('leader still assigned to a Rebel mission');
}

// ASSERT 5: nothing blocks the Refresh sweep from pooling him next phase.
// refreshRetrieveLeaders drains every leader in leadersOnBoard into that side's
// pool UNLESS they were detained this round — so a detained entry here would
// silently strand him on the board forever.
const detained = (G.detainedLeadersNextRefresh ?? []).some((d) => d.leaderId === LEADER);
if (detained) fail('turned leader is marked detained — he would never reach the Empire pool');

// ASSERT 6: no other leader was disturbed by the flip.
const poolAfter = G.empire.leaderPool;
if (poolAfter.length !== poolBefore.length || poolBefore.some((l) => !poolAfter.includes(l))) {
  fail(`Empire pool changed unexpectedly: ${JSON.stringify(poolBefore)} -> ${JSON.stringify(poolAfter)}`);
}

console.log('ok — Lure of the Dark Side leaves the turned leader on the planet; '
  + 'Refresh (not the flip) places her in the Imperial pool [#609]');
