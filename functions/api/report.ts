// Cloudflare Pages Function — POST /api/report
//
// Receives a problem-report payload from the in-game "Report a problem"
// dialog and files a GitHub Issue against the configured repo. Mirrors the
// dev-only vite middleware (`/__report` in vite.config.ts) so the same
// client code works in dev and in production.
//
// Env vars (set in the Cloudflare Pages dashboard, Settings → Environment
// variables, *encrypted*):
//   SWR_BUGREPORT_TOKEN — GitHub Personal Access Token with `repo` scope
//                        (or `public_repo` if the bug-report repo is public)
//   SWR_BUGREPORT_REPO  — e.g. "johnchampaign/star-wars-rebellion"
//
// Token never reaches the client: this Function runs on Cloudflare's edge.

interface Env {
  SWR_BUGREPORT_TOKEN?: string;
  SWR_BUGREPORT_REPO?: string;
}

interface ReportBody {
  description?: string;
  userAgent?: string;
  timestamp?: string;
  canEncodeState?: boolean;
  state?: unknown;
  pending?: unknown;
  turnLog?: Array<{ turn: number; side?: string; kind: string; payload?: unknown }>;
  screenshotBase64?: string;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  let body: ReportBody;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad json' }, 400);
  }
  const description = (body.description || '').trim();
  if (!description) return json({ ok: false, error: 'empty description' }, 400);

  const token = env.SWR_BUGREPORT_TOKEN;
  const repo = env.SWR_BUGREPORT_REPO;
  if (!token || !repo) {
    return json({
      ok: false,
      error: 'server-not-configured',
      note: 'Cloudflare Pages env vars SWR_BUGREPORT_TOKEN / SWR_BUGREPORT_REPO are not set.',
    }, 500);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const title = description.split('\n')[0].slice(0, 80) || 'Problem report';

  // Commit screenshot first (if present) so the issue body can embed it.
  let screenshotRawUrl: string | null = null;
  if (body.screenshotBase64 && typeof body.screenshotBase64 === 'string') {
    try {
      const repoPath = `reports/screenshots/report-${stamp}.png`;
      const putResp = await fetch(`https://api.github.com/repos/${repo}/contents/${repoPath}`, {
        method: 'PUT',
        headers: ghHeaders(token),
        body: JSON.stringify({
          message: `Screenshot for problem report ${stamp}`,
          content: body.screenshotBase64,
        }),
      });
      if (putResp.ok) {
        const j: { content?: { download_url?: string } } = await putResp.json();
        screenshotRawUrl = j.content?.download_url ?? null;
      }
    } catch {
      /* non-fatal — issue still files without the screenshot */
    }
  }

  // Build the issue markdown body.
  const sections: string[] = [`**What happened**\n\n${description}`];
  sections.push(
    `**Build / context**\n\n` +
    `- userAgent: \`${body.userAgent || ''}\`\n` +
    `- canEncodeState: \`${body.canEncodeState}\`\n` +
    `- timestamp: \`${body.timestamp || ''}\`\n` +
    `- server-stamp: \`${stamp}\``
  );
  if (body.turnLog?.length) {
    const tail = body.turnLog.slice(-30).map((e) =>
      `t${e.turn} ${e.side || ''} ${e.kind} ${JSON.stringify(e.payload || '')}`.slice(0, 220)
    ).join('\n');
    sections.push(`**Last ${Math.min(30, body.turnLog.length)} log entries**\n\n\`\`\`\n${tail}\n\`\`\``);
  }
  if (body.state) {
    const stateJson = JSON.stringify(body.state, null, 2);
    const truncated = stateJson.length > 50_000
      ? stateJson.slice(0, 50_000) + '\n...(truncated — game state was over 50KB)'
      : stateJson;
    sections.push(`**Game state**\n\n\`\`\`json\n${truncated}\n\`\`\``);
  }
  if (body.pending) {
    sections.push(`**Pending mid-resolution state**\n\n\`\`\`json\n${JSON.stringify(body.pending, null, 2)}\n\`\`\``);
  }
  if (screenshotRawUrl) {
    sections.push(`**Screenshot**\n\n![screenshot](${screenshotRawUrl})`);
  }
  const issueBody = sections.join('\n\n---\n\n');

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify({
        title,
        body: issueBody,
        labels: ['bug', 'from-game'],
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return json({
        ok: false,
        error: `GitHub ${resp.status}: ${text.slice(0, 400)}`,
      }, 502);
    }
    const issue: { html_url: string; number: number } = await resp.json();
    return json({ ok: true, url: issue.html_url, number: issue.number });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 502);
  }
};

function ghHeaders(token: string): Record<string, string> {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    // Required by GitHub API for some endpoints — provide a UA.
    'User-Agent': 'star-wars-rebellion-bug-reporter',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
