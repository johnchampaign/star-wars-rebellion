// POST /api/games/:id/claim?t=<token>
// The present player claims the win because their opponent abandoned the game.
// Allowed only when it's the opponent's turn and they've been away past the
// grace period. Ends the game in the claimant's favour.

import { makeServer, isSideAbandoned, claimVictory, otherSide, json, fail, type Env } from '../../../_lib/gameServer';
import type { Side } from '../../../../src/types';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const deps = await makeServer(request, env);
    const r = await deps.server.fetch(id, token);
    if (r.gameOver) return json({ error: 'game is already over' }, 400);
    if (r.yourTurn) return json({ error: "it's your turn" }, 400);
    const you = r.you as Side;
    if (!(await isSideAbandoned(deps.supabase, id, otherSide(you), env))) {
      return json({ error: 'your opponent has not been away long enough yet' }, 400);
    }
    await claimVictory(deps.store, deps.codec, id, you);
    return json(await deps.server.fetch(id, token));
  } catch (e) {
    return fail(e);
  }
};
