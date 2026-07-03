// Per-request GameServer factory for Cloudflare Pages Functions (online play).
//
// CF Functions run as V8 isolates that persist module-level state across
// requests within an isolate, so we cache the Supabase client, the asset
// DataBundle, and the built catalog at module scope. The GameServer itself is
// cheap to construct per request.
//
// Required env (Cloudflare Pages → Settings → Environment variables, encrypted;
// already set for the Production scope — add the same to the Preview scope to
// test a branch preview):
//   SUPABASE_URL               — https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  — service-role key (NEVER shipped to the client)
// Optional:
//   PUBLIC_BASE_URL            — absolute origin for invite/turn links;
//                                falls back to the request origin.
//
// Apply the framework schema once to the Supabase project:
//   node_modules/digital-boardgame-framework/supabase/schema.sql  (idempotent)
//
// Import the framework server pieces from the './server' barrel — in 0.5.0 the
// node-only FsStore lives in './server/node', so the barrel is Workers-safe.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { GameServer, SupabaseStore, NoopNotifier, ResendNotifier, SupabaseBroadcaster, verifyIdentityToken } from 'digital-boardgame-framework/server';
import type { Notifier, SnapshotStore, Jwks } from 'digital-boardgame-framework/server';
import type { Codec } from 'digital-boardgame-framework';
import type { GameState, GameCatalog } from '../../src/engine/types';
import type { Side } from '../../src/types';
import type { RebellionAction } from '../../src/adapter/rebellionAction';
import { rebellionAdapter } from '../../src/adapter/rebellionAdapter';
import { makeRebellionCodec } from '../../src/adapter/codec';
import { buildCatalog, createGame, type DataBundle } from '../../src/engine/setup';
import { stepOnce } from '../../src/play/randomAI';

const HUB = 'https://games-hub-5vo.pages.dev';
let _jwks: Jwks | undefined;
let _jwksAt = 0;
async function getJwks(): Promise<Jwks> {
  if (!_jwks || Date.now() - _jwksAt > 3_600_000) {
    _jwks = (await (await fetch(`${HUB}/id/jwks`)).json()) as Jwks;
    _jwksAt = Date.now();
  }
  return _jwks;
}

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Shared secret matching the hub's RATINGS_INGEST_KEY (enables ranked play). */
  RATINGS_INGEST_KEY?: string;
  PUBLIC_BASE_URL?: string;
  // Optional — when both are set, players get a "your turn" email (Phase 5).
  // Until then we use NoopNotifier and nothing is sent.
  RESEND_API_KEY?: string;
  RESEND_FROM?: string; // a verified Resend sender, e.g. "Rebellion <play@yourdomain>"
  // Abandonment grace (ms) before the present player may take over / claim.
  // Default 3 days; lower it for testing.
  ABANDON_GRACE_MS?: string;
  // Optional shared token gating the /api/cron/sweep-reminders endpoint. When
  // unset the endpoint is open (a sweep is idempotent and only sends already-
  // due reminders — "we send an email at most"). When set, callers must send
  // a matching `x-cron-key` header. Set the SAME value on the cron Worker if
  // you enable it.
  CRON_SECRET?: string;
  // Shared secret gating the /api/admin/ai-* endpoints, which let an off-
  // Cloudflare AI worker (e.g. the Linode box) fetch full game state and submit
  // computed moves. Unlike the idempotent, read-only cron sweep (which fails
  // OPEN), these endpoints expose unredacted secret state and accept writes, so
  // they MUST fail CLOSED: if SWR_ADMIN_TOKEN is unset, every request is denied.
  SWR_ADMIN_TOKEN?: string;
  // When set (any value), Cloudflare stops advancing AI seats inline (on submit
  // and on the poll self-heal), handing sole AI-move ownership to the off-
  // Cloudflare worker so its stronger depth-2 moves aren't pre-empted by the
  // inline heuristic. Leave UNSET until the worker is verified running — with it
  // set and no worker up, AI turns pause until a worker appears. (Running both
  // is safe — optimistic concurrency prevents double-moves — this only decides
  // who plays the AI's move.)
  AI_WORKER_ENABLED?: string;
}

