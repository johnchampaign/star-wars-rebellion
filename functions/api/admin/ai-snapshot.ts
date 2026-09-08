// Cloudflare Pages Function — GET /api/admin/ai-snapshot?gameId=<id>
// Admin-token gated (SWR_ADMIN_TOKEN). Returns ONE game's raw latest snapshot
// for the off-Cloudflare AI worker, which got the game's id from /api/admin/ai-due.
// One snapshot per request keeps each request far inside the per-request CPU
// limit (a snapshot is ~170 KB of JSON text; this parses it once and writes it
// once). Exposes UNREDACTED state — trusted worker only, never a browser.
import { makeAdminStore, requireAdmin, json, fail, type Env } from '../../_lib/gameServer';

const handler: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const gameId = new URL(request.url).searchParams.get('gameId') ?? '';
    if (!gameId) return json({ error: 'gameId required' }, 400);
    const { store } = makeAdminStore(env);               // no catalog build
    const latest = await store.getLatest(gameId);
    if (!latest) return json({ error: 'no snapshot' }, 404);
    return json({ gameId, turn: latest.turn, snapshot: latest.state });
  } catch (e) {
    return fail(e);
  }
};

export const onRequestGet = handler;
