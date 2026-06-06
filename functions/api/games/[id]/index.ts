// Cloudflare Pages Function — GET /api/games/:id?t=<token>
// Returns the redacted view for the seat the token authenticates as:
//   { view, yourTurn, turn, gameOver, you }

import { makeServer, syncTurnNotify, currentActorOf, json, fail, type Env } from '../../../_lib/gameServer';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params, waitUntil } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const deps = await makeServer(request, env);
    const r = await deps.server.fetch(id, token);
    // Deferred "your turn" email: this poll is the timer. Runs after the
    // response so it never adds latency.
    waitUntil(syncTurnNotify(deps, id, currentActorOf(r), r.turn));
    return json(r);
  } catch (e) {
    return fail(e);
  }
};
