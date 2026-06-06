# Online multiplayer (async PvP + vs-AI)

How the asynchronous, play-by-cloud version of the game works. Built on
`digital-boardgame-framework` (the user's own npm package) over Cloudflare
Pages Functions + Supabase, with Resend for turn-alert email. This file is
the map; the code is the territory.

## At a glance

- **One app, opt-in.** The same React app serves hotseat *and* online. A
  player opts into online from the Lobby; nothing about the local hotseat
  game changed. vs-AI is just an online game where one seat is flagged AI.
- **Authoritative server.** The engine is pure functions, but in online
  games the *server* owns the canonical state. Clients submit actions; the
  server validates, applies, runs any AI turn, persists, and hands back a
  per-seat-redacted view. A client can never see the opponent's hidden info.
- **Async by design.** No realtime socket. A player loads the game, sees
  whether it's their turn, submits, and leaves. The opponent gets an email
  when it's been their turn for a while. Games can span days.

## Pieces

```
src/adapter/      engine ↔ framework glue (pure, no DOM)
  rebellionAction.ts   ~95-variant RebellionAction discriminated union + assertNever
  rebellionAdapter.ts  GameAdapter impl: dispatch(action) -> phases.*/combat.*
  redact.ts            redactStateForViewer(state, viewer) — per-seat hiding
  codec.ts             makeRebellionCodec(catalog) — encode/decode GameState

src/engine/
  choiceOwner.ts       pendingChoiceOwner(G, side) — whose decision is pending
                       (used by currentActor; also the source PlayTab should de-dup to, task #108)

functions/            Cloudflare Pages Functions (the server)
  _lib/gameServer.ts   makeServer(), AI/abandonment/email helpers
  api/games/index.ts             POST create, GET list
  api/games/[id]/index.ts        GET per-seat view (+ reclaim/abandonment signal)
  api/games/[id]/submit.ts       POST an action -> apply + AI + notify
  api/games/[id]/legal.ts        GET legal actions for the caller's seat
  api/games/[id]/takeover.ts     POST: hand an abandoned seat to the AI / reclaim
  api/games/[id]/claim.ts        POST: claim victory over an abandoned opponent
  api/games/[id]/report.ts       POST a bug report scoped to the game

src/online/           online-only UI
  gameClient.ts        thin fetch wrapper over the /api/games routes
  Lobby.tsx            create/join, list your games, opt into online
  OnlinePlay.tsx       mounts the real PlayTab board against the server view
  onlineEngine.ts      shim: spreads the real engine module, overrides mutators
                       to submit() to the server instead of mutating locally
```

## Snapshot format

The framework wraps every stored snapshot as `v<schemaVersion>:` + codec
output (e.g. `v1:{...}`). **Always strip/add the prefix at the boundary** —
the helpers `decodeSnapshot`/`encodeSnapshot` in `gameServer.ts` do this.
Calling `codec.decode` on a raw snapshot string throws
`Unexpected token 'v'` (this bit us once on the vs-AI path).

The codec uses `encodeFull(G)` (keeps pendingChoice / pendingCombat /
pendingMission) — these are **branch-only** additions to the engine
(`encodeFull`, `setup.buildCatalog` export, `types.aiSides`). On master they
don't exist; they arrive when this branch merges.

## Per-seat redaction

`adapter.viewFor(state, seat)` → `redactStateForViewer`. The Rebel never
sees the Empire's hand / probe knowledge and vice-versa; the hidden base
location is masked from the Empire. Hidden fields become the sentinel
`'__hidden__'`. Verified by `scripts/verify-redaction.mts` (28 assertions —
asserts no leak across Empire / Rebel / spectator, and that inputs are not
mutated). Run it after any redaction or codec change.

> Not yet done: per-*entry* public-log redaction (task #109) — the online
> event banner is suppressed until each log entry is individually redacted,
> because a raw entry can leak hidden info.

## vs-AI and the abandonment flow

The server can drive a seat with the existing heuristic AI
(`randomAI.stepOnce`, engine-only so it's Workers-safe).

- **vs-AI game**: one seat carries `aiSides: ['Empire'|'Rebel']`. After every
  human submit, `advanceAIAndStore` loops `runServerAI` while it's the AI's
  turn, persisting each step.
- **Abandonment**: turn timing is tracked in Supabase table
  `swr_turn_notify` (`game_id`, `actor`, `started_at`, `emailed`). If the
  current actor has been sitting on their turn longer than the grace period
  (`ABANDON_GRACE_MS` env, default **3 days**), `isSideAbandoned` returns
  true and the present player is offered, on the opponent's behalf:
  - **Let the AI take over** → `setSeatAI` flags the seat AI and immediately
    plays its turn (`/takeover`).
  - **Claim victory** → `claimVictory` ends the game in the present player's
    favour (`/claim`).
  - **Keep waiting** → no-op.
- **Reclaim**: if the absent human comes back, `reclaimSeat` removes their
  side from `aiSides` and they resume control. Done automatically on fetch.

Local verification without deploy/sleep: `reports/verify-abandon.mts`
(in-memory store) exercises takeover / reclaim / claim / grace gate.

## Email (Resend, poll-driven — "Option A")

We do **not** email on every turn flip (that spams during active play).
Instead `syncTurnNotify` (called from submit via `ctx.waitUntil`) records
when the current actor's turn started; a later poll that finds the same
actor still up after `TURN_EMAIL_DELAY_MS` (**15 min**) sends one email and
sets `emailed`. A new actor restarts the clock. So you only get pinged once
your opponent has genuinely stepped away.

Identity is Supabase magic-link auth; the turn email is an
`it's-your-move` nudge with a link back to the game.

### Scheduled reminder cron (covers vs-AI / both-clients-closed)

The poll-driven path can't fire when **no client is open** — most importantly
in **vs-AI** games (the AI has no browser to poll). The fix is a sweep that
runs server-side on a schedule.

**Split design (no duplicated secrets):**
- The sweep itself is a **Pages Function**, `/api/cron/sweep-reminders`, which
  builds the server via `makeCronServer(env, origin)` — same wiring as the API
  but with the **real** Resend notifier — and calls
  `server.sweepTurnReminders({ olderThanMs: 24h })`. Because it's a Pages
  Function it already has the project's `SUPABASE_*` / `RESEND_*` secrets.
- `workers/reminder-cron/` is a **tiny standalone Worker** (Pages Functions
  can't run cron) that just **pings** that endpoint hourly. It holds **no
  credentials** — only a `SWEEP_URL` var.

The framework keeps a per-game inactivity clock in `dbf_games.reminder`
(jsonb) and sends at most one nudge per turn.

- Deploy the cron Worker: `npx wrangler deploy --config workers/reminder-cron/wrangler.toml`
- Auth (trust-tier): the endpoint is **open** by default — a sweep is
  idempotent and only sends already-due reminders. Set `CRON_SECRET` on the
  Pages project (and the matching `CRON_KEY` var on the Worker) to lock it
  down via an `x-cron-key` header.
- The 15-min `syncTurnNotify` path is intentionally kept for prompt nudges in
  active human-vs-human play; the two use independent dedupe state.

## Secrets & deploy model

Secrets are set by the **user** in the Cloudflare dashboard — Claude never
handles the Resend API key value. **Cloudflare Production and Preview env
scopes are separate (no inheritance).** Required, per scope:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (service-role; server-only)
- `RESEND_API_KEY`, `RESEND_FROM` (for turn email)
- optional `ABANDON_GRACE_MS` (override the 3-day default; e.g. for testing)

Supabase tables are fixed-named and idempotently created by the framework
(`dbf_games`, `dbf_snapshots`, `dbf_reports`); the turn-timing table
`swr_turn_notify` is ours (`supabase/swr_turn_notify.sql`, already applied).

**0.7.0 migration (one-time, existing DB):** the reminder cron needs a new
column on the framework table —
`alter table dbf_games add column if not exists reminder jsonb;`
(Fresh DBs get it from the framework's shipped `schema.sql`.) Run this in the
Supabase SQL editor before the cron's first sweep, or the snapshot upsert will
fail on the missing column.

Server code imports the framework server barrel `./server` (Workers-safe).
The Node-only `FsStore` lives in `./server/node` — never import it from a
Function.

## Pre-merge checklist (run before merging this branch to master)

```bash
npm run typecheck                          # baseline: 9 cosmetic src/play errors, 0 new
npx tsx scripts/verify-redaction.mts       # no cross-seat leaks
npx tsx scripts/verify-online-local.mts    # create / auth / redact / submit E2E
npx tsx reports/verify-abandon.mts         # takeover / reclaim / claim / grace
```

Plus a live two-human PvP playtest on the preview deployment, and confirm
RESEND_* + Supabase secrets exist in **both** Cloudflare scopes.