/** Resend turn-alert emails when configured, else a no-op. The framework's
 *  GameServer fires notifier.notifyYourTurn whenever a submit hands the turn to
 *  a new actor that has an email on file. */
function makeNotifier(env: Env): Notifier {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return new NoopNotifier();
  return new ResendNotifier({
    apiKey: env.RESEND_API_KEY,
    from: env.RESEND_FROM,
    subject: () => "It's your turn — Star Wars: Rebellion",
    htmlBody: (a) =>
      `<p>Your move is ready in your game of <b>Star Wars: Rebellion</b> (turn ${a.turn}).</p>` +
      `<p><a href="${a.gameUrl}">Open the game</a> and take your turn.</p>` +
      `<p style="color:#888;font-size:12px">You're receiving this because someone created an async game with your email. The link above is your private seat — don't share it.</p>`,
  });
}

/** Invite email, sent once at game creation to each seat that has an email on
 *  file. Distinct from the turn nudge: this is "here's your private link, come
 *  play". Best-effort — no-ops if Resend isn't configured. */
export async function sendInviteEmail(
  env: Env,
  args: { to: string; gameUrl: string; side: Side },
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return;
  const { to, gameUrl, side } = args;
  const html =
    `<p>You've been invited to play <b>Star Wars: Rebellion</b> as the <b>${side}</b>.</p>` +
    `<p><a href="${gameUrl}">Open your game</a> and take your first turn.</p>` +
    `<p>It's a play-by-cloud game: take your turn whenever you like, then it's your opponent's move. ` +
    `If it becomes your turn and you've been away a while, we'll email you a nudge.</p>` +
    `<p style="color:#888;font-size:12px">The link above is your private seat — don't share it.</p>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM, to,
      subject: `You're invited to a game of Star Wars: Rebellion (${side})`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend invite failed: ${res.status} ${await res.text()}`);
}

type Server = GameServer<GameState, RebellionAction, Side>;

let _supabase: SupabaseClient | null = null;
let _dataBundle: DataBundle | null = null;
let _catalog: GameCatalog | null = null;

function getSupabase(env: Env): SupabaseClient {
  if (_supabase) return _supabase;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them in Cloudflare ' +
      'Pages → Settings → Environment variables (and the Preview scope for branch previews).',
    );
  }
  _supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

/** Load the asset DataBundle by fetching the catalog JSON that ships in the
 *  deploy under /dev-assets/ (vite copies assets/ → dist/dev-assets/, and the
 *  strip-images step keeps the .json files). Cached per isolate. */
async function getDataBundle(request: Request): Promise<DataBundle> {
  return getDataBundleFromOrigin(new URL(request.url).origin);
}

/** Origin-based DataBundle loader (no Request needed) — used by the cron
 *  Worker, which has no incoming request to derive an origin from. */
async function getDataBundleFromOrigin(origin: string): Promise<DataBundle> {
  if (_dataBundle) return _dataBundle;
  const files = ['systems', 'adjacency', 'leaders', 'actions', 'missions', 'objectives', 'tactics', 'probes'] as const;
  const responses = await Promise.all(files.map((f) => fetch(`${origin}/dev-assets/${f}.json`)));
  responses.forEach((r, i) => {
    if (!r.ok) throw new Error(`Failed to load /dev-assets/${files[i]}.json (${r.status})`);
  });
  const [systems, adjacency, leaders, actions, missions, objectives, tactics, probes] =
    await Promise.all(responses.map((r) => r.json()));
  _dataBundle = { systems, adjacency, leaders, actions, missions, objectives, tactics, probes } as DataBundle;
  return _dataBundle;
}

async function getCatalog(request: Request): Promise<GameCatalog> {
  if (_catalog) return _catalog;
  _catalog = buildCatalog(await getDataBundle(request));
  return _catalog;
}

/** Build a GameServer for this request, plus the DataBundle (needed to mint a
 *  fresh initial state when creating a game). */
type GameUrl = (gameId: string, token: string) => string;

