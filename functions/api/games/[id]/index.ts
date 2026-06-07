// Cloudflare Pages Function — GET /api/games/:id?t=<token>
// Returns the redacted view for the seat the token authenticates as:
//   { view, yourTurn, turn, gameOver, you }

import {
  makeServer, recordTurnTiming, currentActorOf, reclaimSeat, isSideAbandoned, otherSide,
  fetchChat, json, fail, type Env,
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
    // Record who's on the clock (drives abandonment + the reminder sweep's
    // handoff time). No email here — the scheduled sweep owns reminders now.
    waitUntil(recordTurnTiming(deps.supabase, id, currentActorOf(r)));
    // Has the opponent abandoned (their turn, away past grace)? Drives the
    // takeover/claim UI. Only checked when it's not your turn.
    const opponentAbandoned =
      you && !r.yourTurn && !r.gameOver
        ? await isSideAbandoned(deps.supabase, id, otherSide(you), env)
        : false;
    // In-game chat, delivered on the existing poll (only to an authenticated
    // seat). Best-effort — never fail the view fetch over chat.
    const chat = you ? await fetchChat(deps.supabase, id) : [];
    return json({ ...r, opponentAbandoned, chat });
  } catch (e) {
    return fail(e);
  }
};
