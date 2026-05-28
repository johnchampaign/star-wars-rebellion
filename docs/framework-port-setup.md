# Framework-port setup (Phase 2)

How to get the `framework-port` branch of this project running on Cloudflare
Pages with a Supabase backend, so you can hand two players invite URLs and
play a full game over the network.

This is the **Phase 2 / Option A** integration: hotseat is untouched, the
online play UI is a deliberately minimal "buttons for legal actions" page
sufficient to validate the framework integration end-to-end. The real
PlayTab → online port is Phase 3.

## One-time setup (you, once)

### 1. Create a Supabase project

1. Go to <https://supabase.com>, sign in, click **New project**.
2. Pick a name (`rebellion-port` works), generate a strong DB password, pick
   a region close to your players. Free tier is fine.
3. Wait ~2 minutes for it to provision.

### 2. Apply the framework's schema

1. In the Supabase dashboard, open **SQL Editor → New query**.
2. Paste the contents of
   `../Digital Boardgame Framework/supabase/schema.sql` (three tables:
   `dbf_games`, `dbf_snapshots`, `dbf_reports`).
3. Click **Run**. Should report "Success. No rows returned."

### 3. Get the credentials

In the Supabase dashboard:
- **Settings → API → Project URL** — copy the `https://<id>.supabase.co` URL.
- **Settings → API → Project API keys → service_role secret** — copy this
  too. **This key bypasses RLS — never put it in client code or commit it.**

### 4. Set Cloudflare Pages env vars

```bash
# From the rebellion repo root. The wrangler CLI is already auth'd on
# this machine per CLAUDE.md.
npx wrangler pages secret put SUPABASE_URL --project-name star-wars-rebellion
# Paste the project URL when prompted.

npx wrangler pages secret put SUPABASE_SERVICE_ROLE_KEY --project-name star-wars-rebellion
# Paste the service_role secret.
```

Optional: set `PUBLIC_BASE_URL` if you want invite URLs to use a specific
host (e.g. when testing across previews). Otherwise the API uses the
request's own origin.

### 5. Deploy the branch as a preview

```bash
git push -u origin framework-port
npx wrangler pages deploy dist --project-name star-wars-rebellion --branch framework-port --commit-dirty=true
```

Wrangler prints the preview URL — something like
`https://<hash>.star-wars-rebellion.pages.dev`. That URL has the online
routes live (`/lobby`, `/play/:id?as=TOKEN`) while production
(`https://star-wars-rebellion.pages.dev`) keeps the unchanged hotseat
build until we explicitly merge to `master`.

## Per-game flow (you and a co-player)

1. **Whoever creates the game:** visit `<preview-url>/lobby`, click
   **Create new game**.
2. Copy the **Rebel invite** URL and send it to the Rebel player.
3. Copy the **Empire invite** URL and send it to the Empire player.
4. Both players click their links. Whoever moves first sees a "Your turn"
   header with a list of legal-action buttons. Click one to submit; the
   server validates and updates the shared state. The other player sees the
   change on their next poll (default 8s).

Invite URLs are the only way back into a specific game — there's no "your
games" list. Bookmark them.

## Phase 2 limitations (what's deliberately missing)

- **No map render, no token art, no combat board** — the UI shows the
  redacted state as JSON and the legal actions as buttons. Sufficient to
  play a full game and exercise every adapter code path, but not pretty.
- **No setup phase** — `makeInitialState` uses `autoSetupUnits: true` so
  games start in Assignment. The interactive base-pick + unit-placement
  flow comes back in Phase 3.
- **No email-on-your-turn** — `NoopNotifier`. Players poll for opponent
  moves at 8s intervals while the page is open.
- **No game-list / lobby browsing** — one-shot invite-URL model.
- **Hotseat is unchanged.** Same URL, same UI, same behavior. The online
  routes are additive.

## Verifying the deployment

After setting env vars and deploying, smoke-test the API directly:

```bash
PREVIEW="https://<hash>.star-wars-rebellion.pages.dev"

# 1. Create a game.
curl -X POST "$PREVIEW/api/games" -H "Content-Type: application/json" -d '{}'
# Returns { gameId, invites: { Rebel: "...?as=TOK_R", Empire: "...?as=TOK_E" }, seed }

# 2. Fetch the Rebel view.
curl "$PREVIEW/api/games/<gameId>?as=<TOK_R>" | jq .

# 3. List the Rebel's legal actions.
curl "$PREVIEW/api/games/<gameId>/legal?as=<TOK_R>" | jq '.actions | length'

# 4. Submit one (use any action from the list above).
curl -X POST "$PREVIEW/api/games/<gameId>/submit?as=<TOK_R>" \
  -H "Content-Type: application/json" \
  -d '{"action":{"kind":"skipAssignment"}}'
```

If step 1 returns `error: "Missing SUPABASE_URL..."`, the env vars aren't
plumbed — recheck step 4.

## When you're satisfied with Phase 2

The branch stays as `framework-port`. Don't merge to master until Phase 3
(the real PlayTab refactor) is in.

If you want to nuke a game by ID:

```sql
-- Supabase SQL editor
delete from dbf_games where game_id = '<gameId>';
-- Snapshots cascade-delete automatically.
```
