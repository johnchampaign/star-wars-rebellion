// GET /api/games/:id?as=TOKEN  — fetch the redacted view for the token's player.
// Returns: { view, yourTurn, turn, gameOver }

import { makeGameServer, getToken, safe, type Env }
  from '../../../_lib/gameServer';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  return safe(async () => {
    const gameId = ctx.params.id as string;
    const token = getToken(ctx.request);
    const server = makeGameServer(ctx.env, ctx.request);
    return server.fetch(gameId, token);
  });
};
