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

## Kinds (266)

| Kind | Description | Sample payload | Emitted from |
|---|---|---|---|
| `a-time-for-peace-destroy` | — | `{"destroyed":["mon-cala-cruiser","y-wing","corellian-corvette","rebel-trooper"]}` | src/engine/phases.ts |
| `action-card-noop` | — | `{"cardId":"proceeding-as-planned","reason":"no-projects-in-deck"}` | src/engine/phases.ts |
| `action-card-play` | — | `{"cardId":"early-promotion","leaderId":null,"systemId":null,"timing":"Immediate","viaStartingHand":true}` | src/engine/phases.ts |
| `action-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `action-deck-reshuffled` | Depleted action deck recycled its discard into a new deck (RR "Discarding", #657). The objective deck deliberately never does this — see the note on drawObjective. | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `activate-system` | Leader activates a system; orders = source systems, unitsMoved = total units. | `{"leaderId":"general-tagge","targetSystemId":"kashyyyk","orders":1,"unitsMoved":5}` | src/engine/phases.ts |
| `advance-time` | Time marker advanced (start of a new turn; followed by the turn-start snapshot). | `{"newValue":2}` | src/engine/mechanics.ts |
| `aggressive-negotiations-fail-destroy` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `ai-decision` | AI Command decision trace: chosen action + score, top-5 alternatives, engine-rejected count, planner state when enabled. | `{"chose":{"kind":"activate","leaderId":"darth-vader","target":"kashyyyk","score":42},"alts":[{"kind":"activate` | src/play/mctsAI.ts, src/play/randomAI.ts |
| `ambitions-of-power-applied` | — | `{"newCap":9}` | src/engine/phases.ts |
| `ambitions-of-power-skipped` | — | `{}` | src/engine/phases.ts |
| `arm-card` | — | `{"cardId":"secret-facility","probeSystemId":"kessel","probeId":"probe-kessel"}` | src/engine/phases.ts |
| `arm-card-blocked` | Refused to arm a one-of-a-kind card that was already armed or already spent to the discard (#656). Should never appear in a healthy game: if it does, the payload names the card and the current armed/discard contents, which identifies the path that was duplicating it. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `arm-card-noop` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `armed-reveal-already-spent` | Safety net (#644): a reveal was requested for an armed card that is no longer armed, so nothing happened. Should never appear in a healthy game — if it does, a stale reveal offer survived past the card being spent. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `armed-reveal-declined` | — | `{"cardId":"sweep-the-area","systemId":"kashyyyk"}` | src/engine/phases.ts |
| `assign-leader` | — | `{"missionId":"build-alliance","leaderIds":["mon-mothma"]}` | src/engine/phases.ts |
| `auto-rescue` | — | `{"leaderId":"jan-dodonna","systemId":"kashyyyk","reason":"no-imperial-units"}` | src/engine/mechanics.ts |
| `behind-enemy-lines` | — | `{"systemId":"ryloth","moved":1}` | src/engine/phases.ts |
| `blindside-applied` | — | `{"missionId":"gather-intel"}` | src/engine/phases.ts |
| `blindside-skipped` | — | `{"missionId":"gather-intel"}` | src/engine/phases.ts |
| `boba-block` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `break-their-will-probe` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `brilliant-administrator-built` | — | `{"systemId":"mon-calamari","added":2,"picks":["tie-striker","star-destroyer"]}` | src/engine/phases.ts |
| `build-from-icons` | — | `{"systemId":"ord-mantell","label":"Construct Factory","added":2,"picks":["assault-carrier","shield-bunker"]}` | src/engine/phases.ts |
| `build-queue` | Unit added to the build queue. | `{"typeId":"at-at","slot":2,"sourceSystemId":"sullust"}` | src/engine/mechanics.ts |
| `build-queue-advance` | — | `{"typeId":"death-star","fromSlot":3,"toSlot":2,"via":"double-our-efforts"}` | src/engine/phases.ts |
| `build-queue-destroy` | — | `{"slot":1,"typeId":"stormtrooper","via":"demolition"}` | src/engine/phases.ts |
| `build-wasted-no-supply` | — | `{"sourceSystemId":"mygeeto","slot":2,"iconType":"ground","iconShape":"square","legalUnitTypes":["at-at"]}` | src/engine/phases.ts |
| `c3po-applied` | — | `{"missionId":"build-alliance","targetSystemId":"rodia","explanation":"C-3PO ring discarded — diplomacy failure` | src/engine/phases.ts |
| `c3po-skipped` | — | `{"missionId":"safe-haven"}` | src/engine/phases.ts |
| `capture-leader` | Leader captured (ring: captured/carbonite). | `{"leaderId":"mon-mothma","ring":"captured","systemId":"toydaria"}` | src/engine/mechanics.ts |
| `capture-operative-pick` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `captured-leader-moved` | Empire | `{"leaderId":"jan-dodonna","fromSystemId":"ord-mantell","toSystemId":"mygeeto"}` | src/engine/phases.ts |
| `carbonite-applied` | — | `{"leaderId":"jan-dodonna","systemId":"mygeeto"}` | src/engine/phases.ts |
| `catch-them-by-surprise-move` | — | `{"fromSystemId":"saleucami","toSystemId":"kashyyyk","moved":6,"movedIds":["s100002","s100022","s100021","s1000` | src/engine/phases.ts |
| `choice-cancel` | — | `{"kind":"AssignSecondLeaderPick"}` | src/engine/phases.ts |
| `choice-request` | — | `{"kind":"StartingCardBranch","cardId":"early-promotion","canDraw":true}` | src/engine/cinematicTactics.ts, src/engine/combat.ts, src/engine/mechanics.ts, src/engine/objectives.ts, src/engine/phases.ts |
| `cinematic-confrontation-choose` | — | `{"systemId":"naboo","candidates":["darth-vader"]}` | src/engine/cinematicTactics.ts |
| `cinematic-confrontation-eliminate` | — | `{"leaderId":"darth-vader"}` | src/engine/phases.ts |
| `cinematic-confrontation-mark` | — | `{"leaderId":"darth-vader","systemId":"naboo"}` | src/engine/combat.ts |
| `cinematic-confrontation-no-leader` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-deck-recycle` | — | `{"theater":"ground","kept":"cin-empire-ground-target-the-generator","recycled":7}` | src/engine/cinematicTactics.ts |
| `cinematic-escape-plan` | — | `{"theater":"ground","round":2}` | src/engine/combat.ts |
| `cinematic-escape-plan-cancel` | — | `{"cancelKey":"Empire:ground:1"}` | src/engine/combat.ts |
| `cinematic-prevent-applied` | — | `{"theater":"ground","round":3,"red":0,"black":1,"directHit":0}` | src/engine/combat.ts |
| `cinematic-remove-damage` | — | `{"theater":"ground","round":1,"removed":1}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-reroll` | — | `{"theater":"space","round":1,"rerolled":2,"allowance":2,"before":["blank","blank"],"after":["blank","blank"],"` | src/engine/combat.ts |
| `cinematic-rogue-one-no-retreat` | — | `{"systemId":"kashyyyk"}` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-no-target` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-rogue-one-remove-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-rogue-one-rescue` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `cinematic-shield-absorb` | — | `{"theater":"ground","round":2,"absorbed":2,"structure":"shield-generator"}` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-cancelled` | — | `{"theater":"space","round":1,"card":"cin-empire-space-overwhelming-presence"}` | src/engine/combat.ts |
| `cinematic-tactic-locked` | — | `(not seen in corpus or sample game)` | src/engine/cinematicTactics.ts |
| `cinematic-tactic-no-ability` | — | `{"theater":"space","round":1,"card":"cin-rebel-space-bombing-run"}` | src/engine/combat.ts |
| `cinematic-tactic-play` | — | `{"cardId":"cin-rebel-space-fleet-logistics","ability":"secondary","theater":"space","prevent":{"red":2,"black"` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `cinematic-tactic-skip` | — | `{"theater":"ground","round":3}` | src/engine/combat.ts |
| `cinematic-tractor-beam-capture` | — | `{"leaderId":"jan-dodonna","systemId":"naboo"}` | src/engine/cinematicTactics.ts, src/engine/combat.ts |
| `combat-action-card` | — | `{"card":"ready-for-action"}` | src/engine/combat.ts |
| `combat-action-card-applied` | — | `{"card":"according-to-my-design","targetSide":"Rebel","theater":"space","round":1,"reducedRed":1,"reducedBlack` | src/engine/combat.ts |
| `combat-action-card-effect` | — | `{"card":"ready-for-action","placedLeader":"admiral-piett"}` | src/engine/combat.ts |
| `combat-action-card-not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-add-leader` | — | `{"leaderId":"jan-dodonna","tacticValue":3}` | src/engine/combat.ts |
| `combat-add-leader-declined` | — | `{}` | src/engine/combat.ts |
| `combat-attack` | One attack roll (theater, dice faces, attacker count). | `{"theater":"space","dice":[{"color":"red","face":"blank"},{"color":"black","face":"blank"}],"attackers":1}` | src/engine/combat.ts |
| `combat-begin` | Combat starts. A base assault also writes the base-assault snapshot. | `{"systemId":"mygeeto","attackerSide":"Rebel","cinematic":true}` | src/engine/combat.ts |
| `combat-blocks-removed` | RR p.5 step 4: after the attacker assigns every hit, the defender's blocks remove that many of the assigned damages (greedily, where they save a unit). | `{"theater":"space","blocks":1,"removed":1,"perUnit":{"s100026":1}}` | src/engine/combat.ts |
| `combat-draw-tactics` | — | `{"attackerHand":0,"defenderHand":0,"cinematic":true}` | src/engine/combat.ts |
| `combat-dsuc-destroyed` | — | `{"systemId":"dathomir","round":2,"reason":"only remaining Imperial ship was the Death Star Under Construction"` | src/engine/combat.ts |
| `combat-end` | Combat over (rounds fought, winner). | `{"systemId":"mygeeto","rounds":1,"winner":"Empire"}` | src/engine/combat.ts |
| `combat-retreat` | Retreat executed (from/to, units, leader). | `{"from":"mygeeto","to":"dantooine","units":1,"leaderId":"princess-leia","stayedBehind":0,"ignoresTransport":fa` | src/engine/combat.ts |
| `combat-retreat-decline` | — | `{"systemId":"nal-hutta"}` | src/engine/combat.ts |
| `combat-retreat-unavailable` | A side was NOT offered the retreat window, and why (no leader in the system, nothing that can move itself out, a Death Star present, a tactic card, or no legal destination). Explanatory only — nothing branches on it. Written once per combat per distinct reason. | `{"systemId":"mygeeto","round":1,"reason":"Retreating means marching a leader out of the system, and you have n` | src/engine/combat.ts |
| `combat-safety-abort` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-special-draw` | — | `{"card":"ground-concentrate-fire"}` | src/engine/combat.ts |
| `combat-stalemate-end` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `combat-structure-destroy` | — | `{"systemId":"tatooine"}` | src/engine/combat.ts |
| `combat-structure-survive` | — | `{"systemId":"mon-calamari","round":1}` | src/engine/combat.ts |
| `combat-tactic` | — | `{"card":"space-take-it-down","bonusDamage":2}` | src/engine/combat.ts |
| `combat-tactic-effect` | — | `{"effect":"unstoppable-assault-prevents-block"}` | src/engine/combat.ts |
| `contingency-plan-applied` | — | `{"leaderId":"cassian-andor","missionId":"build-alliance"}` | src/engine/phases.ts |
| `covert-operation-pick` | — | `{"drawn":["regional-support-1","rebel-assault-1"],"kept":"regional-support-1","bottomed":"rebel-assault-1"}` | src/engine/phases.ts |
| `death-star-completed` | — | `{"systemId":"tatooine","replacedUnit":"u1001895"}` | src/engine/phases.ts |
| `death-star-plans-blocked-by-shield-bunker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-blocked-by-target-marker` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-declined` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `death-star-plans-miss` | — | `{"objectiveId":"death-star-plans-2","systemId":"dagobah","faces":["blank","special","blank"]}` | src/engine/combat.ts |
| `death-star-plans-success` | — | `{"objectiveId":"death-star-plans-2","systemId":"geonosis","destroyed":"u1002005","faces":["hit","direct-hit","` | src/engine/combat.ts |
| `deploy` | One built unit deployed to a system (id + typeId). | `{"typeId":"corellian-corvette","systemId":"mygeeto","unit":"u1001701"}` | src/engine/mechanics.ts |
| `deploy-declined-to-queue` | — | `{"typeId":"at-at"}` | src/engine/phases.ts |
| `deploy-returned-to-queue` | — | `{"typeId":"x-wing","reason":"all-systems-at-deploy-cap"}` | src/engine/phases.ts |
| `destroy-system` | — | `{"systemId":"endor"}` | src/engine/mechanics.ts |
| `destroy-unit` | One unit destroyed (id + typeId + where + cause). | `{"unit":"s100365","typeId":"stormtrooper","systemId":"mygeeto","cause":"cinematic-destroy"}` | src/engine/mechanics.ts |
| `destroy-up-to-health` | — | `{"card":"Hit And Run","killed":1,"totalHealth":2}` | src/engine/phases.ts |
| `destroyed-system-cull` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `destroyed-system-overflow` | — | `{"systemId":"kashyyyk","typeId":"stormtrooper","unit":"s100104"}` | src/engine/mechanics.ts |
| `detained-applied` | — | `{"leaderId":"jan-dodonna"}` | src/engine/phases.ts |
| `detained-refresh-skip` | — | `{"leaderIds":["jan-dodonna"]}` | src/engine/phases.ts |
| `discredit-rebellion-remove` | — | `{"systemIds":["toydaria"],"removed":1}` | src/engine/phases.ts |
| `discredit-rebellion-roll` | — | `{"faces":["special"],"special":true,"diceCount":1}` | src/engine/phases.ts |
| `draw-action` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `draw-mission` | — | `{"count":2,"missionIds":["wookie-uprising","public-uprising"]}` | src/engine/mechanics.ts |
| `draw-objective` | — | `{"count":1,"objectiveIds":["support-of-the-hutts-1"]}` | src/engine/mechanics.ts |
| `draw-probe` | — | `{"count":2,"probeIds":["probe-naboo","probe-nal-hutta"]}` | src/engine/mechanics.ts |
| `draw-them-out` | — | `{"leaderId":"jyn-erso","systemId":"bespin","auto":true}` | src/engine/phases.ts |
| `dsuc-destroyed-cancels-build` | — | `{"slot":1}` | src/engine/mechanics.ts |
| `dsuc-replaced-by-death-star` | — | `{"systemId":"dagobah","removed":"s100001"}` | src/engine/mechanics.ts |
| `eliminate-leader` | — | `{"leaderId":"darth-vader"}` | src/engine/mechanics.ts |
| `establish-trade-relations` | — | `{"systemId":"utapau","loyalty":1}` | src/engine/phases.ts |
| `falcon-applied` | — | `{"missionId":"infiltration","targetSystemId":"kashyyyk","leaderId":"princess-leia","bearer":"han-solo","explan` | src/engine/phases.ts |
| `falcon-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `false-orders` | — | `{"targetLeaderId":"emperor-palpatine","missionId":"imperial-propaganda"}` | src/engine/phases.ts |
| `gain-loyalty` | Loyalty gained at a system. | `{"systemId":"nal-hutta","newLoyalty":"rebel"}` | src/engine/mechanics.ts |
| `gain-reputation` | Rebel reputation advanced. | `{"newValue":13}` | src/engine/mechanics.ts |
| `game-over` | Terminal event: winner + reason. | `{"winner":"Empire","reason":"base-captured"}` | src/engine/mechanics.ts, src/engine/phases.ts |
| `heist-draw-objective` | — | `{"systemId":"bespin"}` | src/engine/phases.ts |
| `hidden-fleet-move` | — | `{"targetSystemId":"cato-neimoidia","moved":1,"movedIds":["u1002004"]}` | src/engine/phases.ts |
| `homing-beacon-place` | — | `{"leaderId":"mon-mothma","systemId":"felucia","regionRevealed":1}` | src/engine/phases.ts |
| `immediate-objective-discarded` | — | `{"objectiveId":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `imperial-might-deploy` | — | `{"systemId":"dagobah","unitTypes":["star-destroyer","tie-fighter"],"auto":true}` | src/engine/phases.ts |
| `imperial-might-move-leaders` | — | `{"leaderIds":["moff-jerjerrod","admiral-ozzel"]}` | src/engine/phases.ts |
| `independent-operation-evac` | — | `{"fromSystemId":"bothawui","toSystemId":"corellia","moved":7}` | src/engine/phases.ts |
| `instance-id-heal` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `interrogation-droid-named-systems` | — | `{"named":["dagobah","cato-neimoidia","dathomir"],"note":"One of these contains the Rebel base."}` | src/engine/phases.ts |
| `invariant-violation` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `ion-cannon-applied` | Rebel Ion Cannon structure cut the opponent's red dice for one space battle step (faction sheet: "your opponent rolls 2 fewer red dice"). `reducedRed` is the actual cut after flooring at the attacker's red pool; multiple cannons stack (#736). | `{"systemId":"nal-hutta","targetSide":"Empire","round":1,"reducedRed":2}` | src/engine/combat.ts |
| `it-is-your-destiny-applied` | — | `{"capturedLeader":"princess-leia","explanation":"Vader captures a rescuer."}` | src/engine/phases.ts |
| `it-is-your-destiny-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lando-contingency-bonus-consumed` | — | `{"missionId":"build-alliance"}` | src/engine/phases.ts |
| `lead-strike-team-move` | — | `{"targetSystemId":"dathomir","unitsSent":4}` | src/engine/phases.ts |
| `leader-flipped` | — | `{"leaderId":"mon-mothma","newSide":"Empire"}` | src/engine/mechanics.ts |
| `leader-pool-cap-eliminate` | — | `{"leaderId":"mon-mothma","chosen":true}` | src/engine/phases.ts |
| `leader-retreat` | — | `{"leaderId":"princess-leia","from":"mygeeto","to":"dantooine"}` | src/engine/mechanics.ts |
| `liberated` | Subjugation removed. | `{"systemId":"mygeeto"}` | src/engine/mechanics.ts |
| `local-rumors-reveal` | — | `{"systemId":"mandalore","region":6,"baseInRegion":false}` | src/engine/phases.ts |
| `lord-vader-s-orders-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `lose-loyalty` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lose-reputation` | — | `{"newValue":12}` | src/engine/mechanics.ts |
| `loyalty-already` | — | `{"systemId":"kashyyyk","loyalty":"rebel"}` | src/engine/mechanics.ts |
| `loyalty-blocked` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `lure-dark-side-pick` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `misdirection-set` | — | `{"leaderId":"han-solo"}` | src/engine/phases.ts |
| `mission-deck-reshuffled` | Rebel/Empire | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `mission-discard` | — | `{"missionId":"public-uprising"}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-hand-trim` | — | `{"missionId":"secret-weapons-research"}` | src/engine/phases.ts |
| `mission-return-to-hand` | — | `{"missionId":"build-alliance","onFail":false}` | src/engine/combat.ts, src/engine/phases.ts |
| `mission-roll` | Contested mission dice resolution. | `{"missionId":"build-alliance","skill":"diplomacy","attacker":{"dice":3,"successes":4,"portrait":0,"landoBonus"` | src/engine/phases.ts |
| `mission-unopposed` | Mission auto-succeeded unopposed. | `{"missionId":"public-uprising","result":"auto-success"}` | src/engine/phases.ts |
| `move-unit` | One unit moved (self-contained: id + typeId + from/to). | `{"unit":"u1001701","typeId":"corellian-corvette","from":"mygeeto","to":"dantooine"}` | src/engine/mechanics.ts |
| `noble-sacrifice-applied` | — | `{"explanation":"Noble Sacrifice — Obi-Wan eliminated for +1 reputation."}` | src/engine/phases.ts |
| `noble-sacrifice-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `not-implemented` | — | `(not seen in corpus or sample game)` | src/engine/log.ts |
| `note` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `notice` | — | `{"id":"rapid-mobilization-queued-t1-1","title":"Rapid Mobilization — queued"}` | src/engine/log.ts |
| `objective-check-not-met` | — | `{"objectives":[{"id":"support-of-the-hutts-1","name":"Support of the Hutts","rulesText":""}],"note":"StartOfRe` | src/engine/phases.ts |
| `objective-declined` | — | `{"legal":["the-long-war-1"]}` | src/engine/phases.ts |
| `objective-immediate-no-target` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `objective-peek` | — | `{"looked":["heart-of-the-empire-2","a-time-for-peace-2"],"kept":"heart-of-the-empire-2","keptRep":2,"bottomed"` | src/engine/phases.ts |
| `objective-played` | — | `{"objectiveId":"liberation-2","reputation":1,"timing":"Combat"}` | src/engine/combat.ts |
| `one-in-a-million-applied` | — | `{"context":"combat","theater":"ground","picks":[{"index":1,"face":"direct-hit"},{"index":2,"face":"direct-hit"` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-skipped` | — | `{"context":"combat"}` | src/engine/combat.ts, src/engine/phases.ts |
| `one-in-a-million-used` | — | `{"context":"dsplans","picks":[{"index":2,"face":"direct-hit"},{"index":1,"face":"direct-hit"}],"faces":["hit",` | src/engine/combat.ts |
| `our-most-desperate-hour-applied` | — | `{"missionId":"support-of-mon-calamari","leaderId":"princess-leia"}` | src/engine/phases.ts |
| `oversee-project-pick` | — | `{"typeId":"super-star-destroyer","slot":1,"targetSystemId":"bothawui"}` | src/engine/phases.ts |
| `pass` | Command turn passed. | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `phase` | Phase transition marker. | `{"phase":"Assignment","via":"setup-complete"}` | src/engine/phases.ts |
| `pick-rebel-base` | Rebel base location chosen at setup. | `{"systemId":"ryloth"}` | src/engine/phases.ts |
| `place-leader` | — | `{"leaderId":"motti","systemId":"mustafar"}` | src/engine/mechanics.ts |
| `plan-the-assault-move` | — | `{"targetSystemId":"mygeeto","shipsSent":5}` | src/engine/phases.ts |
| `planetary-conquest-source` | — | `{"sourceSystemId":"mandalore","targetSystemId":"ryloth","units":2}` | src/engine/phases.ts |
| `plant-false-lead` | — | `{"moved":4,"top":0,"bottom":4}` | src/engine/phases.ts |
| `play-objective` | — | `{"objectiveId":"support-of-the-hutts-1","reputation":1}` | src/engine/phases.ts |
| `post-bounty-applied` | — | `{"leaderId":"general-rieekan","missionId":"ignite-rebellion"}` | src/engine/phases.ts |
| `post-bounty-rep-loss` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `post-bounty-skipped` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `prepare-for-battle-peek` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `probe-removed-for-system` | — | `{"systemId":"hoth","probeId":"probe-hoth"}` | src/engine/mechanics.ts |
| `probe-state-repaired` | — | `(not seen in corpus or sample game)` | src/engine/mechanics.ts |
| `proceeding-as-planned-applied` | — | `{"missionId":"construct-death-star","leaderId":"admiral-ozzel"}` | src/engine/phases.ts |
| `project-draw` | — | `{"count":1,"drawn":["construct-factory"]}` | src/engine/phases.ts |
| `project-peek` | — | `{"drawn":["superlaser-online","construct-super-star-destroyer"],"kept":"superlaser-online","bottomed":"constru` | src/engine/phases.ts |
| `public-support-gain` | — | `{"systemId":"bespin","stormtroopers":3}` | src/engine/phases.ts |
| `public-uprising-pick` | — | `{"systemId":"mygeeto","circle":"corellian-corvette","triangles":["rebel-trooper","rebel-trooper"]}` | src/engine/phases.ts |
| `r2d2-flip` | — | `{"systemId":"dagobah","theater":"space","dieIndex":2,"flippedFrom":"special","explanation":"R2-D2 ring discard` | src/engine/combat.ts, src/engine/phases.ts |
| `r2d2-skipped` | — | `{"context":"mission","systemId":"mon-calamari"}` | src/engine/combat.ts, src/engine/phases.ts |
| `raid-outposts-score` | — | `{"systemId":"dantooine","reputation":1}` | src/engine/mechanics.ts |
| `rapid-mobilization-base-declined` | — | `{}` | src/engine/phases.ts |
| `rapid-mobilization-base-established` | Base relocated via Rapid Mobilization. | `{"fromSystemId":"ryloth","toSystemId":"dathomir","baseRevealed":false,"wasRevealed":true}` | src/engine/phases.ts |
| `rapid-mobilization-base-no-legal-candidate` | — | `{"twoLeaders":false,"drawnCount":4}` | src/engine/phases.ts |
| `rapid-mobilization-move-applied` | — | `{"sourceSystemId":"alderaan","movedCount":0,"movedIds":[]}` | src/engine/phases.ts |
| `rapid-mobilization-old-base-probe-to-empire` | Old base probe card given to the Empire after relocation (LTP p.12). | `{"probeId":"probe-ryloth","systemId":"ryloth"}` | src/engine/phases.ts |
| `rapid-mobilization-probe-draw` | — | `{"count":4,"twoLeaders":false,"drawnProbeIds":["probe-ilum","probe-corellia","probe-kessel","probe-yavin"]}` | src/engine/phases.ts |
| `rapid-mobilization-probes-to-bottom` | — | `{"count":4}` | src/engine/phases.ts |
| `rebel-cell-discard` | — | `{"discarded":"popular-support-2"}` | src/engine/phases.ts |
| `reconnaissance-recover` | — | `{"missionId":"misdirection"}` | src/engine/phases.ts |
| `recruit-action-only` | — | `{"cardId":"baze-s-loyalty"}` | src/engine/phases.ts |
| `recruit-draw-another` | — | `{"drawn":"good-intel"}` | src/engine/phases.ts |
| `recruit-leader` | Leader recruited. | `{"leaderId":"motti","via":"early-promotion"}` | src/engine/phases.ts |
| `recruit-pick-resolved` | — | `{"kept":"he-means-well","bottomed":["ambush"]}` | src/engine/phases.ts |
| `refresh-retrieve` | — | `{"leaderIds":["jan-dodonna","princess-leia","mon-mothma","general-rieekan"]}` | src/engine/phases.ts |
| `regional-aid-second` | — | `{"systemId":"felucia","targetSystemId":"saleucami"}` | src/engine/phases.ts |
| `remove-loyalty` | — | `{"systemId":"kessel"}` | src/engine/mechanics.ts |
| `rescue-leader` | — | `{"leaderId":"jan-dodonna","dest":"toydaria","reason":"aggressive-negotiations"}` | src/engine/mechanics.ts |
| `rescuer-return` | — | `{"systemId":"naboo","returned":["princess-leia"],"stayed":[]}` | src/engine/phases.ts |
| `resignation` | AI side | `{ winner, reasons }` — the AI offered to resign (#677) and the human accepted; `reasons` is the hopelessness detector's explanation (e.g. `no-force-left`, `cannot-reach-base-in-time`). Always followed by a `game-over` with reason `resignation`. | src/engine/phases.ts |
| `retrieve-plans-applied` | — | `{"bottomed":"death-star-plans-2","revealedHand":["death-star-plans-2","seize-control-2","popular-support-2"]}` | src/engine/phases.ts |
| `return-leader` | — | `{"leaderId":"admiral-piett"}` | src/engine/mechanics.ts |
| `return-of-the-jedi-eliminate` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `reveal-armed-card` | — | `{"cardId":"secret-facility","systemId":"kessel","armedAt":2}` | src/engine/phases.ts |
| `reveal-armed-card-noop` | — | `{"cardId":"sweep-the-area","reason":"no-rebel-leader-here","systemId":"kashyyyk"}` | src/engine/phases.ts |
| `reveal-armed-card-unknown` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `reveal-base` | Rebel base revealed (followed by the base-reveal snapshot). | `{"reason":"auto","systemId":"ryloth"}` | src/engine/mechanics.ts |
| `reveal-mission` | Mission revealed at a target system. | `{"missionId":"public-uprising","targetSystemId":"mygeeto","isAttempt":true}` | src/engine/phases.ts |
| `ring-attach` | — | `{"leaderId":"jan-dodonna","ring":"k2so"}` | src/engine/mechanics.ts |
| `ring-remove` | — | `{"leaderId":"mon-mothma","ring":"c3po"}` | src/engine/mechanics.ts |
| `sabotage-destroy-bunker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-place-marker` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `sabotage-removed` | — | `{"systemId":"kessel"}` | src/engine/combat.ts, src/engine/phases.ts |
| `safe-haven-deploy` | — | `{"systemId":"utapau","unitTypes":["mon-cala-cruiser","corellian-corvette"]}` | src/engine/phases.ts |
| `scouting-mission-relocate` | — | `{"targetSystemId":"coruscant","moved":4,"movedIds":["s100034","s100032","s100014","s100015"]}` | src/engine/phases.ts |
| `secret-facility-unit` | — | `{"systemId":"kessel","typeId":"assault-tank"}` | src/engine/phases.ts |
| `secret-mission` | — | `{"kept":["regional-aid"],"andor":false}` | src/engine/phases.ts |
| `setup` | Game seed + starting loyalty draw. The seed here is meta.seed in v2. | `{"seed":898436532,"rebelLoyalty":["kashyyyk","naboo","ryloth"],"imperialLoyalty":["mustafar","mygeeto","sullus` | src/engine/setup.ts |
| `setup-auto-fill` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `setup-deploy` | One manually-placed setup unit (unit id included). Auto-filled units are NOT evented — read the setup-complete snapshot. | `{"typeId":"death-star","systemId":"mandalore","unit":"s100358"}` | src/engine/phases.ts |
| `setup-undeploy` | — | `{"typeId":"at-at","systemId":"corellia"}` | src/engine/phases.ts |
| `setup-warning` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `show-no-fear-revealed` | — | `{"systemId":"mon-calamari"}` | src/engine/phases.ts |
| `show-no-fear-score` | — | `{"reputation":1}` | src/engine/phases.ts |
| `skip-assignment` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `something-to-fight-for-applied` | — | `{"objectiveId":"death-star-plans-2"}` | src/engine/combat.ts |
| `something-to-fight-for-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `son-of-skywalker-applied` | — | `{"pulledMissionId":"seek-yoda"}` | src/engine/phases.ts |
| `son-of-skywalker-skipped` | — | `{}` | src/engine/phases.ts |
| `start-evacuation-applied` | — | `{"targetSystemId":"mon-calamari","moved":7,"movedIds":["s100038","s100039","s100040","s100041","s100042","s100` | src/engine/phases.ts |
| `starting-card-draw` | — | `{"cardId":"brilliant-administrator","via":"early-promotion"}` | src/engine/phases.ts |
| `state` | Full board snapshot (codec string, turnLog-stripped). `at` says why: setup-complete / turn-start / base-reveal / base-assault. | `{"codec":"(full board snapshot, JSON codec string)","at":"setup-complete"}` | src/engine/combat.ts, src/engine/mechanics.ts, src/engine/phases.ts |
| `stolen-intel-discard` | — | `{"missionId":"misdirection"}` | src/engine/phases.ts |
| `stolen-plans-reorder` | — | `{"order":["death-star-plans-2","heart-of-the-empire-2","a-time-for-peace-2","liberation-2"],"deck":"objective"` | src/engine/phases.ts |
| `subjugated` | System subjugated (Empire). | `{"systemId":"kashyyyk"}` | src/engine/mechanics.ts |
| `subjugation-cleared` | — | `{"systemId":"naboo","reason":"imperial-loyalty"}` | src/engine/mechanics.ts |
| `subversion-trigger` | — | `{"missionId":"subversion-original","leaderIds":["jabba"],"targetSystemId":"toydaria"}` | src/engine/phases.ts |
| `superlaser-loyalty` | — | `{"systemId":"bespin","destroyedSystemId":"endor"}` | src/engine/phases.ts |
| `support-mon-cala-pick` | — | `{"option":"cruiser"}` | src/engine/phases.ts |
| `sweep-the-area-relocate` | — | `{"leaderId":"admiral-ackbar","from":"kashyyyk","to":"cato-neimoidia"}` | src/engine/phases.ts |
| `target-marker-place` | — | `{"systemId":"mon-calamari","source":"rebel-cell-2"}` | src/engine/mechanics.ts |
| `target-marker-remove` | — | `{"systemId":"dagobah","source":"secure-the-plans"}` | src/engine/mechanics.ts |
| `temporary-alliance-built` | — | `{"systemId":"ord-mantell","added":2,"picks":["corellian-corvette","airspeeder"]}` | src/engine/phases.ts |
| `the-long-war-discard` | — | `{"discarded":["decisive-victory-1","crippling-blow-1"]}` | src/engine/phases.ts |
| `track-them-applied` | — | `{"leaderId":"boba-fett","systemId":"mon-calamari"}` | src/engine/combat.ts |
| `track-them-skipped` | — | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `unassign-leader` | — | `{"missionId":"superlaser-online","leaderIds":["admiral-ozzel"],"fromDeck":false}` | src/engine/phases.ts |
| `under-the-radar-keep` | — | `{"probeId":"probe-bothawui"}` | src/engine/phases.ts |
| `under-the-radar-keep-holding` | — | `{"probeId":"probe-bothawui"}` | src/engine/phases.ts |
| `under-the-radar-noop` | — | `{"reason":"empty-probe-deck"}` | src/engine/phases.ts |
| `under-the-radar-reorder` | — | `{"top":0,"bottom":3}` | src/engine/phases.ts |
| `under-the-radar-return` | — | `{"probeId":"probe-bothawui"}` | src/engine/phases.ts |
| `undercover-applied` | — | `{"leaderId":"lando-calrissian","targetSystemId":"mon-calamari"}` | src/engine/phases.ts |
| `undercover-skipped` | — | `{}` | src/engine/phases.ts |
| `were-the-bait` | — | `(not seen in corpus or sample game)` | src/engine/phases.ts |
| `wookie-guardian-applied` | — | `{"missionId":"collect-bounty","explanation":"Chewbacca auto-stops the Empire special-ops mission."}` | src/engine/phases.ts |
| `wookie-guardian-skipped` | — | `{"missionId":"capture-rebel-operative"}` | src/engine/phases.ts |
| `yoda-reroll` | — | `{"holder":"luke-skywalker-jedi","systemId":"mandalore","color":"red","oldFace":"blank","newFace":"blank"}` | src/engine/combat.ts, src/engine/phases.ts |
| `yoda-reroll-unavailable` | Yoda ring reroll not offered — already used this game round (#540 messaging). | `(not seen in corpus or sample game)` | src/engine/combat.ts |
| `yoda-skipped` | — | `{"context":"mission","systemId":"mandalore"}` | src/engine/combat.ts, src/engine/phases.ts |
