# Star Wars: Rebellion — digital port

A faithful in-browser port of the 2016 FFG board game. Engine is a pure-function
TypeScript core; UI is React + Vite. Designed for solo play against a random AI
while the engine is fleshed out.

## Status

Early playable. Setup, Assignment, Command, and Refresh phases run end-to-end.
Mission resolution (with opposition), combat (with tactic-card choice for the
human), build-phase choice, retreat/reputation tracking, and probe-card play
are wired up. See `docs/engine.md` for architecture and the task list (`/`
TaskList in Claude Code, or the GitHub Issues tab) for what's still pending.

## Quickstart

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Engine state is mirrored to
`./game-logs/latest.json` on every action while `vite dev` is running, which is
the agent-collaboration loop — see "Problem reports" below.

## Reference materials (not in this repo)

You will need to bring your own copies of:

- The FFG **Rules Reference** PDF (`sw03_rules_reference_web.pdf`)
- The **Learn to Play** book (`sw03_learn_to_play_web.pdf`)
- The VASSAL module (`Star Wars Rebellion_v1.02d.vmod`) if you want to
  regenerate the unit / board / card image assets

The pipeline scripts in `scripts/` expect these to live at the repo root.
They are deliberately gitignored — FFG owns the content and we don't
redistribute it.

To regenerate the dev image assets after dropping the .vmod in the root:

```bash
npm run copy-assets  # extracts board, units, cards from the .vmod
```

## Problem reports & log uploads

The Play tab has two header buttons:

- **Report a problem** — captures a page screenshot, the full turn log, and
  the current game state, then files a GitHub Issue (if `SWR_BUGREPORT_TOKEN`
  + `SWR_BUGREPORT_REPO` env vars are set). Falls back to a local `reports/`
  file and a pre-filled GitHub "new issue" URL otherwise.
- **Upload logs** — submits archived game records to the repo under `logs/`
  for AI development. Shows a consent dialog up front; hash-based dedup means
  re-clicking only commits new games.

To enable both, drop a `.env` in the project root:

```
SWR_BUGREPORT_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
SWR_BUGREPORT_REPO=johnchampaign/star-wars-rebellion
```

The token needs `contents:write` and `issues:write`. `.env` is gitignored.

## FFG IP policy

Per the policy followed by the VASSAL module this project builds on:
**objective card text is redacted in the source PNGs**. FFG has had an
informal policy of permitting fan-made tools that block out text on key
cards, so players who own the game can reference their physical cards.

This project provides two ways to bake text onto those redacted PNGs:

- `npm run composite-card-text` — bakes the verbatim rules text. **Local
  play only.** Output lives in `public/dev-assets/cards/`, which is
  gitignored — it never ships from this repo.
- `npm run composite-card-notice` — bakes a short notice on each
  objective explaining the redaction and asking the player to buy the
  game. **Use this for any public deploy** (GitHub Pages, etc.) where
  the dist folder includes the card images.

If you're cloning to play locally, run the first one. If you ever set
up a public host of the built site, switch to the second one before
running `npm run build`.

## License

Code is MIT (see `LICENSE` once added). All game content (rules, card text,
unit names, board art, etc.) belongs to Fantasy Flight Games. This project
is a non-commercial fan implementation; do not distribute the original game
assets via this repo.
