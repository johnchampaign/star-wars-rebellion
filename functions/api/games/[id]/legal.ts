// Cloudflare Pages Function — GET /api/games/:id/legal?t=<token>
// Returns the legal actions for the seat the token authenticates as.
// (Minimal in Phase 1 — human clients build actions via the UI; this is mainly
// for online AI later. The server still validates every submit via the adapter.)

import { makeServer, json, fail, type Env } from '../../../_lib/gameServer';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const { server } = await makeServer(request, env);
    return json(await server.legalActions(id, token));
  } catch (e) {
    return fail(e);
  }
};
