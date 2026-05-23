# Deploying to Cloudflare Pages

The game is a static Vite build (in `dist/` after `npm run build`) plus two
Cloudflare Pages Functions in `functions/api/` that proxy player-submitted
problem reports and game-log uploads into a GitHub repo. This document
walks through getting it running on a public URL.

## One-time setup

### 1. Create a GitHub Personal Access Token

The Functions file GitHub Issues and commit files via the GitHub API.
They need a token with `repo` scope (or `public_repo` if the bug-report
repo is public).

1. Go to https://github.com/settings/tokens → **Generate new token (classic)**.
2. Scopes: tick **`repo`** (or **`public_repo`** if the repo is public).
3. Set expiration to your preference (Cloudflare doesn't refresh tokens —
   set a reminder to rotate before it expires).
4. Copy the token (`ghp_…`). You'll paste it into Cloudflare in step 3.

### 2. Connect the repo to Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages** → **Create application** →
   **Pages** → **Connect to Git**.
2. Authorize GitHub if you haven't, then pick the
   `star-wars-rebellion` repo.
3. Project settings:
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: leave blank
4. Click **Save and Deploy**. The first build will succeed but the Functions
   won't work yet — they need env vars (step 3).

### 3. Set environment variables

Cloudflare dashboard → your Pages project → **Settings** → **Environment
variables** → **Production** → **Add variable**:

| Name | Value | Encrypted? |
|------|-------|------------|
| `SWR_BUGREPORT_TOKEN` | the `ghp_…` token from step 1 | ✅ yes |
| `SWR_BUGREPORT_REPO` | `johnchampaign/star-wars-rebellion` (or your fork) | no |
| `SWR_LOGS_REPO`      | (optional) different repo for play logs; defaults to `SWR_BUGREPORT_REPO` | no |

⚠ **Mark `SWR_BUGREPORT_TOKEN` as Encrypted.** If you don't, anyone with
collaborator access to the Cloudflare project can read it.

Click **Save**. Cloudflare will redeploy automatically with the new env.

### 4. Test it

Visit the deployed URL (Cloudflare shows it on the project's overview page,
e.g. `https://star-wars-rebellion.pages.dev`).

- Play any move, click **Report a problem**, fill out the form, submit.
- You should get a "Submitted as issue #N" link in the dialog.
- The GitHub repo should now have a new issue + a committed screenshot
  PNG in `reports/screenshots/`.
- Click **Upload logs** → confirm the warning → the repo's `logs/` folder
  should get one `<hash>.json` per submitted game.

If something fails, the Cloudflare dashboard's **Functions** tab shows live
logs and error responses.

## Ongoing operation

- **Auto-deploys**: every push to `main` triggers a fresh build + deploy.
  Other branches get preview URLs (also configurable in CF Pages settings).
- **Token rotation**: when the GitHub PAT expires, generate a new one and
  update `SWR_BUGREPORT_TOKEN` in CF. No code change needed.
- **Cost**: Cloudflare Pages free tier covers 500 builds/month and
  100,000 Function invocations/day. This project will not approach those
  limits.

## Local dev parity

`npm run dev` still works exactly as before — Vite middleware (`vite.config.ts`)
exposes the same `/api/report` and `/api/upload-logs` endpoints locally,
backed by the same `SWR_BUGREPORT_TOKEN` / `SWR_BUGREPORT_REPO` env vars
loaded from a `.env` file. So bug-report submissions during local dev still
file real GitHub issues (against whichever repo your `.env` points to).

To opt-out of real issue filing during dev (e.g. for testing the UI without
spamming the repo), just leave the env vars unset — the dev middleware falls
back to writing reports to `./reports/` locally.
