// Online per-seat mission-set flow — server side. Exercises newInitialState()
// (human seats start UNLOCKED, an AI seat is locked with a random set at
// creation) and setSeatMissionSet() (a human seat picks its own set, gated to
// the Setup phase, idempotent once locked), against an in-memory store.
//   npx tsx scripts/verify-online-mission-set.mts

import { readFile } from 'node:fs/promises';
import { GameServer, NoopNotifier } from 'digital-boardgame-framework/server';
import type { SnapshotStore, GameMeta, SnapshotRow, BugReportRow } from 'digital-boardgame-framework/server';
import { rebellionAdapter } from '../src/adapter/rebellionAdapter';
import { makeRebellionCodec } from '../src/adapter/codec';
import { buildCatalog, createGame, type DataBundle } from '../src/engine/setup';
import { newInitialState, setSeatMissionSet, decodeSnapshot } from '../functions/_lib/gameServer';
import type { GameState } from '../src/engine/types';
import type { RebellionAction } from '../src/adapter/rebellionAction';
import type { Side } from '../src/types';

let failures = 0;
const check = (label: string, cond: boolean, extra = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${extra ? ' — ' + extra : ''}`); failures++; }
};

function memStore(): SnapshotStore {
  const metas = new Map<string, GameMeta>();
  const snaps = new Map<string, SnapshotRow[]>();
  const reports: BugReportRow[] = [];
  return {
    async putGameMeta(m) { metas.set(m.gameId, m); },
    async getGameMeta(id) { return metas.get(id) ?? null; },
    async deleteGame(id) { metas.delete(id); snaps.delete(id); },
    async putSnapshot(id, row) { const a = snaps.get(id) ?? []; a.push(row); snaps.set(id, a); },
    async getLatest(id) { const a = snaps.get(id) ?? []; return a.length ? a[a.length - 1] : null; },
    async getHistory(id) { return snaps.get(id) ?? []; },
    async putReport(r) { reports.push(r); },
    async listReports() { return reports; },
    async resolveReport() { /* no-op */ },
  };
}

async function loadData(): Promise<DataBundle> {
  const names = ['systems', 'adjacency', 'leaders', 'actions', 'missions', 'objectives', 'tactics', 'probes'] as const;
  const parsed = await Promise.all(names.map(async (n) => JSON.parse(await readFile(`assets/${n}.json`, 'utf8'))));
  const [systems, adjacency, leaders, actions, missions, objectives, tactics, probes] = parsed;
  return { systems, adjacency, leaders, actions, missions, objectives, tactics, probes } as DataBundle;
}

const data = await loadData();
const catalog = buildCatalog(data);
const codec = makeRebellionCodec(catalog);
const membership = (m: any) => m.missionSet ? m.missionSet : (m.set === 'rote' ? 'rote' : (m.leaderPortrait ? 'both' : 'base'));
const hasRote = (G: GameState, side: Side) => {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  return [...(f.missionDeck || []), ...(f.missionHand || [])]
    .some((id) => { const m = (catalog.missions as any)[id]; return m && !m.isStarting && membership(m) === 'rote'; });
};

console.log('newInitialState — seat locking at creation:');
{
  const pvp = newInitialState(data, undefined, { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true });
  check('PvP: both human seats start UNLOCKED', !pvp.expansion.missionSetLocked?.Rebel && !pvp.expansion.missionSetLocked?.Empire,
    JSON.stringify(pvp.expansion.missionSetLocked));
  check('PvP: starts in Setup phase', pvp.phase === 'Setup', pvp.phase);

  const vsAi = newInitialState(data, 'Empire', { enabled: true, roeUnits: true });
  check('vs-AI: the AI (Empire) seat is LOCKED at creation', vsAi.expansion.missionSetLocked?.Empire === true,
    JSON.stringify(vsAi.expansion.missionSetLocked));
  check('vs-AI: the human (Rebel) seat stays UNLOCKED', !vsAi.expansion.missionSetLocked?.Rebel);

  const base = newInitialState(data, undefined, { enabled: false });
  check('base game: no locks at all', base.expansion.missionSetLocked === undefined || Object.keys(base.expansion.missionSetLocked).length === 0);
}

console.log('setSeatMissionSet — human seat picks, gated to Setup phase:');
{
  const store = memStore();
  const server = new GameServer<GameState, RebellionAction, Side>({
    adapter: rebellionAdapter, codec, store, notifier: new NoopNotifier(),
    gameUrl: (id, token) => `https://example.test/?g=${id}&t=${token}`,
  });
  const initial = newInitialState(data, undefined, { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true });
  const { gameId } = await server.createGame({ initialState: initial, players: ['Rebel', 'Empire'] });

  const ok1 = await setSeatMissionSet(store, codec, gameId, 'Rebel', /* useRoe */ false, 111);
  check('Rebel picks base → applied', ok1 === true);
  let latest = await store.getLatest(gameId); let G = decodeSnapshot(codec, latest!.state);
  check('Rebel deck is now base (no rote regulars)', !hasRote(G, 'Rebel'));
  check('Rebel locked, Empire still unlocked', G.expansion.missionSetLocked?.Rebel === true && !G.expansion.missionSetLocked?.Empire);
  check('Empire still RoE (untouched)', hasRote(G, 'Empire'));

  const ok2 = await setSeatMissionSet(store, codec, gameId, 'Rebel', true, 222);
  check('Rebel picks again → refused (already locked)', ok2 === false);

  const ok3 = await setSeatMissionSet(store, codec, gameId, 'Empire', false, 333);
  check('Empire picks base → applied', ok3 === true);
  latest = await store.getLatest(gameId); G = decodeSnapshot(codec, latest!.state);
  check('now BOTH sides base, both locked', !hasRote(G, 'Empire') && G.expansion.missionSetLocked?.Empire === true && G.expansion.missionSetLocked?.Rebel === true);
}

console.log('setSeatMissionSet — refused outside the Setup phase and for AI seats:');
{
  const store = memStore();
  const server = new GameServer<GameState, RebellionAction, Side>({
    adapter: rebellionAdapter, codec, store, notifier: new NoopNotifier(),
    gameUrl: (id, token) => `https://example.test/?g=${id}&t=${token}`,
  });
  // autoSetupUnits:true starts in Assignment (past Setup) — window closed.
  const initial = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  initial.expansion.missionSetLocked = {};
  const { gameId } = await server.createGame({ initialState: initial, players: ['Rebel', 'Empire'] });
  const refused = await setSeatMissionSet(store, codec, gameId, 'Rebel', false, 1);
  check('past Setup phase → refused', refused === false);

  const store2 = memStore();
  const server2 = new GameServer<GameState, RebellionAction, Side>({
    adapter: rebellionAdapter, codec, store: store2, notifier: new NoopNotifier(),
    gameUrl: (id, token) => `https://example.test/?g=${id}&t=${token}`,
  });
  const vsAi = newInitialState(data, 'Empire', { enabled: true, roeUnits: true });
  const { gameId: gid2 } = await server2.createGame({ initialState: vsAi, players: ['Rebel', 'Empire'] });
  const aiRefused = await setSeatMissionSet(store2, codec, gid2, 'Empire', false, 1);
  check('AI seat → refused (locked at creation)', aiRefused === false);
}

console.log('');
if (failures > 0) { console.error(`ONLINE MISSION-SET CHECK FAILED: ${failures} failure(s)`); process.exit(1); }
console.log('ONLINE MISSION-SET CHECK PASSED — per-seat pick + Setup-phase gate + AI lock all work.');
