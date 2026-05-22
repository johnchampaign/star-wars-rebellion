# Star Wars: Rebellion — Engine

Runtime engine on top of the data model in `core-model.md`. Covers the turn
loop, the combat sub-machine, the `ChoiceRequest` pause-resume idiom, the
`Mechanics` façade contract, the logging conventions, the codec / replay
contract, and the determinism contract.

This document is the engineering-side companion to `core-model.md`. If a fact
about *data shape* lives in both docs, `core-model.md` wins. If a fact about
*how the engine progresses* lives in both, this doc wins.

Rule citations: `(rr p.N)` Rules Reference, `(ltp p.N)` Learn to Play. Where
this engine deviates from the rules text in a way that's non-obvious, the
deviation is called out with a `**Deviation:**` block and a reason.

---

## 1. Architecture & boundaries

```
src/
  engine/                 boardgame.io Game definition, no React.
    game.ts               The Game<G, Ctx>; phases; moves.
    mechanics/            All mutating helpers — the Mechanics façade.
    handlers/             Per-card EffectHandler implementations.
    combat/               CombatRunner: the sub-machine.
    ai/                   IPlayerController + Random and Heuristic.
    rng.ts                SeededRng.
    log.ts                GameLog: structured event stream.
    codec.ts              base64 snapshot of GameState.
  components/             React UI. Observes G; sends moves; answers choices.
  data/                   JSON loaders for systems / adjacency / leaders / cards.
  App.tsx                 Top-level shell.
scripts/                  Extraction / dev tooling (Node TS or Python).
assets/                   JSON data files.
```

Engine code **does not** import from `components/` or any React surface.
Components observe `G` (typed via the same module-level types as
`engine/game.ts`), dispatch `boardgame.io` moves, and answer `ChoiceRequest`s.
A React tree that holds Phaser, an animation library, or anything else can be
swapped without touching the engine.

This is the Tyrants boundary, restated. Same boundary as the C# projects
(`Innovation.Core ↔ Innovation.Wpf`) — Core knows nothing about the UI.

---

## 2. Game definition (boardgame.io)

We use boardgame.io's `phases` to model Assignment / Command / Refresh, and an
explicit sub-state machine for Combat (boardgame.io phases don't compose well
for the nested-multi-decision pattern combat needs).

```ts
const RebellionGame: Game<GameState> = {
  name: 'star-wars-rebellion',
  setup: (ctx, setupData) => GameSetup.create(setupData.seed, setupData.controllerSeeds),
  playerView: GameView.maskFor,       // see §3 hidden info
  endIf: (G) => G.IsGameOver ? { winner: G.Winner } : undefined,
  phases: {
    assignment: { /* see §4 */ },
    command:    { /* see §5 */ },
    refresh:    { /* see §7 */ },
  },
  moves: {
    submitChoice: SubmitChoiceMove,   // resolves a pending ChoiceRequest
    pass: PassMove,                   // command phase only
    activateSystem: ActivateMove,     // command phase only
    revealMission: RevealMissionMove, // command phase only
    assignLeader: AssignLeaderMove,   // assignment phase only
  },
};
```

`G` is the entire `GameState` from `core-model.md` §7.

### Why a hand-rolled combat sub-machine

boardgame.io phases are global to the game — entering a phase means *every
player* is in that phase. Combat is local: it's a nested interaction between
the attacker and defender of one specific system while the rest of the game
state is paused mid-Command-turn. Modeling combat as a phase forces the
"current player" mechanic to fight boardgame.io's turn order. We push combat
state into `G.PendingCombat` and run a small driver outside the phase
machinery; the Command phase doesn't advance until combat ends.

Same lesson as Innovation's mid-dogma state — boardgame.io's flow primitives
are for the outer game, not for nested per-card-effect machinery.

---

## 3. Hidden information (`playerView`)

`playerView(G, ctx, playerID)` returns a *projection* of `G` where the viewing
player's secrets are intact and the opponent's are masked. The rules for
masking come from `core-model.md` §6.

Implementation:

