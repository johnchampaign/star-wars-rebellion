# Star Wars: Rebellion — Core Model

Domain model for the engine, derived from the official Rules Reference
(`sw03_rules_reference_web.pdf`, FFG 2016). Engine details — turn loop, effect
handlers, combat sub-machine, persistence — live in `engine.md`; this doc fixes
the data shapes and invariants.

Rulebook citations use the form `(rr p.N)` for the Rules Reference and
`(ltp p.N)` for Learn to Play. The EOG v2.5 community summary
(`StarWarsRebellion_v2.5.pdf`) is consulted but never authoritative.

**Scope (locked):** 2-player base game only. No Team Game (3p/4p), no Rise of
the Empire expansion, no Cinematic Combat alternate. Where the data model could
trivially leave room for an expansion pass later, it does (noted inline); no
expansion *behavior* is implemented.

The **Golden Rules** (rr p.2) are honored in code:
1. Rules Reference > Learn to Play.
2. Card text > Rules Reference, unless both can apply, in which case both do.
3. "Cannot" on a card is absolute and cannot be overridden.

---

## 1. Sides and factions

Exactly two sides: `Rebel` and `Empire`. Asymmetric — they share a board and
turn rhythm but have separate decks, leader rosters, victory conditions, and
private state.

```ts
type Side = 'Rebel' | 'Empire';
```

A `FactionState` (one per side) holds:

| Field | Type | Notes |
|---|---|---|
| `LeaderPool` | `LeaderId[]` | Available to assign / activate / oppose / add-to-combat. |
| `LeadersOnBoard` | `Dict<SystemId, LeaderId[]>` | Placed on the map, including the Rebel Base space. |
| `LeadersOnMissions` | `{ mission: MissionCardId; leaders: LeaderId[] }[]` | Face-down assignment from the Assignment Phase; revealed during Command. |
| `ActionDeck` | `ActionCardId[]` | Face-down, recruit-icon cards only. |
| `ActionHand` | `ActionCardId[]` | Face-down to opponent; player can look. Includes starting action cards. |
| `MissionDeck` | `MissionCardId[]` | Face-down, non-starting non-project cards. |
| `MissionHand` | `MissionCardId[]` | Includes the 4 starting missions plus draws. |
| `BuildQueue` | `{ 1: UnitType[]; 2: UnitType[]; 3: UnitType[] }` | Three positions; units slide 3 → 2 → 1 → deploy. |
| `EliminatedLeaders` | `LeaderId[]` | Returned to the box; cannot re-enter. |

### Rebel-only

| Field | Type | Notes |
|---|---|---|
| `ObjectiveDeck` | `ObjectiveCardId[]` | Stage-ordered at setup (I on top, then II, then III). |
| `ObjectiveHand` | `ObjectiveCardId[]` | Hidden from Empire. No hand limit (rr p.10). |
| `ObjectiveDiscard` | `ObjectiveCardId[]` | Used objectives — *returned to the box*, not reshuffled. Tracked for analytics; never drawn from. |

### Empire-only

| Field | Type | Notes |
|---|---|---|
| `ProbeHand` | `ProbeCardId[]` | Probe cards drawn during Refresh, kept secret. |
| `ProjectDeck` | `MissionCardId[]` | Drawn from via "Research and Development". Project cards are missions; share the 10-card hand limit. |
| `ProjectDiscard` | `MissionCardId[]` | |
| `CapturedLeaders` | `{ leaderId: LeaderId; ring: 'captured' \| 'carbonite' }[]` | At most one `'captured'` ring exists at a time (rr p.3); carbonite is unlimited in principle but only one card creates it. |

`MissionDeck.discard` is implicit — non-starting missions are discarded after
use into a faction-side `MissionDiscard` pile that reshuffles when the deck
empties (rr p.6 component limitations).

---

## 2. Leaders

`Leader` — immutable record:

