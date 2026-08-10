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

## Kinds (264)

| Kind | Description | Sample payload | Emitted from |
|---|---|---|---|
| `a-time-for-peace-destroy` | — | `{"destroyed":["mon-cala-cruiser","y-wing","corellian-corvette","rebel-trooper"]}` | src/engine/phases.ts |
| `action-card-noop` | — | `{"cardId":"proceeding-as-planned","reason":"no-projects-in-deck"}` | src/engine/phases.ts |
| `action-card-play` | — | `{"cardId":"false-orders","leaderId":null,"systemId":null,"timing":"Assignment"}` | src/engine/phases.ts |
| `action-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `action-deck-reshuffled` | Depleted action deck recycled its discard into a new deck (RR "Discarding", #657). The objective deck deliberately never does this — see the note on drawObjective. | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `activate-system` | Leader activates a system; orders = source systems, unitsMoved = total units. | `{"leaderId":"darth-vader","targetSystemId":"kashyyyk","orders":1}` | src/engine/phases.ts |
| `advance-time` | Time marker advanced (start of a new turn; followed by the turn-start snapshot). | `{"newValue":2}` | src/engine/mechanics.ts |
| `aggressive-negotiations-fail-destroy` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `ai-decision` | AI Command decision trace: chosen action + score, top-5 alternatives, engine-rejected count, planner state when enabled. | `{"policy":"mcts","chose":{"kind":"activate","leaderId":"darth-vader","target":"naboo","score":36,"mc":0.9},"al` | src/play/mctsAI.ts, src/play/randomAI.ts |
| `ambitions-of-power-applied` | — | `{"newCap":9}` | src/engine/phases.ts |
| `ambitions-of-power-skipped` | — | `{}` | src/engine/phases.ts |
| `arm-card` | — | `{"cardId":"secret-facility","probeSystemId":"endor","probeId":"probe-endor"}` | src/engine/phases.ts |
| `arm-card-blocked` | Refused to arm a one-of-a-kind card that was already armed or already spent to the discard (#656). Should never appear in a healthy game: if it does, the payload names the card and the current armed/discard contents, which identifies the path that was duplicating it. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `arm-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `armed-reveal-already-spent` | Safety net (#644): a reveal was requested for an armed card that is no longer armed, so nothing happened. Should never appear in a healthy game — if it does, a stale reveal offer survived past the card being spent. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `armed-reveal-declined` | — | `{"cardId":"sweep-the-area","systemId":"dagobah"}` | src/engine/phases.ts |
| `assign-leader` | — | `{"missionId":"rapid-mobilization","leaderIds":["general-rieekan"]}` | src/engine/phases.ts |
| `auto-rescue` | — | `{"leaderId":"jan-dodonna","systemId":"mygeeto","reason":"no-imperial-units"}` | src/engine/mechanics.ts |
| `behind-enemy-lines` | — | `{"systemId":"corellia","moved":5}` | src/engine/phases.ts |
| `blindside-applied` | — | `{"missionId":"collect-bounty"}` | src/engine/phases.ts |
| `blindside-skipped` | — | `{"missionId":"capture-rebel-operative"}` | src/engine/phases.ts |
| `boba-block` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `break-their-will-probe` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `brilliant-administrator-built` | — | `{"systemId":"corellia","added":2,"picks":["tie-striker","star-destroyer"]}` | src/engine/phases.ts |
| `build-from-icons` | — | `{"systemId":"toydaria","label":"Establish Trade Relations","added":1,"picks":["nebulon-b-frigate"]}` | src/engine/phases.ts |
| `build-queue` | Unit added to the build queue. | `{"typeId":"mon-cala-cruiser","slot":3}` | src/engine/mechanics.ts |
| `build-queue-advance` | — | `{"typeId":"super-star-destroyer","fromSlot":2,"toSlot":1,"via":"double-our-efforts"}` | src/engine/phases.ts |
| `build-queue-destroy` | — | `{"slot":1,"typeId":"assault-carrier","via":"rogue-squadron-raid"}` | src/engine/phases.ts |
| `build-wasted-no-supply` | — | `{"sourceSystemId":"mon-calamari","slot":3,"iconType":"space","iconShape":"square","legalUnitTypes":["mon-cala-` | src/engine/phases.ts |
| `c3po-applied` | — | `{"missionId":"build-alliance","targetSystemId":"rodia","explanation":"C-3PO ring discarded — diplomacy failure` | src/engine/phases.ts |
| `c3po-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `capture-leader` | Leader captured (ring: captured/carbonite). | `{"leaderId":"jan-dodonna","ring":"captured","systemId":"mygeeto"}` | src/engine/mechanics.ts |
| `capture-operative-pick` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `captured-leader-moved` | Empire | `{"leaderId":"mon-mothma","fromSystemId":"felucia","toSystemId":"yavin"}` | src/engine/phases.ts |
| `carbonite-applied` | — | `{"leaderId":"general-rieekan","systemId":"coruscant"}` | src/engine/phases.ts |
| `catch-them-by-surprise-move` | — | `{"fromSystemId":"saleucami","toSystemId":"kashyyyk","moved":6,"movedIds":["s100002","s100022","s100021","s1000` | src/engine/phases.ts |
| `choice-cancel` | — | `{"kind":"AssignSecondLeaderPick"}` | src/engine/phases.ts |
| `choice-request` | — | `{"kind":"FalseOrdersWindow","candidates":["emperor-palpatine","grand-moff-tarkin"]}` | src/engine/cinematicTactics.ts, src/engine/combat.ts, src/engine/mechanics.ts, src/engine/objectives.ts, src/engine/phases.ts |
| `cinematic-confrontation-choose` | — | `{"systemId":"naboo","candidates":["darth-vader"]}` | src/engine/cinematicTactics.ts |
| `cinematic-confrontation-eliminate` | — | `{"leaderId":"darth-vader"}` | src/engine/phases.ts |
| `cinematic-confrontation-mark` | — | `{"leaderId":"darth-vader","systemId":"naboo"}` | src/engine/combat.ts |
| `cinematic-confrontation-no-leader` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-deck-recycle` | — | `{"theater":"ground","kept":"cin-empire-ground-target-the-generator","recycled":7}` | src/engine/cinematicTactics.ts |
| `cinematic-escape-plan` | — | `{"theater":"ground","round":2}` | src/engine/combat.ts |
| `cinematic-escape-plan-cancel` | — | `{"cancelKey":"Empire:ground:2"}` | src/engine/combat.ts |
| `cinematic-prevent-applied` | — | `{"theater":"space","round":1,"red":1,"black":1}` | src/engine/combat.ts |
| `cinematic-remove-damage` | — | `{"theater":"ground","round":1,"removed":1}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-reroll` | — | `{"theater":"space","round":1,"rerolled":1,"allowance":1}` | src/engine/combat.ts |
| `cinematic-rogue-one-no-retreat` | — | `{"systemId":"kashyyyk"}` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-no-target` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-remove-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-rogue-one-rescue` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-shield-absorb` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-cancelled` | — | `{"theater":"space","round":1,"card":"cin-empire-space-swarm-tactics"}` | src/engine/combat.ts |
| `cinematic-tactic-locked` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-no-ability` | — | `{"theater":"space","round":3,"card":"cin-rebel-space-rogue-squadron-support"}` | src/engine/combat.ts |
| `cinematic-tactic-play` | — | `{"cardId":"cin-empire-space-reinforcements","ability":"primary","theater":"space","gained":"tie-fighter","prev` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-tactic-skip` | — | `{"theater":"ground","round":2}` | src/engine/combat.ts |
| `cinematic-tractor-beam-capture` | — | `{"leaderId":"wedge-antilles","systemId":"cato-neimoidia"}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `combat-action-card` | — | `{"card":"more-dangerous-than-you-realize"}` | src/engine/combat.ts |
| `combat-action-card-applied` | — | `{"card":"according-to-my-design","targetSide":"Rebel","theater":"space","round":1,"reducedRed":1,"reducedBlack` | src/engine/combat.ts |
| `combat-action-card-effect` | — | `{"card":"more-dangerous-than-you-realize","drew":["space-take-it-down","space-critical-hit","space-brilliant-s` | src/engine/combat.ts |
| `combat-action-card-not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-add-leader` | — | `{"leaderId":"darth-vader","tacticValue":5}` | src/engine/combat.ts |
| `combat-add-leader-declined` | — | `{}` | src/engine/combat.ts |
| `combat-attack` | One attack roll (theater, dice faces, attacker count). | `{"theater":"space","dice":[{"color":"black","face":"hit"}],"attackers":2}` | src/engine/combat.ts |
| `combat-begin` | Combat starts. A base assault also writes the base-assault snapshot. | `{"systemId":"ord-mantell","attackerSide":"Empire","cinematic":true}` | src/engine/combat.ts |
| `combat-blocks-removed` | RR p.5 step 4: after the attacker assigns every hit, the defender's blocks remove that many of the assigned damages (greedily, where they save a unit). | `{"theater":"space","blocks":1,"removed":1,"perUnit":{"s100026":1}}` | src/engine/combat.ts |
| `combat-draw-tactics` | — | `{"attackerHand":0,"defenderHand":0,"cinematic":true}` | src/engine/combat.ts |
| `combat-dsuc-destroyed` | — | `{"systemId":"dagobah","round":2,"reason":"only remaining Imperial ship was the Death Star Under Construction"}` | src/engine/combat.ts |
| `combat-end` | Combat over (rounds fought, winner). | `{"systemId":"ord-mantell","rounds":3,"winner":"Rebel"}` | src/engine/combat.ts |
| `combat-retreat` | Retreat executed (from/to, units, leader). | `{"from":"geonosis","to":"rodia","units":1,"leaderId":"darth-vader","stayedBehind":0,"ignoresTransport":false}` | src/engine/combat.ts |
| `combat-retreat-decline` | — | `{"systemId":"ord-mantell"}` | src/engine/combat.ts |
| `combat-retreat-unavailable` | A side was NOT offered the retreat window, and why (no leader in the system, nothing that can move itself out, a Death Star present, a tactic card, or no legal destination). Explanatory only — nothing branches on it. Written once per combat per distinct reason. | `{"systemId":"naboo","round":1,"reason":"None of your units here can leave on their own — retreating needs a sh` | src/engine/combat.ts |
| `combat-safety-abort` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-special-draw` | — | `{"card":"ground-critical-hit"}` | src/engine/combat.ts |
| `combat-stalemate-end` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-structure-destroy` | — | `{"systemId":"kashyyyk"}` | src/engine/combat.ts |
| `combat-structure-survive` | — | `{"systemId":"saleucami","round":2}` | src/engine/combat.ts |
| `combat-tactic` | — | `{"card":"space-critical-hit","bonusDamage":1}` | src/engine/combat.ts |
| `combat-tactic-effect` | — | `{"effect":"unstoppable-assault-prevents-block"}` | src/engine/combat.ts |
| `contingency-plan-applied` | — | `{"leaderId":"lando-calrissian","missionId":"build-alliance"}` | src/engine/phases.ts |
| `covert-operation-pick` | — | `{"drawn":["threaten-the-core-1","regional-support-1"],"kept":"threaten-the-core-1","bottomed":"regional-suppor` | src/engine/phases.ts |
| `death-star-completed` | — | `{"systemId":"dathomir","replacedUnit":"s100020"}` | src/engine/phases.ts |
| `death-star-plans-blocked-by-shield-bunker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-blocked-by-target-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-declined` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-miss` | — | `{"objectiveId":"death-star-plans-2","systemId":"dantooine","faces":["blank","hit","special"]}` | src/engine/combat.ts |
| `death-star-plans-success` | — | `{"objectiveId":"death-star-plans-2","systemId":"dantooine","destroyed":"u1000190","faces":["hit","direct-hit",` | src/engine/combat.ts |
| `deploy` | One built unit deployed to a system (id + typeId). | `{"typeId":"tie-fighter","systemId":"ord-mantell","unit":"u1000001"}` | src/engine/mechanics.ts |
| `deploy-declined-to-queue` | — | `{"typeId":"stormtrooper"}` | src/engine/phases.ts |
| `deploy-returned-to-queue` | — | `{"typeId":"rebel-transport","reason":"all-systems-at-deploy-cap"}` | src/engine/phases.ts |
| `destroy-system` | — | `{"systemId":"kashyyyk"}` | src/engine/mechanics.ts |
| `destroy-unit` | One unit destroyed (id + typeId + where + cause). | `{"unit":"s100044","typeId":"x-wing","systemId":"ord-mantell","cause":"combat"}` | src/engine/mechanics.ts |
| `destroy-up-to-health` | — | `{"card":"Ambush","killed":1,"totalHealth":2}` | src/engine/phases.ts |
| `destroyed-system-cull` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `destroyed-system-overflow` | — | `{"systemId":"kashyyyk","typeId":"stormtrooper","unit":"s100104"}` | src/engine/mechanics.ts |
| `detained-applied` | — | `{"leaderId":"jan-dodonna"}` | src/engine/phases.ts |
| `detained-refresh-skip` | — | `{"leaderIds":["jan-dodonna"]}` | src/engine/phases.ts |
| `discredit-rebellion-remove` | — | `{"systemIds":["corellia"],"removed":1}` | src/engine/phases.ts |
| `discredit-rebellion-roll` | — | `{"faces":["special"],"special":true,"diceCount":1}` | src/engine/phases.ts |
| `draw-action` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `draw-mission` | — | `{"count":2,"missionIds":["ignite-rebellion","rogue-squadron-raid"]}` | src/engine/mechanics.ts |
| `draw-objective` | — | `{"count":1,"objectiveIds":["cut-supply-lines-1"]}` | src/engine/mechanics.ts |
| `draw-probe` | — | `{"count":3,"probeIds":["probe-mustafar","probe-mon-calamari","probe-alderaan"]}` | src/engine/mechanics.ts |
| `draw-them-out` | — | `{"leaderId":"jyn-erso","systemId":"bespin","auto":true}` | src/engine/phases.ts |
| `dsuc-destroyed-cancels-build` | — | `{"slot":3}` | src/engine/mechanics.ts |
| `dsuc-replaced-by-death-star` | — | `{"systemId":"dagobah","removed":"s100001"}` | src/engine/mechanics.ts |
| `eliminate-leader` | — | `{"leaderId":"darth-vader"}` | src/engine/mechanics.ts |
| `establish-trade-relations` | — | `{"systemId":"toydaria","loyalty":1}` | src/engine/phases.ts |
| `falcon-applied` | — | `{"missionId":"build-alliance","targetSystemId":"mon-calamari","leaderId":"lando-calrissian","explanation":"Mil` | src/engine/phases.ts |
| `falcon-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `false-orders` | — | `{"targetLeaderId":"emperor-palpatine","missionId":"message-from-high-command"}` | src/engine/phases.ts |
| `gain-loyalty` | Loyalty gained at a system. | `{"systemId":"geonosis","newLoyalty":"rebel"}` | src/engine/mechanics.ts |
| `gain-reputation` | Rebel reputation advanced. | `{"newValue":13}` | src/engine/mechanics.ts |
| `game-over` | Terminal event: winner + reason. | `{"winner":"Empire","reason":"base-captured"}` | src/engine/mechanics.ts |
| `heist-draw-objective` | — | `{"systemId":"utapau"}` | src/engine/phases.ts |
| `hidden-fleet-move` | — | `{"targetSystemId":"coruscant","moved":1,"movedIds":["u1000023"]}` | src/engine/phases.ts |
| `homing-beacon-place` | — | `{"leaderId":"wedge-antilles","systemId":"geonosis","regionRevealed":3}` | src/engine/phases.ts |
| `immediate-objective-discarded` | — | `{"objectiveId":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `imperial-might-deploy` | — | `{"systemId":"dagobah","unitTypes":["star-destroyer","tie-fighter"],"auto":true}` | src/engine/phases.ts |
| `imperial-might-move-leaders` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `independent-operation-evac` | — | `{"fromSystemId":"mandalore","toSystemId":"corellia","moved":3}` | src/engine/phases.ts |
| `instance-id-heal` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `interrogation-droid-named-systems` | — | `{"named":["dagobah","kashyyyk","ryloth"],"note":"One of these contains the Rebel base."}` | src/engine/phases.ts |
| `invariant-violation` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `it-is-your-destiny-applied` | — | `{"capturedLeader":"jan-dodonna","explanation":"Vader captures a rescuer."}` | src/engine/phases.ts |
| `it-is-your-destiny-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lando-contingency-bonus-consumed` | — | `{"missionId":"build-alliance"}` | src/engine/phases.ts |
| `lead-strike-team-move` | — | `{"targetSystemId":"coruscant","unitsSent":4}` | src/engine/phases.ts |
| `leader-flipped` | — | `{"leaderId":"general-rieekan","newSide":"Empire"}` | src/engine/mechanics.ts |
| `leader-pool-cap-eliminate` | — | `{"leaderId":"mon-mothma","chosen":true}` | src/engine/phases.ts |
| `leader-retreat` | — | `{"leaderId":"darth-vader","from":"geonosis","to":"rodia"}` | src/engine/mechanics.ts |
| `liberated` | Subjugation removed. | `{"systemId":"ord-mantell"}` | src/engine/mechanics.ts |
| `local-rumors-reveal` | — | `{"systemId":"dantooine","region":5,"baseInRegion":true}` | src/engine/phases.ts |
| `lord-vader-s-orders-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lose-loyalty` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lose-reputation` | — | `{"newValue":15}` | src/engine/mechanics.ts |
| `loyalty-already` | — | `{"systemId":"geonosis","loyalty":"rebel"}` | src/engine/mechanics.ts |
| `loyalty-blocked` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lure-dark-side-pick` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `misdirection-set` | — | `{"leaderId":"obi-wan-kenobi"}` | src/engine/phases.ts |
| `mission-deck-reshuffled` | Rebel/Empire | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `mission-discard` | — | `{"missionId":"support-of-mon-calamari"}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-hand-trim` | — | `{"missionId":"display-of-power"}` | src/engine/phases.ts |
| `mission-return-to-hand` | — | `{"missionId":"sabotage"}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-roll` | Contested mission dice resolution. | `{"missionId":"support-of-mon-calamari","skill":"diplomacy","attacker":{"dice":2,"successes":2,"portrait":0,"la` | src/engine/phases.ts |
| `mission-unopposed` | Mission auto-succeeded unopposed. | `{"missionId":"sabotage","result":"auto-success"}` | src/engine/phases.ts |
| `move-unit` | One unit moved (self-contained: id + typeId + from/to). | `{"unit":"s100007","from":"mandalore","to":"kashyyyk"}` | src/engine/mechanics.ts |
| `noble-sacrifice-applied` | — | `{"explanation":"Noble Sacrifice — Obi-Wan eliminated for +1 reputation."}` | src/engine/phases.ts |
| `noble-sacrifice-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/log.ts |
| `note` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `notice` | — | `{"id":"lrp-bothawui-t5","title":"Long Range Probe"}` | src/engine/log.ts |
| `objective-check-not-met` | — | `{"objectives":[{"id":"defend-the-people-1","name":"Defend The People","rulesText":""},{"id":"cut-supply-lines-` | src/engine/phases.ts |
| `objective-declined` | — | `{"legal":["the-long-war-1"]}` | src/engine/phases.ts |
| `objective-immediate-no-target` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `objective-peek` | — | `{"looked":["the-long-war-1","defensive-position-1"],"kept":"the-long-war-1","keptRep":1,"bottomed":"defensive-` | src/engine/phases.ts |
| `objective-played` | — | `{"objectiveId":"crippling-blow-1","reputation":1,"timing":"Combat"}` | src/engine/combat.ts |
| `one-in-a-million-applied` | — | `{"context":"combat","theater":"space","picks":[{"index":2,"face":"direct-hit"},{"index":4,"face":"direct-hit"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-skipped` | — | `{"context":"combat"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-used` | — | `{"context":"dsplans","picks":[{"index":2,"face":"direct-hit"},{"index":1,"face":"direct-hit"}],"faces":["hit",` | src/engine/combat.ts |
| `our-most-desperate-hour-applied` | — | `{"missionId":"support-of-mon-calamari","leaderId":"princess-leia"}` | src/engine/phases.ts |
| `oversee-project-pick` | — | `{"typeId":"star-destroyer","slot":1,"targetSystemId":"mygeeto"}` | src/engine/phases.ts |
| `pass` | Command turn passed. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `phase` | Phase transition marker. | `{"phase":"Assignment","via":"setup-complete"}` | src/engine/phases.ts |
| `pick-rebel-base` | Rebel base location chosen at setup. | `{"systemId":"ord-mantell"}` | src/engine/phases.ts |
| `place-leader` | — | `{"leaderId":"princess-leia","systemId":"sullust"}` | src/engine/mechanics.ts |
| `plan-the-assault-move` | — | `{"targetSystemId":"dantooine","shipsSent":7}` | src/engine/phases.ts |
| `planetary-conquest-source` | — | `{"sourceSystemId":"alderaan","targetSystemId":"utapau","units":2}` | src/engine/phases.ts |
| `plant-false-lead` | — | `{"moved":4,"top":0,"bottom":4}` | src/engine/phases.ts |
| `play-objective` | — | `{"objectiveId":"regional-support-1","reputation":1}` | src/engine/phases.ts |
| `post-bounty-applied` | — | `{"leaderId":"jyn-erso","missionId":"critical-rescue"}` | src/engine/phases.ts |
| `post-bounty-rep-loss` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `post-bounty-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `prepare-for-battle-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `probe-removed-for-system` | — | `{"systemId":"dathomir","probeId":"probe-dathomir"}` | src/engine/mechanics.ts |
| `probe-state-repaired` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `proceeding-as-planned-applied` | — | `{"missionId":"construct-factory","leaderId":"admiral-ozzel"}` | src/engine/phases.ts |
| `project-draw` | — | `{"count":1,"drawn":["superlaser-online"]}` | src/engine/phases.ts |
| `project-peek` | — | `{"drawn":["construct-death-star","construct-super-star-destroyer"],"kept":"construct-super-star-destroyer","bo` | src/engine/phases.ts |
| `public-support-gain` | — | `{"systemId":"mygeeto","stormtroopers":3}` | src/engine/phases.ts |
| `public-uprising-pick` | — | `{"systemId":"alderaan","circle":"airspeeder","triangles":["rebel-trooper","rebel-trooper"]}` | src/engine/phases.ts |
| `r2d2-flip` | — | `{"context":"mission","systemId":"corellia","dieIndex":0,"flippedFrom":"special","empireSide":"attacker","expla` | src/engine/combat.ts, src/engine/phases.ts |
| `r2d2-skipped` | — | `{"context":"mission","systemId":"kashyyyk"}` | src/engine/combat.ts, src/engine/phases.ts |
| `raid-outposts-score` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `rapid-mobilization-base-declined` | — | `{}` | src/engine/phases.ts |
| `rapid-mobilization-base-established` | Base relocated via Rapid Mobilization. | `{"fromSystemId":"mustafar","toSystemId":"bothawui","baseRevealed":false,"wasRevealed":false}` | src/engine/phases.ts |
| `rapid-mobilization-base-no-legal-candidate` | — | `{"twoLeaders":false,"drawnCount":0}` | src/engine/phases.ts |
| `rapid-mobilization-move-applied` | — | `{"sourceSystemId":"mon-calamari","movedCount":4,"movedIds":["s100051","u1000021","u1000003","s100050"]}` | src/engine/phases.ts |
| `rapid-mobilization-old-base-probe-to-empire` | Old base probe card given to the Empire after relocation (LTP p.12). | `{"probeId":"probe-ryloth","systemId":"ryloth"}` | src/engine/phases.ts |
| `rapid-mobilization-probe-draw` | — | `{"count":4,"twoLeaders":false,"drawnProbeIds":["probe-dagobah","probe-bothawui","probe-geonosis","probe-yavin"` | src/engine/phases.ts |
| `rapid-mobilization-probes-to-bottom` | — | `{"count":4}` | src/engine/phases.ts |
| `rebel-cell-discard` | — | `{"discarded":"defend-the-people-1"}` | src/engine/phases.ts |
| `reconnaissance-recover` | — | `{"missionId":"base-defenses"}` | src/engine/phases.ts |
| `recruit-action-only` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `recruit-draw-another` | — | `{"drawn":"good-intel"}` | src/engine/phases.ts |
| `recruit-leader` | Leader recruited. | `{"leaderId":"lando-calrissian","cardId":"independent-operation"}` | src/engine/phases.ts |
| `recruit-pick-resolved` | — | `{"kept":"independent-operation","bottomed":["wookie-guardian"]}` | src/engine/phases.ts |
| `refresh-retrieve` | — | `{"leaderIds":["jan-dodonna","mon-mothma","general-rieekan","princess-leia"]}` | src/engine/phases.ts |
| `regional-aid-second` | — | `{"systemId":"kessel","targetSystemId":"toydaria"}` | src/engine/phases.ts |
| `remove-loyalty` | — | `{"systemId":"mygeeto","hiddenUnderSubjugation":true}` | src/engine/mechanics.ts |
| `rescue-leader` | — | `{"leaderId":"jan-dodonna","dest":"rebel-base-space","reason":"no-imperial-units"}` | src/engine/mechanics.ts |
| `rescuer-return` | — | `{"systemId":"corellia","returned":[],"stayed":["chirrut-imwe"]}` | src/engine/phases.ts |
| `retrieve-plans-applied` | — | `{"bottomed":"death-star-plans-3","revealedHand":["leave-no-one-behind-2","death-star-plans-3","establish-outpo` | src/engine/phases.ts |
| `return-leader` | — | `{"leaderId":"chewbacca"}` | src/engine/mechanics.ts |
| `return-of-the-jedi-eliminate` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `reveal-armed-card` | — | `{"cardId":"secret-facility","systemId":"endor","armedAt":3}` | src/engine/phases.ts |
| `reveal-armed-card-noop` | — | `{"cardId":"sweep-the-area","reason":"no-rebel-leader-here","systemId":"kashyyyk"}` | src/engine/phases.ts |
| `reveal-armed-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-base` | Rebel base revealed (followed by the base-reveal snapshot). | `{"reason":"auto","systemId":"ord-mantell"}` | src/engine/mechanics.ts |
| `reveal-mission` | Mission revealed at a target system. | `{"missionId":"sabotage","targetSystemId":"sullust","isAttempt":true}` | src/engine/phases.ts |
| `ring-attach` | — | `{"leaderId":"luke-skywalker","ring":"yoda"}` | src/engine/mechanics.ts |
| `ring-remove` | — | `{"leaderId":"luke-skywalker","ring":"yoda"}` | src/engine/mechanics.ts |
| `sabotage-destroy-bunker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-place-marker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-removed` | — | `{"systemId":"corellia"}` | src/engine/combat.ts, src/engine/phases.ts |
| `safe-haven-deploy` | — | `{"systemId":"saleucami","unitTypes":["mon-cala-cruiser","corellian-corvette"]}` | src/engine/phases.ts |
| `scouting-mission-relocate` | — | `{"targetSystemId":"bothawui","moved":4,"movedIds":["s100010","s100009","s100003","s100028"]}` | src/engine/phases.ts |
| `secret-facility-unit` | — | `{"systemId":"endor","typeId":"assault-tank"}` | src/engine/phases.ts |
| `secret-mission` | — | `{"kept":["heist","behind-enemy-lines"],"andor":true}` | src/engine/phases.ts |
| `setup` | Game seed + starting loyalty draw. The seed here is meta.seed in v2. | `{"seed":395101934,"rebelLoyalty":["bothawui","kashyyyk","ryloth"],"imperialLoyalty":["saleucami","mandalore","` | src/engine/setup.ts |
| `setup-auto-fill` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `setup-deploy` | One manually-placed setup unit (unit id included). Auto-filled units are NOT evented — read the setup-complete snapshot. | `{"typeId":"death-star-under-construction","systemId":"dagobah"}` | src/engine/phases.ts |
| `setup-undeploy` | — | `{"typeId":"stormtrooper","systemId":"rodia"}` | src/engine/phases.ts |
| `setup-warning` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `show-no-fear-revealed` | — | `{"systemId":"dantooine"}` | src/engine/phases.ts |
| `show-no-fear-score` | — | `{"reputation":1}` | src/engine/phases.ts |
| `skip-assignment` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `something-to-fight-for-applied` | — | `{"objectiveId":"leave-no-one-behind-2"}` | src/engine/combat.ts |
| `something-to-fight-for-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `son-of-skywalker-applied` | — | `{"pulledMissionId":"daring-rescue"}` | src/engine/phases.ts |
| `son-of-skywalker-skipped` | — | `{}` | src/engine/phases.ts |
| `start-evacuation-applied` | — | `{"targetSystemId":"mon-calamari","moved":7,"movedIds":["s100038","s100039","s100040","s100041","s100042","s100` | src/engine/phases.ts |
| `starting-card-draw` | — | `{"cardId":"start-the-evacuation","via":"rebel-extremist"}` | src/engine/phases.ts |
| `state` | Full board snapshot (codec string, turnLog-stripped). `at` says why: setup-complete / turn-start / base-reveal / base-assault. | `{"codec":"(full board snapshot, JSON codec string)","at":"setup-complete"}` | src/engine/combat.ts, src/engine/mechanics.ts, src/engine/phases.ts |
| `stolen-intel-discard` | — | `{"missionId":"seek-yoda"}` | src/engine/phases.ts |
| `stolen-plans-reorder` | — | `{"order":["death-star-plans-2","the-long-war-1","threaten-the-core-1","popular-support-2"],"deck":"objective"}` | src/engine/phases.ts |
| `subjugated` | System subjugated (Empire). | `{"systemId":"kashyyyk"}` | src/engine/mechanics.ts |
| `subjugation-cleared` | — | `{"systemId":"mygeeto","reason":"imperial-loyalty"}` | src/engine/mechanics.ts |
| `subversion-trigger` | — | `{"missionId":"subversion-new-rebel","leaderIds":["princess-leia"],"targetSystemId":"utapau"}` | src/engine/phases.ts |
| `superlaser-loyalty` | — | `{"systemId":"malastare","destroyedSystemId":"kashyyyk"}` | src/engine/phases.ts |
| `support-mon-cala-pick` | — | `{"option":"cruiser"}` | src/engine/phases.ts |
| `sweep-the-area-relocate` | — | `{"leaderId":"luke-skywalker-jedi","from":"dagobah","to":"sullust"}` | src/engine/phases.ts |
| `target-marker-place` | — | `{"systemId":"dantooine","source":"show-no-fear-3"}` | src/engine/mechanics.ts |
| `target-marker-remove` | — | `{"systemId":"dagobah","source":"secure-the-plans"}` | src/engine/mechanics.ts |
| `temporary-alliance-built` | — | `{"systemId":"ord-mantell","added":2,"picks":["corellian-corvette","airspeeder"]}` | src/engine/phases.ts |
| `the-long-war-discard` | — | `{"discarded":["death-star-plans-2","decisive-victory-1"]}` | src/engine/phases.ts |
| `track-them-applied` | — | `{"leaderId":"darth-vader","systemId":"saleucami"}` | src/engine/combat.ts |
| `track-them-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `unassign-leader` | — | `{"missionId":"capture-rebel-operative","leaderIds":["darth-vader"],"fromDeck":false}` | src/engine/phases.ts |
| `under-the-radar-keep` | — | `{"probeId":"probe-dantooine"}` | src/engine/phases.ts |
| `under-the-radar-keep-holding` | — | `{"probeId":"probe-dantooine"}` | src/engine/phases.ts |
| `under-the-radar-noop` | — | `{"reason":"empty-probe-deck"}` | src/engine/phases.ts |
| `under-the-radar-reorder` | — | `{"top":0,"bottom":3}` | src/engine/phases.ts |
| `under-the-radar-return` | — | `{"probeId":"probe-bothawui"}` | src/engine/phases.ts |
| `undercover-applied` | — | `{"leaderId":"lando-calrissian","targetSystemId":"mon-calamari"}` | src/engine/phases.ts |
| `undercover-skipped` | — | `{}` | src/engine/phases.ts |
| `were-the-bait` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `wookie-guardian-applied` | — | `{"missionId":"collect-bounty","explanation":"Chewbacca auto-stops the Empire special-ops mission."}` | src/engine/phases.ts |
| `wookie-guardian-skipped` | — | `{"missionId":"capture-rebel-operative"}` | src/engine/phases.ts |
| `yoda-reroll` | — | `{"context":"mission","holder":"princess-leia","holderName":"Princess Leia","systemId":"cato-neimoidia","color"` | src/engine/combat.ts, src/engine/phases.ts |
| `yoda-reroll-unavailable` | Yoda ring reroll not offered — already used this game round (#540 messaging). | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `yoda-skipped` | — | `{"context":"mission","systemId":"mandalore"}` | src/engine/combat.ts, src/engine/phases.ts |
