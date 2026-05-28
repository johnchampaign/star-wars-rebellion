// GET /api/reports  — list bug reports for agent/admin triage.
//
// Public-read per CLAUDE.md trust-tier rule: tokens & emails live in
// dbf_games, NEVER in dbf_reports, so reports carry no PII beyond what the
// reporter typed in their message + their viewer-side state snapshot. Safe
// to expose unauthenticated.
//
// Query params (all optional):
//   ?unresolved=1     — only reports with no resolution yet
//   ?gameId=XXX       — filter to one game
//   ?severity=bug     — filter by severity
//   ?limit=50         — max rows (default 50)

import { makeGameServer, json, safe, type Env } from '../../_lib/gameServer';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  return safe(async () => {
    const url = new URL(ctx.request.url);
    const filter = {
      unresolvedOnly: url.searchParams.get('unresolved') === '1',
      gameId: url.searchParams.get('gameId') ?? undefined,
      severity: url.searchParams.get('severity') ?? undefined,
      limit: parseInt(url.searchParams.get('limit') ?? '50', 10),
    };
    const server = makeGameServer(ctx.env, ctx.request);
    const reports = await server.listReports(filter as never);
    return { reports };
  });
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method === 'GET') return onRequestGet(ctx);
  return json({ ok: false, error: `Method ${ctx.request.method} not allowed` }, 405);
};
