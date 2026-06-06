// Scheduled stale-turn-reminder cron (Cloudflare Worker).
//
// WHY a separate Worker: Cloudflare *Pages Functions* (where the rest of the
// online stack lives, under functions/api/) cannot register cron triggers —
// only a standalone Worker can. This worker shares the SAME GameServer /
// SupabaseStore / ResendNotifier wiring as the API (via makeCronServer), so
// there is one source of truth for the game logic and the email sender.
//
// WHAT it does: once an hour it calls server.sweepTurnReminders(), which scans
// every active game, computes whose turn it is, and — if that player has been
// on the clock past `olderThanMs` with no move and an email on file — sends a
// single "it's your turn" nudge. This is the path that makes **vs-AI** games
// (and games where BOTH clients are closed) email the waiting human: there is
// no client polling to drive the request-path reminder in those cases.
//
// The request-path reminder (functions/_lib/gameServer.ts syncTurnNotify, 15-min)
// is intentionally LEFT in place — it gives prompt nudges during active
// human-vs-human play. The two use independent dedupe state, so a turn left
// idle for over a day could in theory produce a second (sweep) email; that is
// acceptable for a day-scale safety net.
//
// Required env (set with `wrangler secret put <NAME>` for THIS worker — Worker
// secrets are separate from the Pages project's secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RESEND_FROM
// Plain var (in wrangler.toml [vars]): PUBLIC_BASE_URL.
//
// Deploy:  npx wrangler deploy --config workers/reminder-cron/wrangler.toml
// Test now (no waiting for the cron): add `--test-scheduled` to `wrangler dev`
//   then `curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"`.

import { makeCronServer, type Env } from '../../functions/_lib/gameServer';

// Email the waiting player once a turn has been idle this long.
const OLDER_THAN_MS = 24 * 60 * 60 * 1000; // 24 hours

export default {
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    try {
      const { server } = await makeCronServer(env);
      const result = await server.sweepTurnReminders({ olderThanMs: OLDER_THAN_MS });
      console.log('[reminder-cron] sweep complete', JSON.stringify(result));
    } catch (e) {
      // Never throw out of scheduled() — log and let the next tick retry.
      console.error('[reminder-cron] sweep failed', e instanceof Error ? e.stack ?? e.message : String(e));
    }
  },
};