| Field | Type | Notes |
|---|---|---|
| `Id` | `LeaderId` (string) | Slug, e.g. `'darth-vader'`. |
| `Name` | string | Display. |
| `Side` | `Side` | |
| `IsStarting` | boolean | The 4 starting leaders per side (no recruit icon). |
| `Skills` | `{ diplomacy, intel, specOps, logistics: number }` | Major skill icons. Sum is typically 1–3. |
| `MinorSkills` | same shape | **Rise of Empire only** — included on the type for forward compatibility, always zero in base game. Rolls green dice (`rr` not applicable; expansion rules). |
| `TacticValues` | `{ space, ground: number }` | Cards drawn at start of combat. `0` means no tactic value in that theater; a leader with `{0,0}` cannot activate a system (rr p.2). |
| `LeaderImage` | string | Filename in the .vmod image set. |

Starting roster (transcribed from .vmod `LeaderRebel*` / `LeaderEmpire*`):

- **Rebel starting (4):** Mon Mothma, Jan Dodonna, Leia Organa, Luke Skywalker.
- **Rebel recruitable:** Admiral Ackbar, Chewbacca, General Madine, General Rieekan, Han Solo, Lando Calrissian, Luke Skywalker (Jedi), Obi-Wan Kenobi, Wedge Antilles.
- **Empire starting (4):** Emperor Palpatine, Darth Vader, Grand Moff Tarkin, General Tagge.
- **Empire recruitable:** Admiral Ozzel, Admiral Piett, Boba Fett, Colonel Yularen, General Veers, Janus Greejatus, Moff Jerjerrod, Soontir Fel.

(Starting/recruitable counts confirmed against .vmod assets; skill/tactic numbers must be transcribed from the printed leader sheets — flagged for the card-data extraction step.)

Luke Skywalker (Jedi) is treated as Luke Skywalker for all card and action-card
references (rr p.8). Modeled by a `BaseId` field on the `LeaderId` rather than
two records sharing a name.

---

## 3. Map

Static board data loaded once from JSON. **32 systems** across **8 regions**
(4 systems per region, rr p.12).

`System` — immutable definition:

| Field | Type | Notes |
|---|---|---|
| `Id`, `Name`, `Region` | | `Region` is one of 8 IDs; used by `region-mate` predicates on a few cards. |
| `IsRemote` | boolean | No resource icons, no loyalty space. Always neutral, no deploy, no subjugation (rr p.12). |
| `IsCoruscant` | boolean | Always Imperial loyalty, cannot change (rr p.8). |
| `BuildSlot` | `1 \| 2 \| 3 \| null` | The build-queue position units built at this system land on. Applies to all of this system's resource icons (the printed number to the left of the icons). `null` for remote systems. |
| `Resources` | `{ type: 'space'\|'ground'; shape: 'triangle'\|'circle'\|'square' }[]` | 0–2 ordered entries. Empty for remote systems. `resources[0]` is the *left* icon — the only one usable while subjugated (rr p.3). `shape` is the unit-tier filter: triangle < circle < square; a square icon can build any unit of that color, a circle can build triangle- and circle-tier units, a triangle only builds triangle-tier. |
| `BoardPos` | `{ x: number; y: number }` | From `vmod/buildFile` `Region originx/originy` — used by the UI, not rules. |

The 32 systems (from `vmod/buildFile`): Alderaan, Bespin, Bothawui, Cato
Neimoidia, Corellia, Coruscant, Dagobah, Dantooine, Dathomir, Endor, Felucia,
Geonosis, Hoth, Ilum, Kashyyyk, Kessel, Malastare, Mandalore, Mon Calamari,
Mustafar, Mygeeto, Naboo, Nal Hutta, Ord Mantell, Ord Mantell, Rodia, Ryloth,
Saleucami, Sullust, Tatooine, Toydaria, Utapau, Yavin. Plus the **Rebel Base
space** which is not a system (rr p.10) but uses the same ID space for
unit/leader placement.

