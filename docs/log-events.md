# turnLog event registry (log-format v2)

> AUTO-GENERATED TABLE — regenerate with `node scripts/gen-log-registry.mjs`.
> Descriptions are hand-editable: regeneration preserves them. The tripwire
> `node scripts/test-log-registry.mjs` fails when a source kind is missing
> here, so a new event can't ship undocumented.

## The envelope

Every turnLog entry (see `log()` in `src/engine/log.ts`):

```ts
{
  seq: number,      // monotonic append index — ordering + cross-reference key
  turn: number,     // G.timeMarker at write time
  phase: string,    // Setup | Assignment | Command | Refresh | GameOver
  side?: 'Rebel' | 'Empire',   // the acting side, when the event has one
  kind: string,     // one of the kinds below
  payload?: object, // kind-specific data (sampled below)
}
```

Entries written before 2026-07-10 lack `seq`/`phase` (and snapshots lack the
`at` label) — readers default missing labels to `turn-start`.

## The containers

- **v2** (current uploads): `{ schemaVersion: 2, gameId, meta, timeline,
  keyframes, final }` — built by `src/play/logFormat.ts` at upload time.
  `meta` carries seed, expansion, human/AI sides, AI policy + planner flag,
  build SHA, and outcome. `timeline[t]` = board snapshot at the start of turn
  t + that turn's events. `keyframes` = base-reveal / base-assault boards.
  `final` = end board, turnLog-stripped.
- **v1** (the 558 logs before 2026-07-10): `{ schemaVersion: 1, hash, game }`
  with the full history nested inside `game.codec` (a JSON string).

**Always read logs through `scripts/lib/log-reader.mjs`** — it normalizes both
formats to `{ meta, humanSide, winner, events, snapshots, final }`.

## Adding a new event kind

1. Emit it via `log()`/`logForSide()` with a **self-contained** payload —
   any unit reference carries `unit` (instance id) **and** `typeId`; any
   system reference uses the system id.
2. Run `node scripts/gen-log-registry.mjs`, then edit your kind's Description.
3. `node scripts/test-log-registry.mjs` must pass.

## Kinds (260)

