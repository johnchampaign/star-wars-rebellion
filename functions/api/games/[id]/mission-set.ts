// Cloudflare Pages Function — POST /api/games/:id/mission-set?t=<token>
// Body: { useRoe: boolean }
// The seat the token authenticates as picks its own mission set (base vs Rise
// of the Empire) — RoE p.2 "Choosing Mission Sets", where each side chooses
// independently. Server rebuilds just that side's mission deck and locks the
// choice. Only valid once, while the game is still in the Setup phase and the
// seat is human. Returns the caller's refreshed redacted view.

import { makeServer, setSeatMissionSet, json, fail, type Env } from '../../../_lib/gameServer';
import type { Side } from '../../../../src/types';

interface Body { useRoe?: boolean }

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env, params } = ctx;
    const id = String(params.id);
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const body = (await request.json().catch(() => ({}))) as Body;
    if (typeof body.useRoe !== 'boolean') return json({ error: 'missing useRoe' }, 400);

    const deps = await makeServer(request, env);
    // Resolve which seat this token holds.
    const before = await deps.server.fetch(id, token);
    const you = before.you as Side | undefined;
    if (!you) return json({ error: 'no seat for this token' }, 403);

    const seed = Math.floor(Math.random() * 2 ** 31);
    const changed = await setSeatMissionSet(deps.store, deps.codec, id, you, body.useRoe, seed);
    // Not changed = window closed (not Setup phase / already locked / AI seat /
    // base game). Return the current view either way so the client re-syncs and
    // simply drops the chooser.
    const result = changed ? await deps.server.fetch(id, token) : before;
    return json({ ...result, missionSetApplied: changed });
  } catch (e) {
    return fail(e);
  }
};
