// Cloudflare Pages Function — POST /api/upload-logs
//
// Receives a batch of game-log records from the in-game "Upload logs"
// dialog and commits each one to the configured GitHub repo under
// `logs/<hash>.json`. Hash-based filenames make the upload idempotent —
// re-uploading the same game is a deterministic dedup.
//
// The logs repo is intentionally public per the project setup (see the
// upload dialog's warning copy: "anyone — including researchers — can
// use the dataset"). Players are warned before they click submit.
//
// Env vars:
//   SWR_BUGREPORT_TOKEN — GitHub PAT with `repo` scope (shared with /api/report)
//   SWR_BUGREPORT_REPO  — e.g. "johnchampaign/star-wars-rebellion"
//   SWR_LOGS_REPO       — optional override (e.g. dedicated logs repo)

interface Env {
  SWR_BUGREPORT_TOKEN?: string;
  SWR_BUGREPORT_REPO?: string;
  SWR_LOGS_REPO?: string;
}

interface GameRecord {
  encodedAt: string;
  winner?: string;
  winReason?: string;
  codec: string;
  inProgress?: boolean;
  source?: string;
}

interface UploadBody {
  games?: GameRecord[];
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  let body: UploadBody;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad json' }, 400);
  }
  const games = Array.isArray(body.games) ? body.games : [];
  if (games.length === 0) return json({ ok: false, error: 'no games' }, 400);

  const token = env.SWR_BUGREPORT_TOKEN;
  const repo = env.SWR_LOGS_REPO || env.SWR_BUGREPORT_REPO;
  if (!token || !repo) {
    return json({
      ok: false,
      error: 'server-not-configured',
      note: 'Cloudflare Pages env vars SWR_BUGREPORT_TOKEN / SWR_BUGREPORT_REPO (or SWR_LOGS_REPO) are not set.',
    }, 500);
  }

  let uploaded = 0, deduped = 0, failed = 0;
  const results: Array<{ hash: string; status: string; url?: string }> = [];

  for (const game of games) {
    const hash = await sha256Short(JSON.stringify(game));
    const payload = JSON.stringify({ schemaVersion: 1, hash, game }, null, 2);
    try {
      const repoPath = `logs/${hash}.json`;
      const putResp = await fetch(`https://api.github.com/repos/${repo}/contents/${repoPath}`, {
        method: 'PUT',
        headers: ghHeaders(token),
        body: JSON.stringify({
          message: `Upload play log ${hash}`,
          content: base64Utf8(payload),
        }),
      });
      if (putResp.ok) {
        const j: { content?: { html_url?: string } } = await putResp.json();
        uploaded++;
        results.push({ hash, status: 'uploaded', url: j.content?.html_url });
      } else if (putResp.status === 422) {
        // File already exists — same hash, identical content. Idempotent dedup.
        deduped++;
        results.push({ hash, status: 'deduped' });
      } else {
        failed++;
        const text = await putResp.text();
        results.push({ hash, status: `failed-${putResp.status}: ${text.slice(0, 100)}` });
      }
    } catch (e) {
      failed++;
      results.push({ hash, status: `failed-network: ${String(e).slice(0, 100)}` });
    }
  }

  return json({ ok: true, uploaded, deduped, failed, results });
};

// SHA256 via the Web Crypto API (Cloudflare Workers runtime).
async function sha256Short(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const arr = new Uint8Array(buf);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 16);
}

// Base64 of a UTF-8 string. GitHub Contents API expects base64.
function base64Utf8(s: string): string {
  // CF Workers exposes globalThis.btoa, but it only accepts Latin-1. Encode
  // to UTF-8 bytes first.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function ghHeaders(token: string): Record<string, string> {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'star-wars-rebellion-log-uploader',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
