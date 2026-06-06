// Local end-to-end smoke test of the online stack — GameServer + rebellion
// adapter + multiplayer codec + an in-memory store. No Supabase, no deploy.
//   npx tsx scripts/verify-online-local.mts
// Proves: token->seat auth, per-seat redaction THROUGH the server, and the
// create -> fetch -> submit -> turn-flip write path (codec round-trip incl.
// pending state). Exits non-zero on failure.

import { readFile } from 'node:fs/promises';
import { GameServer, NoopNotifier } from 'digital-boardgame-framework/server';
import type { SnapshotStore, GameMeta, SnapshotRow, BugReportRow } from 'digital-boardgame-framework/server';
import { rebellionAdapter } from '../src/adapter/rebellionAdapter';
import { makeRebellionCodec } from '../src/adapter/codec';
import { buildCatalog, createGame, type DataBundle } from '../src/engine/setup';
import { HIDDEN } from '../src/adapter/redact';
import type { GameState } from '../src/engine/types';
import type { RebellionAction } from '../src/adapter/rebellionAction';
import type { Side } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}`); failures++; }
}

// ---- in-memory SnapshotStore ----
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
const server = new GameServer<GameState, RebellionAction, Side>({
  adapter: rebellionAdapter,
  codec: makeRebellionCodec(catalog),
  store: memStore(),
  notifier: new NoopNotifier(),
  gameUrl: (id, token) => `https://example.test/?g=${id}&t=${token}`,
});

const initial = createGame(data, { seed: 42, autoSetupUnits: true });
console.log(`initial phase: ${initial.phase}, currentPlayer: ${initial.currentPlayer}`);

const { gameId, invites } = await server.createGame({ initialState: initial, players: ['Rebel', 'Empire'] });
check('createGame returns a gameId', typeof gameId === 'string' && gameId.length > 0);
check('createGame returns both seat invites', !!invites.Rebel && !!invites.Empire && invites.Rebel !== invites.Empire);

// invites are share-link URLs (gameUrl); the auth token is the `t` query param,
// exactly as the client will extract it when a player opens their link.
const tokenFor = (side: Side): string => new URL(invites[side]).searchParams.get('t') ?? '';

console.log('Token -> seat + redaction through the server:');
const eView = await server.fetch(gameId, tokenFor('Empire'));
const rView = await server.fetch(gameId, tokenFor('Rebel'));
check('empire token authenticates as Empire seat', eView.you === 'Empire');
check('rebel token authenticates as Rebel seat', rView.you === 'Rebel');
check('Empire view has the base REDACTED', eView.view.rebelBaseSystemId === HIDDEN);
check('Rebel view sees its own base', rView.view.rebelBaseSystemId !== HIDDEN);
check('exactly one side has the turn', eView.yourTurn !== rView.yourTurn);
// NB: the base system id is a normal board map key in EVERY view (all systems
// are on the board); the secret is WHICH system is the base — i.e. the
// rebelBaseSystemId field — and that is HIDDEN above. (The redact unit test
// does the full no-leak string scan against a synthetic off-board base.)

console.log('Submit -> turn advances:');
const actorSide: Side = rView.yourTurn ? 'Rebel' : 'Empire';
const actorToken = tokenFor(actorSide);
const beforeTurn = rView_turn(rView, eView);
let submitted = false;
try {
  // skipAssignment is legal for the active player during the Assignment phase.
  const after = await server.submit(gameId, actorToken, { kind: 'skipAssignment' });
  submitted = true;
  check('turn number advanced after submit', after.turn === beforeTurn + 1);
  const otherSide: Side = actorSide === 'Rebel' ? 'Empire' : 'Rebel';
  const otherView = await server.fetch(gameId, tokenFor(otherSide));
  check('the turn passed to the other seat', otherView.yourTurn === true);
} catch (e) {
  console.error(`  (submit skipAssignment not legal in phase ${initial.phase}: ${(e as Error).message})`);
}
check('a submit was exercised', submitted);

function rView_turn(a: { turn: number }, b: { turn: number }): number {
  return Math.max(a.turn, b.turn);
}

console.log('');
if (failures > 0) { console.error(`ONLINE LOCAL CHECK FAILED: ${failures} failure(s)`); process.exit(1); }
console.log('ONLINE LOCAL CHECK PASSED — create / auth / redact / submit all work end-to-end.');