```ts
function maskFor(G: GameState, ctx: Ctx, playerID: PlayerID | null): GameState {
  if (playerID == null) return G;          // spectator sees public-only view
  const side: Side = playerID === '0' ? 'Rebel' : 'Empire';
  const opp: Side = side === 'Rebel' ? 'Empire' : 'Rebel';
  return {
    ...G,
    [opp]: {
      ...G[opp],
      MissionHand:       G[opp].MissionHand.map(() => 'hidden' as const),
      ActionHand:        G[opp].ActionHand.map(() => 'hidden' as const),
      ObjectiveHand:     side === 'Empire' ? G[opp].ObjectiveHand?.map(() => 'hidden') : G[opp].ObjectiveHand,
      ProbeHand:         side === 'Rebel'  ? G[opp].ProbeHand?.map(() => 'hidden')      : G[opp].ProbeHand,
      LeadersOnMissions: G[opp].LeadersOnMissions.map(m => ({ ...m, mission: 'hidden' })),
      MissionDeck:       new Array(G[opp].MissionDeck.length).fill('hidden'),
      ActionDeck:        new Array(G[opp].ActionDeck.length).fill('hidden'),
      ObjectiveDeck:     side === 'Empire' && G[opp].ObjectiveDeck ? new Array(G[opp].ObjectiveDeck.length).fill('hidden') : G[opp].ObjectiveDeck,
    },
    RebelBaseSystemId: G.RebelBaseRevealed || side === 'Rebel' ? G.RebelBaseSystemId : 'hidden',
    ProbeDeck:          new Array(G.ProbeDeck.length).fill('hidden'),
  };
}
```

**Critical:** any masked field is replaced with the literal sentinel
`'hidden'`, not with `undefined`. The UI distinguishes "you can't see this
card" (string `'hidden'`) from "this slot is empty" (`undefined`).

Hand counts remain truthful — the opponent's card count is public.

### Mid-resolution leak risk

When `G.PendingChoice` is set during the Empire's turn and the choice involves
private Imperial information (e.g. "Empire picks a probe card to reveal"), the
masked Rebel view must not include the Empire's `ChoiceRequest.options`. The
`ChoiceRequest` field itself is filtered in `maskFor`: if `ctx.currentPlayer`
≠ viewing player, replace any `cards`/`leaders`/`options` arrays in the
choice with their lengths and an opaque token. The viewing player sees that
their opponent has a pending choice but not what it is.

---

## 4. Phase: Assignment

```
Assignment Phase:
  start →
    Rebel assigns any leaders to missions     (alternating: Rebel goes first, finishes)
    Empire assigns any leaders to missions
  end → Command Phase
```

Moves available:

```ts
AssignLeaderMove(missionId, leaderIds)        // attach 1-2 leaders to a face-down mission
SkipAssignmentMove()                           // declare "done assigning"
```

Skill icons of assigned leaders are **not** checked here (rr p.8). A leader
can be face-down-assigned to a mission they cannot themselves reveal — but if
that's the only leader on the mission and skills don't meet the requirement
at reveal time, the mission is stuck face-down and the player must take a
different action (rr p.8).

Skipping is a deliberate signal — boardgame.io's turn end won't auto-fire
because there's no per-player turn-end condition; the player chooses when
they're done assigning. Phase transitions when both `SkipAssignmentMove`s
have fired.

---

## 5. Phase: Command

The main game phase. Turns alternate Rebel → Empire (rr p.6), and each turn
the current player either activates a system, reveals a mission, or passes.

```
Command Phase:
  loop:
    if both sides have passed: → Refresh Phase
    current player takes one action:
      - ActivateSystem(leaderId, systemId)
      - RevealMission(missionId, systemId)
      - Pass
    advance current player to the other side
        (unless they have already passed; then stay)
```

Passing is sticky for the rest of the phase (rr p.6). A passed side still
participates passively: they can oppose missions and add leaders to combat
during the first step of a combat triggered by the other side's activation.
Tracked via `G.PassedThisCommand: Set<Side>`.

### 5.1 Activate System move

The move signature (boardgame.io):

```ts
ActivateMove(G, ctx, leaderId, targetSystemId, moveOrders)

// moveOrders: which units from which adjacent systems flow into the target.
// Shape: { fromSystemId: { unitIds: UnitId[] } }
```

The client computes the *legal* set of move orders (transport capacity,
restriction-icon rules, immobile-icon checks, leader-blocks-own-units rule)
and submits a single `moveOrders` object. The engine **re-validates** every
order — never trusts the client.

