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

## Kinds (258)

| Kind | Description | Sample payload | Emitted from |
|---|---|---|---|
| `a-time-for-peace-destroy` | — | `{"destroyed":["x-wing","shield-generator","nebulon-b-frigate","y-wing"]}` | src/engine/phases.ts |
| `action-card-noop` | — | `{"cardId":"proceeding-as-planned","reason":"no-projects-in-deck"}` | src/engine/phases.ts |
| `action-card-play` | — | `{"cardId":"our-most-desperate-hour","leaderId":"princess-leia","systemId":null,"timing":"Assignment"}` | src/engine/phases.ts |
| `action-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `activate-system` | Leader activates a system; orders = source systems, unitsMoved = total units. | `{"leaderId":"jan-dodonna","targetSystemId":"saleucami","orders":1}` | src/engine/phases.ts |
| `advance-time` | Time marker advanced (start of a new turn; followed by the turn-start snapshot). | `{"newValue":2}` | src/engine/mechanics.ts |
| `aggressive-negotiations-fail-destroy` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `ai-decision` | AI Command decision trace: chosen action + score, top-5 alternatives, engine-rejected count, planner state when enabled. | `{"policy":"mcts","chose":{"kind":"activate","leaderId":"darth-vader","target":"naboo","score":36,"mc":0.9},"al` | src/play/mctsAI.ts, src/play/randomAI.ts |
| `ambitions-of-power-applied` | — | `{"newCap":9}` | src/engine/phases.ts |
| `ambitions-of-power-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `arm-card` | — | `{"cardId":"secret-facility","probeSystemId":"naboo","probeId":"probe-naboo"}` | src/engine/phases.ts |
| `arm-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `armed-reveal-declined` | — | `{"cardId":"sweep-the-area","systemId":"ord-mantell"}` | src/engine/phases.ts |
| `assign-leader` | — | `{"missionId":"stolen-plans","leaderIds":["princess-leia"]}` | src/engine/phases.ts |
| `auto-rescue` | — | `{"leaderId":"luke-skywalker","systemId":"corellia","reason":"no-imperial-units"}` | src/engine/mechanics.ts |
| `behind-enemy-lines` | — | `{"systemId":"mygeeto","moved":3}` | src/engine/phases.ts |
| `blindside-applied` | — | `{"missionId":"gather-intel"}` | src/engine/phases.ts |
| `blindside-skipped` | — | `{"missionId":"collect-bounty"}` | src/engine/phases.ts |
| `boba-block` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `break-their-will-probe` | — | `{"systemId":"endor","region":4,"baseInRegion":false}` | src/engine/phases.ts |
| `brilliant-administrator-built` | — | `{"systemId":"corellia","added":2,"picks":["tie-fighter","star-destroyer"]}` | src/engine/phases.ts |
| `build-from-icons` | — | `{"systemId":"corellia","label":"Establish Trade Relations","added":1,"picks":["x-wing",null]}` | src/engine/phases.ts |
| `build-queue` | Unit added to the build queue. | `{"typeId":"mon-cala-cruiser","slot":3,"sourceSystemId":"mon-calamari"}` | src/engine/mechanics.ts |
| `build-queue-advance` | — | `{"typeId":"death-star","fromSlot":3,"toSlot":2,"via":"double-our-efforts"}` | src/engine/phases.ts |
| `build-queue-destroy` | — | `{"slot":1,"typeId":"assault-carrier","via":"rogue-squadron-raid"}` | src/engine/phases.ts |
| `build-wasted-no-supply` | — | `{"sourceSystemId":"mon-calamari","slot":3,"iconType":"space","iconShape":"square","legalUnitTypes":["mon-cala-` | src/engine/phases.ts |
| `c3po-applied` | — | `{"missionId":"build-alliance","targetSystemId":"bespin","explanation":"C-3PO ring discarded — diplomacy failur` | src/engine/phases.ts |
| `c3po-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `capture-leader` | Leader captured (ring: captured/carbonite). | `{"leaderId":"lando-calrissian","ring":"captured","systemId":"naboo"}` | src/engine/mechanics.ts |
| `capture-operative-pick` | — | `{"leaderId":"han-solo"}` | src/engine/phases.ts |
| `carbonite-applied` | — | `{"leaderId":"general-rieekan","systemId":"mustafar"}` | src/engine/phases.ts |
| `catch-them-by-surprise-move` | — | `{"fromSystemId":"hoth","toSystemId":"endor","moved":5,"movedIds":["s100028","s100029","s100026","u1000064","s1` | src/engine/phases.ts |
| `choice-cancel` | — | `{"kind":"FalseOrdersWindow"}` | src/engine/phases.ts |
| `choice-request` | — | `{"kind":"FalseOrdersWindow","candidates":["emperor-palpatine"]}` | src/engine/cinematicTactics.ts, src/engine/combat.ts, src/engine/mechanics.ts, src/engine/objectives.ts, src/engine/phases.ts |
| `cinematic-confrontation-choose` | — | `{"systemId":"saleucami","candidates":["darth-vader"]}` | src/engine/cinematicTactics.ts |
| `cinematic-confrontation-eliminate` | — | `{"leaderId":"darth-vader"}` | src/engine/phases.ts |
| `cinematic-confrontation-mark` | — | `{"leaderId":"darth-vader","systemId":"saleucami"}` | src/engine/combat.ts |
| `cinematic-confrontation-no-leader` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-deck-recycle` | — | `{"theater":"ground","kept":"cin-empire-ground-armored-position","recycled":7}` | src/engine/cinematicTactics.ts |
| `cinematic-escape-plan` | — | `{"theater":"ground","round":2}` | src/engine/combat.ts |
| `cinematic-escape-plan-cancel` | — | `{"cancelKey":"Empire:ground:2"}` | src/engine/combat.ts |
| `cinematic-prevent-applied` | — | `{"theater":"space","round":2,"red":2,"black":0,"special":0}` | src/engine/combat.ts |
| `cinematic-remove-damage` | — | `{"theater":"space","round":1,"removed":1}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-reroll` | — | `{"theater":"space","round":1,"rerolled":2,"allowance":2}` | src/engine/combat.ts |
| `cinematic-rogue-one-no-retreat` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-no-target` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-remove-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-rogue-one-rescue` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-shield-absorb` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-cancelled` | — | `{"theater":"ground","round":1,"card":"cin-rebel-ground-hold-them-back"}` | src/engine/combat.ts |
| `cinematic-tactic-locked` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-no-ability` | — | `{"theater":"ground","round":3,"card":"cin-empire-ground-air-superiority"}` | src/engine/combat.ts |
| `cinematic-tactic-play` | — | `{"cardId":"cin-rebel-space-draw-their-fire","ability":"secondary","theater":"space","resolveFirst":"Empire"}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-tactic-skip` | — | `{"theater":"ground","round":2}` | src/engine/combat.ts |
| `cinematic-tractor-beam-capture` | — | `{"leaderId":"general-rieekan","systemId":"kashyyyk"}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `combat-action-card` | — | `{"card":"good-intel"}` | src/engine/combat.ts |
| `combat-action-card-applied` | — | `{"card":"according-to-my-design","targetSide":"Rebel","theater":"space","round":1,"reducedRed":1,"reducedBlack` | src/engine/combat.ts |
| `combat-action-card-effect` | — | `{"card":"good-intel","applied":"empire-chooses-tactic-after-rebel-reveals"}` | src/engine/combat.ts |
| `combat-action-card-not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-add-leader` | — | `{"leaderId":"darth-vader","tacticValue":5}` | src/engine/combat.ts |
| `combat-add-leader-declined` | — | `{}` | src/engine/combat.ts |
| `combat-attack` | One attack roll (theater, dice faces, attacker count). | `{"theater":"space","dice":[{"color":"red","face":"direct-hit"},{"color":"black","face":"special"},{"color":"bl` | src/engine/combat.ts |
| `combat-begin` | Combat starts. A base assault also writes the base-assault snapshot. | `{"systemId":"saleucami","attackerSide":"Rebel","cinematic":true}` | src/engine/combat.ts |
| `combat-blocks-removed` | RR p.5 step 4: after the attacker assigns every hit, the defender's blocks remove that many of the assigned damages (greedily, where they save a unit). | `{"theater":"space","blocks":1,"removed":1,"perUnit":{"s100014":1}}` | src/engine/combat.ts |
| `combat-draw-tactics` | — | `{"attackerHand":0,"defenderHand":0,"cinematic":true}` | src/engine/combat.ts |
| `combat-dsuc-destroyed` | — | `{"systemId":"dagobah","round":2,"reason":"only remaining Imperial ship was the Death Star Under Construction"}` | src/engine/combat.ts |
| `combat-end` | Combat over (rounds fought, winner). | `{"systemId":"saleucami","rounds":2,"winner":"Rebel"}` | src/engine/combat.ts |
| `combat-retreat` | Retreat executed (from/to, units, leader). | `{"from":"kashyyyk","to":"cato-neimoidia","units":6,"leaderId":"admiral-piett","stayedBehind":0,"ignoresTranspo` | src/engine/combat.ts |
| `combat-retreat-decline` | — | `{"systemId":"saleucami"}` | src/engine/combat.ts |
| `combat-safety-abort` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-special-draw` | — | `{"card":"space-critical-hit"}` | src/engine/combat.ts |
| `combat-stalemate-end` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-structure-destroy` | — | `{"systemId":"corellia"}` | src/engine/combat.ts |
| `combat-structure-survive` | — | `{"systemId":"naboo","round":1}` | src/engine/combat.ts |
| `combat-tactic` | — | `{"card":"space-concentrate-fire","rerolls":1}` | src/engine/combat.ts |
| `combat-tactic-effect` | — | `{"effect":"unstoppable-assault-prevents-block"}` | src/engine/combat.ts |
| `contingency-plan-applied` | — | `{"leaderId":"general-rieekan","missionId":"build-alliance"}` | src/engine/phases.ts |
| `covert-operation-pick` | — | `{"drawn":["death-star-plans-3","major-victory-3"],"kept":"major-victory-3","bottomed":"death-star-plans-3"}` | src/engine/phases.ts |
| `death-star-completed` | — | `{"systemId":"dagobah","replacedUnit":"s100055"}` | src/engine/phases.ts |
| `death-star-plans-blocked-by-shield-bunker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-blocked-by-target-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-declined` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-miss` | — | `{"objectiveId":"death-star-plans-3","systemId":"utapau","faces":["blank","hit","hit"]}` | src/engine/combat.ts |
| `death-star-plans-success` | — | `{"objectiveId":"death-star-plans-2","systemId":"malastare","destroyed":"s100189","faces":["blank","direct-hit"` | src/engine/combat.ts |
| `deploy` | One built unit deployed to a system (id + typeId). | `{"typeId":"tie-fighter","systemId":"saleucami","unit":"u1000001"}` | src/engine/mechanics.ts |
| `deploy-declined-to-queue` | — | `{"typeId":"rebel-vanguard"}` | src/engine/phases.ts |
| `deploy-returned-to-queue` | — | `{"typeId":"rebel-trooper","reason":"all-systems-at-deploy-cap"}` | src/engine/phases.ts |
| `destroy-system` | — | `{"systemId":"naboo"}` | src/engine/mechanics.ts |
| `destroy-unit` | One unit destroyed (id + typeId + where + cause). | `{"unit":"s100071","typeId":"assault-carrier","systemId":"saleucami","cause":"combat"}` | src/engine/mechanics.ts |
| `destroy-up-to-health` | — | `{"card":"Ambush","killed":3,"totalHealth":3}` | src/engine/phases.ts |
| `destroyed-system-cull` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `destroyed-system-overflow` | — | `{"systemId":"mustafar","typeId":"stormtrooper","unit":"s100006"}` | src/engine/mechanics.ts |
| `detained-applied` | — | `{"leaderId":"jan-dodonna"}` | src/engine/phases.ts |
| `detained-refresh-skip` | — | `{"leaderIds":["mon-mothma"]}` | src/engine/phases.ts |
| `discredit-rebellion-remove` | — | `{"systemIds":["cato-neimoidia","corellia"],"removed":2}` | src/engine/phases.ts |
| `discredit-rebellion-roll` | — | `{"faces":["special","hit"],"special":true,"diceCount":2}` | src/engine/phases.ts |
| `draw-action` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `draw-mission` | — | `{"count":2,"missionIds":["support-of-mon-calamari","lead-the-strike-team"]}` | src/engine/mechanics.ts |
| `draw-objective` | — | `{"count":1,"objectiveIds":["cut-supply-lines-1"]}` | src/engine/mechanics.ts |
| `draw-probe` | — | `{"count":1,"probeIds":["probe-mandalore"]}` | src/engine/mechanics.ts |
| `draw-them-out` | — | `{"leaderId":"jyn-erso","systemId":"bespin","auto":true}` | src/engine/phases.ts |
| `dsuc-destroyed-cancels-build` | — | `{"slot":3}` | src/engine/mechanics.ts |
| `dsuc-replaced-by-death-star` | — | `{"systemId":"dagobah","removed":"s101044"}` | src/engine/mechanics.ts |
| `eliminate-leader` | — | `{"leaderId":"darth-vader"}` | src/engine/mechanics.ts |
| `establish-trade-relations` | — | `{"systemId":"corellia","loyalty":1}` | src/engine/phases.ts |
| `falcon-applied` | — | `{"missionId":"build-alliance","targetSystemId":"mon-calamari","leaderId":"lando-calrissian","explanation":"Mil` | src/engine/phases.ts |
| `falcon-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `false-orders` | — | `{"targetLeaderId":"boba-fett","missionId":"gather-intel"}` | src/engine/phases.ts |
| `gain-loyalty` | Loyalty gained at a system. | `{"systemId":"utapau","newLoyalty":"rebel"}` | src/engine/mechanics.ts |
| `gain-reputation` | Rebel reputation advanced. | `{"newValue":13}` | src/engine/mechanics.ts |
| `game-over` | Terminal event: winner + reason. | `{"winner":"Rebel","reason":"reputation-time"}` | src/engine/mechanics.ts |
| `heist-draw-objective` | — | `{"systemId":"naboo"}` | src/engine/phases.ts |
| `hidden-fleet-move` | — | `{"targetSystemId":"dantooine","moved":9,"movedIds":["s100042","s100043","s100046","u1000049","s100049","s10005` | src/engine/phases.ts |
| `homing-beacon-place` | — | `{"leaderId":"mon-mothma","systemId":"felucia","regionRevealed":1}` | src/engine/phases.ts |
| `immediate-objective-discarded` | — | `{"objectiveId":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `imperial-might-deploy` | — | `{"systemId":"naboo","unitTypes":[],"auto":true}` | src/engine/phases.ts |
| `imperial-might-move-leaders` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `independent-operation-evac` | — | `{"fromSystemId":"utapau","toSystemId":"corellia","moved":5}` | src/engine/phases.ts |
| `instance-id-heal` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `interrogation-droid-named-systems` | — | `{"named":["alderaan","bespin","kessel"],"note":"One of these contains the Rebel base."}` | src/engine/phases.ts |
| `invariant-violation` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `it-is-your-destiny-applied` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `it-is-your-destiny-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lando-contingency-bonus-consumed` | — | `{"missionId":"build-alliance"}` | src/engine/phases.ts |
| `lead-strike-team-move` | — | `{"targetSystemId":"sullust","unitsSent":4}` | src/engine/phases.ts |
| `leader-flipped` | — | `{"leaderId":"jan-dodonna","newSide":"Empire"}` | src/engine/mechanics.ts |
| `leader-pool-cap-eliminate` | — | `{"leaderId":"janus-greejatus","chosen":true}` | src/engine/phases.ts |
| `leader-retreat` | — | `{"leaderId":"admiral-piett","from":"kashyyyk","to":"cato-neimoidia"}` | src/engine/mechanics.ts |
| `liberated` | Subjugation removed. | `{"systemId":"utapau"}` | src/engine/mechanics.ts |
| `local-rumors-reveal` | — | `{"systemId":"ord-mantell","region":5,"baseInRegion":false}` | src/engine/phases.ts |
| `lord-vader-s-orders-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lose-loyalty` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lose-reputation` | — | `{"newValue":15}` | src/engine/mechanics.ts |
| `loyalty-already` | — | `{"systemId":"kashyyyk","loyalty":"rebel"}` | src/engine/mechanics.ts |
| `loyalty-blocked` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lure-dark-side-pick` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `misdirection-set` | — | `{"leaderId":"han-solo"}` | src/engine/phases.ts |
| `mission-discard` | — | `{"missionId":"stolen-plans"}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-hand-trim` | — | `{"missionId":"stolen-intel"}` | src/engine/phases.ts |
| `mission-return-to-hand` | — | `{"missionId":"gather-intel","onFail":false}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-roll` | Contested mission dice resolution. | `{"missionId":"stolen-plans","skill":"intel","attacker":{"dice":2,"successes":3,"portrait":2,"landoBonus":0,"to` | src/engine/phases.ts |
| `mission-unopposed` | Mission auto-succeeded unopposed. | `{"missionId":"gather-intel","result":"auto-success"}` | src/engine/phases.ts |
| `move-unit` | One unit moved (self-contained: id + typeId + from/to). | `{"unit":"s100096","from":"mon-calamari","to":"saleucami"}` | src/engine/mechanics.ts |
| `noble-sacrifice-applied` | — | `{"explanation":"Noble Sacrifice — Obi-Wan eliminated for +1 reputation."}` | src/engine/phases.ts |
| `noble-sacrifice-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/log.ts |
| `note` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `notice` | — | `{"id":"lrp-dagobah-t8","title":"Long Range Probe"}` | src/engine/log.ts |
| `objective-check-not-met` | — | `{"objectives":[{"id":"defend-the-people-1","name":"Defend The People","rulesText":""}],"note":"StartOfRefresh ` | src/engine/phases.ts |
| `objective-declined` | — | `{"legal":["the-long-war-1"]}` | src/engine/phases.ts |
| `objective-immediate-no-target` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `objective-peek` | — | `{"looked":["rebel-assault-1","threaten-the-core-1"],"kept":"threaten-the-core-1","keptRep":1,"bottomed":"rebel` | src/engine/phases.ts |
| `objective-played` | — | `{"objectiveId":"rebel-assault-1","reputation":1,"timing":"Combat"}` | src/engine/combat.ts |
| `one-in-a-million-applied` | — | `{"context":"combat","theater":"space","picks":[{"index":0,"face":"direct-hit"},{"index":1,"face":"direct-hit"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-skipped` | — | `{"context":"combat"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-used` | — | `{"context":"dsplans","picks":[{"index":1,"face":"direct-hit"}],"faces":["blank","direct-hit","hit"]}` | src/engine/combat.ts |
| `our-most-desperate-hour-applied` | — | `{"missionId":"safe-haven","leaderId":"princess-leia"}` | src/engine/phases.ts |
| `oversee-project-pick` | — | `{"typeId":"death-star","slot":1,"targetSystemId":"cato-neimoidia"}` | src/engine/phases.ts |
| `pass` | Command turn passed. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `phase` | Phase transition marker. | `{"phase":"Assignment","via":"setup-complete"}` | src/engine/phases.ts |
| `pick-rebel-base` | Rebel base location chosen at setup. | `{"systemId":"mon-calamari"}` | src/engine/phases.ts |
| `place-leader` | — | `{"leaderId":"jan-dodonna","systemId":"saleucami"}` | src/engine/mechanics.ts |
| `plan-the-assault-move` | — | `{"targetSystemId":"alderaan","shipsSent":2}` | src/engine/phases.ts |
| `planetary-conquest-source` | — | `{"sourceSystemId":"ord-mantell","targetSystemId":"alderaan","units":3}` | src/engine/phases.ts |
| `plant-false-lead` | — | `{"moved":4,"top":4,"bottom":0}` | src/engine/phases.ts |
| `play-objective` | — | `{"objectiveId":"cut-supply-lines-1","reputation":1}` | src/engine/phases.ts |
| `post-bounty-applied` | — | `{"leaderId":"princess-leia","missionId":"build-alliance"}` | src/engine/phases.ts |
| `post-bounty-rep-loss` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `post-bounty-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `prepare-for-battle-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `probe-removed-for-system` | — | `{"systemId":"dagobah","probeId":"probe-dagobah"}` | src/engine/mechanics.ts |
| `probe-state-repaired` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `proceeding-as-planned-applied` | — | `{"missionId":"construct-death-star","leaderId":"moff-jerjerrod"}` | src/engine/phases.ts |
| `project-draw` | — | `{"count":1,"drawn":["interdictor-development"]}` | src/engine/phases.ts |
| `project-peek` | — | `{"drawn":["single-reactor-ignition","superlaser-online"],"kept":"single-reactor-ignition","bottomed":"superlas` | src/engine/phases.ts |
| `public-support-gain` | — | `{"systemId":"saleucami","stormtroopers":3}` | src/engine/phases.ts |
| `public-uprising-pick` | — | `{"systemId":"bespin","circle":"corellian-corvette","triangles":["rebel-trooper","rebel-trooper"]}` | src/engine/phases.ts |
| `r2d2-flip` | — | `{"context":"mission","systemId":"mon-calamari","dieIndex":0,"flippedFrom":"special","empireSide":"opposer","ex` | src/engine/combat.ts, src/engine/phases.ts |
| `r2d2-skipped` | — | `{"context":"mission","systemId":"mustafar"}` | src/engine/combat.ts, src/engine/phases.ts |
| `raid-outposts-score` | — | `{"systemId":"dagobah","reputation":1}` | src/engine/mechanics.ts |
| `rapid-mobilization-base-declined` | — | `{}` | src/engine/phases.ts |
| `rapid-mobilization-base-established` | Base relocated via Rapid Mobilization. | `{"fromSystemId":"utapau","toSystemId":"kashyyyk","baseRevealed":false,"wasRevealed":false}` | src/engine/phases.ts |
| `rapid-mobilization-base-no-legal-candidate` | — | `{"twoLeaders":false,"drawnCount":0}` | src/engine/phases.ts |
| `rapid-mobilization-move-applied` | — | `{"sourceSystemId":"mon-calamari","movedCount":3,"movedIds":["u1000002","u1000017","u1000018"]}` | src/engine/phases.ts |
| `rapid-mobilization-old-base-probe-to-empire` | Old base probe card given to the Empire after relocation (LTP p.12). | `{"probeId":"probe-felucia","systemId":"felucia"}` | src/engine/phases.ts |
| `rapid-mobilization-probe-draw` | — | `{"count":4,"twoLeaders":false,"drawnProbeIds":["probe-dantooine","probe-mandalore","probe-malastare","probe-to` | src/engine/phases.ts |
| `rapid-mobilization-probes-to-bottom` | — | `{"count":4}` | src/engine/phases.ts |
| `rebel-cell-discard` | — | `{"discarded":"decisive-victory-1"}` | src/engine/phases.ts |
| `reconnaissance-recover` | — | `{"missionId":"safe-haven"}` | src/engine/phases.ts |
| `recruit-action-only` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `recruit-draw-another` | — | `{"drawn":"baze-s-loyalty"}` | src/engine/phases.ts |
| `recruit-leader` | Leader recruited. | `{"leaderId":"han-solo","cardId":"the-milleninium-falcon"}` | src/engine/phases.ts |
| `recruit-pick-resolved` | — | `{"kept":"the-milleninium-falcon","bottomed":["noble-sacrifice"]}` | src/engine/phases.ts |
| `refresh-retrieve` | — | `{"leaderIds":["jan-dodonna","princess-leia","general-rieekan","mon-mothma"]}` | src/engine/phases.ts |
| `regional-aid-second` | — | `{"systemId":"cato-neimoidia","targetSystemId":"corellia"}` | src/engine/phases.ts |
| `remove-loyalty` | — | `{"systemId":"saleucami"}` | src/engine/mechanics.ts |
| `rescue-leader` | — | `{"leaderId":"luke-skywalker","dest":"rebel-base-space","reason":"no-imperial-units"}` | src/engine/mechanics.ts |
| `rescuer-return` | — | `{"systemId":"cato-neimoidia","returned":["jan-dodonna"],"stayed":[]}` | src/engine/phases.ts |
| `retrieve-plans-applied` | — | `{"bottomed":"the-long-war-1","revealedHand":["decisive-victory-1","threaten-the-core-1","the-long-war-1","deat` | src/engine/phases.ts |
| `return-leader` | — | `{"leaderId":"jyn-erso"}` | src/engine/mechanics.ts |
| `return-of-the-jedi-eliminate` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `reveal-armed-card` | — | `{"cardId":"secret-facility","systemId":"naboo","armedAt":3}` | src/engine/phases.ts |
| `reveal-armed-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-armed-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-base` | Rebel base revealed (followed by the base-reveal snapshot). | `{"reason":"auto","systemId":"kashyyyk"}` | src/engine/mechanics.ts |
| `reveal-mission` | Mission revealed at a target system. | `{"missionId":"stolen-plans","targetSystemId":"corellia","isAttempt":true}` | src/engine/phases.ts |
| `ring-attach` | — | `{"leaderId":"luke-skywalker","ring":"yoda"}` | src/engine/mechanics.ts |
| `ring-remove` | — | `{"leaderId":"luke-skywalker","ring":"yoda"}` | src/engine/mechanics.ts |
| `sabotage-destroy-bunker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-place-marker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-removed` | — | `{"systemId":"cato-neimoidia"}` | src/engine/combat.ts, src/engine/phases.ts |
| `safe-haven-deploy` | — | `{"systemId":"mandalore","unitTypes":["mon-cala-cruiser","mon-cala-cruiser"]}` | src/engine/phases.ts |
| `scouting-mission-relocate` | — | `{"targetSystemId":"coruscant","moved":4,"movedIds":["s100034","s100032","s100014","s100015"]}` | src/engine/phases.ts |
| `secret-facility-unit` | — | `{"systemId":"naboo","typeId":"assault-tank"}` | src/engine/phases.ts |
| `secret-mission` | — | `{"kept":["regional-aid"],"andor":false}` | src/engine/phases.ts |
| `setup` | Game seed + starting loyalty draw. The seed here is meta.seed in v2. | `{"seed":161991997,"rebelLoyalty":["naboo","kashyyyk","mon-calamari"],"imperialLoyalty":["sullust","corellia","` | src/engine/setup.ts |
| `setup-auto-fill` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `setup-deploy` | One manually-placed setup unit (unit id included). Auto-filled units are NOT evented — read the setup-complete snapshot. | `{"typeId":"corellian-corvette","systemId":"mon-calamari"}` | src/engine/phases.ts |
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
| `starting-card-draw` | — | `{"cardId":"more-dangerous-than-you-realize","via":"early-promotion"}` | src/engine/phases.ts |
| `state` | Full board snapshot (codec string, turnLog-stripped). `at` says why: setup-complete / turn-start / base-reveal / base-assault. | `{"codec":"(full board snapshot, JSON codec string)","at":"setup-complete"}` | src/engine/combat.ts, src/engine/mechanics.ts, src/engine/phases.ts |
| `stolen-intel-discard` | — | `{"missionId":"safe-haven"}` | src/engine/phases.ts |
| `stolen-plans-reorder` | — | `{"order":["cut-supply-lines-1","the-long-war-1","rebel-assault-1","threaten-the-core-1"],"deck":"objective"}` | src/engine/phases.ts |
| `subjugated` | System subjugated (Empire). | `{"systemId":"naboo"}` | src/engine/mechanics.ts |
| `subjugation-cleared` | — | `{"systemId":"cato-neimoidia","reason":"imperial-loyalty"}` | src/engine/mechanics.ts |
| `subversion-trigger` | — | `{"missionId":"subversion-original-rebel","leaderIds":["princess-leia"],"targetSystemId":"bothawui"}` | src/engine/phases.ts |
| `superlaser-loyalty` | — | `{"systemId":"utapau","destroyedSystemId":"naboo"}` | src/engine/phases.ts |
| `support-mon-cala-pick` | — | `{"option":"cruiser"}` | src/engine/phases.ts |
| `sweep-the-area-relocate` | — | `{"leaderId":"luke-skywalker-jedi","from":"dagobah","to":"sullust"}` | src/engine/phases.ts |
| `target-marker-place` | — | `{"systemId":"mon-calamari","source":"show-no-fear-3"}` | src/engine/mechanics.ts |
| `target-marker-remove` | — | `{"systemId":"ryloth","source":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `temporary-alliance-built` | — | `{"systemId":"ord-mantell","added":2,"picks":["corellian-corvette","golan-arms-turret"]}` | src/engine/phases.ts |
| `the-long-war-discard` | — | `{"discarded":["threaten-the-core-1","defend-the-people-1"]}` | src/engine/phases.ts |
| `track-them-applied` | — | `{"leaderId":"darth-vader","systemId":"saleucami"}` | src/engine/combat.ts |
| `track-them-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `unassign-leader` | — | `{"missionId":"build-alliance","leaderIds":["mon-mothma"],"fromDeck":false}` | src/engine/phases.ts |
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
| `yoda-reroll` | — | `{"context":"mission","holder":"luke-skywalker-jedi","holderName":"Luke Skywalker (Jedi)","systemId":"toydaria"` | src/engine/combat.ts, src/engine/phases.ts |
| `yoda-reroll-unavailable` | Yoda ring reroll not offered — already used this game round (#540 messaging). | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `yoda-skipped` | — | `{"context":"mission","systemId":"toydaria"}` | src/engine/combat.ts, src/engine/phases.ts |
