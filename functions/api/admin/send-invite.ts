// Cloudflare Pages Function — POST /api/admin/send-invite
//
// The invite-email relay for the Linode API (server/linode.ts). The Resend key
// is a Cloudflare secret, which can't be read back to copy it, so the Linode
// posts its invite emails here and this sends them with the key Cloudflare
// already holds. The middleware keeps this path on Cloudflare (LOCAL_ONLY).
//
// Auth: SWR_ADMIN_TOKEN (requireAdmin; fails closed). Body: { to, gameUrl, side }.
// gameUrl must be on this site, so the endpoint can't be used to mail links
// elsewhere even by a token holder.
import { requireAdmin, sendInviteEmail, json, fail, type Env } from '../../_lib/gameServer';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  try {
    const b = (await request.json().catch(() => ({}))) as { to?: unknown; gameUrl?: unknown; side?: unknown };
    const site = new URL(env.PUBLIC_BASE_URL || request.url).origin;
    if (typeof b.to !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(b.to)) return json({ error: 'bad to' }, 400);
    if (b.side !== 'Rebel' && b.side !== 'Empire') return json({ error: 'bad side' }, 400);
    if (typeof b.gameUrl !== 'string' || new URL(b.gameUrl, site).origin !== site) return json({ error: 'bad gameUrl' }, 400);
    if (!env.RESEND_API_KEY || !env.RESEND_FROM) return json({ error: 'email not configured here' }, 503);
    await sendInviteEmail({ ...env, INVITE_EMAIL_RELAY: undefined }, { to: b.to, gameUrl: b.gameUrl, side: b.side });
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
};
