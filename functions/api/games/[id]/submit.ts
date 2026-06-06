// Cloudflare Pages Function — POST /api/games/:id/submit?t=<token>
// Body: { action: RebellionAction }
// Applies the action as the seat the token authenticates as (the server checks
// turn ownership + legality via the adapter), then returns the submitter's
// refreshed redacted view: { view, yourTurn, turn, gameOver, you }.

import { makeServer, advanceAIAndStore, json, fail, type Env } from '../../../_lib/gameServer';
import type { RebellionAction } from '../../../../src/adapter/rebellionAction';

interface SubmitBody {
  action: RebellionAction;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const body = (await request.json()) as SubmitBody;
    if (!body || !body.action) return json({ error: 'missing action' }, 400);
    const { server, store, codec } = await makeServer(request, env);
    const view = await server.submit(id, token, body.action);
    // Online-vs-AI: if the human's move handed the turn to an AI seat, let the
    // AI play and persist, then return the submitter's refreshed view.
    const advanced = await advanceAIAndStore(store, codec, id);
    return json(advanced ? await server.fetch(id, token) : view);
  } catch (e) {
    return fail(e);
  }
};
