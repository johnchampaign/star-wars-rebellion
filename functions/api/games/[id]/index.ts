// Cloudflare Pages Function — GET /api/games/:id?t=<token>
// Returns the redacted view for the seat the token authenticates as:
//   { view, yourTurn, turn, gameOver, you }

import { makeServer, json, fail, type Env } from '../../../_lib/gameServer';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const { server } = await makeServer(request, env);
    return json(await server.fetch(id, token));
  } catch (e) {
    return fail(e);
  }
};
