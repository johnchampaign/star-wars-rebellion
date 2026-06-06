// Cloudflare Pages Function — GET /api/games/:id?t=<token>
// Returns the redacted view for the seat the token authenticates as:
//   { view, yourTurn, turn, gameOver, you }

import {
  makeServer, syncTurnNotify, currentActorOf, reclaimSeat, isSideAbandoned, otherSide,
  json, fail, type Env,
} from '../../../_lib/gameServer';
import type { Side } from '../../../../src/types';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params, waitUntil } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const deps = await makeServer(request, env);
    let r = await deps.server.fetch(id, token);
    const you = r.you as Side | undefined;
    // Reclaim: if the requester's own seat is AI-controlled, they're back —
    // return the seat to them and re-fetch.
    if (you && r.view.aiSides?.includes(you)) {
      await reclaimSeat(deps.store, deps.codec, id, you);
      r = await deps.server.fetch(id, token);
    }
    // Deferred "your turn" email: this poll is the timer. Background (no latency).
    waitUntil(syncTurnNotify(deps, id, currentActorOf(r), r.turn));
    // Has the opponent abandoned (their turn, away past grace)? Drives the
    // takeover/claim UI. Only checked when it's not your turn.
    const opponentAbandoned =
      you && !r.yourTurn && !r.gameOver
        ? await isSideAbandoned(deps.supabase, id, otherSide(you), env)
        : false;
    return json({ ...r, opponentAbandoned });
  } catch (e) {
    return fail(e);
  }
};