**Adjacency** is a `Dict<SystemId, SystemId[]>` symmetric graph. Region borders
(thick orange) are traversable; impassable areas (light red) are not (rr p.9).
Not encoded in the .vmod XML — must be hand-transcribed from a high-res board
scan or community list. Tracked as deliverable #2.

### Map runtime state

```ts
SystemState = {
  loyalty: 'rebel' | 'imperial' | 'neutral'   // loyalty marker; absent = neutral
  subjugated: boolean                          // subjugation marker present
  destroyed: boolean                           // Superlaser Online consequence
  sabotage: boolean                            // max 1 marker
  targetMarkers: TargetMarkerId[]              // RoE only; empty in base game
  units: UnitInstance[]                        // both sides, both theaters
}
```

The "Rebel Base space" gets its own `SystemState`-like record (with
`loyalty='neutral'`, never subjugated) for unit/leader staging while hidden.

### Derived predicates (not stored)

- `isImperial(systemId)` ≡ loyalty=imperial OR subjugated (rr p.8).
- `isRebel(systemId)` ≡ loyalty=rebel AND NOT subjugated (rr p.11).
- `isNeutral(systemId)` ≡ no loyalty marker AND no subjugation marker (rr p.10).
- `canDeploy(side, systemId)` — checked against ownership, sabotage, opponent units, remote, destroyed, and the 2-per-system cap (rr p.7).

Compute on demand; do not cache in `GameState`.

---

## 4. Units

`UnitType` — immutable record:

| Field | Type | Notes |
|---|---|---|
| `Id`, `Name`, `Side` | | |
| `Theater` | `'space' \| 'ground'` | |
| `Class` | `'capital' \| 'fighter' \| 'station' \| 'ground' \| 'structure'` | Death Star and DSUC are `station` (rr p.6); Shield Generator and Ion Cannon are `structure` (rr p.13). |
| `Tier` | `'triangle' \| 'circle' \| 'square'` | Build-eligibility tier. A unit of tier T can be built from a resource icon of shape S iff T ≤ S in the order triangle < circle < square. E.g. an X-wing (triangle) can be built at any blue icon; a Mon Calamari Cruiser (square) can only be built at a blue square icon. |
| `Health` | `{ color: 'red'\|'black'\|null; value: number }` | `color=null` for the Death Star, which cannot be assigned damage (rr p.6). Structures take damage via their special-rule destruction. |
| `Attack` | `{ red: number; black: number }` | Sum of dice rolled per attack. |
| `Transport` | `{ capacity: number; restriction: boolean; immobile: boolean }` | `restriction` = the transport-restriction icon (can only move with a transporting ship from the same system); `immobile` = cannot move at all. |
| `BuildResource` | `1 \| 2 \| 3` | Build-queue position from the system's resource icon. |

Supply pools (rr p.14):

- **Imperial:** 24 TIE Fighters, 8 Assault Carriers, 8 Star Destroyers, 2 Super Star Destroyers, 2 Death Stars, 1 DSUC, 30 Stormtroopers, 10 AT-STs, 4 AT-ATs.
- **Rebel:** 8 X-wings, 12 Y-wings, 4 Corellian Corvettes, 4 Rebel Transports, 3 Mon Cala Cruisers, 21 Rebel Troopers, 6 Airspeeders, 3 Shield Generators, 3 Ion Cannons.

Component limit (rr p.6): cannot build a unit type if the supply pool is empty.
At Refresh step 5 a player may destroy own units on the board to free supply.

```ts
UnitInstance = { typeId: UnitTypeId; side: Side; damage: number }
```

`damage` is mid-combat only — cleared at end of combat (rr p.5). No persistent
hull damage across combats.

---

## 5. Cards

Five card kinds. All share a registry pattern lifted from Innovation: data
records live in JSON (`assets/*.json`), behavior lives in TS handlers keyed by
`EffectKey`.

