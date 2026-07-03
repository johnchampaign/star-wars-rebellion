// Cloudflare Pages Function — POST /api/games/:id/submit?t=<token>
// Body: { action: RebellionAction }
// Applies the action as the seat the token authenticates as (the server checks
// turn ownership + legality via the adapter), then returns the submitter's
// refreshed redacted view: { view, yourTurn, turn, gameOver, you }.

import { makeServer, advanceAIAndStore, recordTurnTiming, currentActorOf, json, fail, type Env } from '../../../_lib/gameServer';
import type { RebellionAction } from '../../../../src/adapter/rebellionAction';

interface SubmitBody {
  action: RebellionAction;
  identityToken?: string;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params, waitUntil } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const body = (await request.json()) as SubmitBody;
    if (!body || !body.action) return json({ error: 'missing action' }, 400);
    const deps = await makeServer(request, env);
    // Ranked: attribute this seat from the move's identity (idempotent, race-free
    // — turns are sequential). Best-effort; never blocks the move.
    if (typeof body.identityToken === 'string' && body.identityToken) {
      try { await deps.server.claimSeat(id, token, body.identityToken); } catch { /* attribution optional */ }
    }
    const view = await deps.server.submit(id, token, body.action);
    // Online-vs-AI: if the human's move handed the turn to an AI seat, let the
    // AI play and persist, then return the submitter's refreshed view. Skipped
    // when AI_WORKER_ENABLED — the off-Cloudflare worker owns AI moves then.
    const advanced = env.AI_WORKER_ENABLED ? false : await advanceAIAndStore(deps.store, deps.codec, id);
    const result = advanced ? await deps.server.fetch(id, token) : view;
    // (Re)start the turn clock for whoever is now on the move (abandonment +
    // reminder-sweep handoff time). The scheduled sweep sends any email.
    {
      const a = currentActorOf(result);
      waitUntil(recordTurnTiming(deps.supabase, id, a, !!(a && result.view.aiSides?.includes(a))));
    }
    return json(result);
  } catch (e) {
    return fail(e);
  }
};
