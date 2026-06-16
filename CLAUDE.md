# Notes for Claude

Project-local conventions for the Star Wars: Rebellion port. Skim before
each session.

## Branches: master + the multiplayer-framework feature branch

This project develops on **`master`**, in the one working directory
`C:/Users/johnc/Claude Games/Star Wars Rebellion`. master is production
(deploys to https://star-wars-rebellion.pages.dev). Do all hotseat/engine
work here.

**Active feature branch: `multiplayer-framework`.** This is the
async-online-PvP + vs-AI rebuild on `digital-boardgame-framework` (Supabase
+ Cloudflare Functions + Resend email). It is a *real, live* branch (unlike
the abandoned `framework-port`), kept reconciled with master by periodically
`git merge master` into it (PlayTab auto-merges cleanly so far). It merges
to master at "Phase 6" after a live two-human playtest. The online stack,
its architecture, the secret/deploy model, and the pre-merge checklist are
documented in **`docs/online-multiplayer.md`** — read it before touching
anything under `functions/`, `src/adapter/`, or `src/online/`. The
engine has branch-only additions there (`codec.encodeFull`,
`setup.buildCatalog` export, `types.aiSides`) that don't exist on master
yet.

History: there was a `framework-port` branch (an online/lobby/game-server
rebuild) developed in parallel. It was **abandoned** — the parallel
branches caused accidental cross-branch edits and a wrong-branch
production deploy. It's preserved as the tag **`framework-port-archive`**
(local + origin) if its online-stack code is ever wanted again, but it is
NOT an active branch. There is no second worktree anymore.

**Rules:**
1. Everything happens on `master` in the main directory. Still worth a
   quick `git branch --show-current` before a commit/deploy, but there's
   no longer another branch to drift to.
2. Do NOT revive or merge `framework-port` into master without an explicit
   request — it carries framework dependencies (game server, lobby) that
   would complicate the single-player build.
3. `public/dev-assets/*.json` is the RUNTIME catalog the game fetches; it's
   gitignored and generated from the tracked `assets/*.json` by
   `scripts/copy-dev-assets.mjs`. The `build` script runs that copy first,
   so source edits always reach the runtime — never hand-edit dev-assets.

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

## Commit + push after a fix (standing authorization)

Once something is **fixed and verified** (typecheck clean at the known
baseline, relevant tests/suites pass), commit and push it to `master`
**without asking** — this is pre-authorized. Use a HEREDOC commit message
summarizing by impact + the Co-Authored-By line; never `--amend` or
`--force-push`; `git pull --no-edit origin master` before pushing
(parallel sessions push to master too). This covers commit + `git push
origin master`. It does NOT auto-authorize a Cloudflare **deploy** — that
still waits for an explicit "ship/deploy/release" (see below) — nor does it
license committing on a bad/unverified change.

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

## Typecheck before touching the engine

The deploy path runs `vite build` only (esbuild), which **erases type-only
imports and never type-checks** — so type errors, stale property reads, and
out-of-scope references sail through the build and surface as runtime
crashes instead. `tsc -b` is intentionally skipped (composite-reference
issue), so it can't be the guard.

**Run `npm run typecheck` before committing anything under `src/engine`**
(and ideally `src/play`). It uses `tsconfig.typecheck.json`, which bypasses
the composite-reference problem and checks all of `src/`. The engine is
expected to report **zero** errors; a real typecheck pass once caught a
report-payload `ReferenceError`, an AI reading a non-existent `G.buildQueue`,
and a loyalty comparison that never fired.

Known-cosmetic remaining errors live in `src/play` only (UI type-strictness:
a self-referential `j` initializer, a couple `DieFace`/`UnitImageStyle`
string-literal narrowings, the `OneInAMillionOffer` prop shape, and the
captured-leader `Pip` type-predicate generics). None affect runtime; don't
let them mask a *new* error — diff the list, don't eyeball the count.

Do **not** "fix" these by adding `@types/node` to the main tsconfig, enabling
`tsc -b` in deploy, or bulk-casting to `any`.

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
- **Online multiplayer** (`multiplayer-framework` branch only): the async
  PvP + vs-AI stack — `src/adapter/` (engine↔framework glue), `functions/`
  (authoritative server, AI takeover, abandonment, turn email), `src/online/`
  (Lobby + OnlinePlay). Full map in **`docs/online-multiplayer.md`**.

## AI logs & analysis — which side was the human?

When mining play logs, prefer the RECORDED controlled side; only fall
back to outcome-inference, and never confuse the two. The human plays
BOTH sides and (per the user) basically never loses to the current AI —
so a "Rebel reputation-time win" is usually the **human playing Rebel
beating the AI Empire**, not the AI Rebel winning.

- For logs that predate the `humanSide` field, inferring **human = the
  winning side** is reliable *for this project* (the AI is weak enough
  that the user wins ~every game) — but tag it as inferred, not recorded.
- This shortcut is valid ONLY because the player ~always beats the AI.
  Don't carry it to logs that might contain losses (e.g. future
  human-vs-human games, or a much stronger AI).

- The controlled side IS recorded: game start writes the resolved side to
  `localStorage['rebellion-human-side']`; `archiveCompletedGame` and the
  `/api/upload-logs` payload both carry a `humanSide` field on the upload
  **wrapper** (NOT inside the `codec` engine state — the engine is
  symmetric and has no such field).
- `scripts/analyze-invasions.mjs` reads that wrapper field and prints
  `Empire=human|AI|unknown`. Logs uploaded before the field existed show
  `unknown` — treat those as genuinely unknown; do not guess.
- AI-vs-AI **tournament** logs (`scripts/tournament.mjs`) have no human at
  all — both sides are the heuristic AI. The ~28–48% Empire win rates come
  from there (self-play), which is a separate thing from the user's games.

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
#97 (Collect Bounty relocate — likely already implemented; verify-and-close),
#99 (action card play paths — partially done). Don't add new tasks without
checking the list first to avoid duplicates.

Completed: #98 (Empire base-hover probe overlay) — done, including the
pin/unpin follow-up; the whole `from-game` GitHub queue is also cleared.

## Things NOT to do

- Don't commit `.env` or any token-bearing file.
- Don't commit anything under `reports/`, `logs/`, `game-logs/`,
  `vmod_extracted/`, or `public/dev-assets/` (all gitignored).
- Don't ship FFG-copyrighted PDFs (gitignored by pattern).
- Don't add `@types/node` to fix the vite.config.ts tsc errors —
  see deploy note above. The pragmatic answer is the `build:fast` /
  `deploy` script that uses `vite build` directly.
