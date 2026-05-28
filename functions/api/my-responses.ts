// Cloudflare Pages Function — GET /api/my-responses?reporterId=...
//
// Returns the list of closed problem-report issues filed by this device's
// reporterId, along with the resolution comment we attached when closing.
// The client uses this to show a polite "your report was responded to"
// modal the next time the user opens the app.
//
// Issue bodies carry the reporter tag as an HTML comment:
//     <!-- reporter:abc123 -->
// (See functions/api/report.ts.) GitHub's issue-search API is fuzzy on
// HTML comments, so we list all from-game issues and filter client-side
// (only ~30-50 issues total, well under any pagination concern).

interface Env {
  SWR_BUGREPORT_TOKEN?: string;
  SWR_BUGREPORT_REPO?: string;
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const reporterId = (url.searchParams.get('reporterId') || '').trim();
  if (!reporterId || !/^[a-zA-Z0-9-]{4,64}$/.test(reporterId)) {
    return json({ ok: false, error: 'missing-or-bad-reporterId' }, 400);
  }
  const token = env.SWR_BUGREPORT_TOKEN;
  const repo = env.SWR_BUGREPORT_REPO;
  if (!token || !repo) {
    return json({ ok: false, error: 'server-not-configured' }, 500);
  }
  const tag = `<!-- reporter:${reporterId} -->`;

  try {
    // List recently-closed from-game issues. 50 is plenty; we use
    // `per_page=50` and don't paginate — older responses past 50 closed
    // issues will fall off and that's fine.
    const listResp = await fetch(
      `https://api.github.com/repos/${repo}/issues?state=closed&labels=from-game&per_page=50&sort=updated&direction=desc`,
      { headers: ghHeaders(token) },
    );
    if (!listResp.ok) {
      const text = await listResp.text();
      return json({ ok: false, error: `github-list: ${listResp.status} ${text.slice(0, 200)}` }, 502);
    }
    const issues: Array<{
      number: number; title: string; html_url: string; body: string | null;
      closed_at: string | null; comments: number;
    }> = await listResp.json();

    // Filter to this reporter's issues.
    const mine = issues.filter((i) => (i.body ?? '').includes(tag));

    // For each, fetch the most recent NON-bot, NON-screenshot-PR comment —
    // that's the resolution response. Cheap-fetch only if comments > 0.
    const out: Array<{
      number: number;
      title: string;
      htmlUrl: string;
      closedAt: string | null;
      response: string | null;
    }> = [];
    for (const issue of mine) {
      let response: string | null = null;
      if (issue.comments > 0) {
        const cResp = await fetch(
          `https://api.github.com/repos/${repo}/issues/${issue.number}/comments?per_page=20`,
          { headers: ghHeaders(token) },
        );
        if (cResp.ok) {
          const comments: Array<{
            body: string; user: { login: string; type: string }; created_at: string;
          }> = await cResp.json();
          // Take the most recent comment that ISN'T a screenshot-attached
          // commit notification or a bot post. Most resolution comments
          // are posted by the maintainer when closing.
          const candidates = comments
            .filter((c) => c.user?.type !== 'Bot')
            .filter((c) => !/^Screenshot for problem report/.test(c.body))
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          if (candidates.length > 0) {
            response = candidates[0].body;
          }
        }
      }
      out.push({
        number: issue.number,
        title: issue.title,
        htmlUrl: issue.html_url,
        closedAt: issue.closed_at,
        response,
      });
    }
    return json({ ok: true, responses: out });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 502);
  }
};

function ghHeaders(token: string): Record<string, string> {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'star-wars-rebellion-my-responses',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Allow short caching at the edge so a refresh-spam doesn't hit GH.
      'Cache-Control': 'public, max-age=60',
    },
  });
}
