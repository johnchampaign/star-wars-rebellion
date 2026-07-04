// Cloudflare Pages Function — GET /api/admin/ai-due
// Admin-token gated (SWR_ADMIN_TOKEN). Returns every active game where it's an
// AI seat's turn, with the raw latest snapshot, so an off-Cloudflare worker can
// decode + compute a stronger move locally (no per-request CPU limit) and post
// it back via /api/admin/ai-move.
//
// Auth: `Authorization: Bearer <SWR_ADMIN_TOKEN>` (or `x-admin-token`). FAILS
// CLOSED — see requireAdmin. This surface exposes UNREDACTED state (base
// location, hands), which is why it must only ever be reached by the trusted
// worker, never a browser.
import { makeAdminDeps, requireAdmin, listAiDueGames, json, fail, type Env } from '../../_lib/gameServer';

const handler: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const { store, codec, supabase } = await makeAdminDeps(request, env);
    const games = await listAiDueGames(store, codec, supabase);
    return json({ games });
  } catch (e) {
    return fail(e);
  }
};

export const onRequestGet = handler;
export const onRequestPost = handler;