### 5.1 Action cards

```ts
ActionCard = {
  Id, Name, Side
  IsStarting: boolean                   // true = no recruit icon
  Timing: 'Assignment'|'StartOfCombat'|'Immediate'|'Special'
  LeaderRequirement?: LeaderId[]        // any of these leaders must be in the
                                        // mission/combat system (rr p.2); ignored
                                        // for Assignment-timing cards
  EffectKey: string                     // → handler in ActionCardRegistry
  RulesText: string                     // display only
}
```

Each card is **single-use** (rr p.2) — used cards return to the box.

### 5.2 Mission cards

```ts
MissionCard = {
  Id, Name, Side
  IsStarting: boolean                   // yellow arrow at bottom
  IsProject: boolean                    // Empire-only: white star, in ProjectDeck
  SkillRequirement: { skill: Skill; count: number }
  IsAttempt: boolean                    // attempt (opposable) vs. resolve (auto)
  LeaderPortrait?: LeaderId             // +2 successes if that leader is assigned (rr p.9)
  EffectKey: string
  RulesText: string
}

Skill = 'diplomacy' | 'intel' | 'specOps' | 'logistics'
```

Starting missions return to hand after use; all others discard (rr p.13).
Project cards reshuffle when the project deck empties (rr p.6).

### 5.3 Objective cards (Rebel only)

```ts
ObjectiveCard = {
  Id, Name
  Stage: 1 | 2 | 3
  Reputation: number                    // amount to move reputation marker
  Timing: 'Combat' | 'StartOfRefresh' | 'Special'
  EffectKey: string
  RulesText: string
}
```

Setup order (rr p.15): III on bottom, II on top of III, I on top — shuffled
within each stage. After play, returned to the box (rr p.10).

### 5.4 Tactic cards

```ts
TacticCard = {
  Id, Name
  Theater: 'space' | 'ground'
  RequiresSpecial: boolean              // ⚡ icon: must spend a special die to use
  EffectKey: string                     // 'block-2-damage', 'reroll-2-dice', etc.
  RulesText: string
}
```

Two decks of 10 (counts from .vmod: TacticGround*, TacticSpace* = 10 each).
Reshuffled into deck at end of every combat (rr p.14); hands cleared.

### 5.5 Probe cards

```ts
ProbeCard = { Id; systemId: SystemId }
```

One per system **except Coruscant** (rr p.10). Setup removes 5 (those showing
the 5 starting Imperial systems). Used by Empire to narrow base location; used
by Rebel at setup to pick the secret base.

---

## 6. Hidden information

This is the asymmetry that drives the architecture. boardgame.io
`playerView(G, ctx, playerID)` strips fields the viewing player isn't entitled
to see:

| Hidden field | Hidden from |
|---|---|
| `Map.rebelBaseSystemId` | Empire (until reveal). Replaced with `'hidden'` sentinel. |
| `RebelFaction.MissionHand` | Empire. Counts visible; identities not. |
| `RebelFaction.ActionHand` | Empire. |
| `RebelFaction.ObjectiveHand` | Empire. |
| `RebelFaction.LeadersOnMissions[*].mission` | Empire (until reveal step). The fact that *N* leaders are assigned to *some* mission is public; the card identity is not. |
| `EmpireFaction.MissionHand` | Rebel. |
| `EmpireFaction.ActionHand` | Rebel. |
| `EmpireFaction.ProbeHand` | Rebel. |
| `EmpireFaction.LeadersOnMissions[*].mission` | Rebel. |
| Both `ActionDeck`, `MissionDeck`, `ObjectiveDeck`, `ProjectDeck`, `ProbeDeck` | The opposing side. Player can see own deck *counts* and *discards*. |

The `ActionDeck` order is hidden from the owning player too (it shouldn't be —
cards are shuffled — but the owner can look at any time at their *hand*, not
their face-down deck above the line). Modeled by a `peek` capability on the
hand only.

