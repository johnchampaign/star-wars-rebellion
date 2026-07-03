#!/usr/bin/env bash
# Root-free supervisor + auto-deploy for the SWR online AI worker on the Linode
# box. Run every minute from champaignj's user crontab (+ @reboot). It:
#   1. pulls the latest commit (auto-deploy, mirroring echo),
#   2. reinstalls deps only if package-lock changed, restarts on new code,
#   3. (re)starts the worker if it isn't running — so a crash or reboot self-heals.
# No root, no systemd, no linger needed: cron runs it regardless of login state.
# Install: see deploy/ai-worker/README.md.
set -uo pipefail

REPO="$HOME/swr-ai"
ENV_FILE="$HOME/swr-worker.env"
LOG="$HOME/swr-ai-worker.log"
cd "$REPO" || exit 0

before=$(git rev-parse HEAD 2>/dev/null || echo none)
git pull --ff-only --quiet 2>/dev/null || true
after=$(git rev-parse HEAD 2>/dev/null || echo none)

if [ "$before" != "$after" ]; then
  # Reinstall only when the lockfile actually moved (npm ci is the slow part).
  if ! git diff --quiet "$before" "$after" -- package-lock.json 2>/dev/null; then
    nice -n 19 npm ci --no-audit --no-fund >>"$LOG" 2>&1 || true
  fi
  # New code — restart so the worker runs the fresh engine (matches Cloudflare).
  pkill -f "scripts/ai-worker.mjs" 2>/dev/null || true
  sleep 1
fi

# Ensure the worker is running (restart if it crashed). Lowest priority so the
# live tutor/forum on this shared 1-vCPU box always pre-empt it.
if ! pgrep -f "scripts/ai-worker.mjs" >/dev/null 2>&1; then
  # setsid + </dev/null fully detaches so it survives the launching session
  # closing (a plain `nohup ... &` from an SSH command still dies on channel
  # close because stdin stays tied to the SSH channel).
  setsid nice -n 19 node "$REPO/scripts/ai-worker.mjs" "$ENV_FILE" >>"$LOG" 2>&1 </dev/null &
  echo "[tick $(date -u +%FT%TZ)] started worker" >>"$LOG"
fi
