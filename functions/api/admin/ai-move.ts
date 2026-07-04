// Cloudflare Pages Function — POST /api/admin/ai-move
// Admin-token gated (SWR_ADMIN_TOKEN). Accepts a worker-computed snapshot and
// stores it with optimistic concurrency. Body:
//   { gameId: string, baseTurn: number, snapshot: string }
// where `snapshot` is the new raw snapshot (as returned by /ai-due, re-encoded
// after the worker applied the AI's move). Rejects a stale baseTurn (someone
// else advanced first), a non-AI turn, or an undecodable snapshot — so a
// trusted-but-buggy worker can't corrupt or hijack a game.
import { makeAdminDeps, requireAdmin, applyAiWorkerMove, json, fail, type Env } from '../../_lib/gameServer';

interface Body { gameId?: string; baseTurn?: number; snapshot?: string; }

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const body = (await request.json().catch(() => ({}))) as Body;
    if (!body.gameId || typeof body.baseTurn !== 'number' || typeof body.snapshot !== 'string') {
      return json({ error: 'expected { gameId, baseTurn:number, snapshot:string }' }, 400);
    }
    const { store, codec, supabase } = await makeAdminDeps(request, env);
    const r = await applyAiWorkerMove(store, codec, body.gameId, body.baseTurn, body.snapshot, supabase);
    return json(r.ok ? { ok: true } : { error: r.reason }, r.status);
  } catch (e) {
    return fail(e);
  }
};