export async function makeServer(request: Request, env: Env): Promise<{
  server: Server; store: SnapshotStore; codec: Codec<GameState>; dataBundle: DataBundle;
  supabase: SupabaseClient; notifier: Notifier; gameUrl: GameUrl;
}> {
  const catalog = await getCatalog(request);
  const dataBundle = await getDataBundle(request);
  const base = env.PUBLIC_BASE_URL || new URL(request.url).origin;
  const codec = makeRebellionCodec(catalog);
  const supabase = getSupabase(env);
  const store: SnapshotStore = new SupabaseStore(supabase);
  const gameUrl: GameUrl = (gameId, token) => `${base}/?g=${encodeURIComponent(gameId)}&t=${encodeURIComponent(token)}`;
  // The request path never emails turn nudges (the framework would email on
  // EVERY handoff — spammy). All turn-reminder email is done by the scheduled
  // sweep (makeCronServer's GameServer, with the real Resend notifier), so the
  // per-request server gets a NoopNotifier. `notifier` is still returned for
  // the invite path, though sendInviteEmail talks to Resend directly.
  const notifier = makeNotifier(env);
  // Realtime broadcaster: server.postMessage / submit fan a signal-only ping
  // over Supabase Realtime so clients refresh instantly (they still poll as a
  // fallback). Service-key, server-side only.
  const broadcaster = new SupabaseBroadcaster({
    supabaseUrl: env.SUPABASE_URL!,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY!,
  });
  const server = new GameServer<GameState, RebellionAction, Side>({
    snapshotHistory: 20,   // cap per-game snapshot history (framework >=0.32)
    adapter: rebellionAdapter,
    codec,
    store,
    notifier: new NoopNotifier(),
    broadcaster,
    gameUrl,
    // Best-effort play counter: createGame fires an 'online' beacon to the
    // games hub so it can tally games-played per game. Never affects
    // createGame's result (failures/timeouts are swallowed). Hotseat/AI
    // starts call recordPlay() client-side instead.
    playBeacon: { appId: 'rebellion' },
    // Ranked play: verify hub identity tokens (claimSeat) + auto-report results.
    verifyIdentity: async (t) => verifyIdentityToken(t, await getJwks()),
    ...(env.RATINGS_INGEST_KEY
      ? { ratings: { game: 'rebellion', ingestKey: env.RATINGS_INGEST_KEY } }
      : {}),
  });
  return { server, store, codec, dataBundle, supabase, notifier, gameUrl };
}

/** Request-free GameServer for the scheduled stale-turn-reminder cron. Unlike
 *  makeServer (per-request, NoopNotifier — the request path never emails turn
 *  nudges), the cron's server is given the REAL Resend notifier, since
 *  sweepTurnReminders fires `notifier.notifyYourTurn` itself. This is the ONLY
 *  path that sends turn-reminder email. Needs PUBLIC_BASE_URL (or a request
 *  origin) — used to load the asset bundle and mint the seat links. */
export async function makeCronServer(env: Env, originFallback?: string): Promise<{ server: Server }> {
  const base = env.PUBLIC_BASE_URL || originFallback;
  if (!base) {
    throw new Error('PUBLIC_BASE_URL (or a request origin) is required for the reminder sweep.');
  }
  const dataBundle = await getDataBundleFromOrigin(base);
  const catalog = _catalog ?? (_catalog = buildCatalog(dataBundle));
  const codec = makeRebellionCodec(catalog);
  const store: SnapshotStore = new SupabaseStore(getSupabase(env));
  const gameUrl: GameUrl = (gameId, token) => `${base}/?g=${encodeURIComponent(gameId)}&t=${encodeURIComponent(token)}`;
  const server = new GameServer<GameState, RebellionAction, Side>({
    adapter: rebellionAdapter,
    codec,
    store,
    notifier: makeNotifier(env), // REAL Resend — the sweep sends directly
    gameUrl,
  });
  return { server };
}

/** Record who is on the clock and since when, per game (table
 *  swr_turn_notify). Called on every fetch and submit. When the actor changes,
 *  the clock restarts with a fresh `started_at` = the real moment the turn was
 *  handed over.
 *
 *  This NO LONGER sends email — turn-reminder emails are handled solely by the
 *  scheduled sweep (GameServer.sweepTurnReminders, fired by the cron Worker),
 *  so a player gets at most one nudge per turn whether or not a client is open.
 *  The timing recorded here is still used by abandonment detection
 *  (isSideAbandoned / turnStartedAt). Best-effort. */
