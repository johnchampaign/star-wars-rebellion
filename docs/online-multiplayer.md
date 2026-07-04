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

## Generic choice framework — one adapter action covers all of them

Master added a unified player-choice framework (`src/engine/choices.ts`): a
single data-driven `Choice` pendingChoice kind (see `GenericChoice` in
`types.ts`) resolved by ONE engine entry point, `phases.resolveGenericChoice(G,
selection: string[])`, dispatched internally by a `tag -> resolver` registry.
New/migrated prompts (The Long War discard, etc.) use it instead of a bespoke
kind+resolver+modal+AI+adapter quintuple.

**Branch wiring (do this once when merging master in):** the entire framework
needs exactly ONE new online action, and never another for any future generic
choice:

- `rebellionAction.ts`: add `| { kind: 'resolveChoice'; selection: string[] }`
  to the `RebellionAction` union.
- `rebellionAdapter.ts`: add `case 'resolveChoice': return
  phases.resolveGenericChoice(G, a.selection);`
- `onlineEngine.ts`: add `resolveGenericChoice: (_g, selection) => act({ kind:
  'resolveChoice', selection })`.

The choice payload is plain serializable data (candidate ids, min/max, a JSON
`context`), so it round-trips through the codec with no special handling, and
`choiceOwner.ts` already routes ownership via the universal `case 'Choice':
return pc.side === side`. Nothing else is per-choice.

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

## Per-seat mission set (RoE p.2)

In a Rise of the Empire game each side chooses its own mission set (base vs RoE)
independently — the two may differ. Online, the two humans aren't both present
at creation, so instead of a simultaneous facedown reveal **each human seat
picks its own set the first time that player enters**:

- **Creation** (`newInitialState`): both human seats start with
  `expansion.missionSetLocked` **unset** for their side. An AI seat is locked
  immediately with a **random** set (there's no human to choose for it), mirroring
  single-player. Base game (`enabled:false`) has no locks.
- **The chooser** (`OnlinePlay` → `MissionSetChooser`): if the seat isn't locked,
  the expansion is on, and the game is still in the **Setup phase**, the board is
  gated behind a one-time base-vs-RoE pick. It POSTs `/api/games/:id/mission-set`.
- **Server** (`setSeatMissionSet` → `rebuildMissionDeck`): re-derives **only that
  side's** `missionHand`+`missionDeck` for the chosen set and sets
  `missionSetLocked[side]`. Refused unless expansion-on + Setup phase + human seat
  + not already locked (idempotent). Optimistic-concurrency via `mutateStored`.

The Setup-phase gate is the safety window: mission cards aren't used until
Assignment, and the game can't leave Setup until both humans engage. Verified by
`scripts/verify-online-mission-set.mts` + `scripts/test-online-per-seat-mission-set.mjs`.

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

## Turn-reminder email (Resend — single source: the scheduled sweep)

There is exactly **one** path that sends turn-reminder email: the scheduled
sweep. A player gets **at most one** "it's your move" nudge per turn, ~15-20
min after their opponent's move, whether or not any client is open (this is
what makes **vs-AI** and both-clients-closed games work — they have no browser
polling). We do **not** email on every turn flip (that spams active play).

**Split design (no duplicated secrets):**
- The sweep is a **Pages Function**, `/api/cron/sweep-reminders`, which builds
  the server via `makeCronServer(env, origin)` — same wiring as the API but
  with the **real** Resend notifier — and calls
  `server.sweepTurnReminders({ olderThanMs: 15 min })`. Because it's a Pages
  Function it already has the project's `SUPABASE_*` / `RESEND_*` secrets.
- `workers/reminder-cron/` is a **tiny standalone Worker** (Pages Functions
  can't run cron) that just **pings** that endpoint **every 5 min**. It holds
  **no credentials** — only a `SWEEP_URL` var.

The framework keeps a per-game inactivity clock in `dbf_games.reminder` (jsonb).
The clock starts when a sweep first observes a turn, so the email lands one
sweep interval (≤5 min) of lag plus the 15-min threshold after the move. A new
turn resets the clock; `sent` dedupes to one email per turn.

The request path (`recordTurnTiming`, called from fetch/submit via
`ctx.waitUntil`) **no longer emails** — it only records who's on the clock and
since when, in `swr_turn_notify`, which still drives **abandonment** detection
(`isSideAbandoned` / `turnStartedAt`).

- Deploy the cron Worker: `npx wrangler deploy --config workers/reminder-cron/wrangler.toml`
- Auth (trust-tier): the endpoint is **open** by default — a sweep is
  idempotent and only sends already-due reminders. Set `CRON_SECRET` on the
  Pages project (and the matching `CRON_KEY` var on the Worker) to lock it
  down via an `x-cron-key` header.

Identity is Supabase magic-link auth; the turn email is an `it's-your-move`
nudge with a link back to the game.

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
