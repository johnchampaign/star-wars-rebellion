// POST /api/reports/:id/resolve  — mark a report as resolved.
//
// Public-write per CLAUDE.md trust-tier rule: this is a reversible triage
// action (the resolution string is just appended to the row, the snapshot
// is preserved). Worst case of misuse: someone marks reports resolved with
// nonsense — we can clear it from the dashboard.
//
// Body: { resolution: string }

import { makeGameServer, json, safe, type Env }
  from '../../../_lib/gameServer';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  return safe(async () => {
    const reportId = ctx.params.id as string;
    let body: { resolution?: string };
    try { body = await ctx.request.json(); }
    catch { throw new Error('Bad JSON'); }
    if (!body.resolution || !body.resolution.trim()) {
      throw new Error('Empty resolution');
    }
    const server = makeGameServer(ctx.env, ctx.request);
    await server.resolveReport(reportId, body.resolution.trim());
    return { ok: true };
  });
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method === 'POST') return onRequestPost(ctx);
  return json({ ok: false, error: `Method ${ctx.request.method} not allowed` }, 405);
};