---

## 7. Game state

```ts
GameState = {
  // Timing
  TimeMarker: number                    // 1..(track end)
  ReputationMarker: number              // starts 14, decreases toward TimeMarker
  Phase: 'Assignment' | 'Command' | 'Refresh' | 'Combat' | 'GameOver'
  CurrentPlayer: Side                   // alternates in Command Phase
  PassedThisCommand: Set<Side>          // a passed side cannot reveal/activate
                                        // but can still oppose missions and add
                                        // to combat (rr p.6)

  // Factions
  Rebel: FactionState
  Empire: FactionState

  // Map
  Map: MapState
  RebelBaseSystemId: SystemId           // secret; hidden in playerView
  RebelBaseRevealed: boolean
  RebelBaseSpace: SystemState           // staging area, see §3

  // Decks shared by both sides (probe deck is Empire-facing but its identity
  // pool is fixed by setup, so it lives at game root)
  ProbeDeck: ProbeCardId[]
  GroundTacticDeck: TacticCardId[]
  SpaceTacticDeck: TacticCardId[]

  // Mid-resolution scratch
  PendingMission?: MissionResolution    // see §8
  PendingCombat?: CombatState           // see §9
  PendingChoice?: ChoiceRequest         // see §10

  // End conditions
  IsGameOver: boolean
  Winner?: Side

  // Determinism
  Rng: SeededRng
  ControllerSeeds: { Rebel: number; Empire: number }

  // Telemetry
  TurnLog: LogEntry[]
}
```

---

## 8. Turn structure

```
Round:
  1. Assignment Phase
     Rebel assigns any leaders to missions (face-down), then Empire does.
     Skill icons of assigned leaders need not yet meet the mission's
     requirement — that is only checked at reveal time (rr p.8).

  2. Command Phase
     Starting with Rebel, players alternate. On a turn, the current player:
       (a) Activate a system with a leader from the pool → move units → maybe
           combat → maybe subjugate, OR
       (b) Reveal a mission a leader is assigned to → opposition? → resolve, OR
       (c) Pass.
     A passed player can still oppose missions and add to combats.
     Phase ends when both sides have passed.

  3. Refresh Phase (fixed sub-order, rr p.12)
     1. Retrieve leaders   (Rebel may play one Start-of-Refresh objective first)
     2. Draw missions      (down to 10 unless starting)
     3. Launch probe droids (Empire draws 2)
     4. Draw objective     (Rebel draws 1)
     5. Advance time marker
        - if 🛡 Recruit:  each draws 2 action cards, picks leader, keeps card
        - if 🛠 Build:    each builds 1 per resource icon to build queue
     6. Deploy units       (queue slides 3→2→1→board; max 2 per system)
```

Combat is a sub-machine entered mid-turn during (a). See §9.

---

## 9. Combat sub-machine

Combat occurs when a player moves units to a system where the opponent has
units, *and* both sides have units in the same theater (rr p.4). Resolved in
combat rounds:

```
Combat:
  1. Add leader      (current player decides first; then Start-of-Combat actions)
  2. Draw tactic cards (each side draws per leader's space/ground tactic value;
                       only for theaters where both sides have units)
  3. Combat round (repeat until one side has no units in either theater):
     I.   Space battle   (if both sides have ships)
     II.  Ground battle  (if both sides have ground units)
     III. Retreat option (current player first)
     IV.  Next round check
  4. End: discard hands, reshuffle tactic decks, remove damage markers.
```

Each Space/Ground sub-step:

```
SpaceBattle (current player attacks first, then opponent):
  for actor in [current, opponent]:
     attack(actor):
       1. Roll dice            (max 5 red + 5 black; reductions before cap)
       2. Combat actions       (any order, any count):
            - spend ⚡ die to draw a tactic card from this theater's deck
            - play a tactic card (matches theater; ⚡ cards cost a ⚡ die)
       3. Assign damage         (hit color must match unit health color;
                                 direct-hit can hit any color)
       4. Opponent blocks       (tactic cards only; can't block damage markers)
       5. Destroy units         (damage ≥ health → side stages destroyed unit
                                 on faction sheet, still attacks this round)
```

