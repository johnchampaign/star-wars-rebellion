// POST /api/games  — create a new online game, return invite URLs.
//
// Body: { seed?: number, emails?: { Rebel?: string, Empire?: string } }
// Returns: { gameId, invites: { Rebel, Empire } }
//
// No auth — anyone can create a game. The cost of misuse is "extra rows in
// dbf_games"; mitigate at the table level later if needed.

import { makeGameServer, makeInitialState, json, safe, type Env }
  from '../../_lib/gameServer';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  return safe(async () => {
    let body: { seed?: number; emails?: { Rebel?: string; Empire?: string } } = {};
    try { body = await ctx.request.json(); } catch { /* empty body ok */ }
    const seed = typeof body.seed === 'number'
      ? body.seed
      : Math.floor(Math.random() * 0x7fffffff);
    const initialState = await makeInitialState(ctx.env, ctx.request, seed);
    const server = makeGameServer(ctx.env, ctx.request);
    const result = await server.createGame({
      initialState,
      players: ['Rebel', 'Empire'],
      emails: body.emails,
    });
    return { ...result, seed };
  });
};

// Reject other methods with 405 (CF Pages default handler would 405 anyway,
// but this surfaces a clearer message for curl debugging).
export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method === 'POST') return onRequestPost(ctx);
  return json({ ok: false, error: `Method ${ctx.request.method} not allowed` }, 405);
};