| Kind | Description | Sample payload | Emitted from |
|---|---|---|---|
| `a-time-for-peace-destroy` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `action-card-noop` | — | `{"cardId":"proceeding-as-planned","reason":"no-projects-in-deck"}` | src/engine/phases.ts |
| `action-card-play` | — | `{"cardId":"resourceful-astromech","leaderId":"general-rieekan","systemId":null,"timing":"attach-ring"}` | src/engine/phases.ts |
| `action-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `activate-system` | Leader activates a system; orders = source systems, unitsMoved = total units. | `{"leaderId":"general-tagge","targetSystemId":"ord-mantell","orders":1}` | src/engine/phases.ts |
| `advance-time` | Time marker advanced (start of a new turn; followed by the turn-start snapshot). | `{"newValue":2}` | src/engine/mechanics.ts |
| `aggressive-negotiations-fail-destroy` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `ai-decision` | AI Command decision trace: chosen action + score, top-5 alternatives, engine-rejected count, planner state when enabled. | `{"policy":"mcts","chose":{"kind":"activate","leaderId":"general-tagge","target":"naboo","score":36,"mc":0.81},` | src/play/mctsAI.ts, src/play/randomAI.ts |
| `ambitions-of-power-applied` | — | `{"newCap":9}` | src/engine/phases.ts |
| `ambitions-of-power-skipped` | — | `{}` | src/engine/phases.ts |
| `arm-card` | — | `{"cardId":"secret-facility","probeSystemId":"tatooine","probeId":"probe-tatooine"}` | src/engine/phases.ts |
| `arm-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `armed-reveal-declined` | — | `{"cardId":"secret-facility","systemId":"endor"}` | src/engine/phases.ts |
| `assign-leader` | — | `{"missionId":"rapid-mobilization","leaderIds":["mon-mothma"]}` | src/engine/phases.ts |
| `auto-rescue` | — | `{"leaderId":"jan-dodonna","systemId":"dantooine","reason":"no-imperial-units"}` | src/engine/mechanics.ts |
| `behind-enemy-lines` | — | `{"systemId":"utapau","moved":5}` | src/engine/phases.ts |
| `blindside-applied` | — | `{"missionId":"hunt-them-down"}` | src/engine/phases.ts |
| `blindside-skipped` | — | `{"missionId":"collect-bounty"}` | src/engine/phases.ts |
| `boba-block` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `break-their-will-probe` | — | `{"systemId":"endor","region":4,"baseInRegion":false}` | src/engine/phases.ts |
| `brilliant-administrator-built` | — | `{"systemId":"corellia","added":2,"picks":["tie-fighter","star-destroyer"]}` | src/engine/phases.ts |
| `build-from-icons` | — | `{"systemId":"cato-neimoidia","label":"Establish Trade Relations","added":2,"picks":["x-wing","airspeeder"]}` | src/engine/phases.ts |
| `build-queue` | Unit added to the build queue. | `{"typeId":"rebel-trooper","slot":1,"sourceSystemId":"alderaan"}` | src/engine/mechanics.ts |
| `build-queue-advance` | — | `{"typeId":"death-star","fromSlot":3,"toSlot":2,"via":"double-our-efforts"}` | src/engine/phases.ts |
| `build-queue-destroy` | — | `{"slot":1,"typeId":"tie-fighter","via":"demolition"}` | src/engine/phases.ts |
| `build-wasted-no-supply` | — | `{"sourceSystemId":"sullust","slot":2,"iconType":"ground","iconShape":"square","legalUnitTypes":["at-at"]}` | src/engine/phases.ts |
| `c3po-applied` | — | `{"missionId":"build-alliance","targetSystemId":"bespin","explanation":"C-3PO ring discarded — diplomacy failur` | src/engine/phases.ts |
| `c3po-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `capture-leader` | Leader captured (ring: captured/carbonite). | `{"leaderId":"general-rieekan","ring":"captured","systemId":"mustafar"}` | src/engine/mechanics.ts |
| `capture-operative-pick` | — | `{"leaderId":"han-solo"}` | src/engine/phases.ts |
| `captured-leader-moved` | Empire | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `carbonite-applied` | — | `{"leaderId":"general-rieekan","systemId":"mustafar"}` | src/engine/phases.ts |
| `catch-them-by-surprise-move` | — | `{"fromSystemId":"hoth","toSystemId":"endor","moved":5,"movedIds":["s100028","s100029","s100026","u1000064","s1` | src/engine/phases.ts |
| `choice-cancel` | — | `{"kind":"AssignSecondLeaderPick"}` | src/engine/phases.ts |
| `choice-request` | — | `{"kind":"OpposeMission","missionId":"base-defenses","attackerDice":2,"existing":[],"poolSize":1}` | src/engine/cinematicTactics.ts, src/engine/combat.ts, src/engine/mechanics.ts, src/engine/objectives.ts, src/engine/phases.ts |
| `cinematic-confrontation-choose` | — | `{"systemId":"naboo","candidates":["grand-moff-tarkin"]}` | src/engine/cinematicTactics.ts |
| `cinematic-confrontation-eliminate` | — | `{"leaderId":"grand-moff-tarkin"}` | src/engine/phases.ts |
| `cinematic-confrontation-mark` | — | `{"leaderId":"grand-moff-tarkin","systemId":"naboo"}` | src/engine/combat.ts |
| `cinematic-confrontation-no-leader` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-deck-recycle` | — | `{"theater":"ground","kept":"cin-empire-ground-armored-patrol","recycled":7}` | src/engine/cinematicTactics.ts |
| `cinematic-escape-plan` | — | `{"theater":"ground","round":2}` | src/engine/combat.ts |
| `cinematic-escape-plan-cancel` | — | `{"cancelKey":"Empire:ground:2"}` | src/engine/combat.ts |
| `cinematic-prevent-applied` | — | `{"theater":"ground","round":1,"red":0,"black":1,"special":0}` | src/engine/combat.ts |
| `cinematic-remove-damage` | — | `{"theater":"ground","round":1,"removed":2}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-reroll` | — | `{"theater":"ground","round":1,"rerolled":1,"allowance":1}` | src/engine/combat.ts |
| `cinematic-rogue-one-no-retreat` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-no-target` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-remove-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-rogue-one-rescue` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-shield-absorb` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-cancelled` | — | `{"theater":"ground","round":2,"card":"cin-rebel-ground-tow-cables"}` | src/engine/combat.ts |
| `cinematic-tactic-locked` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-no-ability` | — | `{"theater":"ground","round":3,"card":"cin-empire-ground-air-superiority"}` | src/engine/combat.ts |
| `cinematic-tactic-play` | — | `{"theater":"ground","destroyed":"s100912"}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-tactic-skip` | — | `{"theater":"ground","round":7}` | src/engine/combat.ts |
| `cinematic-tractor-beam-capture` | — | `{"leaderId":"jan-dodonna","systemId":"dathomir"}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `combat-action-card` | — | `{"card":"good-intel"}` | src/engine/combat.ts |
| `combat-action-card-applied` | — | `{"card":"according-to-my-design","targetSide":"Rebel","theater":"space","round":1,"reducedRed":1,"reducedBlack` | src/engine/combat.ts |
| `combat-action-card-effect` | — | `{"card":"good-intel","applied":"empire-chooses-tactic-after-rebel-reveals"}` | src/engine/combat.ts |
| `combat-action-card-not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-add-leader` | — | `{"leaderId":"general-tagge","tacticValue":3}` | src/engine/combat.ts |
| `combat-add-leader-declined` | — | `{}` | src/engine/combat.ts |
| `combat-attack` | One attack roll (theater, dice faces, attacker count). | `{"theater":"space","dice":[{"color":"red","face":"special"},{"color":"black","face":"hit"}],"attackers":1}` | src/engine/combat.ts |
| `combat-begin` | Combat starts. A base assault also writes the base-assault snapshot. | `{"systemId":"bespin","attackerSide":"Rebel"}` | src/engine/combat.ts |
| `combat-blocks-removed` | RR p.5 step 4: after the attacker assigns every hit, the defender's blocks remove that many of the assigned damages (greedily, where they save a unit). | `{"theater":"space","blocks":1,"removed":1,"perUnit":{"u1000033":1}}` | src/engine/combat.ts |
| `combat-draw-tactics` | — | `{"attackerHand":2,"defenderHand":3}` | src/engine/combat.ts |
| `combat-dsuc-destroyed` | — | `{"systemId":"dagobah","round":2,"reason":"only remaining Imperial ship was the Death Star Under Construction"}` | src/engine/combat.ts |
| `combat-end` | Combat over (rounds fought, winner). | `{"systemId":"bespin","rounds":1,"winner":"Empire"}` | src/engine/combat.ts |
| `combat-retreat` | Retreat executed (from/to, units, leader). | `{"from":"alderaan","to":"corellia","units":2,"droppedByCapacity":0,"ignoresTransport":false}` | src/engine/combat.ts |
| `combat-retreat-decline` | — | `{"systemId":"alderaan"}` | src/engine/combat.ts |
| `combat-safety-abort` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-special-draw` | — | `{"card":"space-concentrate-fire"}` | src/engine/combat.ts |
| `combat-stalemate-end` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-structure-destroy` | — | `{"systemId":"corellia"}` | src/engine/combat.ts |
| `combat-structure-survive` | — | `{"systemId":"bothawui","round":2}` | src/engine/combat.ts |
| `combat-tactic` | — | `{"card":"space-critical-hit","bonusDamage":1}` | src/engine/combat.ts |
| `combat-tactic-effect` | — | `{"effect":"unstoppable-assault-prevents-block"}` | src/engine/combat.ts |
| `contingency-plan-applied` | — | `{"leaderId":"mon-mothma","missionId":"build-alliance"}` | src/engine/phases.ts |
| `covert-operation-pick` | — | `{"drawn":["the-long-war-1","cut-supply-lines-1"],"kept":"the-long-war-1","bottomed":"cut-supply-lines-1"}` | src/engine/phases.ts |
| `death-star-completed` | — | `{"systemId":"tatooine","replacedUnit":"u1002771"}` | src/engine/phases.ts |
| `death-star-plans-blocked-by-shield-bunker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-blocked-by-target-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-declined` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-miss` | — | `{"objectiveId":"death-star-plans-3","systemId":"utapau","faces":["blank","hit","hit"]}` | src/engine/combat.ts |
| `death-star-plans-success` | — | `{"objectiveId":"death-star-plans-2","systemId":"malastare","destroyed":"u1000009","faces":["blank","direct-hit` | src/engine/combat.ts |
| `deploy` | One built unit deployed to a system (id + typeId). | `{"typeId":"ion-cannon","systemId":"rebel-base-space","unit":"u1000001"}` | src/engine/mechanics.ts |
| `deploy-declined-to-queue` | — | `{"typeId":"at-st"}` | src/engine/phases.ts |
| `deploy-returned-to-queue` | — | `{"typeId":"rebel-trooper","reason":"all-systems-at-deploy-cap"}` | src/engine/phases.ts |
| `destroy-system` | — | `{"systemId":"kashyyyk"}` | src/engine/mechanics.ts |
| `destroy-unit` | One unit destroyed (id + typeId + where + cause). | `{"unit":"s100013","typeId":"tie-fighter","systemId":"bespin","cause":"combat"}` | src/engine/mechanics.ts |
| `destroy-up-to-health` | — | `{"card":"Hit And Run","killed":1,"totalHealth":2}` | src/engine/phases.ts |
| `destroyed-system-cull` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `destroyed-system-overflow` | — | `{"systemId":"mustafar","typeId":"stormtrooper","unit":"s100006"}` | src/engine/mechanics.ts |
| `detained-applied` | — | `{"leaderId":"mon-mothma"}` | src/engine/phases.ts |
| `detained-refresh-skip` | — | `{"leaderIds":["mon-mothma"]}` | src/engine/phases.ts |
| `discredit-rebellion-remove` | — | `{"systemIds":["cato-neimoidia","corellia"],"removed":2}` | src/engine/phases.ts |
| `discredit-rebellion-roll` | — | `{"faces":["special","hit"],"special":true,"diceCount":2}` | src/engine/phases.ts |
| `draw-action` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `draw-mission` | — | `{"count":2,"missionIds":["public-uprising","wookie-uprising"]}` | src/engine/mechanics.ts |
| `draw-objective` | — | `{"count":1,"objectiveIds":["regional-support-1"]}` | src/engine/mechanics.ts |
| `draw-probe` | — | `{"count":4,"probeIds":["probe-rodia","probe-ilum","probe-cato-neimoidia","probe-mon-calamari"]}` | src/engine/mechanics.ts |
| `draw-them-out` | — | `{"leaderId":"jyn-erso","systemId":"bespin","auto":true}` | src/engine/phases.ts |
| `dsuc-destroyed-cancels-build` | — | `{"slot":3}` | src/engine/mechanics.ts |
| `dsuc-replaced-by-death-star` | — | `{"systemId":"dagobah","removed":"s101044"}` | src/engine/mechanics.ts |
| `eliminate-leader` | — | `{"leaderId":"mon-mothma"}` | src/engine/mechanics.ts |
| `establish-trade-relations` | — | `{"systemId":"cato-neimoidia","loyalty":1}` | src/engine/phases.ts |
| `falcon-applied` | — | `{"missionId":"build-alliance","targetSystemId":"mon-calamari","leaderId":"lando-calrissian","explanation":"Mil` | src/engine/phases.ts |
| `falcon-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `false-orders` | — | `{"targetLeaderId":"grand-moff-tarkin","missionId":"research-and-development"}` | src/engine/phases.ts |
| `gain-loyalty` | Loyalty gained at a system. | `{"systemId":"mon-calamari","newLoyalty":"imperial"}` | src/engine/mechanics.ts |
| `gain-reputation` | Rebel reputation advanced. | `{"newValue":13}` | src/engine/mechanics.ts |
| `game-over` | Terminal event: winner + reason. | `{"winner":"Empire","reason":"base-captured"}` | src/engine/mechanics.ts |
| `heist-draw-objective` | — | `{"systemId":"dathomir"}` | src/engine/phases.ts |
| `hidden-fleet-move` | — | `{"targetSystemId":"dantooine","moved":9,"movedIds":["s100042","s100043","s100046","u1000049","s100049","s10005` | src/engine/phases.ts |
| `homing-beacon-place` | — | `{"leaderId":"mon-mothma","systemId":"felucia","regionRevealed":1}` | src/engine/phases.ts |
| `immediate-objective-discarded` | — | `{"objectiveId":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `imperial-might-deploy` | — | `{"systemId":"dagobah","unitTypes":["tie-fighter","star-destroyer","tie-striker","at-st"],"auto":true}` | src/engine/phases.ts |
| `imperial-might-move-leaders` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `independent-operation-evac` | — | `{"fromSystemId":"kashyyyk","toSystemId":"corellia","moved":6}` | src/engine/phases.ts |
| `instance-id-heal` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `interrogation-droid-named-systems` | — | `{"named":["alderaan","bespin","kessel"],"note":"One of these contains the Rebel base."}` | src/engine/phases.ts |
| `invariant-violation` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `it-is-your-destiny-applied` | — | `{"capturedLeader":"jan-dodonna","explanation":"Vader captures a rescuer."}` | src/engine/phases.ts |
| `it-is-your-destiny-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lando-contingency-bonus-consumed` | — | `{"missionId":"build-alliance"}` | src/engine/phases.ts |
| `lead-strike-team-move` | — | `{"targetSystemId":"alderaan","unitsSent":1}` | src/engine/phases.ts |
| `leader-flipped` | — | `{"leaderId":"jan-dodonna","newSide":"Empire"}` | src/engine/mechanics.ts |
| `leader-pool-cap-eliminate` | — | `{"leaderId":"janus-greejatus","chosen":true}` | src/engine/phases.ts |
| `leader-retreat` | — | `{"leaderId":"cassian-andor","from":"cato-neimoidia","to":"malastare"}` | src/engine/mechanics.ts |
| `liberated` | Subjugation removed. | `{"systemId":"alderaan"}` | src/engine/mechanics.ts |
| `local-rumors-reveal` | — | `{"systemId":"ord-mantell","region":5,"baseInRegion":false}` | src/engine/phases.ts |
| `lord-vader-s-orders-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lose-loyalty` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lose-reputation` | — | `{"newValue":15}` | src/engine/mechanics.ts |
| `loyalty-already` | — | `{"systemId":"kashyyyk","loyalty":"imperial"}` | src/engine/mechanics.ts |
| `loyalty-blocked` | — | `{"systemId":"coruscant","reason":"coruscant-locked"}` | src/engine/mechanics.ts |
| `lure-dark-side-pick` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `misdirection-set` | — | `{"leaderId":"general-madine"}` | src/engine/phases.ts |
| `mission-deck-reshuffled` | Rebel/Empire | Empty mission deck refilled from the discard pile (rr p.6). Resets the public-discard view (#636). Payload: count. | src/engine/mechanics.ts |
| `mission-discard` | — | `{"missionId":"base-defenses"}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-hand-trim` | — | `{"missionId":"message-from-high-command"}` | src/engine/phases.ts |
| `mission-return-to-hand` | — | `{"missionId":"build-alliance"}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-roll` | Contested mission dice resolution. | `{"missionId":"build-alliance","skill":"diplomacy","attacker":{"dice":1,"successes":0,"portrait":0,"landoBonus"` | src/engine/phases.ts |
| `mission-unopposed` | Mission auto-succeeded unopposed. | `{"missionId":"base-defenses","result":"auto-success"}` | src/engine/phases.ts |
| `move-unit` | One unit moved (self-contained: id + typeId + from/to). | `{"unit":"s100003","from":"coruscant","to":"ord-mantell"}` | src/engine/mechanics.ts |
| `noble-sacrifice-applied` | — | `{"explanation":"Noble Sacrifice — Obi-Wan eliminated for +1 reputation."}` | src/engine/phases.ts |
| `noble-sacrifice-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/log.ts |
| `note` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `notice` | — | `{"id":"rapid-mobilization-queued-t2-1","title":"Rapid Mobilization — queued"}` | src/engine/log.ts |
| `objective-check-not-met` | — | `{"objectives":[{"id":"regional-support-1","name":"Regional Support","rulesText":""}],"note":"StartOfRefresh ob` | src/engine/phases.ts |
| `objective-declined` | — | `{"legal":["the-long-war-1"]}` | src/engine/phases.ts |
| `objective-immediate-no-target` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `objective-peek` | — | `{"looked":["regional-support-1","defend-the-people-1"],"kept":"regional-support-1","keptRep":1,"bottomed":"def` | src/engine/phases.ts |
| `objective-played` | — | `{"objectiveId":"liberation-2","reputation":1,"timing":"Combat"}` | src/engine/combat.ts |
| `one-in-a-million-applied` | — | `{"context":"combat","theater":"space","picks":[{"index":0,"face":"direct-hit"},{"index":1,"face":"direct-hit"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-skipped` | — | `{"context":"combat"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-used` | — | `{"context":"dsplans","picks":[{"index":1,"face":"direct-hit"}],"faces":["blank","direct-hit","hit"]}` | src/engine/combat.ts |
| `our-most-desperate-hour-applied` | — | `{"missionId":"establish-trade-relations","leaderId":"princess-leia"}` | src/engine/phases.ts |
| `oversee-project-pick` | — | `{"typeId":"death-star","slot":1,"targetSystemId":"cato-neimoidia"}` | src/engine/phases.ts |
| `pass` | Command turn passed. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `phase` | Phase transition marker. | `{"phase":"Assignment","via":"setup-complete"}` | src/engine/phases.ts |
| `pick-rebel-base` | Rebel base location chosen at setup. | `{"systemId":"alderaan"}` | src/engine/phases.ts |
| `place-leader` | — | `{"leaderId":"princess-leia","systemId":"nal-hutta"}` | src/engine/mechanics.ts |
| `plan-the-assault-move` | — | `{"targetSystemId":"dagobah","shipsSent":5}` | src/engine/phases.ts |
| `planetary-conquest-source` | — | `{"sourceSystemId":"ord-mantell","targetSystemId":"alderaan","units":3}` | src/engine/phases.ts |
| `plant-false-lead` | — | `{"moved":4,"placed":"bottom"}` | src/engine/phases.ts |
| `play-objective` | — | `{"objectiveId":"regional-support-1","reputation":1}` | src/engine/phases.ts |
| `post-bounty-applied` | — | `{"leaderId":"princess-leia","missionId":"build-alliance"}` | src/engine/phases.ts |
| `post-bounty-rep-loss` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `post-bounty-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `prepare-for-battle-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `probe-removed-for-system` | — | `{"systemId":"dagobah","probeId":"probe-dagobah"}` | src/engine/mechanics.ts |
| `probe-state-repaired` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `proceeding-as-planned-applied` | — | `{"missionId":"construct-death-star","leaderId":"moff-jerjerrod"}` | src/engine/phases.ts |
| `project-draw` | — | `{"count":1,"drawn":["construct-super-star-destroyer"]}` | src/engine/phases.ts |
| `project-peek` | — | `{"drawn":["oversee-project","superlaser-online"],"kept":"superlaser-online","bottomed":"oversee-project"}` | src/engine/phases.ts |
| `public-support-gain` | — | `{"systemId":"saleucami","stormtroopers":3}` | src/engine/phases.ts |
| `public-uprising-pick` | — | `{"systemId":"bespin","circle":"corellian-corvette","triangles":["rebel-trooper","rebel-trooper"]}` | src/engine/phases.ts |
| `r2d2-flip` | — | `{"context":"mission","systemId":"mon-calamari","dieIndex":0,"flippedFrom":"special","empireSide":"opposer","ex` | src/engine/combat.ts, src/engine/phases.ts |
| `r2d2-skipped` | — | `{"context":"mission","systemId":"mustafar"}` | src/engine/combat.ts, src/engine/phases.ts |
| `raid-outposts-score` | — | `{"systemId":"dagobah","reputation":1}` | src/engine/mechanics.ts |
| `rapid-mobilization-base-declined` | — | `{}` | src/engine/phases.ts |
| `rapid-mobilization-base-established` | Base relocated via Rapid Mobilization. | `{"fromSystemId":"felucia","toSystemId":"nal-hutta","baseRevealed":false,"wasRevealed":false}` | src/engine/phases.ts |
| `rapid-mobilization-base-no-legal-candidate` | — | `{"twoLeaders":false,"drawnCount":0}` | src/engine/phases.ts |
| `rapid-mobilization-move-applied` | — | `{"sourceSystemId":null,"movedCount":0,"movedIds":[]}` | src/engine/phases.ts |
| `rapid-mobilization-old-base-probe-to-empire` | Old base probe card given to the Empire after relocation (LTP p.12). | `{"probeId":"probe-felucia","systemId":"felucia"}` | src/engine/phases.ts |
| `rapid-mobilization-probe-draw` | — | `{"count":4,"twoLeaders":false,"drawnProbeIds":["probe-cato-neimoidia","probe-nal-hutta","probe-corellia","prob` | src/engine/phases.ts |
| `rapid-mobilization-probes-to-bottom` | — | `{"count":3}` | src/engine/phases.ts |
| `rebel-cell-discard` | — | `{"discarded":"defend-the-people-1"}` | src/engine/phases.ts |
| `reconnaissance-recover` | — | `{"missionId":"regional-aid","auto":true}` | src/engine/phases.ts |
| `recruit-action-only` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `recruit-draw-another` | — | `{"drawn":"baze-s-loyalty"}` | src/engine/phases.ts |
| `recruit-leader` | Leader recruited. | `{"leaderId":"admiral-ackbar","cardId":"point-blank-assault"}` | src/engine/phases.ts |
| `recruit-pick-resolved` | — | `{"kept":"point-blank-assault","bottomed":"its-a-trap"}` | src/engine/phases.ts |
| `refresh-retrieve` | — | `{"leaderIds":["mon-mothma","princess-leia","jan-dodonna","luke-skywalker"]}` | src/engine/phases.ts |
| `regional-aid-second` | — | `{"systemId":"rodia","targetSystemId":"geonosis"}` | src/engine/phases.ts |
| `remove-loyalty` | — | `{"systemId":"bespin"}` | src/engine/mechanics.ts |
| `rescue-leader` | — | `{"leaderId":"general-rieekan","dest":"rebel-base-space","reason":"for-the-greater-good"}` | src/engine/mechanics.ts |
| `rescuer-return` | — | `{"systemId":"cato-neimoidia","returned":["jan-dodonna"],"stayed":[]}` | src/engine/phases.ts |
| `retrieve-plans-applied` | — | `{"bottomed":"the-long-war-1","revealedHand":["decisive-victory-1","threaten-the-core-1","the-long-war-1","deat` | src/engine/phases.ts |
| `return-leader` | — | `{"leaderId":"chirrut-imwe"}` | src/engine/mechanics.ts |
| `return-of-the-jedi-eliminate` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `reveal-armed-card` | — | `{"cardId":"secret-facility","systemId":"tatooine","armedAt":5}` | src/engine/phases.ts |
| `reveal-armed-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-armed-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-base` | Rebel base revealed (followed by the base-reveal snapshot). | `{"reason":"auto","systemId":"alderaan"}` | src/engine/mechanics.ts |
| `reveal-mission` | Mission revealed at a target system. | `{"missionId":"base-defenses","targetSystemId":"nal-hutta","isAttempt":true}` | src/engine/phases.ts |
| `ring-attach` | — | `{"leaderId":"general-rieekan","ring":"r2d2"}` | src/engine/mechanics.ts |
| `ring-remove` | — | `{"leaderId":"princess-leia","ring":"r2d2"}` | src/engine/mechanics.ts |
| `sabotage-destroy-bunker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-place-marker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-removed` | — | `{"systemId":"mustafar"}` | src/engine/combat.ts, src/engine/phases.ts |
| `safe-haven-deploy` | — | `{"systemId":"rodia","unitTypes":["mon-cala-cruiser","mon-cala-cruiser"]}` | src/engine/phases.ts |
| `scouting-mission-relocate` | — | `{"targetSystemId":"coruscant","moved":4,"movedIds":["s100034","s100032","s100014","s100015"]}` | src/engine/phases.ts |
| `secret-facility-unit` | — | `{"systemId":"tatooine","typeId":"assault-tank"}` | src/engine/phases.ts |
| `secret-mission` | — | `{"kept":["establish-trade-relations"],"andor":false}` | src/engine/phases.ts |
| `setup` | Game seed + starting loyalty draw. The seed here is meta.seed in v2. | `{"seed":742226484,"rebelLoyalty":["alderaan","ord-mantell","nal-hutta"],"imperialLoyalty":["corellia","saleuca` | src/engine/setup.ts |
| `setup-auto-fill` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `setup-deploy` | One manually-placed setup unit (unit id included). Auto-filled units are NOT evented — read the setup-complete snapshot. | `{"typeId":"death-star","systemId":"saleucami","unit":"s100896"}` | src/engine/phases.ts |
| `setup-undeploy` | — | `{"typeId":"death-star","systemId":"mygeeto"}` | src/engine/phases.ts |
| `setup-warning` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `show-no-fear-revealed` | — | `{"systemId":"mon-calamari"}` | src/engine/phases.ts |
| `show-no-fear-score` | — | `{"reputation":1}` | src/engine/phases.ts |
| `skip-assignment` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `something-to-fight-for-applied` | — | `{"objectiveId":"leave-no-one-behind-2"}` | src/engine/combat.ts |
| `something-to-fight-for-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `son-of-skywalker-applied` | — | `{"pulledMissionId":"seek-yoda"}` | src/engine/phases.ts |
| `son-of-skywalker-skipped` | — | `{}` | src/engine/phases.ts |
| `start-evacuation-applied` | — | `{"targetSystemId":"mon-calamari","moved":3,"movedIds":["s100043","s100044","s100038"]}` | src/engine/phases.ts |
| `starting-card-draw` | — | `{"cardId":"more-dangerous-than-you-realize","via":"early-promotion"}` | src/engine/phases.ts |
| `state` | Full board snapshot (codec string, turnLog-stripped). `at` says why: setup-complete / turn-start / base-reveal / base-assault. | `{"codec":"(full board snapshot, JSON codec string)","at":"setup-complete"}` | src/engine/combat.ts, src/engine/mechanics.ts, src/engine/phases.ts |
| `stolen-intel-discard` | — | `{"missionId":"safe-haven"}` | src/engine/phases.ts |
| `stolen-plans-reorder` | — | `{"order":["death-star-plans-2","heart-of-the-empire-2","liberation-2","popular-support-2"]}` | src/engine/phases.ts |
| `subjugated` | System subjugated (Empire). | `{"systemId":"ord-mantell"}` | src/engine/mechanics.ts |
| `subjugation-cleared` | — | `{"systemId":"sullust","reason":"imperial-loyalty"}` | src/engine/mechanics.ts |
| `subversion-trigger` | — | `{"missionId":"subversion-original-rebel","leaderIds":["luke-skywalker"],"targetSystemId":"mon-calamari"}` | src/engine/phases.ts |
| `superlaser-loyalty` | — | `{"systemId":"mandalore","destroyedSystemId":"kashyyyk"}` | src/engine/phases.ts |
| `support-mon-cala-pick` | — | `{"option":"cruiser"}` | src/engine/phases.ts |
| `sweep-the-area-relocate` | — | `{"leaderId":"luke-skywalker-jedi","from":"dagobah","to":"sullust"}` | src/engine/phases.ts |
| `target-marker-place` | — | `{"systemId":"ryloth","source":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `target-marker-remove` | — | `{"systemId":"ryloth","source":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `temporary-alliance-built` | — | `{"systemId":"ord-mantell","added":2,"picks":["corellian-corvette","golan-arms-turret"]}` | src/engine/phases.ts |
| `the-long-war-discard` | — | `{"discarded":["death-star-plans-2","decisive-victory-1"]}` | src/engine/phases.ts |
| `track-them-applied` | — | `{"leaderId":"darth-vader","systemId":"saleucami"}` | src/engine/combat.ts |
| `track-them-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `unassign-leader` | — | `{"missionId":"interrogation-droid","leaderIds":["krennic"],"fromDeck":false}` | src/engine/phases.ts |
| `under-the-radar-keep` | — | `{"probeId":"probe-utapau"}` | src/engine/phases.ts |
| `under-the-radar-keep-holding` | — | `{"probeId":"probe-utapau"}` | src/engine/phases.ts |
| `under-the-radar-noop` | — | `{"reason":"empty-probe-deck"}` | src/engine/phases.ts |
| `under-the-radar-reorder` | — | `{"top":0,"bottom":3}` | src/engine/phases.ts |
| `under-the-radar-return` | — | `{"probeId":"probe-tatooine"}` | src/engine/phases.ts |
| `undercover-applied` | — | `{"leaderId":"lando-calrissian","targetSystemId":"mon-calamari"}` | src/engine/phases.ts |
| `undercover-skipped` | — | `{}` | src/engine/phases.ts |
| `were-the-bait` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `wookie-guardian-applied` | — | `{"missionId":"collect-bounty","explanation":"Chewbacca auto-stops the Empire special-ops mission."}` | src/engine/phases.ts |
| `wookie-guardian-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `yoda-reroll` | — | `{"holder":"luke-skywalker-jedi","systemId":"dagobah","color":"green","oldFace":"blank","newFace":"blank"}` | src/engine/combat.ts, src/engine/phases.ts |
| `yoda-reroll-unavailable` | Yoda ring reroll not offered — already used this game round (#540 messaging). | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `yoda-skipped` | — | `{"context":"mission","systemId":"dagobah"}` | src/engine/combat.ts, src/engine/phases.ts |
