// Cloudflare Pages Function — POST /api/games/:id/submit?t=<token>
// Body: { action: RebellionAction }
// Applies the action as the seat the token authenticates as (the server checks
// turn ownership + legality via the adapter), then returns the submitter's
// refreshed redacted view: { view, yourTurn, turn, gameOver, you }.

import { makeServer, json, fail, type Env } from '../../../_lib/gameServer';
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
    const { server } = await makeServer(request, env);
    return json(await server.submit(id, token, body.action));
  } catch (e) {
    return fail(e);
  }
};
