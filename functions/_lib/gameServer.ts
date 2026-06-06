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
import { GameServer, SupabaseStore, NoopNotifier, ResendNotifier } from 'digital-boardgame-framework/server';
import type { Notifier, SnapshotStore } from 'digital-boardgame-framework/server';
import type { Codec } from 'digital-boardgame-framework';
import type { GameState, GameCatalog } from '../../src/engine/types';
import type { Side } from '../../src/types';
import type { RebellionAction } from '../../src/adapter/rebellionAction';
import { rebellionAdapter } from '../../src/adapter/rebellionAdapter';
import { makeRebellionCodec } from '../../src/adapter/codec';
import { buildCatalog, createGame, type DataBundle } from '../../src/engine/setup';
import { stepOnce } from '../../src/play/randomAI';

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
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
  // Deferred-notification model: the framework would email on EVERY turn handoff
  // (spammy during an active game). We give the framework a NoopNotifier and send
  // "your turn" ourselves only when a player has been on the clock >15 min and
  // hasn't moved (see syncTurnNotify). `notifier` here is the real Resend sender.
  const notifier = makeNotifier(env);
  const server = new GameServer<GameState, RebellionAction, Side>({
    adapter: rebellionAdapter,
    codec,
    store,
    notifier: new NoopNotifier(),
    gameUrl,
  });
  return { server, store, codec, dataBundle, supabase, notifier, gameUrl };
}

/** Request-free GameServer for the scheduled stale-turn-reminder cron. Unlike
 *  makeServer (per-request, NoopNotifier because the request path emails via
 *  syncTurnNotify), the cron's server is given the REAL Resend notifier —
 *  sweepTurnReminders fires `notifier.notifyYourTurn` itself. Needs
 *  PUBLIC_BASE_URL set (used both to load the asset bundle and to mint the
 *  seat links in the email). */
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

const TURN_EMAIL_DELAY_MS = 15 * 60 * 1000; // 15 minutes

/** Deferred "your turn" email (Option A — poll-driven). Called on every fetch
 *  and submit. Tracks, per game, who is on the clock and since when (table
 *  swr_turn_notify). When the actor changes, the clock restarts. When the same
 *  actor has been on the clock >15 min and hasn't moved, email them once. The
 *  trigger is whoever next pings the game (typically the waiting opponent's
 *  poll), so an active back-and-forth produces zero emails. Best-effort. */
export async function syncTurnNotify(
  deps: { supabase: SupabaseClient; store: SnapshotStore; notifier: Notifier; gameUrl: GameUrl },
  gameId: string,
  currentActor: Side | null,
  turn: number,
): Promise<void> {
  try {
    const { data: row } = await deps.supabase
      .from('swr_turn_notify').select('*').eq('game_id', gameId).maybeSingle();
    if (!currentActor) return; // game over / nobody to nudge
    if (!row || row.actor !== currentActor) {
      // New player on the clock — (re)start it, no email yet.
      await deps.supabase.from('swr_turn_notify').upsert({
        game_id: gameId, actor: currentActor, started_at: new Date().toISOString(), emailed: false,
      });
      return;
    }
    if (row.emailed) return;
    if (Date.now() - new Date(row.started_at).getTime() < TURN_EMAIL_DELAY_MS) return;
    const meta = await deps.store.getGameMeta(gameId);
    const email = meta?.emails?.[currentActor];
    if (meta && email) {
      await deps.notifier.notifyYourTurn({ email, gameUrl: deps.gameUrl(gameId, meta.tokens[currentActor]), gameId, turn });
    }
    // Mark emailed regardless (no email on file => nothing to retry; avoids spin).
    await deps.supabase.from('swr_turn_notify').update({ emailed: true }).eq('game_id', gameId);
  } catch {
    /* best-effort — never fail the request over a notification */
  }
}

/** A fresh two-player initial state. autoSetupUnits=false runs the real
 *  interactive Setup phase online: the Empire deploys first, then the Rebel
 *  deploys and secretly picks the hidden base (the base location and the 5
 *  candidates are redacted from the Empire). The same setup actions, adapter
 *  dispatch, online shim, UI, and AI all support this. `aiSide`, when set,
 *  marks that seat as server-AI-controlled (the AI handles its own setup). */
export function newInitialState(dataBundle: DataBundle, aiSide?: Side): GameState {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const state = createGame(dataBundle, { seed, autoSetupUnits: false });
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
function decodeSnapshot(codec: Codec<GameState>, raw: string): GameState {
  const m = /^v\d+:/.exec(raw);
  return codec.decode(m ? raw.slice(m[0].length) : raw);
}
function encodeSnapshot(codec: Codec<GameState>, state: GameState): string {
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
