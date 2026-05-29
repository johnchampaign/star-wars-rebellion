// Per-request GameServer factory for Cloudflare Pages Functions.
//
// CF Functions run as V8 isolates that persist module-level state across
// requests within an isolate. We cache the Supabase client and the static
// catalog data (systems/leaders/missions/etc) at module scope; the GameServer
// itself is cheap to construct per request.
//
// Required env vars (Cloudflare Pages → Settings → Environment variables):
//   SUPABASE_URL                  — e.g. https://abc123.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     — service role key (NEVER ship to client)
//
// Optional env vars:
//   PUBLIC_BASE_URL               — e.g. https://framework-port.star-wars-rebellion.pages.dev
//                                   used to build invite URLs in createGame results.
//                                   Falls back to request.url's origin.
//
// Notifier is NoopNotifier in Phase 2 — async email-on-your-turn is a
// follow-on. The framework supports plugging in ResendNotifier later
// without code changes here.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// NOTE: we import SupabaseStore / NoopNotifier / GameServer via the
// framework's per-module subpath exports rather than its '/server' barrel.
// The barrel re-exports FsStore which imports node:fs, and even with
// "sideEffects":false esbuild can't always prove the re-export is safe
// to drop — going through subpaths sidesteps it. node:fs isn't available
// on Cloudflare Workers, so the barrel import causes a deploy-time
// "No such module" error.
import { GameServer } from 'digital-boardgame-framework/server/game-server';
import { SupabaseStore } from 'digital-boardgame-framework/server/stores/supabase';
import { NoopNotifier } from 'digital-boardgame-framework/server/notifiers/noop';
import { jsonCodec } from 'digital-boardgame-framework';
import type { GameState } from '../../src/engine/types';
import type { Side } from '../../src/types';
import type { RebellionAction } from '../../src/adapter/rebellionAction';
import { rebellionAdapter } from '../../src/adapter/rebellionAdapter';
import { createGame, type DataBundle } from '../../src/engine/setup';

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PUBLIC_BASE_URL?: string;
}

// ---- module-scoped caches (warm across requests within an isolate) ----

let _supabase: SupabaseClient | null = null;
let _dataBundle: DataBundle | null = null;

function getSupabase(env: Env): SupabaseClient {
  if (_supabase) return _supabase;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. ' +
      'Set them in Cloudflare Pages → Settings → Environment variables.',
    );
  }
  _supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

/** Load the engine catalog by fetching the JSON files from the same origin
 *  the function is serving. Cached across requests in the isolate.
 *
 *  NOTE: the catalog JSON is served under /dev-assets/ (not /assets/) — the
 *  hotseat client (src/data/loadAssets.ts) loads from the same path, and
 *  vite copies the repo's assets/ into dist/dev-assets/. Fetching /assets/
 *  returns the SPA index.html (200 text/html), which then fails JSON.parse
 *  with "Unexpected token '<'". */
async function getDataBundle(request: Request): Promise<DataBundle> {
  if (_dataBundle) return _dataBundle;
  const origin = new URL(request.url).origin;
  const files = [
    'systems', 'adjacency', 'leaders', 'actions',
    'missions', 'objectives', 'tactics', 'probes',
  ] as const;
  const responses = await Promise.all(
    files.map(f => fetch(`${origin}/dev-assets/${f}.json`)),
  );
  for (let i = 0; i < responses.length; i++) {
    if (!responses[i].ok) {
      throw new Error(`Failed to load /dev-assets/${files[i]}.json (${responses[i].status})`);
    }
  }
  const [systems, adjacency, leaders, actions, missions, objectives, tactics, probes] =
    await Promise.all(responses.map(r => r.json()));
  _dataBundle = { systems, adjacency, leaders, actions, missions, objectives, tactics, probes } as DataBundle;
  return _dataBundle;
}

/** Construct a GameServer wired to Supabase + the Rebellion adapter. */
export function makeGameServer(env: Env, request: Request)
  : GameServer<GameState, RebellionAction, Side>
{
  const baseUrl = env.PUBLIC_BASE_URL ?? new URL(request.url).origin;
  return new GameServer<GameState, RebellionAction, Side>({
    adapter: rebellionAdapter,
    codec: jsonCodec<GameState>(),
    store: new SupabaseStore(getSupabase(env)),
    notifier: new NoopNotifier(),
    gameUrl: (gameId, token) =>
      `${baseUrl}/play/${gameId}?as=${encodeURIComponent(token)}`,
  });
}

/** Create an initial GameState for a new online game. Uses the same
 *  createGame() the hotseat path uses, with autoSetupUnits=true so the
 *  game lands in Assignment phase immediately (skipping the interactive
 *  Setup phase that's hard to drive over the network in Phase 2). */
export async function makeInitialState(env: Env, request: Request, seed: number): Promise<GameState> {
  const data = await getDataBundle(request);
  return createGame(data, { seed, autoSetupUnits: true });
}

/** JSON response helper matching the existing functions/api/* style. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Try/catch wrapper that turns thrown errors into 4xx/5xx JSON. */
export async function safe<T>(handler: () => Promise<T>): Promise<Response> {
  try {
    const result = await handler();
    return json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Common GameServer errors → 4xx.
    const status =
      msg === 'Game not found'   ? 404
    : msg === 'Invalid token'    ? 401
    : msg === 'Not your turn'    ? 403
    : msg === 'Illegal action'   ? 422
    : msg === 'No snapshot'      ? 404
    : 500;
    return json({ ok: false, error: msg }, status);
  }
}

/** Extract the `?as=TOKEN` query parameter, or throw 'Invalid token'. */
export function getToken(request: Request): string {
  const url = new URL(request.url);
  const tok = url.searchParams.get('as');
  if (!tok) throw new Error('Invalid token');
  return tok;
}
