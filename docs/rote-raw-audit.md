# Rise of the Empire — RAW-compliance audit & fixes

This branch (`rote-raw-fixes`) collects fixes for RAW-compliance issues found
auditing the RoE expansion against the rulebook (`StarWarsRebellion_v2.5.pdf`
pp.8-9). Developed in an **isolated git worktree** so it doesn't collide with
concurrent base-game work on `master`; merges to `master` after that lands.

**Do not deploy from this branch.** Commit/push/PR only; deploy from `master`
after merge.

## Findings (checklist)

### High — clear RAW violations affecting play
- [x] **#1 Imperial starting Stormtroopers: 13 → 6.** Fixed
  `IMPERIAL_STARTING_UNITS_RoE_NEW` (setup.ts). Verified RoE=6, base=12.
- [x] **#2 "Removing damage" can't save a lethally-damaged unit.** Fixed:
  `finalizeTheaterDestructions` now re-checks `damage >= health` at end of the
  theatre round before destroying a staged unit, so a Remove-Damage heal (or
  Energy Shield / Draw Their Fire / shield-absorb) that pulls it below lethal
  saves it. Equivalent in standard combat (no in-round heals).
- [x] **#3 Cinematic tactic-card damage destroys immediately.** Fixed:
  `resolveDeal` / `resolveTargetDeal` now STAGE a unit that reaches lethal
  (add to `c.theaterStaged`) instead of destroying it now; finalize handles it
  at end of round. `resolveDeal` also skips already-doomed units so damage
  spreads ("split among multiple units"). NOTE: the direct **DESTROY** effect
  (`resolveDestroy`, e.g. Support of the 501st) is intentionally left immediate
  — RAW's "destroyed by a tactic card → doesn't roll dice but still matches
  unit icons" nuance is separate and obscure; deferring it would let the unit
  roll dice. Test: `scripts/test-cinematic-damage-timing.mjs`.
- [x] **#4 Cinematic tactic deck never recycles.** Fixed: `recycleCinematicDeck`
  (run when options are built) — when a side's theatre deck is empty (all cards
  discarded), the discard returns to the deck, keeping only the last-resolved
  card in the discard (RAW p.8). Idempotent.
- [x] **#5 "Must play a card each round" not enforced.** Fixed: declining now
  plays (discards) one of the offered cards with no ability resolved
  (`noAbility` selection; auto-picks a card — the discard recycles anyway). A
  side always has a card to play (recycle guarantees it), so play is mandatory.
  UI relabelled ("Resolve no ability (discard a card)").
- [x] **#6 Raid Outposts removal ignores opponent-ground requirement.** Fixed
  `scoreRaidOutposts` to also require no Imperial ground units. Test added.

### Medium
- [x] **#7 Cinematic retreat order.** Fixed: the retreat step now uses
  `[attacker, defender]` in cinematic combat (rulebook p.9 "Retreat: Starting
  with the current player…") and keeps `[defender, attacker]` in base combat.
  Test `scripts/test-cinematic-retreat-order.mjs`.
- [x] **#8 "Immediate" objectives activate on draw** (Raid Outposts, Rebel
  Cell). DONE — RAW p.8 reveals/resolves on draw. New
  `flushImmediateObjectiveActivations(G, resumeKind)` scans the Rebel's hand for
  an un-activated Immediate objective and posts its placement choice (Imperial
  for Raid Outposts, Rebel for Rebel Cell), tagged with how to resume. Hooked at
  the **top of `advanceCommandTurn`** (the universal Command-phase "action done"
  seam — catches Heist / Covert Operation / Rebel Planning, and the setup draw
  at turn 1's first action) and **right after the Refresh draw step** (split
  `continueRefreshAfterObjectives` → `…AfterObjectiveDraw` so the placement
  pauses between steps 4 and 5). The placement resolvers dispatch on `resumeKind`
  (`command` → re-enter `advanceCommandTurn`, which chains the next Immediate
  objective then advances; `refresh-draw` → the rest of Refresh). Placement was
  removed from the refresh pre-steps (scoring stays). Tests in
  `scripts/test-roe-objectives-iii.mjs`. NOTE: yes, this is the "more
  complicated interaction" — e.g. the Empire is prompted to place Raid Outposts
  markers mid-Rebel-turn — which is what RAW wants.
- [x] **#9 Dice-reduction vs the 5-die cap order.** Fixed: `beginAttack` now
  applies the dice-reduction abilities (cinematic Prevent, According To My
  Design) to the raw sums first, then caps at 5/5/3 — RAW p.9 "an ability that
  reduces the number of dice rolled applies BEFORE the limit of 5 is applied."
  Test `scripts/test-dice-reduction-order.mjs` (8 raw red − 2 prevent = 6 →
  capped 5, not the old min(5,8)−2 = 3).

