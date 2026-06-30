// Cloudflare Pages Function — POST /api/games  (create a new online game)
//
// Body (optional): { emails?: { Rebel?: string, Empire?: string } }
// Response: { gameId, invites: { Rebel: <seat URL>, Empire: <seat URL> } }
//
// Each invite value is already a full per-seat URL (the framework builds it via
// gameUrl from the seat token) — share it as-is; don't re-wrap it. GET (list
// games for a player) is deferred to the
// auth phase — it needs the caller's identity to filter dbf_games.

import { makeServer, newInitialState, runServerAI, sendInviteEmail, json, fail, type Env } from '../../_lib/gameServer';

interface CreateBody {
  emails?: Partial<Record<'Rebel' | 'Empire', string>>;
  /** When set, that seat is played by the server-side AI (online vs AI). */
  aiSide?: 'Rebel' | 'Empire';
  /** Rise of the Empire opt-in. Omitted ⇒ base game. */
  expansion?: Partial<import('../../../src/types').ExpansionConfig>;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;
    const body = (await request.json().catch(() => ({}))) as CreateBody;
    const { server, dataBundle } = await makeServer(request, env);
    const initialState = newInitialState(dataBundle, body.aiSide, body.expansion);
    // If the AI moves first (e.g. it's the Rebel and acts first in Assignment),
    // play its opening now so the human's first fetch shows their own turn.
    runServerAI(initialState);
    const result = await server.createGame({
      initialState,
      players: ['Rebel', 'Empire'],
      emails: body.emails,
      // Attribute the AI seat so vs-AI games are RATED (the AI appears on the
      // leaderboard as `ai:rebellion:standard`). Rebellion drives the AI itself
      // via state.aiSides / runServerAI — this only tags it for rating; the
      // framework's own AI driver stays idle (no aiControllers configured).
      ...(body.aiSide ? { ai: { [body.aiSide]: 'standard' } } : {}),
    });
    // Email each seat that has an address on file its private invite link — but
    // not the AI seat. Best-effort, off the response path.
    for (const side of ['Rebel', 'Empire'] as const) {
      const to = body.emails?.[side];
      if (!to || side === body.aiSide) continue;
      // result.invites[side] is already a full seat URL (not a raw token).
      ctx.waitUntil(sendInviteEmail(env, { to, gameUrl: result.invites[side], side }).catch(() => {}));
    }
    return json(result, 201);
  } catch (e) {
    return fail(e);
  }
};
