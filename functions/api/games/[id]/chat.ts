// Cloudflare Pages Function — POST /api/games/:id/chat?t=<token>
// Body: { message: string }
// Appends a chat message from the seat the token authenticates as. The sender
// side is stamped server-side from the token (never trusted from the client),
// so a player can't post as their opponent. Returns the refreshed message list.

import { makeServer, postChat, fetchChat, json, fail, type Env } from '../../../_lib/gameServer';
import type { Side } from '../../../../src/types';

interface ChatBody { message?: string }

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const body = (await request.json().catch(() => ({}))) as ChatBody;
    const text = (body.message ?? '').toString();
    if (!text.trim()) return json({ error: 'empty message' }, 400);

    const deps = await makeServer(request, env);
    // Authenticate the seat: server.fetch throws on a bad token, and returns
    // which seat this token owns. Only a real seat may post.
    const r = await deps.server.fetch(id, token);
    const you = r.you as Side | undefined;
    if (!you) return json({ error: 'unauthorized' }, 401);

    await postChat(deps.supabase, id, you, text);
    const chat = await fetchChat(deps.supabase, id);
    return json({ ok: true, chat });
  } catch (e) {
    return fail(e);
  }
};
