# Rise of the Empire expansion — implementation plan

Opt-in expansion, kept fully separate from the base game. A game records its
expansion config; when fully off, every `set: 'rote'`-tagged catalog entry is
filtered out at `createGame` so base play is byte-identical. Future fixes can
target base-only / rote-only / both via the `set` tag.

## Confirmed scope (user decisions)

- **Granular toggles** (not one master switch). The expansion config is:
  ```
  expansion: {
    enabled: boolean          // include RoE leaders/cards + new rules
    roeUnits?: boolean        // ADD RoE units to the buildable roster
    newStarterUnits?: boolean // starter deployment: New (on) vs Old (off) RoE list
    roeMissions?: boolean     // SWAP base mission set → RoE mission set
    cinematicCombat?: boolean // use the Cinematic Combat module
  }
  ```
  **UX + semantics (Option A — RAW-faithful):**
  - Default is the **base game, untouched** (`enabled: false`). A single "Rise
    of the Empire" switch turns it on; turning it on *reveals* the sub-toggles.
  - `enabled` is NOT just a UI gate — it carries the expansion's **non-optional**
    pieces: the new **leaders** (minor-skill mechanic) and the **core new rules**
    (green dice, 8-leader pool cap, target markers, unit abilities). These aren't
    individually optional in the physical game, so they aren't separate toggles.
  - The sub-toggles cover only what the rulebook actually lets you choose:
    `roeUnits` / `newStarterUnits`, `roeMissions`, `cinematicCombat`. (Earlier
    drafts included an `expandedBoard` toggle; removed once Phase 4 confirmed
    the FFG RoE box doesn't add system tiles — see Phase 4 notes below.)
  - Consequence: "RoE on + all sub-toggles off" is a *hybrid* (base board/units/
    missions but RoE leaders + new rules), NOT the base game. The base game is
    simply `enabled: false`. This is intended.
  Defaults when `enabled` turns on: RoE units, New starter units, and RoE
  missions ON; Cinematic Combat OFF. (Phase 1 shipped a single
  `includeExpansion` placeholder; Phase 2 promoted it to this config.)
- **Cinematic Combat IS in scope** — build the full alternate combat module.
- **Starting units:** an independent toggle (`newStarterUnits`); **default New**
  (the `Rise of the Empire - New Starter Units` VASSAL setup), Old available.
- **Board:** an independent toggle (`expandedBoard`); **default the full
  expanded board** — every RoE system (Nal Hutta, Mandalore, …), base available.

### Additive vs swap (important)

- **Additive package** (present whenever `enabled`): RoE **leaders, systems,
  action / objective / probe cards**, and the new rules (green dice, leader cap,
  target markers, unit abilities).
- **Units are ADDITIVE, not a swap** (revised from earlier draft). The
  rulebook's setup section gives the Imperial player both base units
  (Star Destroyer, AT-AT, TIE Fighter, …) and RoE units (TIE Striker, Assault
  Tank, Interdictor, Shield Bunker) — the new units add to the pool, they
  don't replace the originals. Confirmed against the 2P reference mat
  (shows base + RoE on the same panel) and the user's reading. So `roeUnits`
  toggles whether the RoE-tagged units are *included* in the buildable roster;
  base units stay buildable either way. Implementation: `legalUnitsForIcon`
  in `src/engine/phases.ts` takes G and appends the RoE units on each icon
  when `expansion.roeUnits` is true.
- **Mission swap** (`roeMissions`, exclusive base-OR-RoE per the rules p.8):
  - **Missions** — `roeMissions` replaces the base mission deck with the RoE
    deck (starting/project missions always included).
  - The mission swap is implemented in Phase 5 alongside the actual RoE
    mission deck data.
- **Starter-unit swap** (`newStarterUnits`, also exclusive): picks between
  the New RoE deployment (default) and the Old RoE / base deployment. This
  is distinct from the additive roster — the roster says "what's buildable"
  while the starter list says "what's pre-placed at setup."
- So the `inSet` gate is per-content-type: additive content (leaders, systems,
  RoE-tagged units, cards) keys off `enabled` (or `roeUnits` for units);
  mission selection and starter-list selection key off their own flags.

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
- ~~**Bigger board** — adds systems (Nal Hutta, Mandalore, …).~~ Phase 4
  confirmed this was wrong: the FFG RoE box adds no system tiles, and the
  systems originally listed here are already in the base 32-system map. The
  `expandedBoard` toggle has been removed.
- **Cinematic Combat** — a large OPTIONAL alternate combat module (advanced
  tactic cards, per-round draw/assign flow). Treat as its own opt-in, likely
  deferred past first RotE release.

## Phases

1. **Architecture (DONE):** `set` tag on all content types; `includeExpansion`
   in SetupOptions → GameState; `inSet` filter at every `createGame` selection
   point; catalog stays a full superset. Verified: typecheck baseline, 8-game
   conservation unchanged with flag off.
2. **Toggle model + UI:** promote `includeExpansion` → the `expansion` config
   object (enabled / roeUnits / roeMissions / cinematicCombat); expose the
   switches in hotseat new-game + online Lobby, threaded through `createGame` /
   `/api/games`.
3. **Units (DONE):** RoE unit stats transcribed from the 2P battle mats into
   `units.ts` tagged `set: 'rote'` (TIE Striker, Assault Tank, Shield Bunker,
   Interdictor / U-Wing, Nebulon-B Frigate, Rebel Vanguard, Golan Arms Turret).
   `UnitType.attack` gained a `green` slot; combat ignores it until Phase 6.
   `legalUnitsForIcon` adds RoE units to the buildable roster when
   `expansion.roeUnits` is on (additive, not swap — see above). The **New
   Starter Units** deployment list (rulebook p.8) lands as a second starter
   stack, selected by `(expansion.enabled && newStarterUnits)`; the Old RoE
   starter list is still a TODO and currently falls back to the base list.
   Unit-ability behaviour (Shield Bunker Death Star protection / easy
   deployment / local reinforcement, Interdictor retreat block, structures-
   survive-combat) is captured in comments and deferred to Phase 6.
4. **Systems/board (NO-OP — phase retired):** investigation found the FFG
   RoE expansion adds no system tiles. The base 32-system map in
   `assets/systems.json` is already the full named-planet set; the
   "expanded board" the plan referred to was a vestigial idea. The
   `expandedBoard` config flag and its UI checkboxes were removed in this
   phase. Systems data is unchanged.
5. **Cards** — split into sub-phases:
   - **5a — RoE missions, data-only (DONE):** 31 RoE missions transcribed
     from `MissionReference_RotE_Final.pdf` (pp. 1-4) into
     `assets/missions.json` tagged `set: 'rote'`, with `effectKey: ''` —
     the cards appear in the deck so the swap mechanic is testable
     end-to-end but resolve as no-ops until 5b. The `roeMissions` swap
     lives in `src/engine/setup.ts`: starting + project missions are
     additive (base always in, RoE-tagged in when `expansion.enabled`);
     regular missions are an exclusive swap on `roeMissions`. Verified
     in-browser: with `roeMissions: true` the Heist / Secret Mission /
     Imperial Promotion / etc. land in the decks and base regulars drop
     out; with `roeMissions: false` it inverts. Skill assignments
     (diplomacy/intel/specOps/logistics) and skill costs are best-effort
     from rule flavour and need a confirmation pass against actual card
     art. Leader portraits for RoE-only leaders (Krennic, Motti, Jabba,
     Chirrut Imwe, Jyn Erso, Saw Gerrera, Cassian Andor) are stored as
     slugs even though the leaders don't exist yet — wired so the data
     is correct when Phase 5c lands those leaders. The mission-append
     script lives at `scripts/add-rote-missions.mjs` and is idempotent.
   - **5b — RoE mission handlers (TODO):** bind each RoE mission's
     `effectKey` to an `EffectHandler` in `src/engine/handlers/index.ts`.
     Big slice — base game has 53 handlers.
   - **5c — RoE leaders (DONE):** 8 RoE leaders appended to
     `assets/leaders.json` via `scripts/add-rote-leaders.mjs`
     (idempotent), tagged `set: 'rote'`. Source: the leader-card PNGs
     in `images/` (Jabba.png, Krennic.png, Motti.png, Finest.png,
     Cassian.png, Jyn.png, Chirrut2.png, Saw.png — turned out they
     were on disk all along, contrary to the earlier "blocked"
     status). Icons read at 18× zoom — blue eye / red fist / orange
     diamond / white-square-arrow → Intel / SpecOps / Diplomacy /
     Logistics; major = large circle, minor = small circle. Tactic
     values are **cross-verified** against the RoE action-card text
     in `assets/actions.json` — every Space/Ground value matches
     ("Ambitions of Power Motti 2 1", "Lord Vader's Orders Krennic
     2 2", "Secret Facility Kren.'s Finest 1 3", etc.). Major/minor
     skill counts are best-effort transcriptions; confirm against
     physical cards if any feel off — the data slot is correct even
     if a count is later nudged. RoE leaders are non-starting per
     RAW; they enter play via the recruit missions/action cards that
     Phase 5b/5d-handlers will wire. Patched again after the user
     supplied `Leader_Pool_RotE.pdf` (the canonical RoE leader chart)
     and noted that Jyn Erso has "six skill icons" — a second pass at
     24× zoom corrected Jyn (minor Intel 1 → 2; total 6 icons),
     Cassian Andor (added minor Logistics; total 5 icons), and
     Director Krennic (both small middle icons are blue eyes, not a
     white-square / eye mix). Other leaders unchanged. See
     `scripts/fix-rote-leaders.mjs`.
   - **5d — RoE action cards + objectives, data-only (DONE):** 14 RoE
     action cards (7 Imperial, 7 Rebel) and 12 RoE objectives (4 Level I,
     4 Level II inc. Death Star Plans handling, 4 Level III inc. DSP)
     appended to `assets/actions.json` and `assets/objectives.json` via
     `scripts/add-rote-actions-objectives.mjs` (idempotent), tagged
     `set: 'rote'` with `effectKey: ''`. Source:
     `MissionReference_RotE_Final.pdf` pp. 5-7. Both decks are ADDITIVE
     under `expansion.enabled` (no swap flag) — matches the rulebook
     since action and objective decks have no "OR" wording. C-3PO and
     R2-D2 are skipped as duplicates of base "Human Cyborg Relations"
     and "Resourceful Astromech". RoE leader-only action cards
     (Krennic / Motti / Jabba / Jyn Erso / Chirrut / Andor / Gerrera)
     are wired with the correct slugs so they fire as soon as Phase 5c
     lands those leaders. **Known follow-up (RAW correctness):** with
     RoE objectives present each stage pool grows beyond 5 cards. RAW
     wants "5 random per stage" with Death Star Plans locked into
     Levels II and III. The setup code documents this with a TODO; for
     now expansion games run with the full enlarged pool (9/8/8).
   - **5d-probes — RoE probe cards (TODO):** the FFG RoE expansion adds
     no new probe cards (the probe deck is per-system and the system
     set is unchanged from base). Confirmed against the rulebook:
     nothing to do.
   - **5d-handlers (TODO):** bind `effectKey` for RoE action cards and
     objectives. Same pattern as 5b for missions.
   - **5e — Advanced tactic cards (TODO):** full text on p.8; really
     part of Phase 7 (Cinematic Combat) since they only do anything
     when that module is on.
6. **New rules modules** — incremental:
   - **Leader-pool 8-cap (DONE):** `enforceLeaderPoolCap` in
     `src/engine/mechanics.ts`. Called at the end of every Refresh phase
     (after retrievals + recruits land); excess leaders are eliminated
     tail-first with a `leader-pool-cap-eliminate` log entry per drop.
     RAW lets the player pick which to keep — that's a future UI prompt
     (pendingChoice); for now the deterministic tail-elimination at
     least surfaces the rule. No-op when `expansion.enabled` is false.
   - **Per-stage objective pick + Death Star Plans lock (DONE):** RAW
     wants 5 random per stage, with Death Star Plans locked into II and
     III. Base game (5 cards per stage) was a no-op; with RoE the pools
     grow to 9/8/8 and we now sample 5/5/5 with DSP forced in. See
     setup.ts; verified in-browser (RoE game: deckSize 14 + 1 in hand,
     both DSP cards present; base game: deckSize 14 + 1 in hand,
     no RoE leakage).
   - **Green dice in combat (DONE):** `beginAttack` in
     `src/engine/combat.ts` now sums `attack.green` from each rolling
     unit, caps at 3 (RoE rules p.8: "A player cannot roll more than
     3 green dice"), and rolls. The has-attacker gate also checks
     green so RoE units with green-only attack (e.g. TIE Striker) are
     recognized as having attack capability. `rollDie` and
     `GREEN_FACES` already supported green from a prior pass; the
     `Die` component renders any colour via CSS+glyph (no PNG
     dependency), so green dice show correctly without new art. Mission
     green dice (from leader **minor** skills) are TODO — they're a
     Phase 5c leader-data dependency.
   - **Target markers (TODO):** mission/objective cards that resolve via
     a marker on the board; needed for Heist, Secure the Plans, Raid
     Outposts, Rebel Cell, Show No Fear handlers.
   - **Unit abilities (PARTIAL):**
     - **Interdictor retreat block (DONE):** `legalRetreatDestinations`
       in `combat.ts` returns `[]` for the Rebel side whenever any
       Imperial Interdictor is in the combat system. One-directional
       per RAW. The "as soon as all Interdictors destroyed" caveat
       falls out of reading live unit lists — already-destroyed
       Interdictors aren't in `ss.units` anymore.
     - **Structures-survive-combat (DONE):** `applyStructureRule` now
       checks `c.report.rounds[c.round-1].attacks` for any die rolled
       by the side in the ground theater this round. If yes, structures
       survive and combat continues; a `combat-structure-survive` log
       entry surfaces it. Base behaviour preserved when
       `expansion.enabled` is false.
     - **Shield Bunker Death Star protection (DONE):**
       `isLegalTarget` in the damage-assignment path excludes Death
       Stars and DSUC from eligible targets while any Imperial Shield
       Bunker is in the system. The Death Star Plans path is also
       guarded: a successful DSP direct-hit logs
       `death-star-plans-blocked-by-shield-bunker` and skips the
       destroy, effectively returning the card to hand. Protection
       lapses automatically when all Shield Bunkers in the system die.
     - **Shield Bunker easy-deployment + local-reinforcement (DONE):**
       `legalDeployTargets` in `src/engine/phases.ts` now takes an
       optional `typeId` and, when `expansion.enabled` and the side is
       Empire, widens the candidate set with two distinct overrides:
       (1) when deploying a Shield Bunker, any non-destroyed system
       (remote or populous) with an Imperial ground unit and no Rebels
       is legal — loyalty doesn't matter; (2) any remote system that
       already contains an Imperial Shield Bunker (and no Rebels) is
       legal for ANY Imperial unit. Refresh-deploy path threads
       `next.typeId` through to the function. The "can't use during
       the build step while the Shield Bunker is being deployed"
       carve-out is a build-action concern, separate from refresh
       deploy.
7. **Cinematic Combat** — the alternate combat module (advanced tactic cards,
   per-round draw/assign flow), gated on `cinematicCombat`. In scope.

Each phase ships as a working slice; base game is never at risk.

## Post-RotE: "Easy-To-Forget Rules" audit (deferred)

`Star_Wars_Rebellion.pdf` (repo root) is a player-authored cheat sheet of
easy-to-forget rules (setup, cleanup/refresh order, and misc). A full
engine-vs-cheat-sheet audit was started but **deferred until RotE is
finalized** — many of its items are exactly the RoE new-rules module
(green dice, 8-leader pool cap, target markers, Shield Bunker / Golan turret
abilities, minor skills), which would just read "pending" today. Re-run the
audit once Phase 6 lands so each rule gets a real verdict instead.

**One base-game discrepancy already flagged (resolve against RAW first):**
- **Mission hand limit (10).** The cheat sheet says the limit *includes*
  Imperial projects; the engine currently *excludes* projects (phases.ts
  ~line 3299, citing "RR p.12: only non-project mission cards count toward the
  10-card limit"). Settle which reading is correct against the Rules Reference
  before adjusting anything.