Sequence inside `ActivateMove`:

1. **Validate**: leader is in pool; leader has tactic values (rr p.2);
   target is a system; for each `fromSystemId`, no friendly leader present
   that would prevent unit-out (rr p.2); transport capacity sufficient;
   restriction-icon honored; immobile excluded.
2. **Place leader** in target system.
3. **Move units** one-fromSystemId at a time, calling `Mechanics.MoveUnits`.
   `RecomputeSubjugation(toSystem, ...fromSystems)` runs once at the end.
4. **Rebel base reveal trigger** (rr p.11): if Imperial ground units entered
   the system containing the Rebel base (Rebel knows this; Empire does not),
   reveal the base — `Mechanics.RevealRebelBase('imperial-ground-entered')`.
   This happens *before* combat (rr p.11).
5. **Combat check**: if both sides have units in the same theater in the
   target system, enter the combat sub-machine (§9). Otherwise this move
   ends here.
6. **Game-end check**: `RecomputeGameEnd` (always at the end of every
   `Mechanics.*` call, but emphasized here because this is the most common
   game-end trigger).

### 5.2 Reveal Mission move

```ts
RevealMissionMove(G, ctx, missionId, targetSystemId)
```

Sequence:

1. **Validate**: the mission is in `G[side].LeadersOnMissions`, the assigned
   leaders' skill icons meet the requirement (rr p.8) — *only checked now*,
   not at assignment.
2. **Flip card faceup**, log the reveal (the card identity becomes public).
3. **Choose system** if the mission allows it (some are fixed, e.g.
   "attempt in the Rebel base's system" — Rebel must use the *actual* base
   system, not the Rebel Base space; rr p.4 "Cheating").
4. **Place leaders** in the target system.
5. If the card is `IsAttempt`, prompt the opponent with an
   `OpposeMission` choice; otherwise skip to (8).
6. If opposed, gather skill icons from both sides' leaders in the system
   (captured leaders contribute *only* if attempted against them — rr p.3),
   roll dice, compare successes (`hit`=1, `directHit`=1, `special`=2;
   rr p.7), apply the +2 leader-portrait bonus (rr p.9).
7. If mission failed, discard the card per `IsStarting` rule (starting →
   hand; others → discard pile) and end the move.
8. If mission succeeded (or `IsResolve`), invoke
   `MissionRegistry[card.EffectKey].execute(G, ctx)`. Effect can suspend with
   a `ChoiceRequest` (§8). When it completes, discard the card and end.

---

## 6. Effect handlers

Same pattern as Innovation's `IDogmaHandler` and Tyrants' `IEffectHandler`.

```ts
interface EffectHandler {
  execute(G: GameState, ctx: EffectContext): boolean
}

type EffectContext = {
  actorSide: Side                       // who owns this effect
  card: { kind: 'mission'|'action'|'objective'|'tactic'; id: string }
  targetSystemId?: SystemId             // if the card has a chosen system
  pendingChoice: ChoiceRequest | null   // null when not waiting
  handlerState: unknown                 // typed per-handler stash for stages
  frame?: EffectFrame                   // for nested "card invokes card" — see Tyrants engine.md
  paused: boolean
}
```

Returns `true` when the effect ran to completion this call; `false` when it
suspended awaiting input. The engine drives:

```ts
function runEffect(G, ctx) {
  while (!ctx.paused) {
    const done = handler.execute(G, ctx);
    if (done) return;
    // pending choice posted — wait for SubmitChoiceMove
    return;
  }
}
```

### 6.1 Handler conventions

Lifted directly from Tyrants/Innovation, restated for this codebase:

- **Null `pendingChoice` immediately after consuming it.** The next iteration
  will see stale data otherwise. Identical bug class to Innovation
  `DemocracyReturnHandler`.

