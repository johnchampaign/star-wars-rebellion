# Star Wars: Rebellion — digital port

A faithful in-browser port of the 2016 FFG board game. Engine is a pure-function
TypeScript core; UI is React + Vite. Designed for solo play against a random AI
while the engine is fleshed out.

**Play it here:** https://star-wars-rebellion.pages.dev

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

## Visuals (local play only)

The deployed site at https://star-wars-rebellion.pages.dev ships **no
VASSAL-derived art** — no board, no card art, no leader portraits, no unit
silhouettes. It's a text-mode demo of the engine. Broken `<img>` tags are
hidden via a global error handler so the UI stays clean.

If you want full visuals while playing locally:

1. Get the VASSAL module for Star Wars: Rebellion separately (you'll need
   to own the game / acquire the module yourself — this repo does not
   distribute FFG assets).
2. Extract its contents into `vmod_extracted/` at the repo root.
3. Run `npm run copy-assets` to copy and process the images into
   `public/dev-assets/`.
4. Run `npm run dev`. The full UI now shows board art, cards, etc.

The asset-extraction scripts (`scripts/extract-*.py`, `scripts/copy-dev-assets.mjs`)
are committed; the actual images are gitignored and the deploy script strips
any images out of `dist/dev-assets/` before publishing.

## Deploying

The project deploys as a static Vite build + two Cloudflare Pages Functions
(`functions/api/report.ts`, `functions/api/upload-logs.ts`) that file
GitHub Issues and commit play-log JSON respectively. Step-by-step setup in
[`docs/deploy.md`](docs/deploy.md). Once configured:

- `git push` to `main` → CF auto-builds & deploys
- Players visit your Pages URL → no GitHub account needed
- Problem reports become real GitHub Issues with screenshots
- Game logs get committed to `logs/<hash>.json` in the repo (with an
  in-game warning that the logs are publicly visible)

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
