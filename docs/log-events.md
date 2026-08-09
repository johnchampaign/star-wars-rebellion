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

## Kinds (263)

| Kind | Description | Sample payload | Emitted from |
|---|---|---|---|
| `a-time-for-peace-destroy` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `action-card-noop` | — | `{"cardId":"proceeding-as-planned","reason":"no-projects-in-deck"}` | src/engine/phases.ts |
| `action-card-play` | — | `{"cardId":"rebel-extremist","leaderId":null,"systemId":null,"timing":"Immediate","viaStartingHand":true}` | src/engine/phases.ts |
| `action-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `action-deck-reshuffled` | Depleted action deck recycled its discard into a new deck (RR "Discarding", #657). The objective deck deliberately never does this — see the note on drawObjective. | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `activate-system` | Leader activates a system; orders = source systems, unitsMoved = total units. | `{"leaderId":"general-tagge","targetSystemId":"mon-calamari","orders":1,"unitsMoved":4}` | src/engine/phases.ts |
| `advance-time` | Time marker advanced (start of a new turn; followed by the turn-start snapshot). | `{"newValue":2}` | src/engine/mechanics.ts |
| `aggressive-negotiations-fail-destroy` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `ai-decision` | AI Command decision trace: chosen action + score, top-5 alternatives, engine-rejected count, planner state when enabled. | `{"policy":"mcts","chose":{"kind":"activate","leaderId":"general-tagge","target":"naboo","score":36,"mc":0.81},` | src/play/mctsAI.ts, src/play/randomAI.ts |
| `ambitions-of-power-applied` | — | `{"newCap":9}` | src/engine/phases.ts |
| `ambitions-of-power-skipped` | — | `{}` | src/engine/phases.ts |
| `arm-card` | — | `{"cardId":"secret-facility","probeSystemId":"endor","probeId":"probe-endor"}` | src/engine/phases.ts |
| `arm-card-blocked` | Refused to arm a one-of-a-kind card that was already armed or already spent to the discard (#656). Should never appear in a healthy game: if it does, the payload names the card and the current armed/discard contents, which identifies the path that was duplicating it. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `arm-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `armed-reveal-already-spent` | Safety net (#644): a reveal was requested for an armed card that is no longer armed, so nothing happened. Should never appear in a healthy game — if it does, a stale reveal offer survived past the card being spent. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `armed-reveal-declined` | — | `{"cardId":"secret-facility","systemId":"endor"}` | src/engine/phases.ts |
| `assign-leader` | — | `{"missionId":"build-alliance","leaderIds":["mon-mothma"]}` | src/engine/phases.ts |
| `auto-rescue` | — | `{"leaderId":"jan-dodonna","systemId":"dantooine","reason":"no-imperial-units"}` | src/engine/mechanics.ts |
| `behind-enemy-lines` | — | `{"systemId":"mon-calamari","moved":5}` | src/engine/phases.ts |
| `blindside-applied` | — | `{"missionId":"intercept-transmissions"}` | src/engine/phases.ts |
| `blindside-skipped` | — | `{"missionId":"capture-rebel-operative"}` | src/engine/phases.ts |
| `boba-block` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `break-their-will-probe` | — | `{"systemId":"endor","region":4,"baseInRegion":false}` | src/engine/phases.ts |
| `brilliant-administrator-built` | — | `{"systemId":"corellia","added":2,"picks":["tie-striker","star-destroyer"]}` | src/engine/phases.ts |
| `build-from-icons` | — | `{"systemId":"mon-calamari","label":"Construct Factory","added":2,"picks":["tie-fighter","star-destroyer"]}` | src/engine/phases.ts |
| `build-queue` | Unit added to the build queue. | `{"typeId":"star-destroyer","slot":3,"sourceSystemId":"corellia"}` | src/engine/mechanics.ts |
| `build-queue-advance` | — | `{"typeId":"super-star-destroyer","fromSlot":2,"toSlot":1,"via":"double-our-efforts"}` | src/engine/phases.ts |
| `build-queue-destroy` | — | `{"slot":2,"typeId":"star-destroyer","via":"rogue-squadron-raid"}` | src/engine/phases.ts |
| `build-wasted-no-supply` | — | `{"sourceSystemId":"utapau","slot":3,"iconType":"space","iconShape":"circle","legalUnitTypes":["assault-carrier` | src/engine/phases.ts |
| `c3po-applied` | — | `{"missionId":"build-alliance","targetSystemId":"rodia","explanation":"C-3PO ring discarded — diplomacy failure` | src/engine/phases.ts |
| `c3po-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `capture-leader` | Leader captured (ring: captured/carbonite). | `{"leaderId":"mon-mothma","ring":"captured","systemId":"cato-neimoidia"}` | src/engine/mechanics.ts |
| `capture-operative-pick` | — | `{"leaderId":"han-solo"}` | src/engine/phases.ts |
| `captured-leader-moved` | Empire | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `carbonite-applied` | — | `{"leaderId":"general-rieekan","systemId":"coruscant"}` | src/engine/phases.ts |
| `catch-them-by-surprise-move` | — | `{"fromSystemId":"hoth","toSystemId":"endor","moved":5,"movedIds":["s100028","s100029","s100026","u1000064","s1` | src/engine/phases.ts |
| `choice-cancel` | — | `{"kind":"PlayAssignmentActionCard"}` | src/engine/phases.ts |
| `choice-request` | — | `{"kind":"StartingCardBranch","cardId":"rebel-extremist","canDraw":true}` | src/engine/cinematicTactics.ts, src/engine/combat.ts, src/engine/mechanics.ts, src/engine/objectives.ts, src/engine/phases.ts |
| `cinematic-confrontation-choose` | — | `{"systemId":"naboo","candidates":["grand-moff-tarkin"]}` | src/engine/cinematicTactics.ts |
| `cinematic-confrontation-eliminate` | — | `{"leaderId":"grand-moff-tarkin"}` | src/engine/phases.ts |
| `cinematic-confrontation-mark` | — | `{"leaderId":"grand-moff-tarkin","systemId":"naboo"}` | src/engine/combat.ts |
| `cinematic-confrontation-no-leader` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-deck-recycle` | — | `{"theater":"ground","kept":"cin-rebel-ground-rogue-one","recycled":7}` | src/engine/cinematicTactics.ts |
| `cinematic-escape-plan` | — | `{"theater":"ground","round":2}` | src/engine/combat.ts |
| `cinematic-escape-plan-cancel` | — | `{"cancelKey":"Empire:ground:2"}` | src/engine/combat.ts |
| `cinematic-prevent-applied` | — | `{"theater":"space","round":1,"red":0,"black":2,"directHit":0}` | src/engine/combat.ts |
| `cinematic-remove-damage` | — | `{"theater":"space","round":2,"removed":1}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-reroll` | — | `{"theater":"space","round":1,"rerolled":1,"allowance":1}` | src/engine/combat.ts |
| `cinematic-rogue-one-no-retreat` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-no-target` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-remove-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-rogue-one-rescue` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-shield-absorb` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-cancelled` | — | `{"theater":"ground","round":2,"card":"cin-rebel-ground-take-cover"}` | src/engine/combat.ts |
| `cinematic-tactic-locked` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-no-ability` | — | `{"theater":"ground","round":3,"card":"cin-empire-ground-air-superiority"}` | src/engine/combat.ts |
| `cinematic-tactic-play` | — | `{"cardId":"cin-rebel-space-escort","ability":"primary","theater":"space","prevent":{"red":1,"black":1,"special` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-tactic-skip` | — | `{"theater":"ground","round":3}` | src/engine/combat.ts |
| `cinematic-tractor-beam-capture` | — | `{"leaderId":"jan-dodonna","systemId":"dathomir"}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `combat-action-card` | — | `{"card":"ready-for-action"}` | src/engine/combat.ts |
| `combat-action-card-applied` | — | `{"card":"according-to-my-design","targetSide":"Rebel","theater":"space","round":1,"reducedRed":1,"reducedBlack` | src/engine/combat.ts |
| `combat-action-card-effect` | — | `{"card":"ready-for-action","placedLeader":"emperor-palpatine"}` | src/engine/combat.ts |
| `combat-action-card-not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-add-leader` | — | `{"leaderId":"admiral-ozzel","tacticValue":3}` | src/engine/combat.ts |
| `combat-add-leader-declined` | — | `{}` | src/engine/combat.ts |
| `combat-attack` | One attack roll (theater, dice faces, attacker count). | `{"theater":"space","dice":[{"color":"red","face":"hit"},{"color":"red","face":"hit"},{"color":"black","face":"` | src/engine/combat.ts |
| `combat-begin` | Combat starts. A base assault also writes the base-assault snapshot. | `{"systemId":"mon-calamari","attackerSide":"Rebel","cinematic":true}` | src/engine/combat.ts |
| `combat-blocks-removed` | RR p.5 step 4: after the attacker assigns every hit, the defender's blocks remove that many of the assigned damages (greedily, where they save a unit). | `{"theater":"space","blocks":1,"removed":1,"perUnit":{"s100018":1}}` | src/engine/combat.ts |
| `combat-draw-tactics` | — | `{"attackerHand":0,"defenderHand":0,"cinematic":true}` | src/engine/combat.ts |
| `combat-dsuc-destroyed` | — | `{"systemId":"dagobah","round":2,"reason":"only remaining Imperial ship was the Death Star Under Construction"}` | src/engine/combat.ts |
| `combat-end` | Combat over (rounds fought, winner). | `{"systemId":"mon-calamari","rounds":3,"winner":null}` | src/engine/combat.ts |
| `combat-retreat` | Retreat executed (from/to, units, leader). | `{"from":"ryloth","to":"geonosis","units":2,"leaderId":"darth-vader","stayedBehind":0,"ignoresTransport":false}` | src/engine/combat.ts |
| `combat-retreat-decline` | — | `{"systemId":"mon-calamari"}` | src/engine/combat.ts |
| `combat-safety-abort` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-special-draw` | — | `{"card":"space-outmaneuver"}` | src/engine/combat.ts |
| `combat-stalemate-end` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-structure-destroy` | — | `{"systemId":"corellia"}` | src/engine/combat.ts |
| `combat-structure-survive` | — | `{"systemId":"bothawui","round":2}` | src/engine/combat.ts |
| `combat-tactic` | — | `{"card":"space-take-it-down","bonusDamage":2}` | src/engine/combat.ts |
| `combat-tactic-effect` | — | `{"effect":"unstoppable-assault-prevents-block"}` | src/engine/combat.ts |
| `contingency-plan-applied` | — | `{"leaderId":"general-rieekan","missionId":"build-alliance"}` | src/engine/phases.ts |
| `covert-operation-pick` | — | `{"drawn":["the-long-war-1","cut-supply-lines-1"],"kept":"the-long-war-1","bottomed":"cut-supply-lines-1"}` | src/engine/phases.ts |
| `death-star-completed` | — | `{"systemId":"dagobah","replacedUnit":"s100001"}` | src/engine/phases.ts |
| `death-star-plans-blocked-by-shield-bunker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-blocked-by-target-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-declined` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-miss` | — | `{"objectiveId":"death-star-plans-3","systemId":"utapau","faces":["blank","hit","hit"]}` | src/engine/combat.ts |
| `death-star-plans-success` | — | `{"objectiveId":"death-star-plans-2","systemId":"malastare","destroyed":"u1000009","faces":["blank","direct-hit` | src/engine/combat.ts |
| `deploy` | One built unit deployed to a system (id + typeId). | `{"typeId":"tie-fighter","systemId":"mon-calamari","unit":"u1001140"}` | src/engine/mechanics.ts |
| `deploy-declined-to-queue` | — | `{"typeId":"x-wing"}` | src/engine/phases.ts |
| `deploy-returned-to-queue` | — | `{"typeId":"x-wing","reason":"all-systems-at-deploy-cap"}` | src/engine/phases.ts |
| `destroy-system` | — | `{"systemId":"mustafar"}` | src/engine/mechanics.ts |
| `destroy-unit` | One unit destroyed (id + typeId + where + cause). | `{"unit":"s100155","typeId":"assault-carrier","systemId":"mon-calamari","cause":"combat"}` | src/engine/mechanics.ts |
| `destroy-up-to-health` | — | `{"card":"Hit And Run","killed":2,"totalHealth":2}` | src/engine/phases.ts |
| `destroyed-system-cull` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `destroyed-system-overflow` | — | `{"systemId":"kashyyyk","typeId":"stormtrooper","unit":"s100104"}` | src/engine/mechanics.ts |
| `detained-applied` | — | `{"leaderId":"jyn-erso"}` | src/engine/phases.ts |
| `detained-refresh-skip` | — | `{"leaderIds":["jyn-erso"]}` | src/engine/phases.ts |
| `discredit-rebellion-remove` | — | `{"systemIds":["corellia"],"removed":1}` | src/engine/phases.ts |
| `discredit-rebellion-roll` | — | `{"faces":["special","hit"],"special":true,"diceCount":2}` | src/engine/phases.ts |
| `draw-action` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `draw-mission` | — | `{"count":2,"missionIds":["behind-enemy-lines","behind-enemy-lines"]}` | src/engine/mechanics.ts |
| `draw-objective` | — | `{"count":1,"objectiveIds":["the-long-war-1"]}` | src/engine/mechanics.ts |
| `draw-probe` | — | `{"count":2,"probeIds":["probe-toydaria","probe-naboo"]}` | src/engine/mechanics.ts |
| `draw-them-out` | — | `{"leaderId":"jyn-erso","systemId":"bespin","auto":true}` | src/engine/phases.ts |
| `dsuc-destroyed-cancels-build` | — | `{"slot":3}` | src/engine/mechanics.ts |
| `dsuc-replaced-by-death-star` | — | `{"systemId":"dagobah","removed":"s101044"}` | src/engine/mechanics.ts |
| `eliminate-leader` | — | `{"leaderId":"grand-moff-tarkin"}` | src/engine/mechanics.ts |
| `establish-trade-relations` | — | `{"systemId":"nal-hutta","loyalty":1}` | src/engine/phases.ts |
| `falcon-applied` | — | `{"missionId":"build-alliance","targetSystemId":"mon-calamari","leaderId":"lando-calrissian","explanation":"Mil` | src/engine/phases.ts |
| `falcon-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `false-orders` | — | `{"targetLeaderId":"grand-moff-tarkin","missionId":"research-and-development"}` | src/engine/phases.ts |
| `gain-loyalty` | Loyalty gained at a system. | `{"systemId":"nal-hutta","newLoyalty":"rebel"}` | src/engine/mechanics.ts |
| `gain-reputation` | Rebel reputation advanced. | `{"newValue":14}` | src/engine/mechanics.ts |
| `game-over` | Terminal event: winner + reason. | `{"winner":"Empire","reason":"base-captured"}` | src/engine/mechanics.ts |
| `heist-draw-objective` | — | `{"systemId":"dathomir"}` | src/engine/phases.ts |
| `hidden-fleet-move` | — | `{"targetSystemId":"dantooine","moved":9,"movedIds":["s100042","s100043","s100046","u1000049","s100049","s10005` | src/engine/phases.ts |
| `homing-beacon-place` | — | `{"leaderId":"wedge-antilles","systemId":"geonosis","regionRevealed":3}` | src/engine/phases.ts |
| `immediate-objective-discarded` | — | `{"objectiveId":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `imperial-might-deploy` | — | `{"systemId":"tatooine","unitTypes":["assault-tank","assault-carrier","tie-fighter","stormtrooper"]}` | src/engine/phases.ts |
| `imperial-might-move-leaders` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `independent-operation-evac` | — | `{"fromSystemId":"kashyyyk","toSystemId":"corellia","moved":6}` | src/engine/phases.ts |
| `instance-id-heal` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `interrogation-droid-named-systems` | — | `{"named":["alderaan","bespin","kessel"],"note":"One of these contains the Rebel base."}` | src/engine/phases.ts |
| `invariant-violation` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `it-is-your-destiny-applied` | — | `{"capturedLeader":"jan-dodonna","explanation":"Vader captures a rescuer."}` | src/engine/phases.ts |
| `it-is-your-destiny-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lando-contingency-bonus-consumed` | — | `{"missionId":"build-alliance"}` | src/engine/phases.ts |
| `lead-strike-team-move` | — | `{"targetSystemId":"alderaan","unitsSent":4}` | src/engine/phases.ts |
| `leader-flipped` | — | `{"leaderId":"mon-mothma","newSide":"Empire"}` | src/engine/mechanics.ts |
| `leader-pool-cap-eliminate` | — | `{"leaderId":"general-rieekan","chosen":true}` | src/engine/phases.ts |
| `leader-retreat` | — | `{"leaderId":"darth-vader","from":"ryloth","to":"geonosis"}` | src/engine/mechanics.ts |
| `liberated` | Subjugation removed. | `{"systemId":"bothawui"}` | src/engine/mechanics.ts |
| `local-rumors-reveal` | — | `{"systemId":"ord-mantell","region":5,"baseInRegion":false}` | src/engine/phases.ts |
| `lord-vader-s-orders-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lose-loyalty` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lose-reputation` | — | `{"newValue":15}` | src/engine/mechanics.ts |
| `loyalty-already` | — | `{"systemId":"kashyyyk","loyalty":"rebel"}` | src/engine/mechanics.ts |
| `loyalty-blocked` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lure-dark-side-pick` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `misdirection-set` | — | `{"leaderId":"princess-leia"}` | src/engine/phases.ts |
| `mission-deck-reshuffled` | Rebel/Empire | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `mission-discard` | — | `{"missionId":"behind-enemy-lines"}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-hand-trim` | — | `{"missionId":"interrogation"}` | src/engine/phases.ts |
| `mission-return-to-hand` | — | `{"missionId":"build-alliance","onFail":false}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-roll` | Contested mission dice resolution. | `{"missionId":"rule-by-fear","skill":"diplomacy","attacker":{"dice":3,"successes":5,"portrait":0,"landoBonus":0` | src/engine/phases.ts |
| `mission-unopposed` | Mission auto-succeeded unopposed. | `{"missionId":"build-alliance","result":"auto-success"}` | src/engine/phases.ts |
| `move-unit` | One unit moved (self-contained: id + typeId + from/to). | `{"unit":"s100155","typeId":"assault-carrier","from":"saleucami","to":"mon-calamari"}` | src/engine/mechanics.ts |
| `noble-sacrifice-applied` | — | `{"explanation":"Noble Sacrifice — Obi-Wan eliminated for +1 reputation."}` | src/engine/phases.ts |
| `noble-sacrifice-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/log.ts |
| `note` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `notice` | — | `{"id":"rapid-mobilization-queued-t1-1","title":"Rapid Mobilization — queued"}` | src/engine/log.ts |
| `objective-check-not-met` | — | `{"objectives":[{"id":"defend-the-people-1","name":"Defend The People","rulesText":""}],"note":"StartOfRefresh ` | src/engine/phases.ts |
| `objective-declined` | — | `{"legal":["the-long-war-1"]}` | src/engine/phases.ts |
| `objective-immediate-no-target` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `objective-peek` | — | `{"looked":["the-long-war-1","crippling-blow-1"],"kept":"the-long-war-1","keptRep":1,"bottomed":"crippling-blow` | src/engine/phases.ts |
| `objective-played` | — | `{"objectiveId":"decisive-victory-1","reputation":1,"timing":"Combat"}` | src/engine/combat.ts |
| `one-in-a-million-applied` | — | `{"context":"combat","theater":"space","picks":[{"index":0,"face":"direct-hit"},{"index":1,"face":"direct-hit"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-skipped` | — | `{"context":"combat"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-used` | — | `{"context":"dsplans","picks":[{"index":1,"face":"direct-hit"}],"faces":["blank","direct-hit","hit"]}` | src/engine/combat.ts |
| `our-most-desperate-hour-applied` | — | `{"missionId":"establish-trade-relations","leaderId":"princess-leia"}` | src/engine/phases.ts |
| `oversee-project-pick` | — | `{"typeId":"death-star","slot":1,"targetSystemId":"cato-neimoidia"}` | src/engine/phases.ts |
| `pass` | Command turn passed. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `phase` | Phase transition marker. | `{"phase":"Assignment","via":"setup-complete"}` | src/engine/phases.ts |
| `pick-rebel-base` | Rebel base location chosen at setup. | `{"systemId":"ryloth"}` | src/engine/phases.ts |
| `place-leader` | — | `{"leaderId":"mon-mothma","systemId":"nal-hutta"}` | src/engine/mechanics.ts |
| `plan-the-assault-move` | — | `{"targetSystemId":"cato-neimoidia","shipsSent":2}` | src/engine/phases.ts |
| `planetary-conquest-source` | — | `{"sourceSystemId":"ord-mantell","targetSystemId":"alderaan","units":3}` | src/engine/phases.ts |
| `plant-false-lead` | — | `{"moved":4,"top":0,"bottom":4}` | src/engine/phases.ts |
| `play-objective` | — | `{"objectiveId":"the-long-war-1","reputation":1}` | src/engine/phases.ts |
| `post-bounty-applied` | — | `{"leaderId":"princess-leia","missionId":"build-alliance"}` | src/engine/phases.ts |
| `post-bounty-rep-loss` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `post-bounty-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `prepare-for-battle-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `probe-removed-for-system` | — | `{"systemId":"dathomir","probeId":"probe-dathomir"}` | src/engine/mechanics.ts |
| `probe-state-repaired` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `proceeding-as-planned-applied` | — | `{"missionId":"construct-death-star","leaderId":"admiral-ozzel"}` | src/engine/phases.ts |
| `project-draw` | — | `{"count":1,"drawn":["superlaser-online"]}` | src/engine/phases.ts |
| `project-peek` | — | `{"drawn":["construct-factory","interdictor-development"],"kept":"construct-factory","bottomed":"interdictor-de` | src/engine/phases.ts |
| `public-support-gain` | — | `{"systemId":"saleucami","stormtroopers":3}` | src/engine/phases.ts |
| `public-uprising-pick` | — | `{"systemId":"bothawui","circle":"corellian-corvette","triangles":["rebel-trooper","rebel-trooper"]}` | src/engine/phases.ts |
| `r2d2-flip` | — | `{"context":"mission","systemId":"nal-hutta","dieIndex":0,"flippedFrom":"special","empireSide":"opposer","expla` | src/engine/combat.ts, src/engine/phases.ts |
| `r2d2-skipped` | — | `{"context":"mission","systemId":"kashyyyk"}` | src/engine/combat.ts, src/engine/phases.ts |
| `raid-outposts-score` | — | `{"systemId":"dagobah","reputation":1}` | src/engine/mechanics.ts |
| `rapid-mobilization-base-declined` | — | `{}` | src/engine/phases.ts |
| `rapid-mobilization-base-established` | Base relocated via Rapid Mobilization. | `{"fromSystemId":"geonosis","toSystemId":"nal-hutta","baseRevealed":false,"wasRevealed":false}` | src/engine/phases.ts |
| `rapid-mobilization-base-no-legal-candidate` | — | `{"twoLeaders":false,"drawnCount":4}` | src/engine/phases.ts |
| `rapid-mobilization-move-applied` | — | `{"sourceSystemId":"alderaan","movedCount":0,"movedIds":[]}` | src/engine/phases.ts |
| `rapid-mobilization-old-base-probe-to-empire` | Old base probe card given to the Empire after relocation (LTP p.12). | `{"probeId":"probe-nal-hutta","systemId":"nal-hutta"}` | src/engine/phases.ts |
| `rapid-mobilization-probe-draw` | — | `{"count":4,"twoLeaders":false,"drawnProbeIds":["probe-utapau","probe-mandalore","probe-kessel","probe-cato-nei` | src/engine/phases.ts |
| `rapid-mobilization-probes-to-bottom` | — | `{"count":4}` | src/engine/phases.ts |
| `rebel-cell-discard` | — | `{"discarded":"defend-the-people-1"}` | src/engine/phases.ts |
| `reconnaissance-recover` | — | `{"missionId":"lead-the-strike-team"}` | src/engine/phases.ts |
| `recruit-action-only` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `recruit-draw-another` | — | `{"drawn":"good-intel"}` | src/engine/phases.ts |
| `recruit-leader` | Leader recruited. | `{"leaderId":"saw-gerrera","via":"rebel-extremist"}` | src/engine/phases.ts |
| `recruit-pick-resolved` | — | `{"kept":"ambush","bottomed":["an-old-friend"]}` | src/engine/phases.ts |
| `refresh-retrieve` | — | `{"leaderIds":["mon-mothma","princess-leia","general-rieekan","jan-dodonna","saw-gerrera"]}` | src/engine/phases.ts |
| `regional-aid-second` | — | `{"systemId":"sullust","targetSystemId":"utapau"}` | src/engine/phases.ts |
| `remove-loyalty` | — | `{"systemId":"bothawui","via":"imperial-propaganda"}` | src/engine/mechanics.ts |
| `rescue-leader` | — | `{"leaderId":"jan-dodonna","dest":"rebel-base-space","reason":"for-the-greater-good"}` | src/engine/mechanics.ts |
| `rescuer-return` | — | `{"systemId":"cato-neimoidia","returned":["jan-dodonna"],"stayed":[]}` | src/engine/phases.ts |
| `retrieve-plans-applied` | — | `{"bottomed":"the-long-war-1","revealedHand":["decisive-victory-1","threaten-the-core-1","the-long-war-1","deat` | src/engine/phases.ts |
| `return-leader` | — | `{"leaderId":"general-madine"}` | src/engine/mechanics.ts |
| `return-of-the-jedi-eliminate` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `reveal-armed-card` | — | `{"cardId":"secret-facility","systemId":"endor","armedAt":5}` | src/engine/phases.ts |
| `reveal-armed-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-armed-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-base` | Rebel base revealed (followed by the base-reveal snapshot). | `{"reason":"auto","systemId":"ryloth"}` | src/engine/mechanics.ts |
| `reveal-mission` | Mission revealed at a target system. | `{"missionId":"build-alliance","targetSystemId":"nal-hutta","isAttempt":true}` | src/engine/phases.ts |
| `ring-attach` | — | `{"leaderId":"general-rieekan","ring":"c3po"}` | src/engine/mechanics.ts |
| `ring-remove` | — | `{"leaderId":"luke-skywalker","ring":"yoda"}` | src/engine/mechanics.ts |
| `sabotage-destroy-bunker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-place-marker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-removed` | — | `{"systemId":"mygeeto"}` | src/engine/combat.ts, src/engine/phases.ts |
| `safe-haven-deploy` | — | `{"systemId":"kashyyyk","unitTypes":["mon-cala-cruiser","nebulon-b-frigate"]}` | src/engine/phases.ts |
| `scouting-mission-relocate` | — | `{"targetSystemId":"bothawui","moved":4,"movedIds":["s100010","s100009","s100003","s100028"]}` | src/engine/phases.ts |
| `secret-facility-unit` | — | `{"systemId":"endor","typeId":"assault-tank"}` | src/engine/phases.ts |
| `secret-mission` | — | `{"kept":["plan-the-assault"],"andor":false}` | src/engine/phases.ts |
| `setup` | Game seed + starting loyalty draw. The seed here is meta.seed in v2. | `{"seed":632904190,"rebelLoyalty":["ryloth","bothawui","mon-calamari"],"imperialLoyalty":["rodia","mygeeto","co` | src/engine/setup.ts |
| `setup-auto-fill` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `setup-deploy` | One manually-placed setup unit (unit id included). Auto-filled units are NOT evented — read the setup-complete snapshot. | `{"typeId":"death-star","systemId":"saleucami","unit":"s100154"}` | src/engine/phases.ts |
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
| `stolen-intel-discard` | — | `{"missionId":"seek-yoda"}` | src/engine/phases.ts |
| `stolen-plans-reorder` | — | `{"order":["death-star-plans-2","liberation-2","seize-control-2","raid-outposts-2"],"deck":"objective"}` | src/engine/phases.ts |
| `subjugated` | System subjugated (Empire). | `{"systemId":"mon-calamari"}` | src/engine/mechanics.ts |
| `subjugation-cleared` | — | `{"systemId":"mygeeto","reason":"imperial-loyalty"}` | src/engine/mechanics.ts |
| `subversion-trigger` | — | `{"missionId":"subversion-original-rebel","leaderIds":["luke-skywalker"],"targetSystemId":"mon-calamari"}` | src/engine/phases.ts |
| `superlaser-loyalty` | — | `{"systemId":"malastare","destroyedSystemId":"kashyyyk"}` | src/engine/phases.ts |
| `support-mon-cala-pick` | — | `{"option":"cruiser"}` | src/engine/phases.ts |
| `sweep-the-area-relocate` | — | `{"leaderId":"luke-skywalker-jedi","from":"dagobah","to":"sullust"}` | src/engine/phases.ts |
| `target-marker-place` | — | `{"systemId":"dagobah","source":"raid-outposts-2"}` | src/engine/mechanics.ts |
| `target-marker-remove` | — | `{"systemId":"dagobah","source":"raid-outposts-2"}` | src/engine/mechanics.ts |
| `temporary-alliance-built` | — | `{"systemId":"ord-mantell","added":2,"picks":["corellian-corvette","airspeeder"]}` | src/engine/phases.ts |
| `the-long-war-discard` | — | `{"discarded":["defend-the-people-1","cut-supply-lines-1"]}` | src/engine/phases.ts |
| `track-them-applied` | — | `{"leaderId":"darth-vader","systemId":"saleucami"}` | src/engine/combat.ts |
| `track-them-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `unassign-leader` | — | `{"missionId":"research-and-development","leaderIds":["grand-moff-tarkin"],"fromDeck":false}` | src/engine/phases.ts |
| `under-the-radar-keep` | — | `{"probeId":"probe-utapau"}` | src/engine/phases.ts |
| `under-the-radar-keep-holding` | — | `{"probeId":"probe-utapau"}` | src/engine/phases.ts |
| `under-the-radar-noop` | — | `{"reason":"empty-probe-deck"}` | src/engine/phases.ts |
| `under-the-radar-reorder` | — | `{"top":0,"bottom":3}` | src/engine/phases.ts |
| `under-the-radar-return` | — | `{"probeId":"probe-tatooine"}` | src/engine/phases.ts |
| `undercover-applied` | — | `{"leaderId":"lando-calrissian","targetSystemId":"alderaan"}` | src/engine/phases.ts |
| `undercover-skipped` | — | `{}` | src/engine/phases.ts |
| `were-the-bait` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `wookie-guardian-applied` | — | `{"missionId":"collect-bounty","explanation":"Chewbacca auto-stops the Empire special-ops mission."}` | src/engine/phases.ts |
| `wookie-guardian-skipped` | — | `{"missionId":"capture-rebel-operative"}` | src/engine/phases.ts |
| `yoda-reroll` | — | `{"holder":"luke-skywalker-jedi","systemId":"dagobah","color":"green","oldFace":"blank","newFace":"blank"}` | src/engine/combat.ts, src/engine/phases.ts |
| `yoda-reroll-unavailable` | Yoda ring reroll not offered — already used this game round (#540 messaging). | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `yoda-skipped` | — | `{"context":"mission","systemId":"dagobah"}` | src/engine/combat.ts, src/engine/phases.ts |
