// Cloudflare Pages Function — POST /api/games/:id/report?t=<token>
// Files an in-game problem report against this online game (stored in
// dbf_reports via the framework). Body: { message, severity?, category?,
// clientBuild?, userAgent? }. Returns { reportId }.

import { makeServer, json, fail, type Env } from '../../../_lib/gameServer';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const body = (await request.json().catch(() => ({}))) as { message?: string };
    if (!body || !body.message) return json({ error: 'missing message' }, 400);
    const { server } = await makeServer(request, env);
    return json(await server.report(id, token, body as Parameters<typeof server.report>[2]));
  } catch (e) {
    return fail(e);
  }
};
