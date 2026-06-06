// Cloudflare Pages Function — /api/cron/sweep-reminders
//
// Runs the stale-turn-reminder sweep using the GameServer wired with the SAME
// SUPABASE_* / RESEND_* secrets the rest of the Pages project already has —
// so there is NO need to duplicate those secrets onto a separate Worker.
//
// The standalone cron Worker (workers/reminder-cron/) just *pings* this URL on
// a schedule; all the real work + credentials live here. For each active game
// the sweep computes whose turn it is and, if that player has been idle past
// the threshold with an email on file, sends one "it's your turn" nudge.
//
// Auth (trust-tier, per project convention): a sweep is idempotent and only
// sends reminders that are ALREADY due — worst case is an email going out a
// little early. So the endpoint is OPEN by default. Set the optional
// CRON_SECRET env var to require a matching `x-cron-key` header if you'd rather
// lock it down. GET and POST both work (POST is what the Worker uses).

import { makeCronServer, json, fail, type Env } from '../../_lib/gameServer';

const OLDER_THAN_MS = 24 * 60 * 60 * 1000; // 24h idle → nudge the waiting player

const handler: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;
    if (env.CRON_SECRET && request.headers.get('x-cron-key') !== env.CRON_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }
    const origin = new URL(request.url).origin;
    const { server } = await makeCronServer(env, origin);
    const result = await server.sweepTurnReminders({ olderThanMs: OLDER_THAN_MS });
    return json({ ok: true, ...result });
  } catch (e) {
    return fail(e);
  }
};

export const onRequestGet = handler;
export const onRequestPost = handler;
