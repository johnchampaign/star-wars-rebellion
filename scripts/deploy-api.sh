#!/usr/bin/env bash
# npm run deploy:api — ship the online API to John's Linode
# (docs/online-multiplayer.md "Where the API runs"). `npm run deploy` runs it
# after the Pages deploy, so the restarted process also reloads /dev-assets.
# Needs SSH as root to the Linode, so it runs from John's machine.
#
# Bundles server/linode.ts to one self-contained file, copies it to
# /opt/swr-api, restarts swr-api.service, and checks /api/health both on the
# box and through the tunnel. The previous bundle is kept as swr-api.prev.mjs;
# to roll back:
#   ssh root@$HOST 'cp /opt/swr-api/swr-api.prev.mjs /opt/swr-api/swr-api.mjs && systemctl restart swr-api'
set -euo pipefail
HOST="${SWR_API_HOST:-root@172.232.14.119}"
PUBLIC="${SWR_API_ORIGIN:-https://swr-api.johnchampaign.com}"

npm run build:api
rev=$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- src functions server package.json package-lock.json || echo '+dirty')
echo "deploying Rebellion API $rev to $HOST"
scp -q dist-api/swr-api.mjs "$HOST:/opt/swr-api/swr-api.next.mjs"
ssh "$HOST" "set -e; cd /opt/swr-api
  [ -f swr-api.mjs ] && cp swr-api.mjs swr-api.prev.mjs
  mv swr-api.next.mjs swr-api.mjs && echo '$rev' > REVISION
  systemctl restart swr-api
  for i in \$(seq 20); do curl -fsS http://127.0.0.1:8395/api/health >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fsS http://127.0.0.1:8395/api/health"
echo
# The box itself answered above (fatal if not). The public check is a warning
# only: if it fails, the tunnel or DNS name is down and the site falls back to
# running the API on Cloudflare, so the deploy itself still succeeded.
h=$(curl -fsS --max-time 20 "$PUBLIC/api/health" || true)
case "$h" in
  *'"configured":true'*) echo "$h"; echo "Rebellion API $rev live at $PUBLIC";;
  *'"configured":false'*) echo "WARNING: $PUBLIC is up but has no database keys (/etc/swr-api.env); it hands every request back to Cloudflare";;
  *) echo "WARNING: $PUBLIC unreachable; the site is falling back to Cloudflare (API $rev is on the box)";;
esac
