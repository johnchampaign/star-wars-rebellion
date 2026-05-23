import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/**
 * Dev-only plugin that exposes two POST endpoints:
 *
 * - /__game-dump — fired on every state change, mirrors the current G to
 *   ./game-logs/latest.json so the agent can read live state without
 *   copy-paste.
 * - /api/report — in-game "Report a problem" dialog posts here. Files a
 *   GitHub Issue against the configured repo when SWR_BUGREPORT_TOKEN and
 *   SWR_BUGREPORT_REPO env vars are set (port of the ToTU pattern); always
 *   also writes the report to ./reports/ as a safety net.
 * - /api/upload-logs — bulk-uploads play logs to the repo for AI training.
 *
 * Production uses Cloudflare Pages Functions at the SAME paths
 * (`functions/api/report.ts`, `functions/api/upload-logs.ts`), so the
 * client-side fetches don't need to switch URLs between dev and prod.
 *
 * No-op in production builds — Vite middleware only runs in `vite dev`.
 */
function devPlugin() {
  return {
    name: 'swr-dev',
    configureServer(server: any) {
      // -------- /__game-dump --------
      const dumpDir = resolve(process.cwd(), 'game-logs');
      try { mkdirSync(dumpDir, { recursive: true }); } catch { /* ignore */ }

      server.middlewares.use('/__game-dump', (req: any, res: any) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            writeFileSync(resolve(dumpDir, 'latest.json'), body);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
            writeFileSync(resolve(dumpDir, `${stamp}.json`), body);
            res.statusCode = 204; res.end();
          } catch (e) {
            res.statusCode = 500; res.end(String(e));
          }
        });
        req.on('error', () => { res.statusCode = 400; res.end('bad request'); });
      });

      // -------- /__report --------
      const reportsDir = resolve(process.cwd(), 'reports');
      try { mkdirSync(reportsDir, { recursive: true }); } catch { /* ignore */ }

      const token = process.env.SWR_BUGREPORT_TOKEN;
      const repo = process.env.SWR_BUGREPORT_REPO; // e.g. "johnchampaign/star-wars-rebellion"

      server.middlewares.use('/api/report', async (req: any, res: any) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          let body: any;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { res.statusCode = 400; res.end('bad json'); return; }

          const description = (body.description || '').trim();
          if (!description) { res.statusCode = 400; res.end('empty description'); return; }

          // Always write the raw payload to disk first as a safety net.
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const filename = `report-${stamp}.json`;
          const filepath = resolve(reportsDir, filename);
          try {
            writeFileSync(filepath, JSON.stringify(body, null, 2));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: `disk write failed: ${String(e)}` }));
            return;
          }
          const relPath = relative(process.cwd(), filepath).replace(/\\/g, '/');

          // Save the screenshot to the local reports dir too, alongside
          // the JSON. Even when GitHub upload isn't configured, having the
          // PNG on disk lets the dev cross-reference visually.
          let screenshotLocalPath: string | null = null;
          if (body.screenshotBase64 && typeof body.screenshotBase64 === 'string') {
            try {
              const pngPath = resolve(reportsDir, `report-${stamp}.png`);
              writeFileSync(pngPath, Buffer.from(body.screenshotBase64, 'base64'));
              screenshotLocalPath = relative(process.cwd(), pngPath).replace(/\\/g, '/');
            } catch { /* non-fatal */ }
          }

          // Build a GitHub-friendly markdown issue body.
          const title = description.split('\n')[0].slice(0, 80) || 'Problem report';
          const sections: string[] = [`**What happened**\n\n${description}`];
          sections.push(`**Build / context**\n\n- userAgent: \`${body.userAgent || ''}\`\n- canEncodeState: \`${body.canEncodeState}\`\n- timestamp: \`${body.timestamp || ''}\``);
          if (body.turnLog?.length) {
            const tail = body.turnLog.slice(-30).map((e: any) => `t${e.turn} ${e.side || ''} ${e.kind} ${JSON.stringify(e.payload || '')}`.slice(0, 220)).join('\n');
            sections.push(`**Last ${Math.min(30, body.turnLog.length)} log entries**\n\n\`\`\`\n${tail}\n\`\`\``);
          }
          if (body.state) {
            const stateJson = JSON.stringify(body.state, null, 2);
            const truncated = stateJson.length > 50000 ? stateJson.slice(0, 50000) + '\n...(truncated — full state in reports/' + filename + ')' : stateJson;
            sections.push(`**Game state**\n\n\`\`\`json\n${truncated}\n\`\`\``);
          }
          if (body.pending) {
            sections.push(`**Pending mid-resolution state**\n\n\`\`\`json\n${JSON.stringify(body.pending, null, 2)}\n\`\`\``);
          }
          // Screenshot embed slot — populated after GitHub commit below.
          const screenshotPlaceholder = '__SCREENSHOT_URL__';
          if (body.screenshotBase64 && (token && repo)) {
            sections.push(`**Screenshot**\n\n![screenshot](${screenshotPlaceholder})`);
          } else if (screenshotLocalPath) {
            sections.push(`**Screenshot**\n\n(saved locally to \`${screenshotLocalPath}\`)`);
          }
          let issueBody = sections.join('\n\n---\n\n');

          if (!token || !repo) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ok: true,
              filePath: relPath,
              note: 'GitHub not configured (set SWR_BUGREPORT_TOKEN and SWR_BUGREPORT_REPO in your env to auto-file issues). Report saved locally.',
            }));
            return;
          }

          // If we have a screenshot, commit it to the repo first so the
          // issue body can embed it via raw URL. GitHub doesn't let you
          // upload images via the issues API directly, so this is the
          // standard workaround (commit → reference).
          let screenshotRawUrl: string | null = null;
          if (body.screenshotBase64 && typeof body.screenshotBase64 === 'string') {
            try {
              const repoPath = `reports/screenshots/report-${stamp}.png`;
              const commitMsg = `Screenshot for problem report ${stamp}`;
              const putResp = await fetch(`https://api.github.com/repos/${repo}/contents/${repoPath}`, {
                method: 'PUT',
                headers: {
                  'Accept': 'application/vnd.github+json',
                  'Authorization': `Bearer ${token}`,
                  'X-GitHub-Api-Version': '2022-11-28',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  message: commitMsg,
                  content: body.screenshotBase64,
                }),
              });
              if (putResp.ok) {
                const j = await putResp.json() as { content?: { download_url?: string } };
                screenshotRawUrl = j.content?.download_url ?? null;
              }
            } catch { /* non-fatal — fall through with placeholder */ }
          }
          // Substitute the screenshot placeholder. If commit failed, drop
          // the image reference rather than leaving a broken markdown link.
          if (screenshotRawUrl) {
            issueBody = issueBody.replace('__SCREENSHOT_URL__', screenshotRawUrl);
          } else {
            issueBody = issueBody.replace(/\n\n---\n\n\*\*Screenshot\*\*\n\n!\[screenshot\]\(__SCREENSHOT_URL__\)/, '');
          }

          try {
            const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
              method: 'POST',
              headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                title,
                body: issueBody,
                labels: ['bug', 'from-game'],
              }),
            });
            if (!resp.ok) {
              const text = await resp.text();
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                ok: false,
                error: `GitHub ${resp.status}: ${text.slice(0, 400)}`,
                filePath: relPath,
              }));
              return;
            }
            const issue = await resp.json() as { html_url: string; number: number };
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ok: true,
              url: issue.html_url,
              number: issue.number,
              filePath: relPath,
            }));
          } catch (err) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: String(err), filePath: relPath }));
          }
        });
        req.on('error', () => { res.statusCode = 400; res.end('bad request'); });
      });

      // -------- /__upload-logs --------
      // Bulk-upload play logs to the repo for AI training. The client posts
      // an array of game records; the endpoint commits each one under
      // logs/<hash>.json via the Contents API (when token+repo are set),
      // or saves them under ./logs/ locally otherwise.
      // SHA256-based filenames make duplicate uploads idempotent — re-uploading
      // an unchanged log is a no-op on the server side.
      const logsDir = resolve(process.cwd(), 'logs');
      try { mkdirSync(logsDir, { recursive: true }); } catch { /* ignore */ }

      server.middlewares.use('/api/upload-logs', async (req: any, res: any) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          let body: any;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { res.statusCode = 400; res.end('bad json'); return; }

          const games: any[] = Array.isArray(body.games) ? body.games : [];
          if (games.length === 0) {
            res.statusCode = 400; res.end('no games'); return;
          }

          const { createHash } = await import('node:crypto');
          const hashOf = (obj: unknown): string =>
            createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);

          let uploaded = 0, deduped = 0, failed = 0;
          const results: Array<{ hash: string; status: string; url?: string }> = [];

          for (const game of games) {
            const hash = hashOf(game);
            const payload = JSON.stringify({ schemaVersion: 1, hash, game }, null, 2);
            // Always write locally first.
            try {
              writeFileSync(resolve(logsDir, `${hash}.json`), payload);
            } catch { /* ignore — GitHub path may still succeed */ }

            if (!token || !repo) {
              uploaded++;
              results.push({ hash, status: 'local-only' });
              continue;
            }

            // Commit to repo via Contents API. If the file already exists,
            // GitHub returns 422 — treat that as a dedup hit.
            try {
              const repoPath = `logs/${hash}.json`;
              const putResp = await fetch(`https://api.github.com/repos/${repo}/contents/${repoPath}`, {
                method: 'PUT',
                headers: {
                  'Accept': 'application/vnd.github+json',
                  'Authorization': `Bearer ${token}`,
                  'X-GitHub-Api-Version': '2022-11-28',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  message: `Upload play log ${hash}`,
                  content: Buffer.from(payload).toString('base64'),
                }),
              });
              if (putResp.ok) {
                const j = await putResp.json() as { content?: { html_url?: string } };
                uploaded++;
                results.push({ hash, status: 'uploaded', url: j.content?.html_url });
              } else if (putResp.status === 422) {
                deduped++;
                results.push({ hash, status: 'deduped' });
              } else {
                failed++;
                results.push({ hash, status: `failed-${putResp.status}` });
              }
            } catch {
              failed++;
              results.push({ hash, status: 'failed-network' });
            }
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, uploaded, deduped, failed, results }));
        });
        req.on('error', () => { res.statusCode = 400; res.end('bad request'); });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load .env into process.env so the report middleware can read
  // SWR_BUGREPORT_TOKEN / SWR_BUGREPORT_REPO at server start. Without the
  // empty-prefix arg, Vite only exposes VITE_-prefixed vars; we
  // deliberately keep the token un-prefixed so it never reaches the client.
  const env = loadEnv(mode, process.cwd(), '');
  for (const k of Object.keys(env)) {
    if (process.env[k] === undefined) process.env[k] = env[k];
  }
  return {
    plugins: [react(), devPlugin()],
    server: { port: 5173 },
    build: {
      rollupOptions: {
        output: {
          // Peel React + the engine off the main app bundle so the warning
          // clears and browsers can cache the heavy bits independently of
          // app-code churn.
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'engine': [
              './src/engine/phases.ts',
              './src/engine/combat.ts',
              './src/engine/mechanics.ts',
              './src/engine/handlers/index.ts',
              './src/engine/missionTargets.ts',
              './src/engine/objectives.ts',
              './src/engine/setup.ts',
            ],
          },
        },
      },
    },
  };
});
