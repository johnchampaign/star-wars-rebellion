// GET /api/games/:id/legal?as=TOKEN  — list legal RebellionActions for the
// player whose token is supplied. Returns [] if it's not their turn.

import { makeGameServer, getToken, safe, type Env }
  from '../../../_lib/gameServer';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  return safe(async () => {
    const gameId = ctx.params.id as string;
    const token = getToken(ctx.request);
    const server = makeGameServer(ctx.env, ctx.request);
    const actions = await server.legalActions(gameId, token);
    return { actions };
  });
};