export async function recordTurnTiming(
  supabase: SupabaseClient,
  gameId: string,
  currentActor: Side | null,
  actorIsAi = false,
): Promise<void> {
  try {
    if (!currentActor) return; // game over / nobody on the clock
    const { data: row } = await supabase
      .from('swr_turn_notify').select('actor').eq('game_id', gameId).maybeSingle();
    if (row && row.actor === currentActor) return; // same actor — clock already running
    // New player on the clock — (re)start it from this real handoff moment. Also
    // stamp actor_is_ai so /api/admin/ai-due can find AI-due games with a single
    // indexed query instead of scanning + decoding every active game (#perf). The
    // column is optional: if the migration hasn't run yet, retry without it so
    // timing bookkeeping (abandonment) still works.
    const full = {
      game_id: gameId, actor: currentActor,
      started_at: new Date().toISOString(), emailed: false, actor_is_ai: actorIsAi,
    };
    const { error } = await supabase.from('swr_turn_notify').upsert(full);
    if (error) {
      const { actor_is_ai: _drop, ...base } = full;
      void _drop;
      await supabase.from('swr_turn_notify').upsert(base);
    }
  } catch {
    /* best-effort — never fail the request over timing bookkeeping */
  }
}

/** A fresh two-player initial state. autoSetupUnits=false runs the real
 *  interactive Setup phase online: the Empire deploys first, then the Rebel
 *  deploys and secretly picks the hidden base (the base location and the 5
 *  candidates are redacted from the Empire). The same setup actions, adapter
 *  dispatch, online shim, UI, and AI all support this. `aiSide`, when set,
 *  marks that seat as server-AI-controlled (the AI handles its own setup). */
export function newInitialState(
  dataBundle: DataBundle,
  aiSide?: Side,
  expansion?: Partial<import('../../src/types').ExpansionConfig>,
): GameState {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const state = createGame(dataBundle, { seed, autoSetupUnits: false, expansion });
  if (aiSide) state.aiSides = [aiSide];
  return state;
}

/** Step the server-side heuristic AI — the SAME stepOnce() that drives the
 *  single-player hotseat — while it's an AI seat's turn. Mutates `state`;
 *  returns whether it advanced the game. Bounded to avoid any spin. */
export function runServerAI(state: GameState): boolean {
  const ai = state.aiSides;
  if (!ai || ai.length === 0) return false;
  let advanced = false;
  for (let i = 0; i < 4000; i++) {
    if (state.isGameOver) break;
    const actor = rebellionAdapter.currentActor(state);
    if (!actor || !ai.includes(actor)) break; // human's turn (or no actor) — stop.
    let did = false;
    try { did = stepOnce(state, actor); } catch { break; }
    if (!did) break; // AI couldn't resolve its own step — stop rather than spin.
    advanced = true;
  }
  return advanced;
}

/** After a human move (or at game creation), let the AI take its turn(s) and
 *  persist the result as the next snapshot. Returns true if it advanced (caller
 *  should re-fetch the human's view). Operates at the state/store level —
 *  deliberately bypassing the token-gated server.submit, since the AI has no
 *  client token. */
// The framework wraps each stored snapshot as `v<schemaVersion>:` + codec
// output (GameServer.encode/decodeSnapshot). We must match that format when we
// read/write snapshots directly for AI moves, or the framework can't decode our
// writes (and we can't decode its reads).
function snapshotPrefix(): string {
  return `v${rebellionAdapter.schemaVersion ?? 1}:`;
}
export function decodeSnapshot(codec: Codec<GameState>, raw: string): GameState {
  const m = /^v\d+:/.exec(raw);
  return codec.decode(m ? raw.slice(m[0].length) : raw);
}
export function encodeSnapshot(codec: Codec<GameState>, state: GameState): string {
  return snapshotPrefix() + codec.encode(state);
}

export async function advanceAIAndStore(store: SnapshotStore, codec: Codec<GameState>, gameId: string): Promise<boolean> {
  const latest = await store.getLatest(gameId);
  if (!latest) return false;
  const state = decodeSnapshot(codec, latest.state);
  if (!runServerAI(state)) return false;
  await store.putSnapshot(gameId, { turn: latest.turn + 1, state: encodeSnapshot(codec, state) });
  return true;
}

