# Star Wars: Rebellion — fan-made digital implementation (free, browser-based, solo vs. AI)

I've been building a digital implementation of the FFG **Star Wars: Rebellion** base game (2016 edition) as a fan project. It's now in a state where it's playable end-to-end against an AI opponent, and I'd love feedback from people who actually know the game.

**Play it in your browser (free):** https://star-wars-rebellion.pages.dev

## What's in there

- The full base-game map, all 26 systems with the right loyalty/build/resource icons.
- All 18 base-game unit types, with stats verified against the printed faction reference sheets.
- Solo vs. AI — you pick a side at the start (Rebel, Empire, or Random) and the engine drives the other.
- All Setup → Assignment → Command → Refresh phase flow, leader assignment, mission resolution, opposition rolls, captured leaders, retreat decisions, multi-round combat with tactic cards, Death Star Plans alt-victory.
- All 24 action cards wired with their effects (Assignment, Immediate, and Special timing).
- All four "rings" (Yoda, R2-D2, C-3PO, Millennium Falcon) firing as response triggers.
- A board-side click-die-then-click-unit damage-assignment UI in combat.
- A heuristic AI that follows the standard strategic priorities (Rebel: missions over moves, hide the base; Empire: probe-narrow, reserve a leader for opposition, capture cap at one).

It is **not** Rise of the Empire — base game only.

## Why are the objective cards' text blank?

The deployed version redacts the rules text on the 15 objective cards (the cards say "(text omitted in public build)" instead of their actual rules). The engine still resolves them correctly — only the displayed text is hidden. This is out of respect for FFG's IP: the unit stats and most of the structural rules can be reconstructed from the public Rules Reference, but the objective cards' specific text is the kind of authored content I'd rather not redistribute on a public site. If you own the game, you have the cards in hand anyway.

## Help me make it better

Two ways to contribute, both built into the app — no GitHub account needed:

1. **Report a problem.** There's a "Report a problem" button in the game UI. Describe whatever's broken, attach a screenshot, hit submit. The report gets filed straight to the GitHub issues for the project, along with a snapshot of the current game state — so I can see exactly what you were looking at when the bug fired. I read every one, and the last batch of reports closed in under a day. Please use it for anything: rules misinterpretations, UX papercuts, AI doing dumb things, anything that feels wrong.

2. **Upload your game logs.** There's an "Upload logs" button too. The logs are how I'm going to improve the AI — right now it's a heuristic that follows reasonable strategy but doesn't actually plan very deep, and self-play tournament tells me it's badly out of balance (the Rebel side currently wins ~100% of self-play games). Real human game logs are way more useful than self-play for finding where the AI is being silly. The dialog explains what's in the upload before you send it, and the data goes to a public training-data repo on GitHub — please only upload if you're comfortable with that.

## Caveats

- Single-player only right now (vs. AI). No remote multiplayer.
- The AI is, generously, a "smart-ish first-pass heuristic" — it won't outplay a thoughtful human. Improving it is the next big push and your logs are the fuel.
- Two-player hotseat (both sides human at the same screen) sort of works but the UI doesn't yet hide private information well enough to recommend it for serious play.
- This is a fan project, not commercial, not affiliated with FFG/Asmodee or Lucasfilm.

If you try it and have thoughts (good, bad, "this rule is wrong"), please file a report from inside the app — it's the fastest path to a fix.

May the Force be with you.
