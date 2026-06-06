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
import { GameServer, SupabaseStore, NoopNotifier } from 'digital-boardgame-framework/server';
import type { GameState, GameCatalog } from '../../src/engine/types';
import type { Side } from '../../src/types';
import type { RebellionAction } from '../../src/adapter/rebellionAction';
import { rebellionAdapter } from '../../src/adapter/rebellionAdapter';
import { makeRebellionCodec } from '../../src/adapter/codec';
import { buildCatalog, createGame, type DataBundle } from '../../src/engine/setup';

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PUBLIC_BASE_URL?: string;
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
  if (_dataBundle) return _dataBundle;
  const origin = new URL(request.url).origin;
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
export async function makeServer(request: Request, env: Env): Promise<{ server: Server; dataBundle: DataBundle }> {
  const catalog = await getCatalog(request);
  const dataBundle = await getDataBundle(request);
  const base = env.PUBLIC_BASE_URL || new URL(request.url).origin;
  const server = new GameServer<GameState, RebellionAction, Side>({
    adapter: rebellionAdapter,
    codec: makeRebellionCodec(catalog),
    store: new SupabaseStore(getSupabase(env)),
    notifier: new NoopNotifier(), // Phase 5 swaps in ResendNotifier for turn emails.
    gameUrl: (gameId, token) => `${base}/?g=${encodeURIComponent(gameId)}&t=${encodeURIComponent(token)}`,
  });
  return { server, dataBundle };
}

/** A fresh two-player initial state. autoSetupUnits=true keeps the first online
 *  MVP simple (no manual setup-phase UI yet); revisit for a full setup flow. */
export function newInitialState(dataBundle: DataBundle): GameState {
  const seed = Math.floor(Math.random() * 2 ** 31);
  return createGame(dataBundle, { seed, autoSetupUnits: true });
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
