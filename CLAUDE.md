# Notes for Claude

Project-local conventions for the Star Wars: Rebellion port. Skim before
each session.

## Deploys

The user does NOT want to run deploy commands themselves. When they ask
to "ship", "deploy", "push the changes live", "release", etc., you
handle the whole thing:

1. **Commit any staged work.** Use a HEREDOC commit message that
   summarizes the changes by impact (not just "fixed bug"). Co-author
   line at the bottom. Never `--amend` or `--force-push`.
2. **Push to GitHub.** `git push origin master`.
3. **Build + deploy to Cloudflare Pages.** One command:
   ```bash
   npm run deploy
   ```
   This runs `vite build && wrangler pages deploy dist ...`. Note we
   intentionally skip the `tsc -b` step in the deploy script because
   the project has pre-existing tsconfig issues that don't affect the
   actual runtime build. `vite build` alone produces a working `dist/`.
4. **Report back with**:
   - The new deployment preview URL (wrangler prints `https://<hash>.star-wars-rebellion.pages.dev`)
   - The production URL: https://star-wars-rebellion.pages.dev
   - The commit hash that's now live

The wrangler CLI is already authenticated on this machine (OAuth token,
john.champaign@gmail.com's account). The Cloudflare project is named
`star-wars-rebellion`, production branch is `master`.

If deploy fails, common causes:
- TypeScript error in user code (real bug — fix it, don't bypass)
- Wrangler auth expired (`npx wrangler whoami` to check)
- CF env vars missing (`npx wrangler pages secret list --project-name star-wars-rebellion`)

## Architecture quick-reference

- **Engine** (`src/engine/`): pure-function TypeScript core. No React, no
  DOM. Phases in `phases.ts`, combat sub-machine in `combat.ts`, effects
  in `handlers/index.ts`, RAW data in `units.ts` + `assets/*.json`.
- **UI** (`src/play/PlayTab.tsx`, `CombatBoardLive.tsx`): React + Vite.
  Talks to the engine via direct function calls; no boardgame.io
  abstractions any more.
- **AI**: `src/play/randomAI.ts` — random + minimal heuristic. Synchronous,
  steps once per call, driven by `runAILoop` in PlayTab.
- **Serverless** (`functions/api/*.ts`): Cloudflare Pages Functions for
  `/api/report` and `/api/upload-logs`. Mirror the dev-only vite
  middleware in `vite.config.ts` at the same paths.

## RAW compliance

User wants RAW (rules-as-written) per the FFG 2016 base-game rules:
- Rules Reference: `sw03_rules_reference_web.pdf` (gitignored)
- Learn To Play: `sw03_learn_to_play_web.pdf` (gitignored)
- Mission/Card refs: `assets/*.json` (canonical card text)

If the user asks for something that conflicts with RAW, push back BEFORE
implementing. Example: "this card gives X" might be misremembered — quote
the actual `rulesText` from `assets/*.json` and confirm before changing
behavior.

## Audit / task list

The Claude Code TaskList is the canonical "what's left." Open items as of
the most recent session are #85 (verify unit stats), #94 (combat-board UX),
#97 (Collect Bounty relocate), #98 (Empire base-hover probe overlay),
#99 (action card play paths — partially done). Don't add new tasks without
checking the list first to avoid duplicates.

## Things NOT to do

- Don't commit `.env` or any token-bearing file.
- Don't commit anything under `reports/`, `logs/`, `game-logs/`,
  `vmod_extracted/`, or `public/dev-assets/` (all gitignored).
- Don't ship FFG-copyrighted PDFs (gitignored by pattern).
- Don't add `@types/node` to fix the vite.config.ts tsc errors —
  see deploy note above. The pragmatic answer is the `build:fast` /
  `deploy` script that uses `vite build` directly.
