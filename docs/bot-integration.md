# Building a bot on the Rebellion online API

This document is for people writing an external client — a Discord bot, a
bridge, a companion app — against the hosted game at
`https://star-wars-rebellion.pages.dev`.

It describes the HTTP contract as it actually is today, including the parts
that are not finished. Where something is a stub, it says so; please don't
build on the stubs without talking to us first.

The project is MIT licensed and non-commercial (it is a fan implementation of
Fantasy Flight Games' *Star Wars: Rebellion*). Anything you build on it should
stay non-commercial too.

**Internal counterpart:** `docs/online-multiplayer.md` describes the same stack
from the maintainer's side (schema, Supabase tables, deploy model). This
document is the outside view and is the one to trust for request and response
shapes.

---

## The short version

The server owns the rules. Your bot never simulates the game; it asks for a
seat's view, renders it, and either submits a simple action or hands the player
a deep link into the web UI for anything complicated.

That means you inherit rules fixes and AI improvements automatically, and you
cannot accidentally leak hidden information, because the server redacts each
seat's view before it reaches you.

A minimal loop:

1. `POST /api/games` to create a game. You get back two seat URLs.
2. Send each seat URL **privately** to its player.
3. Poll `GET /api/games/:id?t=<token>` for a seat to see whose turn it is.
4. Render the returned `view`.
5. For a move, either `POST …/submit` (simple actions) or point the player at
   the seat URL to play in the web UI.

---

## Security: the seat token *is* the seat

Every game endpoint authenticates with `?t=<token>`, a per-seat capability.
There are no accounts and no passwords. Whoever holds a seat's token can see
that seat's hidden information and take its turns.

**Never post a seat URL into a shared channel.** Direct-message it. A seat link
pasted into a public Discord channel hands every reader that player's hand, and
lets any of them move for that player.

Two related rules:

- Keep each seat's `view` separate. If your bot fetches both seats' views (for
  example because one person is running a solo game), never render them into
  the same message. Merging them defeats the redaction.
- Treat the token as a secret in your logs and error reports.

---

## Endpoints

All responses are JSON. Errors come back as `{ "error": "<message>" }` with
status `400` for a bad request or a rejected move, and `500` for a server
misconfiguration. A rejected move is a normal, expected outcome — the server
validates turn ownership and legality on every submit, and your bot should
surface the message rather than retry.

### Create a game

```
POST /api/games
Content-Type: application/json

{
  "emails":    { "Rebel": "a@example.com", "Empire": "b@example.com" },  // optional
  "aiSide":    "Empire",                                                 // optional
  "expansion": { "enabled": true, "roeUnits": true, "roeMissions": true } // optional
}
```

All fields are optional; `POST` with `{}` creates a plain two-human base-game
match. Returns `201`:

```json
{
  "gameId": "…",
  "invites": {
    "Rebel":  "https://star-wars-rebellion.pages.dev/?g=…&t=…",
    "Empire": "https://star-wars-rebellion.pages.dev/?g=…&t=…"
  }
}
```

Each invite is already a complete per-seat URL. Share it as-is; do not re-wrap
or rebuild it. This is also the deep link you hand a player when you want them
to finish a move in the web UI.

- `emails` — if present, the server sends that seat its invite link by email.
  Omit it if your bot is doing the delivering. The AI seat is never emailed.
- `aiSide` — that seat is played by the server-side AI. Use this for solo games
  against the bot. If the AI moves first, it has already moved by the time you
  first fetch.
- `expansion` — omit for the base game.

`GET /api/games` is not implemented (listing a player's games needs an identity
layer that does not exist yet).

### Fetch a seat's view

```
GET /api/games/:id?t=<token>
```

Returns:

```json
{
  "view": { … redacted game state … },
  "you": "Rebel",
  "yourTurn": true,
  "turn": 3,
  "gameOver": false,
  "opponentAbandoned": false
}
```

`turn` starts at `0` for a freshly created game. `view.aiSides` lists the seats
the server AI is playing, for example `["Empire"]`, which is how you tell a
versus-AI game from a two-human one after the fact.

This endpoint is not purely a read. It also keeps the turn clock, and it will
nudge a stalled AI seat along, so polling it is how a versus-AI game makes
progress. Poll it rather than trying to be clever.

### Submit an action

```
POST /api/games/:id/submit?t=<token>
Content-Type: application/json

{ "action": { "kind": "pass" } }
```

Returns the same shape as the fetch above, refreshed. If the move handed the
turn to an AI seat, the AI has already played by the time you get the response.

The server checks that it is your seat's turn and that the action is legal. A
rejection is a `400` with a message.

### Chat

```
GET  /api/games/:id/chat?t=<token>          → ChatMessage[]
POST /api/games/:id/chat?t=<token>          { "message": "text" } → ChatMessage[]
```

Useful for mirroring Discord conversation into the game log and back.

### Legal actions — **stub, do not build on this yet**

```
GET /api/games/:id/legal?t=<token>
```

This currently returns `[]`, or `[{ "kind": "pass" }]` when it is your seat's
turn in the Command phase with no pending choice. It does **not** enumerate
real moves. Full enumeration is unimplemented.

Plan around this. It is the main reason the recommended architecture below
hands complex moves to the web UI.

### Abandonment and housekeeping

- `POST /api/games/:id/takeover?t=<token>` — give an absent opponent's seat to
  the AI so the game can finish. Only allowed once they are past the grace
  period (default three days). They can reclaim the seat by returning.
- `POST /api/games/:id/claim?t=<token>` — claim the win outright against an
  abandoned opponent, same conditions.
- `POST /api/games/:id/mission-set?t=<token>` with `{ "useRoe": boolean }` —
  each side picks its own mission set (Rise of the Empire p.2).
- `POST /api/games/:id/report?t=<token>` with `{ "message", "severity?",
  "category?", "clientBuild?", "userAgent?" }` — file a problem report against
  the game. Returns `{ "reportId" }`.

The `opponentAbandoned` flag on the fetch response tells you when takeover and
claim are available.

---

## The view, and what is hidden

`view` is the game state for that seat, with every secret stripped
server-side before it leaves us.

Secrets are not deleted, they are **replaced with the literal string
`"__hidden__"`**, and hidden piles keep their **length**. So the opponent's
four-card mission hand arrives as:

```json
["__hidden__", "__hidden__", "__hidden__", "__hidden__"]
```

That lets you render "4 cards" without knowing which, and it means your bot can
detect redaction by testing for the sentinel rather than for a missing key.

Removed for the viewing seat:

- The Rebel base system while it is unrevealed, and the setup base candidates.
- Every deck's contents and order, including the viewer's own.
- The opponent's hands: action, mission, objective and probe.
- The mission on the opponent's face-down assignments. The committed leaders
  are public; the chosen mission is not.
- The random number generator state, so a client cannot predict dice. The
  `rng` and `controllerSeeds` keys still exist but are zeroed (`{"state": 0}`).
- The turn log, filtered by an allowlist. Public events survive, along with the
  viewer's own entries.

Kept, because it is public: leader pools, leaders and units on the board, the
Rebel Base space contents, eliminated and captured leaders, attachment rings,
the build queue, all discard piles, reputation and time, loyalty, and the
systems the Empire has ruled out.

Redaction is per seat and is the security-critical part of the system. Please
do not reconstruct state by combining views.

---

## Actions

The action union has over 140 variants, one per engine entry point. The
authoritative list is `src/adapter/rebellionAction.ts` in the repository. Every
action is a flat object with a `kind` discriminator, for example:

```json
{ "kind": "pass" }
{ "kind": "skipAssignment" }
{ "kind": "assignLeader", "missionId": "…", "leaderIds": ["…"] }
{ "kind": "activateSystem", "leaderId": "…", "targetSystemId": "…", "moveOrders": [ … ] }
```

Your seat is never packed into the payload; the server derives it from the
token.

A practical split for a bot:

- **Safe to send directly:** the zero-argument and near-zero-argument ones such
  as `pass`, `skipAssignment`, `acknowledgeReport`, `acknowledgeNotices`. These
  are how you clear modal-style prompts that would otherwise block a turn.
- **Hand to the web UI:** activation with move orders, mission resolution,
  combat and its tactic-card windows. These have real payloads, they interact
  with pending choices, and building them correctly means reimplementing UI
  logic. Deep-link instead.

---

## Recommended architecture

This is the shape we would support best, and it matches what a chat bot
actually needs:

1. Your bot holds the seat tokens and does the notifying.
2. On a poll, it fetches each seat's view and renders an image or an embed.
3. When it is a player's turn, it direct-messages them with the board and the
   seat URL.
4. Simple prompts are cleared with a direct `submit`. Real moves happen in the
   web UI through the deep link.
5. After the player moves on the site, the next poll picks up the new state.

You get the rules, the AI, hidden-information handling and future fixes for
free, and you own presentation and notification, which is the part chat is
good at.

---

## Polling, limits and etiquette

There is no rate limiting on these endpoints today, which is a request for good
behaviour rather than a licence.

- Poll a game no more often than about once a minute while it is someone's
  turn, and back off hard for idle games. Turns here take hours or days.
- The fetch endpoint does real work. Do not poll it in a tight loop.
- Back off on `5xx` and stop on repeated `4xx`; a rejected action will not
  become legal by being retried.
- If you expect meaningful traffic, ask us for a dedicated API key first. We
  would rather identify your bot than guess at anomalous load, and it lets us
  contact you before a change bites you.

We run on free tiers. If a bot becomes popular enough to matter, tell us early
so we can plan rather than discover it.

---

## Stability

- The state format is schema-versioned as `rebellion-state-v1`. A breaking
  change bumps it.
- The endpoint shapes above are what we intend to keep. They have been
  internal-only until now, so treat this document as the first published
  version of the contract rather than a long-standing promise.
- The `legal` endpoint is explicitly excluded from that. It will change when it
  is implemented.
- The engine and rules will keep changing. That is the point: you get the
  fixes. Behaviour of a *legal move* may change when a rules bug is corrected.

Every request and response shape in this document was verified against the
live deployment, including the error cases and the redaction behaviour.

Questions, or you want an API key: open an issue on the repository.
