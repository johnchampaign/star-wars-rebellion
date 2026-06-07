# Rise of the Empire expansion — implementation plan

Opt-in expansion, kept fully separate from the base game. A game records
`G.includeExpansion`; when off, every `set: 'rote'`-tagged catalog entry is
filtered out at `createGame` so base play is byte-identical. Future fixes can
target base-only / rote-only / both via the `set` tag.

## Source material (all on disk)

- **Rules:** `StarWarsRebellion_v2.5.pdf` p.8 (left column) — the entire
  "Rise of the Empire Expansion" rules on one page. p.8 (right) + p.9 are the
  optional **Cinematic Combat** module + its player aids.
- **Unit stats (base + expansion):** `images/ReferenceEmpire2P.png` &
  `ReferenceRebel2P.png` (the 2-player battle-mat references). Includes supply
  counts, attack/health, build icons, and unit-ability text.
- **RotE-vs-base card differences:** `MissionReference_RotE_Final.pdf`.
- **Art:** `vmod_extracted/images/` (the "with Rise of Empire" VASSAL module).

## What the expansion changes (NOT purely additive)

New mechanics that need engine work, not just data:
- **Green dice** — a third die colour; no 3-die cap on green (still 5 red / 5
  black max). Used in missions and combat.
- **Leader pool limit** — max 8 leaders in pool; excess eliminated.
- **Target markers** — objective/mission cards that resolve via a marker placed
  on the board (needs a Rebel ground unit in the system).
- **Unit abilities:** Interdictor (Rebel units can't retreat from its system),
  Shield Bunker (Death Star protection + easy/local deployment), structures
  (immobile ground units survive a fought battle round), Assault Tank, etc.
- **Setup choices** — players independently pick **base vs RoE starting units**
  and **base vs RoE mission set**. So "include expansion" is really several
  finer toggles; v1 may collapse them into one and refine later.
- **Bigger board** — adds systems (Nal Hutta, Mandalore, …).
- **Cinematic Combat** — a large OPTIONAL alternate combat module (advanced
  tactic cards, per-round draw/assign flow). Treat as its own opt-in, likely
  deferred past first RotE release.

## Phases

1. **Architecture (DONE):** `set` tag on all content types; `includeExpansion`
   in SetupOptions → GameState; `inSet` filter at every `createGame` selection
   point; catalog stays a full superset. Verified: typecheck baseline, 8-game
   conservation unchanged with flag off.
2. **UI toggle:** "Include Rise of the Empire" in hotseat new-game + online
   Lobby, threaded through `createGame` / `/api/games`.
3. **Units:** transcribe RoE unit stats/supply from the battle mats into
   `units.ts` tagged `set: 'rote'`; wire build-icon legality + alternate
   starting-unit lists.
4. **Systems/board:** add RoE systems + adjacency, tagged rote; verify the map
   renders and base map is unchanged when off.
5. **Cards:** leaders (with minor skills), then mission / objective / action /
   probe / tactic decks, each `set: 'rote'`, with handlers per card.
6. **New rules modules:** green dice, leader-pool cap, target markers, the unit
   abilities — each gated and tested.
7. **(Optional) Cinematic Combat** — separate opt-in if wanted.

Each phase ships as a working slice; base game is never at risk.