// ---------------------------------------------------------------------------
// AI-worker admin surface (/api/admin/ai-*). Lets an off-Cloudflare worker
// (the Linode box) fetch full state, compute a stronger move with no CPU limit,
// and submit it back. The worker authenticates with SWR_ADMIN_TOKEN.
// ---------------------------------------------------------------------------

/** Constant-time string compare (avoids leaking the token via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Gate an admin request. Returns a 401 Response to return, or null if allowed.
 *  FAILS CLOSED: an unset SWR_ADMIN_TOKEN denies everything (these endpoints
 *  expose secret state + accept writes, so they must never be open by default).
 *  Accepts the token via `Authorization: Bearer <t>` or an `x-admin-token`
 *  header. */
export function requireAdmin(request: Request, env: Env): Response | null {
  const expected = env.SWR_ADMIN_TOKEN;
  if (!expected) return json({ error: 'admin endpoint disabled (no SWR_ADMIN_TOKEN configured)' }, 503);
  const auth = request.headers.get('authorization') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
  const supplied = bearer ?? request.headers.get('x-admin-token') ?? '';
  if (!supplied || !timingSafeEqual(supplied, expected)) return json({ error: 'unauthorized' }, 401);
  return null;
}

export interface AiDueGame { gameId: string; turn: number; actor: Side; snapshot: string; }

/** Every active game where it's an AI seat's turn (and the game isn't over),
 *  with the raw latest snapshot so the worker can decode + compute locally.
 *
 *  Candidate selection: when `supabase` is given, ONE indexed query on
 *  swr_turn_notify(actor_is_ai) narrows to just the AI-due games (written by
 *  recordTurnTiming), so we decode a handful, not every active game. If that
 *  column doesn't exist yet (migration not run) the query throws and we fall
 *  back to the full listActiveGames scan — correct, just slower. Either way each
 *  candidate is RE-VERIFIED by decoding (the flag is a superset — a game the
 *  worker just moved may still be flagged until the next timing write). A decode
 *  failure on one game is skipped, never fatal. */
export async function listAiDueGames(
  store: SnapshotStore, codec: Codec<GameState>, supabase?: SupabaseClient,
): Promise<AiDueGame[]> {
  let candidateIds: string[] | null = null;
  if (supabase) {
    const { data, error } = await supabase
      .from('swr_turn_notify').select('game_id').eq('actor_is_ai', true);
    if (!error && data) candidateIds = data.map((r) => r.game_id as string);
  }
  const ids = candidateIds ?? (await store.listActiveGames()).map((m) => m.gameId);
  const due: AiDueGame[] = [];
  for (const gameId of ids) {
    try {
      const latest = await store.getLatest(gameId);
      if (!latest) continue;
      const state = decodeSnapshot(codec, latest.state);
      if (state.isGameOver) continue;
      const actor = rebellionAdapter.currentActor(state);
      if (actor && state.aiSides?.includes(actor)) {
        due.push({ gameId, turn: latest.turn, actor, snapshot: latest.state });
      }
    } catch { /* skip a game whose snapshot won't decode */ }
  }
  return due;
}

/** Store a worker-computed snapshot with optimistic concurrency. Rejects if:
 *  the game is gone, another writer advanced it (baseTurn stale — the inline
 *  path or a second worker moved first), the CURRENT actor wasn't an AI seat
 *  (never let the worker move a human's turn), or the new snapshot won't decode.
 *  Returns a {ok, reason, status} the endpoint maps to HTTP. */
