# SWR online AI worker (Linode)

Off-Cloudflare worker that plays the **online-vs-AI** moves with the strong
depth-2 board-eval policy (Cloudflare's per-request CPU limit can't run depth-2).
Polls `/api/admin/ai-due`, computes locally, posts to `/api/admin/ai-move`.

## Layout on the box (`champaignj@172.232.14.119`, root-free)
- `~/swr-ai/` — clone of `johnchampaign/star-wars-rebellion` (public).
- `~/swr-worker.env` — `SWR_BASE_URL`, `SWR_ADMIN_TOKEN`, `AI_POLL_MS`, `AI_DEPTH`
  (perms 600, **outside** the repo so `git pull` never touches it).
- `~/swr-ai-worker.log` — worker + supervisor output.
- `deploy/ai-worker/tick.sh` — cron supervisor + auto-deploy (see below).

## Install (one-time)
```bash
git clone --depth 1 https://github.com/johnchampaign/star-wars-rebellion.git ~/swr-ai
cd ~/swr-ai && npm ci --no-audit --no-fund
# create ~/swr-worker.env (SWR_BASE_URL + SWR_ADMIN_TOKEN), chmod 600
chmod +x ~/swr-ai/deploy/ai-worker/tick.sh
( crontab -l 2>/dev/null | grep -v 'swr-ai/deploy/ai-worker/tick.sh';
  echo '* * * * * $HOME/swr-ai/deploy/ai-worker/tick.sh';
  echo '@reboot $HOME/swr-ai/deploy/ai-worker/tick.sh' ) | crontab -
~/swr-ai/deploy/ai-worker/tick.sh   # start now
```

## Ops
- **Status:** `pgrep -af scripts/ai-worker.mjs` · **Logs:** `tail -f ~/swr-ai-worker.log`
- **Stop:** `pkill -f scripts/ai-worker.mjs` (cron restarts within a minute; to stop
  for real, remove the crontab lines first).
- **Deploy:** just `git push` to master — `tick.sh` pulls within a minute, `npm ci`s
  on a lockfile change, and restarts on new code (keeps the engine in lockstep
  with Cloudflare so snapshots stay codec-compatible).

## Sole-mover flag
Once the worker is verified moving games, set `AI_WORKER_ENABLED` on the
Cloudflare Pages project so the inline heuristic stops competing:
`npx wrangler pages secret put AI_WORKER_ENABLED --project-name star-wars-rebellion`
(any value). Unset it to fall back to inline heuristic AI.
