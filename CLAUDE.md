# Notes for Claude

Project-local conventions for the Star Wars: Rebellion port. Skim before
each session.

## CRITICAL: which working directory / branch you are in

This repo has TWO active branches developed in parallel, each in its own
git worktree:

- **`master`** = single-player production (deploys to
  https://star-wars-rebellion.pages.dev). **My gameplay / RAW / bug-fix
  work and all production deploys happen here.**
  Worktree: `C:/Users/johnc/Claude Games/Star Wars Rebellion-master`
- **`framework-port`** = the user's online/multiplayer (lobby + game
  server) rebuild, developed in the ORIGINAL directory
  `C:/Users/johnc/Claude Games/Star Wars Rebellion`.

The user actively commits on `framework-port` between sessions, which
flips the original directory's checkout. Earlier this caused me to (a)
edit framework-port files by accident and ferry them to master, and (b)
deploy framework-port code to production by mistake. The worktree split
exists to PREVENT that.

**Rules:**
1. For any master/production task, `cd` into the
   `…/Star Wars Rebellion-master` worktree and work there. Do NOT edit
   files in the original directory unless the task is explicitly about
   `framework-port`.
2. Run `git branch --show-current` immediately before EVERY commit and
   EVERY deploy. It must say `master` for production work.
3. The worktree has its own `node_modules` and a copied
   `public/dev-assets/` (both gitignored). If a fresh worktree is ever
   recreated, run `npm install` and copy `public/dev-assets/` from the
   original directory before building/deploying.
4. Never deploy without confirming the build ran from the master
   worktree.

## ALWAYS check open bug reports at session start

The "Report a problem" button in-game files GitHub issues against
johnchampaign/star-wars-rebellion with the `from-game` label. The user
has filed many of these and gets (justifiably) angry when I "forget"
because nothing surfaces them to me automatically.

**At the start of every working session on this project, run:**

```bash
gh issue list --label from-game --state open
```

If issues exist, read each (`gh issue view N`), then either:
- **Fix it** in this session if it's small and the user is around to
  verify, OR
- **Acknowledge** it in your response so the user knows I've seen it
  ("I see issues #X, #Y, #Z — I'll tackle X this session and you can
  prioritize the others").

When you fix an issue, close it with `gh issue close N --comment
"Fixed in commit HASH — <one-line summary>"` so the user has the
audit trail and so future-me doesn't re-investigate it.

**Never** treat a "this is reported" complaint from the user as
unverified. They almost certainly have receipts in the issue tracker.
Check the tracker before pushing back.

## Report-response writing style

When closing a `from-game` issue, the closing comment is **shown back
to the reporter as a modal the next time they open the app** (via
`/api/my-responses` + `ReportResponseModal`). It's not a release
note — it's a personal reply to the player who took the time to
submit. Write it accordingly.

**Rules (adapted from the tutor project's "Dispute-response writing
style"):**

- **Acknowledge they were right** when they were ("Good catch — you
  spotted a real bug"). When they reported something that turned out
  to be RAW-correct or expected behavior, validate the report anyway
  ("Good question — the engine IS doing this on purpose, but you were
  right to flag it as suspicious").
- **Own bugs briefly.** "Our bad." / "Sorry you ran into that."
  Don't deflect, don't blame "the AI" or "the engine."
- **Plain language.** Not "the `destroyUnit` invariant fired because
  `health.color === null`" — "your Death Star got accidentally
  destroyed by a Rebel mission that wasn't supposed to be able to
  touch it." Imagine a board-game friend explaining the fix.
- **Don't include**: commit hashes, file paths, function names,
  internal terminology, GitHub-isms, library names. The reporter
  doesn't need any of that.
- **Thank them effusively.** Not "thanks for the report." Try:
  "Thank you so much — playtesters who file reports are where every
  improvement comes from. Please keep flagging stuff."
- **Vary the wording** per report. Don't form-letter it; the
  specific thing they noticed deserves specific acknowledgment.

**Template (shape, not text):**

> Good catch — you flagged \[plain description of what they noticed\]
> and you were right. \[What was happening in everyday terms.\]
> \[What's fixed / why it's the way it is.\] Thank you for taking the
> time to file this — reports like yours are how we keep finding
> real bugs. Please keep them coming.

For closures, post the user-facing comment via `gh issue close N
--comment "..."`. The comment shows in the app modal verbatim, so
keep it readable and don't use GitHub-flavored markdown that would
look weird stripped of styling.

## Branch discipline

**At session start, run `git branch --show-current` and verify it says
`master` before any commits.** This repo has parallel work in progress
on other branches (e.g. `framework-port`); committing there accidentally
strands work outside the deploy stream and means cherry-picking later.

If you find yourself on a non-master branch unexpectedly:
1. `git checkout master` before staging changes
2. If a commit already landed on the wrong branch, cherry-pick it onto
   master rather than merging the whole branch — other branches may
   have unrelated work-in-progress that shouldn't go to master.

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