`CombatState` is held in `GameState.PendingCombat` while combat runs.
Resolution emits a sequence of `ChoiceRequest`s for both human and AI seats.

---

## 10. Choice requests (pause-resume)

Lifted from Tyrants / Innovation: every place the engine needs input, it sets
a `ChoiceRequest` and a `Paused: true` flag and returns. The seat's
`IPlayerController` fills in the response; the engine re-enters and proceeds.

```ts
type ChoiceRequest =
  | { kind: 'AssignLeaders'; missionId: MissionCardId; max: 1|2 }
  | { kind: 'ChooseSystem';   filter: SystemFilter; required: boolean }
  | { kind: 'ChooseLeader';   from: 'pool'|'system'; systemId?: SystemId }
  | { kind: 'OpposeMission';  missionSystemId: SystemId }   // yes-no + which leader
  | { kind: 'ChooseUnits';    pool: UnitRef[]; min: number; max: number }
  | { kind: 'AssignDamage';   dice: DieResult[]; targets: UnitRef[] }
  | { kind: 'PlayTacticCard'; hand: TacticCardId[]; allowSkip: boolean }
  | { kind: 'CombatAction';   options: CombatActionOption[] }   // draw/play/done
  | { kind: 'RetreatTo';      legal: SystemId[]; allowSkip: boolean }
  | { kind: 'BuildChoice';    side: Side; slots: BuildSlot[] }  // ambiguous resource type
  | { kind: 'DeployTarget';   unitType: UnitTypeId; legal: SystemId[] }
  | { kind: 'PickProbeForNewBase'; cards: ProbeCardId[] }       // Rapid Mobilization
  | { kind: 'PlayObjective';  legal: ObjectiveCardId[]; window: 'combat'|'refresh' }
  | { kind: 'YesNo';          prompt: string }
  | { kind: 'ChooseActionCard'; from: ActionCardId[] }          // Recruit pick
```

Multi-stage handlers stash progress in `EffectContext.HandlerState: unknown`
(typed per handler) — same idiom as the Innovation `AlchemyDrawRevealHandler`.

---

## 11. Mechanics façade

All state mutations route through `Mechanics.*`. Direct mutation of
`GameState` outside this module is a bug. Each mutation logs to `TurnLog` and
re-checks the end-of-game predicates.

```
// Map & units
ActivateSystem(side, leaderId, systemId)
MoveUnits(side, fromSystemId, toSystemId, units)       // honors transport,
                                                       // restriction, immobile
DeployUnit(side, unitTypeId, systemId)                 // honors 2/system cap
BuildUnitToQueue(side, unitTypeId, slot)
DestroyUnit(unitRef)                                   // → supply
DamageUnit(unitRef, amount)                            // mid-combat damage tracking
DestroySystem(systemId)                                // Superlaser Online

// Loyalty & subjugation (rr p.13)
GainLoyalty(side, systemId, amount)                    // amount=1 or 2
LoseLoyalty(side, systemId)
RecomputeSubjugation(systemId)                         // called after every move/destroy

// Rebel base
RevealRebelBase(reason)                                // moves staged units & leaders
EstablishNewBase(probeCardId)                          // Rapid Mobilization

// Leaders
AssignLeaderToMission(side, leaderId, missionId)
PlaceLeader(side, leaderId, systemId)
ReturnLeader(side, leaderId)                           // → pool
CaptureLeader(leaderId, ring)                          // Imperial gains; honors 1-ring rule
RescueLeader(leaderId)                                 // → Rebel Base space (or system if revealed)
EliminateLeader(leaderId)                              // → box

// Decks
DrawAction(side, n)
DrawMission(side, n)
DrawObjective(n)
DrawProbe(n)
DiscardMission(side, missionId)                        // honors starting-mission rule
PlayObjective(objectiveId)                             // → box, gain reputation

// Time / reputation
AdvanceTime(n=1)                                       // checks reputation==time
GainReputation(n)                                      // moves toward time marker
LoseReputation(n)

// Combat sub-machine
BeginCombat(systemId, attackerSide)
RollAttack(side)                                       // max 5R+5B (+3G if RoE)
ApplyTacticCard(side, cardId, targets)
EndCombat()                                            // discards tactic hands, etc.
```

