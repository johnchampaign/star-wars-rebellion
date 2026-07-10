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

## Kinds (257)

| Kind | Description | Sample payload | Emitted from |
|---|---|---|---|
| `a-time-for-peace-destroy` | — | `{"destroyed":["x-wing","shield-generator","nebulon-b-frigate","y-wing"]}` | src/engine/phases.ts |
| `action-card-noop` | — | `{"cardId":"proceeding-as-planned","reason":"no-projects-in-deck"}` | src/engine/phases.ts |
| `action-card-play` | — | `{"cardId":"rebel-extremist","leaderId":null,"systemId":null,"timing":"Immediate","viaStartingHand":true}` | src/engine/phases.ts |
| `action-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `activate-system` | Leader activates a system; orders = source systems, unitsMoved = total units. | `{"leaderId":"darth-vader","targetSystemId":"kashyyyk","orders":1}` | src/engine/phases.ts |
| `advance-time` | Time marker advanced (start of a new turn; followed by the turn-start snapshot). | `{"newValue":2}` | src/engine/mechanics.ts |
| `aggressive-negotiations-fail-destroy` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `ai-decision` | AI Command decision trace: chosen action + score, top-5 alternatives, engine-rejected count, planner state when enabled. | `{"chose":{"kind":"reveal","missionId":"sabotage","target":"mygeeto","score":35},"alts":[{"kind":"reveal","miss` | src/play/randomAI.ts |
| `ambitions-of-power-applied` | — | `{"newCap":9}` | src/engine/phases.ts |
| `ambitions-of-power-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `arm-card` | — | `{"cardId":"secret-facility","probeSystemId":"nal-hutta","probeId":"probe-nal-hutta"}` | src/engine/phases.ts |
| `arm-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `armed-reveal-declined` | — | `{"cardId":"sweep-the-area","systemId":"ord-mantell"}` | src/engine/phases.ts |
| `assign-leader` | — | `{"missionId":"rapid-mobilization","leaderIds":["general-rieekan"]}` | src/engine/phases.ts |
| `auto-rescue` | — | `{"leaderId":"luke-skywalker","systemId":"corellia","reason":"no-imperial-units"}` | src/engine/mechanics.ts |
| `behind-enemy-lines` | — | `{"systemId":"alderaan","moved":1}` | src/engine/phases.ts |
| `blindside-applied` | — | `{"missionId":"collect-bounty"}` | src/engine/phases.ts |
| `blindside-skipped` | — | `{"missionId":"gather-intel"}` | src/engine/phases.ts |
| `boba-block` | — | `{"systemId":"corellia"}` | src/engine/phases.ts |
| `break-their-will-probe` | — | `{"systemId":"endor","region":4,"baseInRegion":true}` | src/engine/phases.ts |
| `brilliant-administrator-built` | — | `{"systemId":"corellia","added":2,"picks":["tie-striker","star-destroyer"]}` | src/engine/phases.ts |
| `build-from-icons` | — | `{"systemId":"geonosis","label":"Establish Trade Relations","added":2,"picks":["rebel-transport","airspeeder"]}` | src/engine/phases.ts |
| `build-queue` | Unit added to the build queue. | `{"typeId":"rebel-transport","slot":2,"sourceSystemId":"geonosis"}` | src/engine/mechanics.ts |
| `build-queue-advance` | — | `{"typeId":"death-star","fromSlot":3,"toSlot":2,"via":"double-our-efforts"}` | src/engine/phases.ts |
| `build-queue-destroy` | — | `{"slot":1,"typeId":"interdictor","via":"rogue-squadron-raid"}` | src/engine/phases.ts |
| `build-wasted-no-supply` | — | `{"sourceSystemId":"mon-calamari","slot":3,"iconType":"space","iconShape":"square","legalUnitTypes":["mon-cala-` | src/engine/phases.ts |
| `c3po-applied` | — | `{"missionId":"build-alliance","targetSystemId":"bespin","explanation":"C-3PO ring discarded — diplomacy failur` | src/engine/phases.ts |
| `c3po-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `capture-leader` | Leader captured (ring: captured/carbonite). | `{"leaderId":"mon-mothma","ring":"captured","systemId":"cato-neimoidia"}` | src/engine/mechanics.ts |
| `capture-operative-pick` | — | `{"leaderId":"han-solo"}` | src/engine/phases.ts |
| `carbonite-applied` | — | `{"leaderId":"luke-skywalker","systemId":"nal-hutta"}` | src/engine/phases.ts |
| `catch-them-by-surprise-move` | — | `{"fromSystemId":"sullust","toSystemId":"corellia","moved":11,"movedIds":["s100035","s100019","s100032","u10000` | src/engine/phases.ts |
| `choice-cancel` | — | `{"kind":"PlayAssignmentActionCard"}` | src/engine/phases.ts |
| `choice-request` | — | `{"kind":"OpposeMission","missionId":"establish-trade-relations","attackerDice":3,"existing":[],"poolSize":4}` | src/engine/cinematicTactics.ts, src/engine/combat.ts, src/engine/mechanics.ts, src/engine/objectives.ts, src/engine/phases.ts |
| `cinematic-confrontation-choose` | — | `{"systemId":"kessel","candidates":["admiral-piett"]}` | src/engine/cinematicTactics.ts |
| `cinematic-confrontation-eliminate` | — | `{"leaderId":"admiral-piett"}` | src/engine/phases.ts |
| `cinematic-confrontation-mark` | — | `{"leaderId":"admiral-piett","systemId":"kessel"}` | src/engine/combat.ts |
| `cinematic-confrontation-no-leader` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-deck-recycle` | — | `{"theater":"ground","kept":"cin-empire-ground-target-the-generator","recycled":7}` | src/engine/cinematicTactics.ts |
| `cinematic-escape-plan` | — | `{"theater":"ground","round":1}` | src/engine/combat.ts |
| `cinematic-escape-plan-cancel` | — | `{"cancelKey":"Empire:ground:1"}` | src/engine/combat.ts |
| `cinematic-prevent-applied` | — | `{"theater":"space","round":1,"red":1,"black":1,"special":1}` | src/engine/combat.ts |
| `cinematic-remove-damage` | — | `{"theater":"space","round":1,"removed":2}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-reroll` | — | `{"theater":"space","round":1,"rerolled":1,"allowance":2}` | src/engine/combat.ts |
| `cinematic-rogue-one-no-retreat` | — | `{"systemId":"naboo"}` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-no-target` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-remove-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-rogue-one-rescue` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-shield-absorb` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-cancelled` | — | `{"theater":"space","round":3,"card":"cin-empire-space-superlaser-blast"}` | src/engine/combat.ts |
| `cinematic-tactic-locked` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-no-ability` | — | `{"theater":"ground","round":5,"card":"cin-empire-ground-support-of-the-501st"}` | src/engine/combat.ts |
| `cinematic-tactic-play` | — | `{"cardId":"cin-rebel-space-escort","ability":"primary","theater":"space","prevent":{"red":1,"black":1,"special` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-tactic-skip` | — | `{"theater":"ground","round":2}` | src/engine/combat.ts |
| `cinematic-tractor-beam-capture` | — | `{"leaderId":"lando-calrissian","systemId":"mustafar"}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `combat-action-card` | — | `{"card":"according-to-my-design"}` | src/engine/combat.ts |
| `combat-action-card-applied` | — | `{"card":"according-to-my-design","targetSide":"Rebel","theater":"space","round":1,"reducedRed":1,"reducedBlack` | src/engine/combat.ts |
| `combat-action-card-effect` | — | `{"card":"according-to-my-design","applied":"rebel-rolls-1R-2B-fewer-round1"}` | src/engine/combat.ts |
| `combat-action-card-not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-add-leader` | — | `{"leaderId":"darth-vader","tacticValue":5}` | src/engine/combat.ts |
| `combat-add-leader-declined` | — | `{}` | src/engine/combat.ts |
| `combat-attack` | One attack roll (theater, dice faces, attacker count). | `{"theater":"space","dice":[{"color":"red","face":"hit"},{"color":"red","face":"direct-hit"},{"color":"black","` | src/engine/combat.ts |
| `combat-begin` | Combat starts. A base assault also writes the base-assault snapshot. | `{"systemId":"kashyyyk","attackerSide":"Rebel"}` | src/engine/combat.ts |
| `combat-draw-tactics` | — | `{"attackerHand":1,"defenderHand":3}` | src/engine/combat.ts |
| `combat-dsuc-destroyed` | — | `{"systemId":"dagobah","round":2,"reason":"only remaining Imperial ship was the Death Star Under Construction"}` | src/engine/combat.ts |
| `combat-end` | Combat over (rounds fought, winner). | `{"systemId":"kashyyyk","rounds":2,"winner":"Empire"}` | src/engine/combat.ts |
| `combat-retreat` | Retreat executed (from/to, units, leader). | `{"from":"hoth","to":"bespin","units":11,"leaderId":"general-madine","stayedBehind":2,"ignoresTransport":false}` | src/engine/combat.ts |
| `combat-retreat-decline` | — | `{"systemId":"kashyyyk"}` | src/engine/combat.ts |
| `combat-safety-abort` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-special-draw` | — | `{"card":"space-onslaught"}` | src/engine/combat.ts |
| `combat-stalemate-end` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-structure-destroy` | — | `{"systemId":"kashyyyk"}` | src/engine/combat.ts |
| `combat-structure-survive` | — | `{"systemId":"kashyyyk","round":1}` | src/engine/combat.ts |
| `combat-tactic` | — | `{"card":"space-defensive-formation","blocked":1}` | src/engine/combat.ts |
| `combat-tactic-effect` | — | `{"effect":"unstoppable-assault-prevents-block"}` | src/engine/combat.ts |
| `contingency-plan-applied` | — | `{"leaderId":"mon-mothma","missionId":"sabotage"}` | src/engine/phases.ts |
| `covert-operation-pick` | — | `{"drawn":["cut-supply-lines-1","popular-support-2"],"kept":"cut-supply-lines-1","bottomed":"popular-support-2"` | src/engine/phases.ts |
| `death-star-completed` | — | `{"systemId":"dathomir","replacedUnit":"s100217"}` | src/engine/phases.ts |
| `death-star-plans-blocked-by-shield-bunker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-blocked-by-target-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-declined` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-miss` | — | `{"objectiveId":"death-star-plans-2","systemId":"malastare","faces":["blank","blank","blank"]}` | src/engine/combat.ts |
| `death-star-plans-success` | — | `{"objectiveId":"death-star-plans-2","systemId":"malastare","destroyed":"s100037","faces":["hit","blank","direc` | src/engine/combat.ts |
| `deploy` | One built unit deployed to a system (id + typeId). | `{"typeId":"rebel-trooper","systemId":"geonosis","unit":"u1000001"}` | src/engine/mechanics.ts |
| `deploy-declined-to-queue` | — | `{"typeId":"shield-bunker"}` | src/engine/phases.ts |
| `deploy-returned-to-queue` | — | `{"typeId":"rebel-trooper","reason":"all-systems-at-deploy-cap"}` | src/engine/phases.ts |
| `destroy-system` | — | `{"systemId":"kashyyyk"}` | src/engine/mechanics.ts |
| `destroy-unit` | One unit destroyed (id + typeId + where + cause). | `{"unit":"s100016","typeId":"tie-fighter","systemId":"kashyyyk","cause":"combat"}` | src/engine/mechanics.ts |
| `destroy-up-to-health` | — | `{"card":"Plant Explosives","killed":1,"totalHealth":2}` | src/engine/phases.ts |
| `destroyed-system-cull` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `destroyed-system-overflow` | — | `{"systemId":"kashyyyk","typeId":"stormtrooper","unit":"s100007"}` | src/engine/mechanics.ts |
| `detained-applied` | — | `{"leaderId":"jan-dodonna"}` | src/engine/phases.ts |
| `detained-refresh-skip` | — | `{"leaderIds":["jan-dodonna"]}` | src/engine/phases.ts |
| `discredit-rebellion-remove` | — | `{"systemIds":["cato-neimoidia","corellia"],"removed":2}` | src/engine/phases.ts |
| `discredit-rebellion-roll` | — | `{"faces":["special","hit"],"special":true,"diceCount":2}` | src/engine/phases.ts |
| `draw-action` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `draw-mission` | — | `{"count":2,"missionIds":["lead-the-strike-team","plan-the-assault"]}` | src/engine/mechanics.ts |
| `draw-objective` | — | `{"count":1,"objectiveIds":["regional-support-1"]}` | src/engine/mechanics.ts |
| `draw-probe` | — | `{"count":2,"probeIds":["probe-sullust","probe-ord-mantell"]}` | src/engine/mechanics.ts |
| `draw-them-out` | — | `{"leaderId":"lando-calrissian","systemId":"sullust"}` | src/engine/phases.ts |
| `dsuc-destroyed-cancels-build` | — | `{"slot":3}` | src/engine/mechanics.ts |
| `dsuc-replaced-by-death-star` | — | `{"systemId":"yavin","removed":"s100001"}` | src/engine/mechanics.ts |
| `eliminate-leader` | — | `{"leaderId":"darth-vader"}` | src/engine/mechanics.ts |
| `establish-trade-relations` | — | `{"systemId":"cato-neimoidia","loyalty":1}` | src/engine/phases.ts |
| `falcon-applied` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `falcon-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `false-orders` | — | `{"targetLeaderId":"emperor-palpatine","missionId":"rule-by-fear"}` | src/engine/phases.ts |
| `gain-loyalty` | Loyalty gained at a system. | `{"systemId":"geonosis","newLoyalty":"rebel"}` | src/engine/mechanics.ts |
| `gain-reputation` | Rebel reputation advanced. | `{"newValue":14}` | src/engine/mechanics.ts |
| `game-over` | Terminal event: winner + reason. | `{"winner":"Empire","reason":"base-captured"}` | src/engine/mechanics.ts |
| `heist-draw-objective` | — | `{"systemId":"kashyyyk"}` | src/engine/phases.ts |
| `hidden-fleet-move` | — | `{"targetSystemId":"alderaan","moved":0,"movedIds":[]}` | src/engine/phases.ts |
| `homing-beacon-place` | — | `{"leaderId":"mon-mothma","systemId":"felucia","regionRevealed":1}` | src/engine/phases.ts |
| `immediate-objective-discarded` | — | `{"objectiveId":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `imperial-might-deploy` | — | `{"systemId":"naboo","unitTypes":[],"auto":true}` | src/engine/phases.ts |
| `imperial-might-move-leaders` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `independent-operation-evac` | — | `{"fromSystemId":"utapau","toSystemId":"corellia","moved":5}` | src/engine/phases.ts |
| `instance-id-heal` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `interrogation-droid-named-systems` | — | `{"named":["endor","bespin","alderaan"],"note":"One of these contains the Rebel base."}` | src/engine/phases.ts |
| `invariant-violation` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `it-is-your-destiny-applied` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `it-is-your-destiny-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lando-contingency-bonus-consumed` | — | `{"missionId":"build-alliance"}` | src/engine/phases.ts |
| `lead-strike-team-move` | — | `{"targetSystemId":"alderaan","unitsSent":4}` | src/engine/phases.ts |
| `leader-flipped` | — | `{"leaderId":"mon-mothma","newSide":"Empire"}` | src/engine/mechanics.ts |
| `leader-pool-cap-eliminate` | — | `{"leaderId":"general-rieekan","chosen":true}` | src/engine/phases.ts |
| `leader-retreat` | — | `{"leaderId":"general-madine","from":"hoth","to":"bespin"}` | src/engine/mechanics.ts |
| `liberated` | Subjugation removed. | `{"systemId":"bespin"}` | src/engine/mechanics.ts |
| `local-rumors-reveal` | — | `{"systemId":"dantooine","region":5,"baseInRegion":true}` | src/engine/phases.ts |
| `lord-vader-s-orders-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lose-loyalty` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lose-reputation` | — | `{"newValue":15}` | src/engine/mechanics.ts |
| `loyalty-already` | — | `{"systemId":"mon-calamari","loyalty":"rebel"}` | src/engine/mechanics.ts |
| `loyalty-blocked` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lure-dark-side-pick` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `misdirection-set` | — | `{"leaderId":"princess-leia"}` | src/engine/phases.ts |
| `mission-discard` | — | `{"missionId":"establish-trade-relations"}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-hand-trim` | — | `{"missionId":"interrogation"}` | src/engine/phases.ts |
| `mission-return-to-hand` | — | `{"missionId":"build-alliance"}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-roll` | Contested mission dice resolution. | `{"missionId":"establish-trade-relations","skill":"diplomacy","attacker":{"dice":3,"successes":3,"portrait":2,"` | src/engine/phases.ts |
| `mission-unopposed` | Mission auto-succeeded unopposed. | `{"missionId":"infiltration","result":"auto-success"}` | src/engine/phases.ts |
| `move-unit` | One unit moved (self-contained: id + typeId + from/to). | `{"unit":"s100001","from":"mandalore","to":"kashyyyk"}` | src/engine/mechanics.ts |
| `noble-sacrifice-applied` | — | `{"explanation":"Noble Sacrifice — Obi-Wan eliminated for +1 reputation."}` | src/engine/phases.ts |
| `noble-sacrifice-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/log.ts |
| `note` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `notice` | — | `{"id":"rapid-mobilization-queued-t1-1","title":"Rapid Mobilization — queued"}` | src/engine/log.ts |
| `objective-check-not-met` | — | `{"objectives":[{"id":"regional-support-1","name":"Regional Support","rulesText":""}],"note":"StartOfRefresh ob` | src/engine/phases.ts |
| `objective-declined` | — | `{"legal":["the-long-war-1"]}` | src/engine/phases.ts |
| `objective-immediate-no-target` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `objective-peek` | — | `{"looked":["regional-support-1","defend-the-people-1"],"kept":"regional-support-1","keptRep":1,"bottomed":"def` | src/engine/phases.ts |
| `objective-played` | — | `{"objectiveId":"return-of-the-jedi-3","reputation":2,"timing":"Combat"}` | src/engine/combat.ts |
| `one-in-a-million-applied` | — | `{"context":"combat","theater":"space","picks":[{"index":0,"face":"direct-hit"}],"explanation":"One In A Millio` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-skipped` | — | `{"context":"combat"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-used` | — | `{"context":"dsplans","picks":[{"index":1,"face":"direct-hit"}],"faces":["blank","direct-hit","hit"]}` | src/engine/combat.ts |
| `our-most-desperate-hour-applied` | — | `{"missionId":"safe-haven","leaderId":"princess-leia"}` | src/engine/phases.ts |
| `oversee-project-pick` | — | `{"typeId":"at-st","slot":1,"targetSystemId":"cato-neimoidia"}` | src/engine/phases.ts |
| `pass` | Command turn passed. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `phase` | Phase transition marker. | `{"phase":"Assignment","via":"setup-complete"}` | src/engine/phases.ts |
| `pick-rebel-base` | Rebel base location chosen at setup. | `{"systemId":"bespin"}` | src/engine/phases.ts |
| `place-leader` | — | `{"leaderId":"mon-mothma","systemId":"geonosis"}` | src/engine/mechanics.ts |
| `plan-the-assault-move` | — | `{"targetSystemId":"kashyyyk","shipsSent":6}` | src/engine/phases.ts |
| `planetary-conquest-source` | — | `{"sourceSystemId":"cato-neimoidia","targetSystemId":"alderaan","units":3}` | src/engine/phases.ts |
| `plant-false-lead` | — | `{"moved":4,"top":4,"bottom":0}` | src/engine/phases.ts |
| `play-objective` | — | `{"objectiveId":"support-of-the-hutts-1","reputation":1}` | src/engine/phases.ts |
| `post-bounty-applied` | — | `{"leaderId":"princess-leia","missionId":"build-alliance"}` | src/engine/phases.ts |
| `post-bounty-rep-loss` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `post-bounty-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `prepare-for-battle-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `probe-removed-for-system` | — | `{"systemId":"dathomir","probeId":"probe-dathomir"}` | src/engine/mechanics.ts |
| `probe-state-repaired` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `proceeding-as-planned-applied` | — | `{"missionId":"construct-super-star-destroyer","leaderId":"moff-jerjerrod"}` | src/engine/phases.ts |
| `project-draw` | — | `{"count":1,"drawn":["superlaser-online"]}` | src/engine/phases.ts |
| `project-peek` | — | `{"drawn":["construct-factory","construct-factory"],"kept":"construct-factory","bottomed":"construct-factory"}` | src/engine/phases.ts |
| `public-support-gain` | — | `{"systemId":"mygeeto","stormtroopers":3}` | src/engine/phases.ts |
| `public-uprising-pick` | — | `{"systemId":"mandalore","circle":"airspeeder","triangles":["rebel-trooper","rebel-trooper"]}` | src/engine/phases.ts |
| `r2d2-flip` | — | `{"context":"mission","systemId":"mon-calamari","dieIndex":1,"flippedFrom":"hit","empireSide":"opposer","explan` | src/engine/combat.ts, src/engine/phases.ts |
| `r2d2-skipped` | — | `{"systemId":"geonosis","theater":"space"}` | src/engine/combat.ts, src/engine/phases.ts |
| `raid-outposts-score` | — | `{"systemId":"dagobah","reputation":1}` | src/engine/mechanics.ts |
| `rapid-mobilization-base-declined` | — | `{}` | src/engine/phases.ts |
| `rapid-mobilization-base-established` | Base relocated via Rapid Mobilization. | `{"fromSystemId":"bespin","toSystemId":"endor","baseRevealed":false,"wasRevealed":false}` | src/engine/phases.ts |
| `rapid-mobilization-base-no-legal-candidate` | — | `{"twoLeaders":false,"drawnCount":0}` | src/engine/phases.ts |
| `rapid-mobilization-move-applied` | — | `{"sourceSystemId":"toydaria","movedCount":2,"movedIds":["u1000038","u1000039"]}` | src/engine/phases.ts |
| `rapid-mobilization-old-base-probe-to-empire` | Old base probe card given to the Empire after relocation (LTP p.12). | `{"probeId":"probe-nal-hutta","systemId":"nal-hutta"}` | src/engine/phases.ts |
| `rapid-mobilization-probe-draw` | — | `{"count":4,"twoLeaders":false,"drawnProbeIds":["probe-tatooine","probe-sullust","probe-endor","probe-alderaan"` | src/engine/phases.ts |
| `rapid-mobilization-probes-to-bottom` | — | `{"count":4}` | src/engine/phases.ts |
| `rebel-cell-discard` | — | `{"discarded":"decisive-victory-1"}` | src/engine/phases.ts |
| `reconnaissance-recover` | — | `{"missionId":"regional-aid"}` | src/engine/phases.ts |
| `recruit-action-only` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `recruit-draw-another` | — | `{"drawn":"wookie-guardian"}` | src/engine/phases.ts |
| `recruit-leader` | Leader recruited. | `{"leaderId":"general-madine","cardId":"ambush"}` | src/engine/phases.ts |
| `recruit-pick-resolved` | — | `{"kept":"ambush","bottomed":["an-old-friend"]}` | src/engine/phases.ts |
| `refresh-retrieve` | — | `{"leaderIds":["general-rieekan","mon-mothma","princess-leia","jan-dodonna"]}` | src/engine/phases.ts |
| `regional-aid-second` | — | `{"systemId":"alderaan","targetSystemId":"corellia"}` | src/engine/phases.ts |
| `remove-loyalty` | — | `{"systemId":"mustafar"}` | src/engine/mechanics.ts |
| `rescue-leader` | — | `{"leaderId":"lando-calrissian","dest":"rebel-base-space","reason":"for-the-greater-good"}` | src/engine/mechanics.ts |
| `rescuer-return` | — | `{"systemId":"alderaan","returned":["jan-dodonna","han-solo"],"stayed":[]}` | src/engine/phases.ts |
| `retrieve-plans-applied` | — | `{"bottomed":"rebel-cell-2","revealedHand":["defensive-position-1","cut-supply-lines-1","crippling-blow-1","dea` | src/engine/phases.ts |
| `return-leader` | — | `{"leaderId":"lando-calrissian"}` | src/engine/mechanics.ts |
| `return-of-the-jedi-eliminate` | — | `{"systemId":"sullust","leaderId":"darth-vader"}` | src/engine/combat.ts |
| `reveal-armed-card` | — | `{"cardId":"secret-facility","systemId":"nal-hutta","armedAt":3}` | src/engine/phases.ts |
| `reveal-armed-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-armed-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-base` | Rebel base revealed (followed by the base-reveal snapshot). | `{"reason":"auto","systemId":"bespin"}` | src/engine/mechanics.ts |
| `reveal-mission` | Mission revealed at a target system. | `{"missionId":"establish-trade-relations","targetSystemId":"geonosis","isAttempt":true}` | src/engine/phases.ts |
| `ring-attach` | — | `{"leaderId":"mon-mothma","ring":"dark-side"}` | src/engine/mechanics.ts |
| `ring-remove` | — | `{"leaderId":"luke-skywalker","ring":"yoda"}` | src/engine/mechanics.ts |
| `sabotage-destroy-bunker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-place-marker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-removed` | — | `{"systemId":"mandalore"}` | src/engine/combat.ts, src/engine/phases.ts |
| `safe-haven-deploy` | — | `{"systemId":"mustafar","unitTypes":[]}` | src/engine/phases.ts |
| `scouting-mission-relocate` | — | `{"targetSystemId":"coruscant","moved":4,"movedIds":["s100034","s100032","s100014","s100015"]}` | src/engine/phases.ts |
| `secret-facility-unit` | — | `{"systemId":"nal-hutta","typeId":"assault-tank"}` | src/engine/phases.ts |
| `secret-mission` | — | `{"kept":["regional-aid"],"andor":false}` | src/engine/phases.ts |
| `setup` | Game seed + starting loyalty draw. The seed here is meta.seed in v2. | `{"seed":872037004,"rebelLoyalty":["ryloth","kashyyyk","mon-calamari"],"imperialLoyalty":["mygeeto","rodia","mu` | src/engine/setup.ts |
| `setup-auto-fill` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `setup-deploy` | One manually-placed setup unit (unit id included). Auto-filled units are NOT evented — read the setup-complete snapshot. | `{"typeId":"death-star","systemId":"mandalore"}` | src/engine/phases.ts |
| `setup-undeploy` | — | `{"typeId":"death-star","systemId":"mygeeto"}` | src/engine/phases.ts |
| `setup-warning` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `show-no-fear-revealed` | — | `{"systemId":"mon-calamari"}` | src/engine/phases.ts |
| `show-no-fear-score` | — | `{"reputation":1}` | src/engine/phases.ts |
| `skip-assignment` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `something-to-fight-for-applied` | — | `{"objectiveId":"leave-no-one-behind-2"}` | src/engine/combat.ts |
| `something-to-fight-for-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `son-of-skywalker-applied` | — | `{"pulledMissionId":"seek-yoda"}` | src/engine/phases.ts |
| `son-of-skywalker-skipped` | — | `{}` | src/engine/phases.ts |
| `start-evacuation-applied` | — | `{"targetSystemId":"coruscant","moved":1,"movedIds":["u1000026"]}` | src/engine/phases.ts |
| `starting-card-draw` | — | `{"cardId":"according-to-my-design","via":"early-promotion"}` | src/engine/phases.ts |
| `state` | Full board snapshot (codec string, turnLog-stripped). `at` says why: setup-complete / turn-start / base-reveal / base-assault. | `{"codec":"(full board snapshot, JSON codec string)","at":"setup-complete"}` | src/engine/combat.ts, src/engine/mechanics.ts, src/engine/phases.ts |
| `stolen-intel-discard` | — | `{"missionId":"for-the-greater-good"}` | src/engine/phases.ts |
| `stolen-plans-reorder` | — | `{"order":["death-star-plans-2","threaten-the-core-1","raid-outposts-2","popular-support-2"],"deck":"objective"` | src/engine/phases.ts |
| `subjugated` | System subjugated (Empire). | `{"systemId":"kashyyyk"}` | src/engine/mechanics.ts |
| `subjugation-cleared` | — | `{"systemId":"mygeeto","reason":"imperial-loyalty"}` | src/engine/mechanics.ts |
| `subversion-trigger` | — | `{"missionId":"subversion-original","leaderIds":["krennic"],"targetSystemId":"bespin"}` | src/engine/phases.ts |
| `superlaser-loyalty` | — | `{"systemId":"malastare","destroyedSystemId":"kashyyyk"}` | src/engine/phases.ts |
| `support-mon-cala-pick` | — | `{"option":"loyalty"}` | src/engine/phases.ts |
| `sweep-the-area-relocate` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `target-marker-place` | — | `{"systemId":"dathomir","source":"secure-the-plans"}` | src/engine/mechanics.ts |
| `target-marker-remove` | — | `{"systemId":"dagobah","source":"raid-outposts-2"}` | src/engine/mechanics.ts |
| `temporary-alliance-built` | — | `{"systemId":"ord-mantell","added":2,"picks":["corellian-corvette","golan-arms-turret"]}` | src/engine/phases.ts |
| `the-long-war-discard` | — | `{"discarded":["threaten-the-core-1","defend-the-people-1"]}` | src/engine/phases.ts |
| `track-them-applied` | — | `{"leaderId":"darth-vader","systemId":"saleucami"}` | src/engine/combat.ts |
| `track-them-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `unassign-leader` | — | `{"missionId":"hunt-them-down","leaderIds":["boba-fett"],"fromDeck":false}` | src/engine/phases.ts |
| `under-the-radar-keep` | — | `{"probeId":"probe-utapau"}` | src/engine/phases.ts |
| `under-the-radar-keep-holding` | — | `{"probeId":"probe-utapau"}` | src/engine/phases.ts |
| `under-the-radar-noop` | — | `{"reason":"empty-probe-deck"}` | src/engine/phases.ts |
| `under-the-radar-reorder` | — | `{"top":0,"bottom":3}` | src/engine/phases.ts |
| `under-the-radar-return` | — | `{"probeId":"probe-tatooine"}` | src/engine/phases.ts |
| `undercover-applied` | — | `{"leaderId":"lando-calrissian","targetSystemId":"kessel"}` | src/engine/phases.ts |
| `undercover-skipped` | — | `{}` | src/engine/phases.ts |
| `were-the-bait` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `wookie-guardian-applied` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `wookie-guardian-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `yoda-reroll` | — | `{"context":"mission","holder":"luke-skywalker-jedi","holderName":"Luke Skywalker (Jedi)","systemId":"sullust",` | src/engine/combat.ts, src/engine/phases.ts |
| `yoda-reroll-unavailable` | Yoda ring reroll not offered — already used this game round (#540 messaging). | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `yoda-skipped` | — | `{"context":"mission","systemId":"toydaria"}` | src/engine/combat.ts, src/engine/phases.ts |
