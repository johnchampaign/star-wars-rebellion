// Scheduled stale-turn-reminder cron (Cloudflare Worker).
//
// This worker holds NO credentials. Cloudflare Pages Functions can't register
// cron triggers, so this tiny Worker exists only to fire on a schedule and
// PING the Pages endpoint /api/cron/sweep-reminders. That endpoint runs the
// actual sweep using the SUPABASE_* / RESEND_* secrets the Pages project
// already has — so you never re-enter those secrets here.
//
// WHAT the sweep does: scans active games, and for any whose current player
// has been idle past the threshold (with an email on file) sends a single
// "it's your turn" nudge. This is the path that reaches **vs-AI** and
// both-clients-closed games, which have no browser polling to drive the
// request-path reminder.
//
// Config (workers/reminder-cron/wrangler.toml [vars]):
//   SWEEP_URL   — absolute URL of the Pages endpoint to ping.
//   CRON_KEY    — OPTIONAL. Only needed if you set CRON_SECRET on the Pages
//                 project to lock the endpoint down; must match it. Sent as
//                 the `x-cron-key` header. Leave unset for the open default.
//
// Deploy:  npx wrangler deploy --config workers/reminder-cron/wrangler.toml
// Test:    npx wrangler dev --config workers/reminder-cron/wrangler.toml --test-scheduled
//          then curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"

interface Env {
  SWEEP_URL?: string;
  CRON_KEY?: string;
}

export default {
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    const url = env.SWEEP_URL || 'https://star-wars-rebellion.pages.dev/api/cron/sweep-reminders';
    try {
      const headers: Record<string, string> = {};
      if (env.CRON_KEY) headers['x-cron-key'] = env.CRON_KEY;
      const res = await fetch(url, { method: 'POST', headers });
      const body = await res.text();
      console.log(`[reminder-cron] ${res.status} ${body.slice(0, 300)}`);
    } catch (e) {
      // Never throw out of scheduled() — log and let the next tick retry.
      console.error('[reminder-cron] ping failed', e instanceof Error ? e.message : String(e));
    }
  },
};
