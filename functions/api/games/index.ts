// Cloudflare Pages Function — POST /api/games  (create a new online game)
//
// Body (optional): { emails?: { Rebel?: string, Empire?: string } }
// Response: { gameId, invites: { Rebel: <token>, Empire: <token> } }
//
// Each invite token authenticates its seat; share the per-seat link (built via
// gameUrl) with that player. GET (list games for a player) is deferred to the
// auth phase — it needs the caller's identity to filter dbf_games.

import { makeServer, newInitialState, json, fail, type Env } from '../../_lib/gameServer';

interface CreateBody {
  emails?: Partial<Record<'Rebel' | 'Empire', string>>;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;
    const body = (await request.json().catch(() => ({}))) as CreateBody;
    const { server, dataBundle } = await makeServer(request, env);
    const result = await server.createGame({
      initialState: newInitialState(dataBundle),
      players: ['Rebel', 'Empire'],
      emails: body.emails,
    });
    return json(result, 201);
  } catch (e) {
    return fail(e);
  }
};