### Low / verify
- [x] **#10 Destroyed system removes its target markers** (p.8). Implemented
  per the user's reading: when a SYSTEM is destroyed (Superlaser), all target
  markers in it are removed and each removal effect resolves (Raid Outposts
  scores the Rebel +1). Hooked in `mechanics.destroySystem`. (The printed
  "when a unit is destroyed" reads as system-destruction here; the literal
  any-unit reading was rejected as too aggressive.) Test
  `scripts/test-system-destroy-markers.mjs`.
- [x] **#11 Construct Super Star Destroyer copies — FALSE POSITIVE, no fix
  needed.** The audit miscounted: it counted *catalog* entries (1, since the
  catalog is keyed by unique id) instead of *deck* copies. The SSD mission
  carries `projectCopies: 2`, and the project-deck builder expands that
  (`flatMap(... Array.from({length: projectCopies}))`), so the Empire's project
  deck already contains **2** copies in both base and RoE games. RAW ("replace…
  **both copies** of Construct Super Star Destroyer") confirms the count is 2 in
  both (the expansion swaps the art, not the count). Verified 2 copies in-deck.
  Adding a duplicate catalog card would WRONGLY produce 3 copies — so the
  correct action was to change nothing.
- [x] **#12 Auto-setup DSUC placement** (partial). RoE auto-setup now places the
  DSUC + 4 TIE + 1 Stormtrooper in a chosen REMOTE system (p.8) instead of
  round-robining the DSUC across Imperial-loyalty systems. Interactive half was
  #163. NOT done: removing that remote's probe card from the probe deck
  (separate deck logic, low value) — documented sub-deviation.
- [x] **#14 Confrontation "eliminate this card."** Fixed the part that matters
  now recycle (#4) exists: when its effect fires, the card is removed from the
  recyclable discard so it can't return. Leader-selection stays auto (accepted
  — see #15).
- [x] **#13 Leader-pool 8-cap — player now chooses which to eliminate.** DONE
  (no longer a deviation). Over the cap, `enforceLeaderPoolCap` posts a
  `LeaderPoolEliminate` choice (one leader per choice, re-posted/chained until
  both sides are at 8), resolved like the Ambitions offer. The human picks via
  a modal (leaders listed weakest-first as a suggestion); the AI drops the
  LOWEST-value leader (combined tactic values + total skill icons). Test
  `scripts/test-leader-pool-cap.mjs`.
- **#15 Auto-heuristics → interactive player choices (in progress).** The user
  chose option **B**: make the three choices that fit existing pause points
  interactive (default pre-selected, player may override); leave the two that
  live inside `applyCinematicAbility` (deal-damage split, shield-absorb amount)
  as documented near-optimal auto-defaults.
  - [x] **Confrontation leader pick.** The Rebel now CHOOSES which Imperial
    leader to mark for elimination (was auto highest-value). The end-of-round
    hook (`resolveCinematicEndOfRound`) now PAUSES with a
    `ConfrontationLeaderPick` (candidates strongest-first as a suggestion);
    `resolveConfrontationLeaderPick` marks the pick + eliminates the card. AI
    marks the strongest. UI: `ConfrontationLeaderPanel` in CombatBoardLive.
    Test `scripts/test-confrontation-leader-pick.mjs`.
  - [ ] **Reroll** (pick which dice, default = blanks) — `beginAttack`.
  - [ ] **Remove-Damage heal target** (default = most-damaged) — `beginAttack`.
  - DEFERRED (auto near-optimal, documented): deal-damage target/split,
    shield-absorb amount (both inside `applyCinematicAbility`).

### From-game bugs (related)
- [x] **#163 RoE setup: can't place the Death Star Under Construction on a
  remote.** `setupDeployUnit` (and the deploy-picker UI) only allowed Empire
  units on Imperial-loyalty/subjugated systems. Per rulebook p.8 the DSUC goes
  in a chosen REMOTE system, and any system with a DSUC is then legal for
  Imperial units. Fixed engine legality + UI legal-targets (gated on
  `expansion.enabled`); test `scripts/test-rote-dsuc-setup.mjs`. (Also covers
  the interactive half of audit #12.) **Closes #163 on merge+deploy.**

## Plan
Quick, isolated wins first (#1, #6, #11), then the cinematic damage-timing
cluster (#2/#3) and deck rules (#4/#5), then the rest. Each fix: gate so the
base game stays byte-identical, run `npm run typecheck` (9 baseline cosmetic
`src/play` errors) + the relevant `scripts/test-*.mjs`, commit to this branch.
