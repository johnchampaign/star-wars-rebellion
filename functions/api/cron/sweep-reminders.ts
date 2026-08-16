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

import { runBoundedReminderSweep, json, fail, type Env } from '../../_lib/gameServer';

// #683 "turn nudge emails do not send": the framework's own sweep
// (GameServer.sweepTurnReminders) lists EVERY unresolved game and decodes each
// full snapshot in one request. Once the unresolved backlog outgrew the
// request budget the endpoint started dying mid-run — measured from outside,
// it hangs indefinitely while /api/report answers in 0.1s — and since only
// this sweep marks finished games `resolved`, the backlog could never shrink
// again. No nudge has ever been delivered past that point.
//
// runBoundedReminderSweep is the same fix ai-due got for the same disease:
// bounded chunks (newest 30 for live nudges + oldest 8 so the dead backlog
// drains), a 15s wall-clock deadline, per-call timeouts, identical
// reminder-clock semantics (turn/since/sent). The 5-minute cron cadence does
// the rest: each tick makes real progress, and the response now reports
// scanned/reminded/resolvedMarked/truncated so the drain is observable.

const handler: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;
    if (env.CRON_SECRET && request.headers.get('x-cron-key') !== env.CRON_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }
    const origin = new URL(request.url).origin;
    const result = await runBoundedReminderSweep(env, origin);
    return json({ ok: true, ...result });
  } catch (e) {
    return fail(e);
  }
};

export const onRequestGet = handler;
export const onRequestPost = handler;