- **`if (G.IsGameOver) return true;` before any post-effect phase reset.**
  Identical bug class to Innovation `TurnManager.ResumeDogma` — a handler
  can end the game mid-effect (e.g. Superlaser Online destroys the Rebel
  base's system; Empire wins immediately). The wrapper code that schedules
  the "discard the card and proceed" must guard.

- **Multi-stage handlers stash state in `handlerState`**, typed per-handler
  with a small enum. E.g. `RapidMobilization` has stages
  `'await-empire-confirm' | 'await-rebel-pick' | 'done'`.

- **Mission text reward target.** When a mission says "If you succeed, you
  gain X", "you" is the side that *played* the mission. When a mission
  resolves an effect on *another* leader or unit, that leader/unit is the
  target. This is mostly clean in Rebellion (unlike Innovation's
  demand/share traps), but specifically watch:
  - Mission "Hunt Them Down" (Imperial, captures a Rebel leader) — the
    captured-leader ring goes on the *Rebel* leader, not the Empire's.
  - Mission "Lure of the Dark Side" — moves a Rebel leader to the Imperial
    leader pool. Multi-step bookkeeping; tests required.

### 6.2 Registration

Card registries key by **card name** (string), not by id, for resilience
to JSON re-ordering. From Innovation `CardRegistrations.RegisterAll`:

```ts
MissionRegistry.register('Sabotage', new SabotageHandler());
MissionRegistry.register('Rapid Mobilization', new RapidMobilizationHandler());
MissionRegistry.register('Death Star Plans', new DeathStarPlansHandler());
// ...
```

The cards-tab `EffectKey` dropdown (see `dev-tabs.md`) is populated from this
registry. A card whose JSON `EffectKey` doesn't appear in the registry is a
broken card; the loader logs at startup and the cards tab shows it red.

---

## 7. Phase: Refresh

Six fixed sub-steps (rr p.12). No player choice except step 1 (Start-of-Refresh
objective) and step 5/6 (target system for deploy).

```
Refresh Phase:
  1. Retrieve leaders
       (Rebel may play one StartOfRefresh objective first via ChoiceRequest)
     - Return all leaders from board to leader pool
     - For each LeadersOnMissions row, return leaders to pool and mission to hand
  2. Draw missions
     - Each side draws 2 mission cards
     - If hand > 10, prompt the holder to discard down to 10 (starting missions exempt)
  3. Launch probe droids
     - Empire draws 2 probe cards (hidden from Rebel)
  4. Draw objective
     - Rebel draws 1 objective card (hidden from Empire)
  5. Advance time marker
     - Increment G.TimeMarker
     - Check reputation == time → Rebel wins
     - If new space has Recruit icon: each side draws 2 action cards,
       picks a leader via ChoiceRequest (action card kept, other returned
       to bottom of action deck unrevealed)
     - If new space has Build icon: each side simultaneously builds 1 unit
       per resource icon in loyal/subjugated systems (skip systems with
       opponent units present; rr p.3)
  6. Deploy units
     - Slide all build queues 3→2→1→deploy
     - Player picks deploy target for each unit that slid off (ChoiceRequest)
     - Honor the 2-units-per-system cap; honor sabotage/opponent/remote/destroyed
       blocks; if no legal target, unit returns to build queue position 1
       (rr p.7)
```

The order is critical and mirrors the rules exactly. Refresh is the only
phase whose order is fully determined by the rules text — Assignment and
Command have free player choice; Refresh is a script with player choice only
at the marked points.

---

## 8. ChoiceRequest taxonomy

The full set is in `core-model.md` §10. Here are the engine-side properties
each must satisfy:

- **Atomic**: a choice is presented and resolved in a single `SubmitChoiceMove`
  call. No partial choices; if the user needs to e.g. select multiple cards,
  the client batches the selection and submits once.
- **Resumable**: after `SubmitChoiceMove`, the engine clears `pendingChoice`
  to `null` and resumes the originating handler. The handler reads its
  `handlerState` to know what stage it was in.
- **Cancelable** only if `allowSkip: true` on the choice. Most game-flow
  choices are forced (you must pick *some* target); a few are optional
  (e.g. `PlayObjective` during a combat window — Rebel can decline).
- **Validated** at submission. The client cannot submit an illegal target
  (e.g. a leader not in the pool, a system that doesn't match the filter).
  Engine re-validates and rejects with a clear error.

### 8.1 Client/AI seat protocol

Same pattern as Innovation's `IPlayerController`:

```ts
interface PlayerController {
  // Synchronous from the engine's perspective. AI returns immediately;
  // human blocks on a UI Promise (TaskCompletionSource analogue).
  resolveChoice(G: GameState, choice: ChoiceRequest): Promise<ChoiceResponse>
}
```

- `HumanController` — thin forwarder to a UI sink (`IUserPromptSink`
  equivalent). Click handlers complete a `Promise<ChoiceResponse>`.
- `RandomController` — uniform over legal options. Seeded from
  `G.ControllerSeeds[side]`.
- `HeuristicController` — one-ply lookahead via `HeuristicEvaluator.score(G)`.
  Scores each legal completion, picks the highest. Seeded for tiebreaks.

The engine doesn't know which controller is which. The `boardgame.io` client
loop dispatches `SubmitChoiceMove` when the active seat's controller
resolves. AI seats resolve immediately; human seats resolve when the UI
sends the move.

---

## 9. Combat sub-machine

Combat is held in `G.PendingCombat`. The Command-phase move that triggered
combat doesn't return to the player until combat ends.

```ts
type CombatState = {
  systemId: SystemId
  attackerSide: Side                  // the side that moved units in
  attackerSourceSystemId: SystemId    // for the no-retreat-to-source rule (rr p.5)
  step: 'AddLeader' | 'DrawTactics' | 'Round' | 'Ended'
  round: number
  phase?: 'Space' | 'Ground' | 'Retreat'
  attackerHand: TacticCardId[]
  defenderHand: TacticCardId[]
  retreated: Set<Side>                // each side at most once (rr p.5)
  destroyedUnits: Set<UnitInstanceId> // staged on faction sheet, see §9.5
}
```

### 9.1 Step: Add Leader

Current player decides first (rr p.4), then opponent. A side without a
tactic-valued leader in the system may add one. Then both sides resolve
`StartOfCombat` action cards in current-then-opponent order.

```ts
runStep_AddLeader():
  for s in [current, opponent]:
    if no leader with tactic values in system:
      issue ChoiceRequest { kind: 'AddCombatLeader', from: 'pool', allowSkip: true }
  for s in [current, opponent]:
    issue ChoiceRequest { kind: 'PlayStartOfCombatAction', allowSkip: true }
  step ← 'DrawTactics'
```

### 9.2 Step: Draw Tactic cards

Each side draws cards equal to their leader's tactic value, *only for theaters
where both sides have units* (rr p.4). Use the highest tactic value if a side
has multiple leaders.

### 9.3 Step: Combat round

```ts
runStep_CombatRound():
  if both sides have ships in system:
    runAttack('Space', currentSide)
    runAttack('Space', oppositeSide)
  if both sides have ground units in system:
    runAttack('Ground', currentSide)
    runAttack('Ground', oppositeSide)
  // Retreat
  for s in [current, opponent]:
    if canRetreat(s):
      issue ChoiceRequest { kind: 'RetreatTo', legal: ..., allowSkip: true }
      if retreated: process retreat (move all ships out, optionally leave
                    ground/TIE per rr p.5, mark s in CombatState.retreated)
  // Next-round check
  if both sides have units in some shared theater:
    round++; goto 'Round'
  else:
    endCombat()
```

### 9.4 `runAttack`

```ts
runAttack(theater, side):
  // 1. Roll dice
  // Sum participating units' attack values, capped at 5R+5B per attack
  // (rr p.4); cap is applied AFTER any reductions.
  dice = rollAttackDice(G, side, theater)
  // 2. Combat actions loop: spend special dice for tactic-card draws/plays
  while true:
    issue ChoiceRequest { kind: 'CombatAction',
                          options: [drawTactic, playTactic, done] }
    if done: break
    apply chosen action
  // 3. Assign damage
  issue ChoiceRequest { kind: 'AssignDamage', dice, targets: legalTargets(theater) }
  // 4. Block damage (opponent)
  issue ChoiceRequest { kind: 'BlockDamage', allowSkip: true, hand: opp tactic hand }
  // 5. Destroy: any unit whose assigned damage ≥ health is staged for destruction
  // at the END of this theater step. It still attacks this round (rr p.5).
  stageDestructionsAtEndOfTheater(theater)
```

After both sides finish their attack in a theater, finalize destructions
**before** moving to the next theater. Damage markers persist into next round
but are wiped at end of combat (rr p.5).

### 9.5 Destruction timing — the Innovation Monument gotcha, restated

A unit reaching health-equal-damage is **staged** on the faction sheet; it
still attacks this combat-round (rr p.5). Destruction happens at the end of
the theater step (after both sides' attacks). Game-end check happens after
each `Mechanics.DestroyUnit` call — meaning a unit-destruction in the middle
of a theater can trigger:

- Empire wins if base system has Imperial units & no Rebel units (rr p.14).
- Rebel wins if reputation rises into time-marker space (combat objectives
  played here, rr p.10).

`runAttack` and `runStep_CombatRound` **must** check `G.IsGameOver` after
every staged destruction is applied, and bail out cleanly without resetting
`Phase = Command` (the Innovation `TurnManager.ResumeDogma` lesson).

### 9.6 Retreat constraints

Encoded once and re-used:

```ts
canRetreat(side, G, combat):
  if !sideHasLeaderInSystem(side, combat.systemId): return false
  if side === 'Empire' && hasDeathStarInCombat(combat): return false  // rr p.5
  if combat.retreated.has(side): return false
  return true

legalRetreatTargets(side, G, combat):
  systemId = combat.systemId
  attackerSrc = combat.attackerSourceSystemId
  adj = neighbors(systemId)
  // Prefer systems with own units/loyalty; if none, any adjacent unit-free system
  preferred = adj.filter(s => sideHasUnits(side, s) || sideHasLoyalty(side, s))
  pool = preferred.length ? preferred : adj.filter(s => !sideHasUnits(opponent, s))
  // Cannot retreat to the system attacker moved units from
  return pool.filter(s => s !== attackerSrc)
                .filter(s => !(side === 'Rebel' && s === 'rebel-base-space'))
```

### 9.7 End-of-combat cleanup

```ts
endCombat():
  // Apply structure-destruction rule (rr p.4 IV)
  if Rebel ground only structures && Imperial ground still present: destroy structures
  if Imperial only ship is DSUC && Rebel ships present: destroy DSUC
  // Discard tactic hands, reshuffle decks
  reshuffle ground tactic deck with current discards (rr p.14)
  reshuffle space tactic deck
  // Wipe damage markers
  for u in G.Map[systemId].units: u.damage = 0
  G.PendingCombat = null
  // Now return control to the Command-phase ActivateMove that triggered combat
```

---

## 10. The Mechanics façade

Every mutation routes through `mechanics/*.ts`. **Direct mutation of `G`
outside `mechanics/` is a bug.** Same contract as Tyrants and Innovation.

```ts
// mechanics/index.ts
export const Mechanics = {
  Map:       MapMechanics,        // MoveUnits, DeployUnit, DestroyUnit, ...
  Loyalty:   LoyaltyMechanics,    // Gain, Lose, recompute subjugation
  Leaders:   LeaderMechanics,     // Assign, Place, Return, Capture, Rescue, Eliminate
  Decks:     DeckMechanics,       // DrawAction, DrawMission, DrawObjective, DrawProbe, Discard
  Build:     BuildMechanics,      // BuildToQueue, AdvanceQueue, Deploy
  Time:      TimeMechanics,       // AdvanceTime, GainReputation, LoseReputation
  Combat:    CombatMechanics,     // BeginCombat, RollAttack, ApplyTactic, EndCombat
  Base:      BaseMechanics,       // RevealRebelBase, EstablishNewBase
  Special:   SpecialMechanics,    // DestroySystem (Superlaser), ...
};
```

### 10.1 Invariants every mutation maintains

After each call into `Mechanics.*`:

1. `RecomputeSubjugation(affectedSystems)`:
   - Empire has ≥1 ground unit there AND loyalty != imperial → place subjugation marker.
   - No Empire ground units there → remove subjugation marker; if a Rebel loyalty marker is beneath, the system reverts to Rebel.
2. `RecomputeRebelBaseReveal`:
   - If Empire has loyalty OR ground units in the Rebel base's system AND
     base is hidden → reveal (rr p.11).
3. `RecomputeGameEnd`:
   - Empire: base revealed, Empire units in base system, no Rebel units → Empire wins.
   - Empire: base system destroyed → Empire wins.
   - Rebel: `ReputationMarker == TimeMarker` → Rebel wins.

These three run as a fixed post-mutation sequence. Idempotent — calling twice
in a row is a no-op on the second call.

### 10.2 The "gain / build / deploy" distinction

`core-model.md` §12.5 has the doctrine. Implementation:

```ts
Mechanics.Build.BuildToQueue(side, unitType, slot, systemId)
  // checks: loyalty, no opponent unit, no sabotage (rr p.13)
  // effect: queue.push

Mechanics.Build.Deploy(side, unitType, systemId)
  // checks: 2/system cap, no sabotage, no opponent ships/ground (rr p.7),
  //         not remote, not destroyed, has loyalty/subjugation
  // effect: place on board

Mechanics.Map.GainUnit(side, unitType, systemId)
  // skips ALL of those checks (rr p.13)
  // effect: place on board directly
```

Mission handlers must call the right one. The naming is the safety belt.

### 10.3 Logging contract

Every public `Mechanics.*` call writes one structured `LogEntry`:

```ts
type LogEntry =
  | { kind: 'move-units'; side: Side; from: SystemId; to: SystemId; units: UnitInstanceId[] }
  | { kind: 'destroy-unit'; unitRef: UnitInstanceId; cause: 'combat' | 'mission' | 'transport-overflow' }
  | { kind: 'gain-loyalty'; side: Side; systemId: SystemId }
  | { kind: 'reveal-base'; reason: 'imperial-ground-entered' | 'imperial-loyalty' | 'voluntary' }
  | { kind: 'state'; codec: string }     // emitted at turn boundaries only
  | // ... one per Mechanics method
```

Private internal helpers (e.g. `recomputeSubjugation`) do not log directly;
their effect surfaces through the outer call's log entry.

---

## 11. Codec / snapshot / replay

```ts
GameStateCodec.encode(G): string     // base64
GameStateCodec.decode(s: string): GameState
```

**Round-trip safe only at turn boundaries.** Mid-Command-turn, mid-mission,
mid-combat: do not encode. The codec omits `PendingChoice`, `PendingCombat`,
`PendingMission`, `EffectContext.handlerState` entirely — they don't survive.

UI behavior:
- "Copy state" button is disabled when any pending field is non-null.
- "Load state" refuses to deserialize a blob that lacks the
  `phase ∈ {assignment, command-start, refresh-start, gameover}` marker.

This is the same rule as Innovation's mid-dogma codec. The reason it exists
is the same: capturing every effect-handler `handlerState` in a round-trip
codec is possible in principle but explodes in cost for negligible benefit;
turn-boundary snapshots cover 99% of "I want to share this game state" use.

Replay path:
- `(seed, controllerSeeds, log)` deterministically reproduces a game.
- For tests, replay validates that the log indeed reproduces; for the UI,
  the move log displayed to users is a subset of `log` filtered for player
  comprehension.

---

## 12. Determinism

Same rules as Tyrants / Innovation / Impulse:

- One `SeededRng` on `G.Rng`. Sole source of shuffle randomness.
- Per-side `ControllerSeeds` for AI tiebreaks. Pass at setup; never re-create.
- No `Date.now()`, no `Math.random()` in `engine/`. ESLint rule enforces.
- No async branches in `Mechanics.*` — they are synchronous, observable,
  fully replayable.

Testable: `npm run sim -- --seed 12345 --games 100` runs 100 random-vs-random
games headlessly; identical seeds produce identical logs.

---

## 13. Known gotchas (pre-registered)

These are problems that *will* occur and need tests before they're written:

1. **Reveal-before-combat ordering** (§5.1 step 4). Don't fold reveal into
   the combat sub-machine — combat starts *after* reveal.

2. **Subjugation flicker during multi-step missions.** A mission that moves
   units multiple times must call `RecomputeSubjugation` after each move,
   not once at the end, or the intermediate marker state is wrong.

3. **Game-end during combat.** `runAttack` and `runStep_CombatRound` must
   check `G.IsGameOver` after every destruction. If true, bail and let the
   outer loop wrap up; do not reset `Phase`. See §9.5.

4. **Mid-effect codec attempts.** UI button disabled rule must be enforced;
   if a developer presses-anyway via console, the encoder throws.

5. **Captured leader skill icons.** Only contribute when attempted-against
   (rr p.3). Default skill-icon aggregation must check for the
   `'captured-leader-target' === ctx.specialFlag` to include.

6. **Mission card return-on-leader-loss.** Eliminating, capturing, or moving
   a leader off a face-down mission returns the mission to hand without
   reveal (rr p.9). This must fire from `Mechanics.Leaders.Eliminate /
   Capture / Place` paths, not from a separate housekeeping pass.

7. **"You" in mission reward text.** Rebellion mostly avoids the Innovation
   demand-target trap, but a handful of cards have "If you succeed, the
   *opponent* X" wording that needs care. Audit list maintained in
   `tests/missions/*.test.ts`.

8. **Continue-gate during AI mid-combat choices.** When an AI seat pauses
   mid-combat for its own decision, the "advance the game" gate (if we add
   one for human-vs-AI UX) must skip that pause. Same as Innovation's
   `_runner.IsResolvingChoice` flag.

9. **Initial setup must not run on a loaded state.** `GameSetup.create` only
   runs if `G.Phase === 'NewGame'`. A loaded snapshot enters at
   `'assignment'`, `'command-start'`, or `'refresh-start'`. Don't reseed.

10. **Probe deck does not include Coruscant.** Verified at setup; the
    `probe` dev tab asserts this; the loader fails fast if violated.

---

## 14. Comments style

Cite rule sources in handler comments:

```ts
// rr p.6 — Death Star Plans usable only during space-battle round;
// requires at least one Rebel fighter in system.
class DeathStarPlansHandler implements EffectHandler { ... }
```

Where this engine deviates, prefix the comment with `**Deviation:**` and
explain why. There should be very few of these; rr is authoritative.

When fixing a bug whose cause is non-obvious, leave a comment explaining
*why* the fix is shaped the way it is. Future-you will thank you.

---

## 15. Test strategy

Inheriting Innovation's three layers:

1. **Direct handler tests.** Build a near-empty `GameState` via a `fresh()`
   factory; call `handler.execute(G, ctx)`; assert state changes. For
   suspended handlers, populate `pendingChoice.response` and re-enter.

2. **End-to-end runner tests.** Use a `ScriptedController` (queue of
   `ChoiceResponse`s) to drive a multi-move scenario. Walk by calling
   `runner.step()` and inspecting `[state]` log lines at turn boundaries.

3. **Headless sim runs.** `npm run sim` runs N games with random
   controllers; outputs JSON per game to `training-logs/<timestamp>/`.
   Smoke test: every sim must reach a winner (no infinite loops) and the
   final state must satisfy exactly one win condition.

Each handler with a tricky rule (Death Star Plans, Rapid Mobilization, Hunt
Them Down, Carbon Freezing, Lure of the Dark Side, Sabotage, Subversion
[RoE-only, deferred], Superlaser Online) gets its own test file.

---

## 16. Workflow for fixing a rules bug

1. **Reproduce in the running app** if possible. Note the `[state]` codec
   from the turn-boundary snapshot just before the bug.
2. **Find the rule.** Search the Rules Reference for the relevant phase /
   topic. Read the surrounding entries. If the rules genuinely contradict
   each other (Golden Rule #1: rr beats ltp; #2: card beats rr unless
   compatible), surface the contradiction and ask the user (per CLAUDE.md
   instructions).
3. **Write a failing unit test.** Direct handler call OR scripted controller
   end-to-end.
4. **Fix the handler / mechanic.** Add a comment citing the rule page.
5. **Verify the test passes** and run the full suite.
6. **If the bug touched a recurring pattern** (e.g. "we forgot to call
   `RecomputeSubjugation` after a mission's mid-effect move"), grep the
   codebase for the same shape before declaring done.

---

## 17. Out of scope (engine, base game v1)

- Online multiplayer — single-machine hot-seat + AI seats only.
- Team Game (3p / 4p) phase variations.
- Rise of the Empire — green dice, Subversion missions, advanced tactic
  cards, target markers, immediate objectives, leader pool limit (>8),
  unit-specific abilities (Shield Bunker, Interdictor, Assault Tank, ...).
- Cinematic Combat alternate rules.
- AI beyond `RandomController` + one `HeuristicController` per side.
- Asset hot-swap (changing the .vmod after first run).

Engine data shapes leave hooks for the expansion (e.g. `Class: 'structure'`
on units, `targetMarkers` on `SystemState`, green dice in the dice roller's
config), but no handlers exist for any of it.
