// Cloudflare Pages Function — GET /api/games/:id?t=<token>
// Returns the redacted view for the seat the token authenticates as:
//   { view, yourTurn, turn, gameOver, you }

import {
  makeServer, recordTurnTiming, currentActorOf, reclaimSeat, isSideAbandoned, otherSide,
  advanceAIAndStore, json, fail, type Env,
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
    // Self-heal a stalled AI seat (#450): normally submit runs the AI right
    // after a human move, but if that single attempt fails (e.g. the snapshot
    // write hit a transient Supabase outage) NOTHING retried it — the game sat
    // at the AI's turn forever ("it's the empire's turn but nothing happens").
    // The poll path now advances a due AI seat, so one lost attempt heals on
    // the player's next refresh. No-op whenever it isn't an AI seat's turn.
    if (!r.gameOver) {
      const actor = currentActorOf(r);
      if (actor && r.view.aiSides?.includes(actor)) {
        if (await advanceAIAndStore(deps.store, deps.codec, id)) {
          r = await deps.server.fetch(id, token);
        }
      }
    }
    // Record who's on the clock (drives abandonment + the reminder sweep's
    // handoff time). No email here — the scheduled sweep owns reminders now.
    {
      const a = currentActorOf(r);
      waitUntil(recordTurnTiming(deps.supabase, id, a, !!(a && r.view.aiSides?.includes(a))));
    }
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
