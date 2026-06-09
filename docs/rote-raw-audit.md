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
- [~] **#8 "Immediate" objectives activate at Refresh, not on draw**
  (Raid Outposts, Rebel Cell). **DEFERRED.** RAW p.8 reveals/resolves on draw,
  but `drawObjective` is a shared low-level mechanic used across the base game
  (Heist, the Refresh draw step, setup, several effects). On-draw activation
  would post placement choices — including an *opponent* choice for Raid
  Outposts — from arbitrary draw contexts, risking pendingChoice conflicts that
  could break base-game objective draws, all for a ~1-refresh timing nuance the
  current Refresh-activation already handles functionally (markers placed,
  scoring correct). Not worth the risk; left as a known timing deviation.
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
- [ ] **#11 Construct Super Star Destroyer: 1 copy; RAW adds a 2nd.**
  DEFERRED — the engine keys missions by unique id; a 2nd copy means a
  duplicate id in the project deck, which risks mission-resolution/codec logic.
  Needs a small duplicate-card mechanism (e.g. a count) before it's safe.
- [ ] **#12 Auto-setup places the DSUC in an Imperial-loyalty system, not a
  remote; doesn't remove the remote's probe card.**
- [ ] **#13 Leader-pool 8-cap auto-eliminates tail-first** (RAW: player chooses
  which 8 to keep). Known/documented.
- [ ] **#14 Confrontation auto-selects the marked leader; "eliminate this card"
  is a discard** (matters once deck-recycle #4 exists).
- [ ] **#15 Auto-heuristics stand in for player choices** (deal-damage split,
  reroll picks — blanks only vs RAW free choice, special-heal target,
  shield-absorb amount).

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
