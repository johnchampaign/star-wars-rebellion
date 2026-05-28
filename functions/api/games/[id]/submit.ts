// POST /api/games/:id/submit?as=TOKEN  — submit one RebellionAction.
// Body: { action: RebellionAction }
// Returns: { view, yourTurn, turn, gameOver }
//
// Server validates currentActor + action ∈ legalActions before applying.

import { makeGameServer, getToken, json, safe, type Env }
  from '../../../_lib/gameServer';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  return safe(async () => {
    const gameId = ctx.params.id as string;
    const token = getToken(ctx.request);
    let body: { action?: unknown };
    try { body = await ctx.request.json(); }
    catch { throw new Error('Bad JSON'); }
    if (!body.action || typeof body.action !== 'object') {
      throw new Error('Missing action');
    }
    const server = makeGameServer(ctx.env, ctx.request);
    // Cast: server validates legality against the adapter's legalActions.
    return server.submit(gameId, token, body.action as never);
  });
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method === 'POST') return onRequestPost(ctx);
  return json({ ok: false, error: `Method ${ctx.request.method} not allowed` }, 405);
};
