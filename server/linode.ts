// The Rebellion API on John's Linode: the SAME Pages Function handlers in
// functions/api/, run in Node behind the Cloudflare tunnel as
// https://swr-api.johnchampaign.com (functions/api/_middleware.ts forwards
// there). Bundled to one file by `npm run build:api` and shipped by
// scripts/deploy-api.sh. docs/online-multiplayer.md "Where the API runs".
//
// Env (/etc/swr-api.env on the Linode, never committed): gameServer.ts's Env —
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RATINGS_INGEST_KEY, SWR_ADMIN_TOKEN,
// AI_WORKER_ENABLED, PUBLIC_BASE_URL, INVITE_EMAIL_RELAY — plus PORT (default
// 8395). No Resend key: Cloudflare's is write-only, so invite emails go through
// INVITE_EMAIL_RELAY (functions/api/admin/send-invite.ts) and Cloudflare sends.
//
// The catalog is loaded from PUBLIC_BASE_URL's /dev-assets/*.json once per
// process, so restart the service (deploy:api does) after an asset change.
// Endpoints the middleware keeps on Cloudflare (cron, bug reports, log upload)
// are deliberately absent here.
import { createServer, type IncomingMessage } from 'node:http';
import * as games from '../functions/api/games/index';
import * as game from '../functions/api/games/[id]/index';
import * as chat from '../functions/api/games/[id]/chat';
import * as claim from '../functions/api/games/[id]/claim';
import * as legal from '../functions/api/games/[id]/legal';
import * as missionSet from '../functions/api/games/[id]/mission-set';
import * as report from '../functions/api/games/[id]/report';
import * as submit from '../functions/api/games/[id]/submit';
import * as takeover from '../functions/api/games/[id]/takeover';
import * as aiDue from '../functions/api/admin/ai-due';
import * as aiMove from '../functions/api/admin/ai-move';
import * as aiSnapshot from '../functions/api/admin/ai-snapshot';

type Handler = (ctx: unknown) => Response | Promise<Response>;
type Route = Partial<Record<'onRequest' | 'onRequestGet' | 'onRequestPost', Handler>>;

// Pages' file routing, spelled out: [id] is one path segment.
const ROUTES = [
  [/^\/api\/games$/, games],
  [/^\/api\/games\/([^/]+)$/, game],
  [/^\/api\/games\/([^/]+)\/chat$/, chat],
  [/^\/api\/games\/([^/]+)\/claim$/, claim],
  [/^\/api\/games\/([^/]+)\/legal$/, legal],
  [/^\/api\/games\/([^/]+)\/mission-set$/, missionSet],
  [/^\/api\/games\/([^/]+)\/report$/, report],
  [/^\/api\/games\/([^/]+)\/submit$/, submit],
  [/^\/api\/games\/([^/]+)\/takeover$/, takeover],
  [/^\/api\/admin\/ai-due$/, aiDue],
  [/^\/api\/admin\/ai-move$/, aiMove],
  [/^\/api\/admin\/ai-snapshot$/, aiSnapshot],
] as unknown as [RegExp, Route][];

const env = process.env;
const port = Number(process.env.PORT ?? 8395);
const origin = env.PUBLIC_BASE_URL ?? 'https://star-wars-rebellion.pages.dev';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Without its database keys this server can't serve a game. Answer 530 — the
// status the Pages middleware already treats as "Linode unreachable" — so
// Cloudflare runs the request itself instead of players getting a 500.
// (2026-11-20: the DNS name went live before the keys were set, and every game
// request failed for ~23 h.) Health reports it, so deploy-api's check does too.
const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

async function route(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/api/health') return json({ ok: true, configured }, 200);
  if (!configured) return json({ error: 'swr-api has no database keys; Cloudflare serves this' }, 530);
  for (const [re, mod] of ROUTES) {
    const m = re.exec(path);
    if (!m) continue;
    const fn = mod.onRequest ?? (request.method === 'GET' ? mod.onRequestGet : request.method === 'POST' ? mod.onRequestPost : undefined);
    if (!fn) return json({ error: 'method not allowed' }, 405);
    return fn({
      request,
      env,
      params: m[1] !== undefined ? { id: decodeURIComponent(m[1]) } : {},
      // the process outlives the response, so background work just runs
      waitUntil: (p: Promise<unknown>) => { p.catch((e) => console.error('swr api waitUntil', e)); },
      next: async () => json({ error: 'not found' }, 404),
      data: {},
      functionPath: path,
    });
  }
  return json({ error: 'not found' }, 404);
}

/** Node request → Fetch Request, at the PUBLIC origin: handlers build invite
 *  links and fetch /dev-assets from new URL(request.url).origin */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const chunks: Buffer[] = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') for await (const c of req) chunks.push(c as Buffer);
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
}

const http = createServer(async (req, res) => {
  try {
    const r = await route(await toRequest(req));
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('swr api', req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});
http.listen(port, '127.0.0.1', () => console.log(`Rebellion API on 127.0.0.1:${port}, links at ${origin}`));
