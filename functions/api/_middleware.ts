// Forwards /api/* to the Rebellion API on John's Linode (server/linode.ts,
// reached through the Cloudflare tunnel), which runs these same handler files
// in Node. docs/online-multiplayer.md "Where the API runs".
// Why: Workers' free plan allows 10 ms of CPU per request. Once the AI worker
// stopped polling every few seconds, the median Rebellion request was ~10 ms
// (decoding a game snapshot plus the catalog), so heavier requests were killed
// (Cloudflare 1102) every day. Waiting on the fetch below costs no CPU.
//
// Still answered here, never forwarded: endpoints that need secrets only this
// Pages project holds — the reminder sweep (/api/cron/*, Resend + the cron
// Worker), the invite-email relay the Linode calls (/api/admin/send-invite,
// Resend), and the bug-report/log endpoints (SWR_BUGREPORT_TOKEN, a GitHub
// token). All are light.
//
// When the Linode can't be reached at all (the fetch throws, or Cloudflare
// answers 530: the tunnel or its DNS name is down), the request runs here as
// before. Only those two: a 502/504 may have reached the origin, and replaying
// a submit that already landed would apply it twice.
//
// Env (Pages project settings, optional):
//   SWR_API_ORIGIN  where the API runs (default https://swr-api.johnchampaign.com);
//                   'local' runs every handler here again — the rollback.
import type { Env } from '../_lib/gameServer';

const API_ORIGIN = 'https://swr-api.johnchampaign.com';
const LOCAL_ONLY = ['/api/cron/', '/api/admin/send-invite', '/api/report', '/api/my-responses', '/api/upload-logs'];

export const onRequest: PagesFunction<Env & { SWR_API_ORIGIN?: string }> = async (ctx) => {
  const url = new URL(ctx.request.url);
  if (ctx.env.SWR_API_ORIGIN === 'local' || LOCAL_ONLY.some((p) => url.pathname.startsWith(p))) return ctx.next();
  const target = new URL(url.pathname + url.search, ctx.env.SWR_API_ORIGIN || API_ORIGIN);
  const fallback = ctx.request.clone() as unknown as Request; // (next() is typed for a plain Request)
  try {
    const r = await fetch(new Request(target, ctx.request));
    if (r.status !== 530) return r;
  } catch { /* unreachable: fall through */ }
  return ctx.next(fallback);
};
