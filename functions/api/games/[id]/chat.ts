// Cloudflare Pages Function — /api/games/:id/chat?t=<token>
//   POST { message }  → append a chat message; returns the refreshed list
//   GET               → list recent messages
// Backed by the framework's GameServer messaging (server.postMessage /
// listMessages over the dbf_messages table). The server authenticates the seat
// from the token and stamps the sender, and the SupabaseBroadcaster fans a
// realtime "message" ping so clients refresh instantly. Both calls return a
// ChatMessage[] directly, which the client's MessagingClientApi consumes.

import { makeServer, json, fail, type Env } from '../../../_lib/gameServer';

interface ChatBody { message?: string }

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const body = (await request.json().catch(() => ({}))) as ChatBody;
    const text = (body.message ?? '').toString().trim();
    if (!text) return json({ error: 'empty message' }, 400);
    const { server } = await makeServer(request, env);
    const messages = await server.postMessage(id, token, text);
    return json(messages);
  } catch (e) {
    return fail(e);
  }
};

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const { server } = await makeServer(request, env);
    const messages = await server.listMessages(id, token);
    return json(messages);
  } catch (e) {
    return fail(e);
  }
};