Every map mutation re-runs:
1. `RecomputeSubjugation` for affected systems.
2. `RecomputeRebelBaseReveal` — reveal if Empire has loyalty OR ground units in the base system.
3. `RecomputeGameEnd`:
   - Empire wins if base revealed AND Imperial units in base system AND no Rebel units there (rr p.14).
   - Empire wins if base system destroyed.
   - Rebel wins if `ReputationMarker == TimeMarker`.

---

## 12. Specific quirks to model from day one

The pattern from Innovation: enumerate the gotchas now so the test suite hits
them before they're rediscovered by losing a playtest.

1. **Captured leaders contribute skills only when attempted *against***
   (rr p.3). In normal opposition they are inert. Hook into mission-resolution
   dice computation, not into a generic "leader contributes" path.

2. **Mission target is the leader's system** when "attempted against a leader"
   (rr p.9) — the resolving player must choose a system containing that leader,
   and *all leaders in that system* participate. Distinct from plain "choose
   a system".

3. **Rebel base reveal happens between movement and combat** (rr p.11). Order:
   activate → move units → if Empire ground units entered base system, reveal
   → then resolve combat. Don't fold reveal into combat setup.

4. **Subjugation cycles**: marker on when any Empire ground unit is present in
   a non-Imperial-loyalty system; off the moment the last Empire ground unit
   leaves. A Rebel loyalty marker can live underneath. Multi-step missions
   that move units mid-resolution can flip subjugation twice — `RecomputeSubjugation`
   must be idempotent and called after each unit move, not just at end-of-effect.

5. **"Gain" vs "build" vs "deploy"** (rr p.7, p.13):
   - **Build**: requires loyalty, requires no opponent unit, goes to build queue, blocked by sabotage.
   - **Deploy**: from queue/Rebel Base space → board; honors 2/system cap, blocked by sabotage and opponent units.
   - **Gain**: from supply → board directly; *bypasses* sabotage, queue, 2/system cap. Mission text uses this word deliberately.

6. **Death Star Plans** (rr p.6) is a Combat-window objective: usable only
   during space-battle round, requires ≥1 Rebel fighter in system, 3-die roll
   for a direct hit. Cannot target a Death Star inside a Shield Bunker system
   (RoE only — not in base). "One in a Million" action card auto-succeeds the
   roll.

7. **Retreat restrictions** (rr p.5):
   - Must retreat to own units / loyalty if able, else any adjacent
     unit-free system.
   - Cannot retreat to the system the opponent moved units from to start this
     combat — store the attacker's source system on `CombatState`.
   - Imperial cannot retreat at all if Death Star or DSUC is in the combat.
   - Rebel Transports, if the only Rebel ships, must retreat or are destroyed.
   - Each side can retreat at most once per combat.

8. **Transport capacity is per-ship-per-move** (rr p.14). When activating, each
   moving ship can carry up to its capacity of ground units + TIE Fighters.
   TIE Fighters require transport even though they're ships. Restriction-icon
   units can only move alongside a transporter from the *same* system.

9. **Coruscant** is locked-Imperial; loyalty mutations on it are no-ops, not
   errors. Encode as a system property, check at the top of `GainLoyalty` /
   `LoseLoyalty`.

