# Rise of the Empire — RAW-compliance audit & fixes

This branch (`rote-raw-fixes`) collects fixes for RAW-compliance issues found
auditing the RoE expansion against the rulebook (`StarWarsRebellion_v2.5.pdf`
pp.8-9). Developed in an **isolated git worktree** so it doesn't collide with
concurrent base-game work on `master`; merges to `master` after that lands.

**Do not deploy from this branch.** Commit/push/PR only; deploy from `master`
after merge.

## Findings (checklist)

### High — clear RAW violations affecting play
- [ ] **#1 Imperial starting Stormtroopers: 13 deployed, RAW = 6.**
  `setup.ts IMPERIAL_STARTING_UNITS_RoE_NEW` has `stormtrooper: 13`; rulebook
  p.8 gives 5 (main list) + 1 (remote DSUC system) = 6. All other unit counts
  match. (Base-game count of 12 looks reused.)
- [ ] **#2 "Removing damage" can't save a lethally-damaged unit.** RAW p.8:
  units aren't destroyed until end of the theatre round, so a heal can rescue
  them. `combat.ts` stages a unit for destruction the instant damage ≥ health
  (~1346-1348) and `finalizeTheaterDestructions` destroys the staged list
  without re-checking current damage — a unit healed below lethal is still
  destroyed. Fix: finalize should re-check `damage >= health` at finalize time.
- [ ] **#3 Cinematic tactic-card damage destroys immediately.**
  `cinematicTactics.ts` resolveDeal/resolveTargetDeal/resolveDestroy call
  `M.destroyUnit` on the spot. RAW defers lethal to end of theatre round (see
  #2). Should stage, not destroy.
- [ ] **#4 Cinematic tactic deck never recycles.** RAW p.8: when the deck
  empties, return the discard (except the just-played card) to the deck. We
  treat discards as gone for the game.
- [ ] **#5 "Must play a card each round" not enforced.** RAW p.8: each player
  must play (discard) 1 advanced tactic card each round; may decline its
  abilities. Our UI lets a side play nothing.
- [ ] **#6 Raid Outposts removal ignores opponent-ground requirement.**
  `phases.ts scoreRaidOutposts` removes a marker when the Rebel has a ground
  unit; RAW p.8 also requires the opponent to have NO ground units there.

### Medium
- [ ] **#7 Cinematic retreat order is defender-first; RAW cinematic is
  current-player(attacker)-first** (p.9). `combat.ts` retreat step iterates
  `[defender, attacker]` for all combat. Base game stays defender-first.
- [ ] **#8 "Immediate" objectives activate at Refresh, not on draw** (Raid
  Outposts, Rebel Cell). RAW p.8: reveal/resolve when drawn into hand.
- [ ] **#9 Dice-reduction vs the 5-die cap order.** RAW p.9: reductions apply
  BEFORE the 5-die cap. `beginAttack` caps first, then applies prevent /
  "According to My Design" reductions.

### Low / verify
- [ ] **#10 General "unit destroyed → remove the system's target markers" rule**
  (p.8) not implemented.
- [ ] **#11 Construct Super Star Destroyer: 1 copy; RAW adds a 2nd.**
- [ ] **#12 Auto-setup places the DSUC in an Imperial-loyalty system, not a
  remote; doesn't remove the remote's probe card.**
- [ ] **#13 Leader-pool 8-cap auto-eliminates tail-first** (RAW: player chooses
  which 8 to keep). Known/documented.
- [ ] **#14 Confrontation auto-selects the marked leader; "eliminate this card"
  is a discard** (matters once deck-recycle #4 exists).
- [ ] **#15 Auto-heuristics stand in for player choices** (deal-damage split,
  reroll picks — blanks only vs RAW free choice, special-heal target,
  shield-absorb amount).

## Plan
Quick, isolated wins first (#1, #6, #11), then the cinematic damage-timing
cluster (#2/#3) and deck rules (#4/#5), then the rest. Each fix: gate so the
base game stays byte-identical, run `npm run typecheck` (9 baseline cosmetic
`src/play` errors) + the relevant `scripts/test-*.mjs`, commit to this branch.
