// POST /api/games/:id/takeover?t=<token>
// The present player hands their absent opponent's seat to the server AI, so
// the game can finish. Allowed only when it's the opponent's turn and they've
// been away past the grace period. The original player can reclaim their seat
// later just by reopening their link.

import { makeServer, isSideAbandoned, setSeatAI, otherSide, json, fail, type Env } from '../../../_lib/gameServer';
import type { Side } from '../../../../src/types';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const deps = await makeServer(request, env);
    const r = await deps.server.fetch(id, token);
    if (r.gameOver) return json({ error: 'game is already over' }, 400);
    if (r.yourTurn) return json({ error: "it's your turn — nothing to take over" }, 400);
    const you = r.you as Side;
    const opp = otherSide(you);
    if (!(await isSideAbandoned(deps.supabase, id, opp, env))) {
      return json({ error: 'your opponent has not been away long enough yet' }, 400);
    }
    await setSeatAI(deps.store, deps.codec, id, opp);
    return json(await deps.server.fetch(id, token));
  } catch (e) {
    return fail(e);
  }
};
