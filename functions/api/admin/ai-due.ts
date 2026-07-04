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
import { makeAdminDeps, requireAdmin, listAiDueGames, raceTimeout, json, fail, type Env } from '../../_lib/gameServer';

const handler: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    // Temporary diagnostic: time-box each stage so a hang RETURNS where it
    // stalled (deps build vs the swr_turn_notify query vs getLatest) instead of
    // hanging until the platform kills the request. Remove once ai-due is green.
    let stage = 'deps';
    try {
      const t0 = Date.now();
      const deps = await raceTimeout(makeAdminDeps(request, env), 7000, 'deps');
      const depsMs = Date.now() - t0;
      stage = 'listAiDueGames';
      const t1 = Date.now();
      const games = await listAiDueGames(deps.store, deps.codec, deps.supabase);
      return json({ games, _diag: { depsMs, listMs: Date.now() - t1 } });
    } catch (e) {
      return json({ _diag: { stalledAt: stage, error: e instanceof Error ? e.message : String(e) } }, 200);
    }
  } catch (e) {
    return fail(e);
  }
};

export const onRequestGet = handler;
export const onRequestPost = handler;