10. **Hand limit timing** (rr p.12): the 10-mission limit (including project
    cards, excluding objectives) is enforced only at Refresh step 2. Players
    may hold >10 during Assignment and Command. Starting missions never
    discard.

11. **Mission-card return on leader loss** (rr p.9): if a leader on a
    face-down mission is eliminated, captured, or moved off, the mission card
    returns to its owner's hand *without* revealing — even for projects.

12. **Action card single-use** (rr p.2): used cards return to the box, not to
    a discard pile. Distinct from missions/tactics which discard-and-reshuffle.

---

## 13. Determinism

- One root `Rng` on `GameState`, seeded at `GameSetup.Create(seed)`.
- Per-side controller RNGs (AI tiebreaks) seeded from a `ControllerSeeds`
  record at setup.
- No `Date.now()`, no unseeded `Math.random()` in engine code.
- All shuffles (decks, probe deck, tactic decks) consume from `Rng`.
- Combat dice consume from `Rng`.
- Card data files are fixed-order; in-game shuffles are the only source of
  variability.

Same contract as Tyrants, Impulse, Innovation.

---

## 14. Persistence / replay

- **Per-turn snapshot** at the start of each player's Command-Phase turn and
  at the start of each Refresh Phase: base64 blob of `GameState` minus
  `PendingChoice`/`PendingCombat`/`PendingMission`. The UI disables "Copy
  state" while any of those are non-null.
- **Move log**: append-only `LogEntry[]`. Each entry has the `seed`-relative
  step index, the acting side, and a structured action descriptor. A game can
  be replayed from `(seed, controllerSeeds, log)` deterministically.

Mid-mission and mid-combat snapshots deliberately don't round-trip — same as
Innovation's mid-dogma rule.

---

## 15. Out of scope (deliberately, base-game v1)

- Team Game (3p / 4p)
- Rise of the Empire expansion (Shield Bunker, Interdictor, Assault Tank,
  Mon Cala Cruiser variants used as RoE alts, U-wing, TIE Striker, Rebel
  Vanguard, target markers, Subversion mission, immediate objectives,
  green/minor-skill dice, Cinematic Combat advanced tactic cards, Darth Vader
  mission set)
- Online multiplayer (single-machine hot-seat + AI seats)
- AI beyond `RandomController` + one `HeuristicController` per side at MVP

Data shapes leave room for the expansion (e.g. `Class: 'structure'`,
`MinorSkills`, `IsProject`, `targetMarkers`) but no handlers exist for any of
it.

---

## Decisions (locked 2026-05-19)

1. **Stack**: TS + React + boardgame.io, matching Tyrants. Cloudflare Worker
   pattern reserved for later (bug reports, log publishing).
2. **Asset source**: at first run, the player's browser fetches the FFG
   Vassal module (`Star Wars Rebellion_v1.02d.vmod`) directly from
   vassalengine.org; JSZip unpacks it in-browser; images cached in IndexedDB;
   schematic placeholder mode for users who skip. If vassalengine.org doesn't
   send `Access-Control-Allow-Origin`, a thin Cloudflare Worker proxies the
   archive solely to add the CORS header — no caching, no copying to project
   infrastructure. Same trust model as Tyrants fetching TTS art from imgur:
   publisher-uploaded files on a public community host, not redistributed by
   this project.
3. **Adjacency source**: traced from the .vmod's `Map.png` (3180×1590, the
   sole authority). Bootstrap pass written to `assets/adjacency.json`;
   user-corrected through the `?dev=1` adjacency tab (hover to highlight
   neighbors; click to enter edit mode; click adjacent systems to toggle).
   Same correction layer for systems, leaders, and cards via their
   respective dev tabs. See `docs/dev-tabs.md`.
4. **MVP scope**: 2-player hot-seat + 2-AI demo. Heuristic AI is post-MVP.
5. **Edition**: base game only. Expansion data hooks present, behavior absent.