export async function applyAiWorkerMove(
  store: SnapshotStore, codec: Codec<GameState>,
  gameId: string, baseTurn: number, newSnapshot: string,
): Promise<{ ok: boolean; reason?: string; status: number }> {
  const latest = await store.getLatest(gameId);
  if (!latest) return { ok: false, reason: 'game-not-found', status: 404 };
  if (latest.turn !== baseTurn) return { ok: false, reason: `stale:${latest.turn}!=${baseTurn}`, status: 409 };
  let priorActor: Side | null;
  try {
    const prior = decodeSnapshot(codec, latest.state);
    if (prior.isGameOver) return { ok: false, reason: 'game-over', status: 409 };
    priorActor = rebellionAdapter.currentActor(prior);
    if (!priorActor || !prior.aiSides?.includes(priorActor)) {
      return { ok: false, reason: 'not-an-ai-turn', status: 409 };
    }
  } catch { return { ok: false, reason: 'prior-decode-failed', status: 500 }; }
  // Validate the incoming snapshot actually decodes to a real state before we
  // persist it — a trusted-but-buggy worker must not be able to corrupt a game.
  try {
    const next = decodeSnapshot(codec, newSnapshot);
    void next;
  } catch { return { ok: false, reason: 'new-snapshot-invalid', status: 400 }; }
  await store.putSnapshot(gameId, { turn: baseTurn + 1, state: newSnapshot });
  return { ok: true, status: 200 };
}


// ----- Abandonment handling (Part 2) -----

const DEFAULT_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export function otherSide(s: Side): Side { return s === 'Rebel' ? 'Empire' : 'Rebel'; }

/** When did the current turn start? (from swr_turn_notify). null if unknown. */
export async function turnStartedAt(supabase: SupabaseClient, gameId: string): Promise<string | null> {
  const { data } = await supabase.from('swr_turn_notify').select('started_at').eq('game_id', gameId).maybeSingle();
  return data?.started_at ?? null;
}

/** True if `side` is the current actor AND has been on the clock past the grace
 *  period — i.e. the opponent may take over or claim the win. */
export async function isSideAbandoned(supabase: SupabaseClient, gameId: string, side: Side, env: Env): Promise<boolean> {
  const grace = Number(env.ABANDON_GRACE_MS) || DEFAULT_GRACE_MS;
  const { data } = await supabase.from('swr_turn_notify').select('*').eq('game_id', gameId).maybeSingle();
  if (!data || data.actor !== side) return false;
  return Date.now() - new Date(data.started_at).getTime() >= grace;
}

async function mutateStored(
  store: SnapshotStore, codec: Codec<GameState>, gameId: string, fn: (s: GameState) => boolean,
): Promise<boolean> {
  const latest = await store.getLatest(gameId);
  if (!latest) return false;
  const state = decodeSnapshot(codec, latest.state);
  if (!fn(state)) return false;
  await store.putSnapshot(gameId, { turn: latest.turn + 1, state: encodeSnapshot(codec, state) });
  return true;
}

/** Hand a seat to the server AI (abandonment takeover); play its turn at once. */
export function setSeatAI(store: SnapshotStore, codec: Codec<GameState>, gameId: string, side: Side): Promise<boolean> {
  return mutateStored(store, codec, gameId, (s) => {
    const set = new Set<Side>(s.aiSides ?? []);
    set.add(side);
    s.aiSides = [...set];
    runServerAI(s);
    return true;
  });
}

/** Return an AI-held seat to its human (they came back). */
export function reclaimSeat(store: SnapshotStore, codec: Codec<GameState>, gameId: string, side: Side): Promise<boolean> {
  return mutateStored(store, codec, gameId, (s) => {
    if (!s.aiSides?.includes(side)) return false;
    s.aiSides = s.aiSides.filter((x) => x !== side);
    return true;
  });
}

/** End the game in `winner`'s favour (abandonment claim). */
export function claimVictory(store: SnapshotStore, codec: Codec<GameState>, gameId: string, winner: Side): Promise<boolean> {
  return mutateStored(store, codec, gameId, (s) => {
    if (s.isGameOver) return false;
    s.isGameOver = true;
    s.winner = winner;
    s.winReason = 'Opponent abandoned the game';
    return true;
  });
}

/** Whose turn it is, derived from a ViewResult (2-player). */
export function currentActorOf(v: { you?: string; yourTurn: boolean; gameOver: boolean }): Side | null {
  if (v.gameOver || !v.you) return null;
  const you = v.you as Side;
  return v.yourTurn ? you : you === 'Rebel' ? 'Empire' : 'Rebel';
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Map a thrown error to a JSON response. Bad token / illegal action / missing
 *  game surface as 400s; missing config as 500. */
export function fail(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e);
  const status = /missing supabase|env/i.test(msg) ? 500 : 400;
  return json({ error: msg }, status);
}
