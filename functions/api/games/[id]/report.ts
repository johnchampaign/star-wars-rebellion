// POST /api/games/:id/report?as=TOKEN  — file an in-game bug report against
// the current snapshot. Stored in dbf_reports for public-read triage.
//
// Body: { message: string, severity?: 'bug' | 'rules-question' | 'feedback' }
// Returns: { reportId }

import { makeGameServer, getToken, json, safe, type Env }
  from '../../../_lib/gameServer';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  return safe(async () => {
    const gameId = ctx.params.id as string;
    const token = getToken(ctx.request);
    let body: { message?: string; severity?: 'bug' | 'rules-question' | 'feedback' };
    try { body = await ctx.request.json(); }
    catch { throw new Error('Bad JSON'); }
    if (!body.message || !body.message.trim()) throw new Error('Empty message');
    const server = makeGameServer(ctx.env, ctx.request);
    return server.report(gameId, token, {
      message: body.message.trim(),
      severity: body.severity ?? 'bug',
      userAgent: ctx.request.headers.get('user-agent') ?? undefined,
    });
  });
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method === 'POST') return onRequestPost(ctx);
  return json({ ok: false, error: `Method ${ctx.request.method} not allowed` }, 405);
};
