// Engine state types. Distinct from src/types.ts which holds data-file shapes.
// See docs/core-model.md for the rules-level model.

import type {
  Side, SystemId, ResourceIcon,
  Leader as LeaderData,
  ActionCard, MissionCard, ObjectiveCard, TacticCard, ProbeCard,
  ExpansionConfig,
} from '../types';

// Re-export the root data-file types the engine modules treat as engine types.
// They live in src/types.ts, but engine code imports them from './types'
// alongside the engine-state types — so surface them here. (Without this,
// `import type { Side, SystemId } from './types'` in combat.ts/phases.ts/etc.
// fails typecheck; it only worked at runtime because esbuild erases type-only
// imports. Run `npm run typecheck` to catch this class of issue.)
export type { Side, SystemId } from '../types';

// ---------- Units ----------

export type UnitTypeId = string; // 'tie-fighter', 'x-wing', 'death-star', ...
export type UnitInstanceId = string; // 'u-001' etc.

export type Theater = 'space' | 'ground';
export type UnitClass = 'capital' | 'fighter' | 'station' | 'ground' | 'structure';
export type UnitTier = 'triangle' | 'circle' | 'square';
export type HealthColor = 'red' | 'black' | null; // null = invulnerable (Death Star)

export type UnitType = {
  id: UnitTypeId;
  name: string;
  side: Side;
  theater: Theater;
  class: UnitClass;
  tier: UnitTier;
  health: { color: HealthColor; value: number };
  // RoE adds a third die colour (green); no 3-die cap on green (still capped
  // at 5 red / 5 black total, 3 green). Base-game units have green: 0.
  // Combat doesn't roll green dice until the Phase 6 new-rules module ships;
  // until then the field is present-but-ignored.
  attack: { red: number; black: number; green: number };
  transport: { capacity: number; restriction: boolean; immobile: boolean };
  buildResource: 1 | 2 | 3;
  supplyCount: number;
  set?: 'base' | 'rote'; // undefined = base game; 'rote' = Rise of the Empire
};

export type UnitInstance = {
  instanceId: UnitInstanceId;
  typeId: UnitTypeId;
  side: Side;
  damage: number; // mid-combat only; reset at end of combat
};

// ---------- Map ----------

export type SystemState = {
  loyalty: 'rebel' | 'imperial' | 'neutral';
  subjugated: boolean;
  destroyed: boolean;
  sabotage: boolean;
  units: UnitInstance[];
  // RoE rules p.8 "Target Markers": objective and mission cards may place a
  // marker on a system; the card lives ON the marker until something removes
  // it. Each marker is tagged with `source` (the card id that placed it) so
  // different cards' markers can coexist and each is removed/scored on its
  // own rule. Removal usually needs a Rebel ground unit in the system
  // (rules p.8: "When you have a ground unit in a system with a target
  // marker and your opponent does not have any ground units in the system,
  // you may remove the marker..."), but per-card text overrides this.
  // Absent/undefined when no markers are present so base-game state remains
  // byte-identical.
  targetMarkers?: TargetMarker[];
};

export type TargetMarker = {
  source: string;       // card id that placed it (e.g. 'secure-the-plans', 'show-no-fear')
  placedBy: 'Rebel' | 'Empire';
  placedAt?: number;    // optional round/turn stamp for "still present at start of refresh" checks
};

/** RoE: an action card the player has ARMED with a facedown probe card.
 *  Used by Secret Facility + Sweep the Area. The committed system (the
 *  destination the chosen probe pointed to) is stored as `probeSystemId`;
 *  the card itself sits in `FactionState.armedActionCards` until its
 *  trigger window auto-reveals it. */
export type ArmedActionCard = {
  cardId: string;        // 'secret-facility' | 'sweep-the-area'
  probeSystemId: string; // the system the chosen probe revealed
  armedAt: number;       // timeMarker stamp
};

// The Rebel Base space is not a system but uses the same state shape for unit/leader staging.
export type RebelBaseSpaceState = SystemState;

export type MapState = {
  systems: Record<SystemId, SystemState>;
  rebelBaseSpace: RebelBaseSpaceState;
};

// ---------- Leaders / decks ----------

export type LeaderId = string;

export type AssignedMission = {
  missionId: string;
  leaderIds: LeaderId[]; // 1 or 2
  // True when the card was pulled straight from the deck by a search effect
  // (Our Most Desperate Hour / Proceeding As Planned) rather than assigned
  // from hand. Un-assigning such a mission returns it to the DECK, not the
  // hand — otherwise you could search the deck, assign, un-assign, and keep
  // any mission in hand for free (player report #108).
  fromDeck?: boolean;
  // The action card that fetched this mission from the deck (Our Most Desperate
  // Hour / Proceeding As Planned). It was discarded when played; un-assigning
  // the mission returns this card to the owner's hand too, fully undoing the
  // play (player report #279).
  viaCard?: string;
};

export type CapturedLeader = {
  leaderId: LeaderId;
  ring: 'captured' | 'carbonite';
  // Per Rules Reference: captured leaders stay at a system. The Imperial
  // player can move them like ground units. If the system has no Imperial
  // units, the leader is immediately rescued.
  systemId: SystemId;
};

export type AttachmentRing = {
  leaderId: LeaderId;
  ringId: string; // 'r2d2', 'c3po', 'master-yoda', 'millennium-falcon', 'lure-of-dark-side', 'carbonite', 'captured'
};

export type BuildQueue = {
  1: UnitTypeId[];
  2: UnitTypeId[];
  3: UnitTypeId[];
};

export type FactionState = {
  side: Side;

  // Leaders
  leaderPool: LeaderId[];
  leadersOnBoard: Record<SystemId, LeaderId[]>; // includes 'rebel-base-space' key
  leadersOnMissions: AssignedMission[];
  eliminatedLeaders: LeaderId[];
  attachmentRings: AttachmentRing[]; // active rings on this side's leaders
  // RoE "Ambitions of Power" (Motti/Jabba) bumps the leader-pool cap by 1
  // for the rest of the game. enforceLeaderPoolCap reads 8 + this bonus.
  // Absent/undefined ⇒ 0.
  leaderPoolCapBonus?: number;
  // RoE "Under the Radar" (Rebel): a probe card pulled out of the deck and
  // held facedown. At the start of each Rebel Command turn the Rebel may
  // return it to the top of the probe deck. Holding it keeps that system
  // out of the Empire's probe draws. Rebel-only.
  heldProbe?: string;
  // RoE Cinematic Combat: this side's advanced tactic cards that have been
  // PLAYED. Unlike the standard tactic deck (reshuffled each combat), a
  // played advanced card is NOT shuffled back at end of combat (rules p.9)
  // — it's gone for the rest of the game. A side's AVAILABLE cinematic
  // cards = all their side+theatre advanced cards minus this pile. Present
  // only in cinematic games.
  cinematicTacticDiscard?: string[];
  // RoE Cinematic Combat: advanced tactic cards that say "eliminate this card"
  // when their effect resolves (e.g. Confrontation). Unlike a normal discard
  // — which is recycled back into the deck once the deck empties (rules p.8) —
  // an eliminated card is GONE for the rest of the game and must never return
  // to the deck. Tracked separately so recycle/availability can exclude it.
  cinematicTacticEliminated?: string[];
  // RoE multi-turn action cards "armed" with a facedown probe (Secret
  // Facility, Sweep the Area). The probe card's destination system is
  // recorded as `probeSystemId`; the action card is out of the hand and
  // discard until it's revealed at its own RAW trigger window. Empire-only
  // in practice (both cards are Imperial).
  armedActionCards?: ArmedActionCard[];

  // Card piles
  actionDeck: string[];
  actionHand: string[];
  actionDiscard: string[]; // returned to the box, kept for analytics only
  // Starting action cards not dealt to the opening hand. RoE "Early
  // Promotion" / "Rebel Extremist" let a player draw 1 from this pile as an
  // alternative to their recruit branch. Empty once exhausted. Present on
  // both sides; only the RoE cards consume it.
  startingActionDeck?: string[];

  missionDeck: string[];
  missionHand: string[];
  missionDiscard: string[];

  // Build
  buildQueue: BuildQueue;

  // Rebel-only
  objectiveDeck?: string[];
  objectiveHand?: string[];
  objectiveDiscard?: string[];
  // Every objective the Rebel has SCORED for reputation, in order, for the UI's
  // scored-objectives list (player request: Foggy Leggy). Distinct from
  // objectiveDiscard, which also holds objectives discarded without scoring.
  scoredObjectives?: { objectiveId: string; reputation: number; turn: number }[];
  // RoE persistent place-on-play objectives (Rebel Cell, Raid Outposts) that
  // have already placed their marker(s), so the Refresh pre-step doesn't
  // re-prompt placement after the markers are later removed/scored.
  activatedPersistentObjectives?: string[];

  // Empire-only
  probeHand?: string[];
  projectDeck?: string[];
  projectDiscard?: string[];
  capturedLeaders?: CapturedLeader[];
};

// ---------- Game flow ----------

export type Phase = 'Setup' | 'Assignment' | 'Command' | 'Refresh' | 'GameOver';

// How the engine resumes after an "Immediate" objective's placement choice
// (Raid Outposts / Rebel Cell), which can be drawn in different contexts:
//   'command'     — drawn during a Command-phase action (resume advanceCommandTurn)
//   'refresh-draw'— drawn during the Refresh draw step (resume the rest of Refresh)
export type ImmediateResume = 'command' | 'refresh-draw';

export type ChoiceRequest =
  | { kind: 'AssignLeaders'; missionId: string; min: 1; max: 1 | 2 }
  | { kind: 'ChooseSystem'; legal: SystemId[]; allowSkip: boolean }
  | { kind: 'ChooseLeader'; from: 'pool' | 'system'; systemId?: SystemId; legal: LeaderId[] }
  | {
      kind: 'OpposeMission';
      missionId: string;
      targetSystemId: SystemId;
      opposerSide: Side;
      skill: string;            // mission's required skill (for tooltip)
      attackerDice: number;     // count of dice the resolver will roll
      attackerPortrait: number; // +successes from the mission's pictured leader (rr p.9)
      poolLeaders: LeaderId[];  // opposer's pool leaders available to send
      existingAtTarget: LeaderId[]; // already-there opposer leaders (auto-oppose)
      // Set when the opposer has a Subversion mission assigned: revealing it is a
      // "may" (RAW), so the opposer chooses whether to use it (moves these leaders
      // to the target + rolls 1 extra die). resolveOpposition's `useSubversion`
      // controls it. (#311)
      subversion?: { missionId: string; leaderIds: LeaderId[] };
    }
  | { kind: 'AssignDamage'; dice: DieResult[]; targets: UnitInstanceId[] }
  | { kind: 'PlayTacticCard'; hand: string[]; allowSkip: boolean }
  | { kind: 'CombatAction'; options: CombatActionOption[] }
  | { kind: 'RetreatTo'; legal: SystemId[]; allowSkip: boolean }
  | { kind: 'DeployTarget'; unitTypeId: UnitTypeId; legal: SystemId[] }
  | { kind: 'PickProbeForNewBase'; cards: string[] }
  | { kind: 'PlayObjective'; side: Side; legal: string[]; window: 'combat' | 'refresh'; logStart?: number; allowDecline?: boolean }
  // RoE Rebel Cell — place the card's target marker in a chosen Rebel system.
  // `resumeKind` = how the engine resumes after placement (the Immediate
  // objective can be drawn during the Command phase or the Refresh draw step).
  | { kind: 'RebelCellPlace'; side: 'Rebel'; legal: SystemId[]; logStart?: number; resumeKind?: ImmediateResume }
  // RoE Rebel Cell — at Refresh, optionally discard 1 objective from hand to
  // gain 1 reputation (instead of playing an objective). `legal` is the
  // discardable objective-card ids; the player may also decline.
  | { kind: 'RebelCellDiscard'; side: 'Rebel'; legal: string[]; logStart?: number }
  // RoE Raid Outposts — the Imperial player places the card's 2 target markers
  // in 2 chosen remote systems. `legal` is the eligible remote system ids.
  | { kind: 'RaidOutpostsPlace'; side: 'Empire'; legal: SystemId[]; count: number; logStart?: number; resumeKind?: ImmediateResume }
  | { kind: 'YesNo'; prompt: string }
  | { kind: 'ChooseActionCard'; from: string[] }
  | { kind: 'InfiltrationPick'; missionId: string; topId: string; bottomId: string }
  // RoE Safe Haven — Rebel chooses up to 2 units from their build queue to
  // deploy at the mission system. `units` is the flat pickable list (slot +
  // index into that slot's queue + typeId). Resolver takes the chosen indices.
  | { kind: 'SafeHavenPick'; side: 'Rebel'; systemId: SystemId; units: { slot: 1 | 2 | 3; index: number; typeId: string }[] }
  | {
      // Covert Operation: drew 2 objectives, keep 1 (into hand), other
      // goes to the bottom of the deck. Distinct from InfiltrationPick
      // because the kept card lands in HAND, not back on top of the deck.
      kind: 'CovertOperationPick';
      missionId: string;
      drawnIds: [string, string];
    }
  | {
      // Oversee Project: Imperial player picks 1 unit from buildQueue
      // space 1 or 2 to deploy at the target system.
      kind: 'OverseeProjectPick';
      side: Side;             // always 'Empire'
      targetSystemId: SystemId;
      candidates: { slot: 1 | 2; queueIndex: number; unitTypeId: UnitTypeId }[];
    }
  | {
      // Capture Rebel Operative: Empire picks which Rebel leader at the
      // target system to capture (when multiple are present).
      kind: 'CaptureOperativePick';
      side: Side;             // always 'Empire'
      targetSystemId: SystemId;
      candidates: LeaderId[];
    }
  | {
      // Carbon Freezing: Empire picks which captured Rebel leader to
      // promote to the Carbonite ring (when multiple captured w/o ring).
      kind: 'CarbonFreezingPick';
      side: Side;             // always 'Empire'
      candidates: LeaderId[];
    }
  | {
      // Lure Of The Dark Side: Empire picks which Rebel leader at the
      // target system to flip with the Dark-Side ring.
      kind: 'LureOfTheDarkSidePick';
      side: Side;             // always 'Empire'
      targetSystemId: SystemId;
      candidates: LeaderId[];
    }
  | {
      // Homing Beacon: Empire picks a Rebel leader to rescue from
      // captured-state AND a system (in the Rebel base region) to place
      // them in. Two-stage: leader pick, then system pick. We bundle
      // both into one choice; UI presents both selectors.
      kind: 'HomingBeaconPlace';
      side: Side;             // 'Rebel' — RAW: the Rebel places the rescued leader
      leaderCandidates: LeaderId[];
      systemCandidates: SystemId[];
    }
  | {
      // Destroy up to N health worth of opponent units at a system.
      // Used by Hunt Them Down (Empire kills Rebels), Hit and Run
      // (Rebel kills Empire), Wookie Uprising (Rebel kills Empire).
      // Resolver expects an array of instance IDs whose total health
      // is <= budget.
      kind: 'DestroyUpToHealth';
      side: Side;
      systemId: SystemId;
      candidates: UnitInstanceId[];
      budget: number;
      // Optional cap on the NUMBER of units (separate from the health budget).
      // Plant Explosives: "destroy up to 3 ground units, combined health up to
      // the difference in successes" — 3 units AND health <= margin (#303).
      unitCap?: number;
      cardName: string;
    }
  | {
      // Rogue Squadron Raid: Rebel destroys up to 4 health from
      // Empire's build queue. Candidates are queue items identified
      // by (slot, queueIndex).
      kind: 'RogueSquadronRaidPick';
      side: Side;
      candidates: { slot: 1 | 2 | 3; queueIndex: number; unitTypeId: UnitTypeId; health: number }[];
      budget: number;
    }
  | {
      // Double Our Efforts: Empire picks 1 unit on space 2 or 3 to
      // move down. Picks-count is 1 normally, 2 if Moff Jerjerrod
      // is the resolver.
      kind: 'DoubleOurEffortsPick';
      side: Side;
      candidates: { slot: 2 | 3; queueIndex: number; unitTypeId: UnitTypeId }[];
      picksAllowed: 1 | 2;
    }
  | {
      // Planetary Conquest: Empire picks 1 source system to draw
      // 1 AT-AT, 1 AT-ST, up to 2 Stormtroopers from.
      kind: 'PlanetaryConquestSourcePick';
      side: Side;
      targetSystemId: SystemId;
      // Pre-computed legal picks per source: which instance IDs
      // would move if this source were chosen.
      sources: { sourceSystemId: SystemId; picks: UnitInstanceId[] }[];
    }
  | {
      // Fear Will Keep Them In Line: Empire picks 2 systems in this
      // region to gain 1 loyalty in. Candidates may include the
      // target system itself.
      kind: 'FearWillKeepThemInLinePick';
      side: Side;
      candidates: SystemId[];
      count: 2;
    }
  | {
      // Public Uprising: Rebel picks composition for 1 circle + 2
      // triangle units, then combat fires at the target.
      kind: 'PublicUprisingPick';
      side: Side;
      systemId: SystemId;
    }
  | {
      // Support Of Mon Calamari: binary choice between gaining 2
      // loyalty at Mon Calamari OR placing a MC Cruiser on slot 3.
      kind: 'SupportOfMonCalamariPick';
      side: Side;
      monCalaLoyalty: 'rebel' | 'imperial' | 'neutral';
      monCalaSubjugated: boolean;
      // False when all 3 Mon Calamari Cruisers are already in play/queued
      // (RR p.6 component limits) — the cruiser option must be unavailable.
      cruiserAvailable: boolean;
    }
  | {
      // Refresh-phase deploy step: a unit fell off slot 1 of the build
      // queue and the player must pick a legal system to deploy it into.
      // Per RR p.7: any system the side controls (or subjugates, for
      // Empire), without enemy units, without sabotage, not remote, not
      // destroyed. Rebel-base-space is also legal if the base is hidden.
      kind: 'DeployUnitPick';
      side: Side;
      typeId: UnitTypeId;
      candidates: SystemId[];
      // All unit types still waiting to be deployed for this side this Refresh,
      // with counts — so the player can choose WHICH type to place next instead
      // of being walked through them in a fixed grouped order (player report: had
      // to "save" every Stormtrooper to reach the Star Destroyer). Switching the
      // active type re-posts the pick for it via switchDeployType.
      remaining: { typeId: UnitTypeId; count: number }[];
    }
  | {
      // Secret Facility (RoE Empire): on reveal it places 1 Shield Bunker + "1
      // triangle ground unit". With RoE units in play that's Stormtrooper OR
      // Assault Tank, so the player chooses (#396). The Shield Bunker is already
      // placed; this pick deploys the chosen triangle unit, then resolves combat.
      kind: 'SecretFacilityUnitPick';
      side: Side; // 'Empire'
      systemId: SystemId;
      candidates: UnitTypeId[]; // triangle ground unit types with supply
    }
  | {
      // Secret Facility (RoE Empire): "you MAY reveal" at the start of your
      // Command turn — the reveal is optional (#396). Decline keeps the facility
      // armed for a later turn; reveal places the units and resolves combat.
      kind: 'ArmedCardRevealOffer';
      side: Side; // 'Empire'
      cardId: string; // 'secret-facility'
      systemId: SystemId;
    }
  | {
      // Death Star Plans 2/3 (Rebel objective, Combat-timed). RAW:
      // "If there is at least 1 fighter after the space battle step, reveal
      // this card to roll 3 dice. If you roll a direct hit, play this card
      // and destroy a Death Star in this system. Otherwise return this card
      // to your hand."
      // The Rebel may DECLINE to reveal (e.g. low-odds roll, save for a
      // better attempt later this game). Posted at end of combat when the
      // conditions are met.
      kind: 'DeathStarPlansAttempt';
      side: Side; // Rebel
      objectiveId: string; // 'death-star-plans-2' or 'death-star-plans-3'
      systemId: SystemId;
      deathStarInstanceIds: UnitInstanceId[];
    }
  | {
      // R2-D2 (Resourceful Astromech) ring effect. RAW: "discard to turn 1
      // opponent's die to the blank side." Posted after an Empire roll
      // (combat attack OR mission) if the Rebel holds the card. Rebel may
      // SKIP (preserve the card for later) or PICK one die index to flip.
      kind: 'R2D2Flip';
      side: Side; // Rebel
      // 'combat' = applied to pendingCombat.pendingAttack.dice
      // 'mission' = applied to pendingMission.r2d2Pending stash
      context: 'combat' | 'mission';
      // Combat-only: which theater (for the panel header).
      theater?: Theater;
      systemId: SystemId;
      // For combat: indices into pendingAttack.dice that aren't blank.
      // For mission: indices into the Empire-rolled faces array (whichever
      // roll triggered this — attacker or opposer side).
      flippableDieIndices: number[];
      // Mission-only: the actual faces array we're flipping (for display).
      missionFaces?: string[];
      // Mission-only: the Rebel's OWN roll + the running success tallies, so
      // the flip decision isn't made blind to your own result (forum report:
      // "you can see the empire result but not your own").
      ownFaces?: string[];
      ownSuccesses?: number;
      empireSuccesses?: number;
    }
  | {
      // Interrogation Droid (Empire mission): "Rebel must name 3 systems,
      // one of which contains the Rebel base." We let the Rebel pick the
      // 2 decoys; the engine inserts the actual base as the third so the
      // narration reveals exactly what RAW reveals.
      kind: 'InterrogationDroidDecoyPick';
      side: Side; // Rebel
      candidates: SystemId[];
      count: number; // always 2 — the decoys; base is added by the resolver
    }
  | {
      // Retrieve The Plans (Empire mission): Empire picks 1 card from the
      // Rebel's revealed objective hand to send to the bottom of the deck.
      kind: 'RetrieveThePlansPick';
      side: Side; // Empire
      candidates: string[]; // objective card ids (Rebel's hand)
    }
  | {
      // Detained (Empire mission): Empire picks which Rebel leader (at any
      // system) gets the "skip next refresh retrieve" mark. RAW says
      // "against a Rebel leader" so the target is implied by the assigned
      // mission's revealMission target system, but to be general we offer
      // a pick of all Rebel leaders currently on the board (matches a
      // common reading of the card).
      kind: 'DetainedTargetPick';
      side: Side; // Empire
      candidates: LeaderId[];
    }
  | {
      // Contingency Plan (Rebel mission): after resolving, the Rebel picks
      // a starting mission from their hand and reassigns the resolver
      // leader to it.
      // Hidden Fleet (Rebel mission): Rebel picks which units at the Rebel
      // Base space to move to the target system. Engine validates transport
      // rules (capacity-shipping for fighters/ground, immobile exclusion).
      // Our Most Desperate Hour (Rebel action card, Leia): Rebel searches
      // their full mission deck for any mission, takes it into hand, and
      // assigns Leia to it. RAW info-leak: the search reveals the deck.
      // Brilliant Administrator (Empire/Tarkin): immediately build at Tarkin's
      // system using its resource icons. Mirror of TemporaryAllianceBuildPick
      // for Empire units.
      // C-3PO (Human-Cyborg Relations ring): after a diplomacy mission
      // fails, the Rebel may discard the C-3PO ring to convert the failure
      // into success. Post-finalize trigger.
      // Son of Skywalker (Rebel): after Luke's mission succeeds, may discard
      // the card to pull Seek Yoda or Daring Rescue into the Rebel's hand.
      // Noble Sacrifice (Rebel/Obi-Wan): when Obi-Wan is captured, may
      // discard this card to eliminate Obi-Wan instead, gaining 1 reputation.
      // One In A Million (Rebel/Luke|Wedge): after rolling, may discard to
      // set up to 2 dice faces to results of choice. Works on Rebel-side
      // rolls in both combat and mission contexts.
      kind: 'OneInAMillionOffer';
      side: Side; // 'Rebel'
      // 'dsplans' = set faces of the Death Star Plans objective roll (the card
      // explicitly works on that roll for an automatic success).
      context: 'combat' | 'mission' | 'dsplans';
      // Whether the Rebel is the attacker or opposer (mission) / which side's
      // dice are flippable (combat).
      rebelRoleInRoll: 'attacker' | 'opposer';
      // Dice faces + colors to choose from. Resolver returns chosen indexes
      // + target faces; engine validates and applies.
      faces: string[];
      // Die colors are DieColor ('red' | 'black' | 'green'); combat dice are
      // only red/black but the field is fed straight from DieResult.color, and
      // the dice renderers handle every DieColor.
      colors: DieColor[];
    }
  | {
      kind: 'NobleSacrificeOffer';
      side: Side; // 'Rebel'
    }
  | {
      // It Is Your Destiny (Empire/Vader): after a Rebel rescue at a system
      // where Vader is, may discard this card to have Vader capture one of
      // the rescuing leaders.
      kind: 'ItIsYourDestinyOffer';
      side: Side; // 'Empire'
      candidates: LeaderId[]; // rescuing leaders to potentially capture
    }
  | {
      // Track Them (Empire, RoE Special): after a Rebel unit retreats from
      // combat, may discard this card to return one Empire leader at the
      // combat's system to the leader pool.
      kind: 'TrackThemOffer';
      side: Side; // 'Empire'
      systemId: SystemId; // the combat system
      candidates: LeaderId[]; // Empire leaders currently at the combat system
    }
  | {
      // Something to Fight For (Rebel/Jyn, RoE Special): after a battle the
      // Rebel won, may discard this card to choose a discarded objective
      // card and put it on top of the deck.
      kind: 'SomethingToFightForOffer';
      side: Side; // 'Rebel'
      candidates: string[]; // objective card ids in the discard pile
    }
  | {
      // RoE Immediate-action-card play modal (the analogue of
      // PlayAssignmentActionCard but for cards with timing === 'Immediate'
      // that don't go through the droid-ring path). Empire/Rebel opens this
      // via requestImmediateActionCardPlay during their own Command or
      // Assignment turn; picking a card calls playImmediateActionCard,
      // which dispatches to applyImmediateActionCardEffect.
      kind: 'PlayImmediateActionCard';
      side: Side;
      candidates: string[]; // card ids
    }
  | {
      // RoE Secret Facility / Sweep the Area arming step: after the player
      // picked the card from the immediate-play modal, pick which probe
      // card from their probe hand to place facedown under it (the chosen
      // probe's system is the committed target). The action card moves out
      // of the actionHand and into FactionState.armedActionCards; the
      // probe is consumed.
      kind: 'ArmCardProbePick';
      side: Side; // 'Empire'
      cardId: string; // 'secret-facility' | 'sweep-the-area'
      candidates: string[]; // probe card ids in the player's probe hand
      // Set when the card auto-fired on being recruited (RAW Immediate timing):
      // the resolver resumes the paused recruit/refresh flow afterward (#314).
      viaRecruit?: boolean;
    }
  | {
      // Post Bounty (Empire/Jabba, RoE Special): after a Rebel mission fails,
      // may discard this card to attach a bounty ring to one of the Rebel
      // leaders that attempted it. If the bountied leader is later captured,
      // Rebels lose 1 reputation.
      kind: 'PostBountyOffer';
      side: Side; // 'Empire'
      missionId: string;
      candidates: LeaderId[]; // Rebel leaders that attempted the failed mission (un-ringed)
    }
  | {
      // Ambitions of Power (Empire/Motti or Jabba, RoE Special): when the
      // Empire leader pool would exceed the 8-leader cap, may discard this
      // card to raise the cap by 1 for the rest of the game.
      kind: 'AmbitionsOfPowerOffer';
      side: Side; // 'Empire'
      currentPoolSize: number;
      currentCap: number;
    }
  | {
      // RoE Leader Pool Limit (p.8): over the 8-leader cap, the player CHOOSES
      // which leader to eliminate (one per choice; re-posts until at cap).
      // `candidates` = the leaders in the pool; `overBy` = how many still over.
      kind: 'LeaderPoolEliminate';
      side: Side;
      candidates: LeaderId[];
      overBy: number;
    }
  | {
      // Discredit Rebellion (Empire/Motti, RoE): Rebel chooses to remove
      // ALL sabotage markers on the board OR to roll dice (1 normally,
      // 2 if Motti assigned). On any success on the roll, Rebels lose 1
      // reputation.
      kind: 'DiscreditRebellionChoice';
      side: Side; // 'Rebel'
      diceCount: 1 | 2;
      sabotageSystemIds: string[]; // every system with a sabotage marker
    }
  | {
      // Secret Mission (Rebel/Cassian Andor, RoE): peek the top 6 of the
      // mission deck and pick `keepCount` (1 normally, 2 with Andor
      // assigned) to add to the Rebel mission hand. The remaining cards
      // get shuffled back into the deck.
      kind: 'SecretMissionPick';
      side: Side; // 'Rebel'
      remaining: string[]; // mission ids still to choose from
      kept: string[];      // accumulating picks (resolves when length === keepCount)
      keepCount: 1 | 2;
    }
  | {
      // RoE: shared pick modal for "recruit a leader from a list and place
      // them in this system" missions — Hire Mercenaries, Imperial
      // Promotion, Rebel Promotion, My Only Hope. Posted when 2+ eligible
      // candidates remain; with 0 or 1 the handler resolves auto.
      kind: 'MissionRecruitLeaderPick';
      side: Side;
      candidates: LeaderId[];
      systemId: SystemId;
      cause: string; // mission id (for the log + UI title)
    }
  | {
      // Reconnaissance (Rebel, RoE): the Rebel picks a discarded mission
      // to return to hand. Posted with all missions in rebel.missionDiscard
      // as candidates.
      kind: 'ReconnaissancePick';
      side: Side; // 'Rebel'
      candidates: string[]; // mission ids in the discard pile
    }
  | {
      // Draw Them Out (Empire/Krennic, RoE): Empire picks a Rebel leader
      // from the leader pool to place into the target system. Posted with
      // candidates = full Rebel pool when 2+ choices exist.
      kind: 'DrawThemOutPick';
      side: Side; // 'Empire'
      candidates: LeaderId[]; // all Rebel leaders currently in their pool
      systemId: SystemId;
    }
  | {
      // Regional Aid (Rebel, RoE): Rebel picks an "elsewhere" system in
      // the same region as the target to gain a second loyalty marker on.
      kind: 'RegionalAidPick';
      side: Side; // 'Rebel'
      candidates: SystemId[]; // populous, non-Coruscant systems in the same region (except the target)
      targetSystemId: SystemId;
    }
  | {
      // Superlaser Online (Empire project): after destroying the system, the
      // Empire picks 1 populous system in the same region to gain Imperial
      // loyalty on (it's the player's choice, not auto-picked — player #284).
      kind: 'SuperlaserLoyaltyPick';
      side: Side; // 'Empire'
      candidates: SystemId[];
      destroyedSystemId: SystemId;
    }
  | {
      // Destroyed-system overflow (RR p.7 "Destroyed Systems"): when a system is
      // destroyed (Superlaser Online) and the Empire's ground there exceeds the
      // transport capacity of its ships in the system, the EMPIRE chooses which
      // excess ground units to destroy. Only posted for a genuine choice
      // (capacity > 0 and mixed unit types); the 0-capacity / no-excess cases
      // are auto-handled. (#286)
      kind: 'DestroyedSystemCull';
      side: Side; // 'Empire'
      systemId: SystemId;
      candidates: UnitInstanceId[]; // the Empire's ground units in the system
      destroyCount: number;         // how many must be destroyed
    }
  | {
      // Behind Enemy Lines (Rebel, RoE): pick up to 5 units (ANY theatre)
      // from the Rebel Base to move to the target system, ignoring leaders
      // and adjacency, then resolve combat. Like LeadStrikeTeamUnits but
      // not ground-restricted and max 5.
      kind: 'BehindEnemyLinesUnits';
      side: Side; // 'Rebel'
      targetSystemId: SystemId;
      sourceSystemId: SystemId; // 'rebel-base-space' or the base's system post-reveal
      availableUnitIds: UnitInstanceId[];
      max: number; // 5
    }
  | {
      // We're the Bait (Empire, RoE): the Empire picks up to 4 HEALTH of
      // Rebel ground units from the Rebel Base to drag to the target and
      // resolve combat. Health-budgeted rather than count-capped.
      kind: 'WereTheBaitUnits';
      side: Side; // 'Empire'
      targetSystemId: SystemId;
      sourceSystemId: SystemId;
      availableUnitIds: UnitInstanceId[];
      healthBudget: number; // 4
    }
  | {
      // Imperial Might (Empire, RoE): pick up to 4 units from build queue
      // space 1 to deploy at the target. `queueTypeIds` is a snapshot of
      // slot-1 contents (a list of unit type ids); the player picks up to
      // `max` indices into it. leaderIds carries the assigned leaders so
      // the resolver can do the "if 2 leaders, move them to Coruscant"
      // clause after deployment.
      kind: 'ImperialMightUnits';
      side: Side; // 'Empire'
      targetSystemId: SystemId;
      queueTypeIds: string[]; // slot-1 unit type ids
      max: number; // 4
      leaderIds: LeaderId[];
    }
  | {
      // Break Their Will (Empire, RoE): Empire names a system; the Rebel
      // must reveal whether their hidden base is in that system's region.
      // Candidates are every nameable system (non-Coruscant).
      kind: 'BreakTheirWillPick';
      side: Side; // 'Empire'
      candidates: SystemId[];
    }
  | {
      // Heist (Rebel/Jyn, RoE): "Remove 1 target marker. If on a Death Star
      // or DSUC, you may draw the top objective card instead." Posted when
      // there's a real decision — multiple markers, or a DS/DSUC present
      // (so the draw-objective branch is available).
      kind: 'HeistChoice';
      side: Side; // 'Rebel'
      systemId: SystemId;
      canDrawObjective: boolean; // true when a DS/DSUC is in the system
      markerSources: string[];   // card-id sources of the target markers present
    }
  | {
      // Establish Trade Relations (Rebel): choose to gain 2 loyalty in the
      // system OR place 1 Mon Calamari Cruiser on space 3 of the build queue.
      // Only posted when the Cruiser option is actually available (one is in
      // supply and the system isn't sabotaged); otherwise loyalty applies.
      kind: 'EstablishTradeChoice';
      side: Side; // 'Rebel'
      systemId: SystemId;
    }
  | {
      // Under the Radar (Rebel, RoE): pick 1 of the top 4 peeked probe
      // cards to hold facedown (pulled out of the deck). After the pick, the
      // Rebel reorders the remaining peeked probes top/bottom (UnderTheRadarReorder).
      kind: 'UnderTheRadarKeep';
      side: Side; // 'Rebel'
      candidates: string[]; // the top-N probe card ids (<= 4)
      // Set when the card auto-fired on a Command turn (resolve → advance turn).
      autoFlush?: boolean;
      // Set when the card fired immediately on being recruited (RAW "Immediate"
      // timing) — the resolver resumes the paused recruit/refresh flow (#289).
      viaRecruit?: boolean;
    }
  | {
      // Sabotage (Rebel, RoE): the target system has BOTH an Imperial Shield
      // Bunker and is populous, so the Rebel chooses between destroying the
      // Shield Bunker or placing a sabotage marker (player report #362).
      kind: 'SabotageChoice';
      side: Side; // 'Rebel'
      systemId: SystemId;
      bunkerInstanceId: string;
    }
  | {
      // After a rescue mission (RR p.12): "any leaders assigned to the mission
      // may also move to the 'Rebel Base' space." The rescued prisoner already
      // went to the base; this offers the RESCUING leaders the choice to follow
      // or stay in the mission system. (For the Greater Good forces them to stay,
      // so it doesn't post this.) Player report #346.
      kind: 'RescuerReturn';
      side: Side; // 'Rebel'
      systemId: SystemId;
      leaderIds: LeaderId[]; // the assigned leaders currently in the system
    }
  | {
      // Under the Radar — second step (RoE): "replace the others at the top or
      // bottom of the deck in any order." After holding 1 probe, the Rebel
      // places each remaining peeked probe on the top or bottom of the probe
      // deck. Carries the same continuation flags so the resolver can resume
      // the auto-flush / recruit flow once placement is done.
      kind: 'UnderTheRadarReorder';
      side: Side; // 'Rebel'
      cards: string[]; // the remaining peeked probe ids to place
      autoFlush?: boolean;
      viaRecruit?: boolean;
    }
  | {
      // Under the Radar return offer: at the start of a Rebel Command turn
      // while a probe is held facedown, the Rebel may return it to the top
      // of the probe deck (or keep holding it).
      kind: 'UnderTheRadarReturn';
      side: Side; // 'Rebel'
      heldProbe: string;
    }
  | {
      // RoE Early Promotion / Rebel Extremist binary branch: draw a starting
      // action card, OR take the recruit branch (recruit Motti / Saw +
      // side effects). `cardId` identifies which RoE card posted this.
      kind: 'StartingCardBranch';
      side: Side;
      cardId: string; // 'early-promotion' | 'rebel-extremist'
      // Whether the draw branch is available (the starting-action draw pile
      // is non-empty). The recruit branch is always offered.
      canDraw: boolean;
    }
  | {
      // RoE Cinematic Combat: this side picks one advanced tactic card to
      // play in this theatre this round (resolving its primary or secondary
      // ability), or skips. Posted by runTheater before the dice attacks.
      kind: 'CinematicTacticSelect';
      side: Side;
      theater: 'space' | 'ground';
      round: number;
      // True when this is an EXTRA play (Imposing Presence / Fleet Logistics /
      // Confrontation) — resolved immediately, outside the simultaneous
      // collect-then-resolve ordering used for each side's first card.
      extra?: boolean;
      // RoE "Good Intel": when the Empire holds it, the Rebel chooses+reveals
      // its tactic first, then the Empire picks knowing the Rebel's card. This
      // carries the Rebel's already-revealed selection so the Empire's modal
      // can show it (null = Rebel skipped / had no card this round).
      revealedOpponentTactic?: { cardId: string; name: string } | null;
      options: {
        cardId: string;
        name: string;
        primaryText: string;
        secondaryText: string;
        // Whether the primary (top) ability is resolvable — its primaryUnit
        // is present in the system. The secondary is always resolvable.
        primaryUsable: boolean;
      }[];
    }
  | {
      // RoE Cinematic — Rogue One primary: a retreat happened this round, so
      // the Rebel rescues 1 captured leader OR removes 1 target marker from the
      // combat system. `rescuable` = captured Rebel leader ids; `markerSources`
      // = target-marker card ids on the system. At least one list is non-empty.
      kind: 'RogueOneChoice';
      side: 'Rebel';
      systemId: SystemId;
      rescuable: LeaderId[];
      markerSources: string[];
    }
  | {
      // RoE Cinematic — Confrontation (Rebel ground): the last Imperial ground
      // unit was destroyed this round, so the Rebel marks 1 Imperial leader in
      // the system for elimination at end of Command phase. The Rebel chooses
      // which (RAW); `candidates` = Imperial leader ids in the system, listed
      // strongest-first as a suggestion. The AI picks the highest-value.
      kind: 'ConfrontationLeaderPick';
      side: 'Rebel';
      systemId: SystemId;
      candidates: LeaderId[];
    }
  | {
      // RoE Cinematic Combat (#15) — once-per-attack reroll. After the side
      // rolls, it MAY reroll up to `allowance` (its leader's tactic value)
      // of its own dice. `faces`/`colors` describe the rolled dice by index;
      // `suggested` = the default pick (blanks first, up to allowance). The
      // resolver rerolls the chosen indices. Choosing none keeps the roll.
      kind: 'CinematicReroll';
      side: Side;
      theater: Theater;
      systemId: SystemId;
      allowance: number;
      faces: string[];
      colors: DieColor[];
      suggested: number[];
    }
  | {
      // RoE Cinematic Combat (#15) — "Removing damage": after rolling, the
      // side may discard each ★ (special) die to remove 1 damage from one of
      // its units whose health colour matches the die's colour. `budget` =
      // red/black ★ available; `candidates` = its wounded matching-colour units
      // in the theatre; `suggested` = the default allocation (most-damaged
      // first). The resolver applies the chosen allocation (≤ budget per colour).
      kind: 'CinematicHeal';
      side: Side;
      theater: Theater;
      systemId: SystemId;
      budget: { red: number; black: number };
      candidates: { instanceId: string; typeId: string; color: 'red' | 'black'; damage: number }[];
      suggested: { instanceId: string; amount: number }[];
    }
  | {
      // Draw Their Fire / Energy Shield (RoE cinematic): "After the opponent
      // assigns damage, remove up to N damage from your ships." Interactive for
      // the human — they pick which units to pull damage off (player report
      // #322: the heal was auto-applied with no prompt). `amount` = the heal
      // budget; `candidates` = own wounded units in the theatre (the excluded
      // type, e.g. Nebulon-B, is already filtered out); `suggested` = the
      // save-staged-then-most-damaged default.
      kind: 'CinematicDeferredHeal';
      side: Side;
      theater: Theater;
      systemId: SystemId;
      amount: number;
      candidates: { instanceId: string; typeId: string; damage: number; staged: boolean }[];
      suggested: { instanceId: string; amount: number }[];
    }
  | {
      // Undercover (Rebel/Lando|Obi-Wan): when the Empire reveals an attempt
      // mission, may discard this card to relocate Lando or Obi-Wan from
      // their current system to the mission's target system. The relocated
      // leader then participates in opposition normally.
      kind: 'UndercoverOffer';
      side: Side; // 'Rebel'
      missionId: string;
      targetSystemId: SystemId;
      candidates: LeaderId[]; // {lando, obi-wan} subset that is on the board somewhere off-target
    }
  | {
      kind: 'SonOfSkywalkerOffer';
      side: Side; // 'Rebel'
      missionId: string; // the just-succeeded mission
      candidates: string[]; // missionIds available to pull
    }
  | {
      // Blindside (Empire/Boba|Greejatus): may discard before opposition so
      // the Rebel cannot send pool leaders to oppose this mission.
      kind: 'BlindsideOffer';
      side: Side; // 'Empire'
      missionId: string;
      targetSystemId: SystemId;
    }
  | {
      // Wookie Guardian (Rebel/Chewbacca): may discard to auto-fail an
      // Empire special-ops mission attempted at a system where Chewie is.
      kind: 'WookieGuardianOffer';
      side: Side; // 'Rebel'
      missionId: string;
      targetSystemId: SystemId;
    }
  | {
      kind: 'C3POOffer';
      side: Side; // 'Rebel'
      missionId: string;
      targetSystemId: SystemId;
    }
  | {
      // Millennium Falcon ring: after a Rebel mission success at a system
      // containing captured leaders, may discard the Falcon ring to rescue
      // one of them. Post-finalize trigger.
      kind: 'FalconOffer';
      side: Side; // 'Rebel'
      missionId: string;
      targetSystemId: SystemId;
      candidates: LeaderId[]; // captured-leader IDs at the target system
    }
  | {
      kind: 'BrilliantAdministratorBuildPick';
      side: Side; // 'Empire'
      systemId: SystemId;
      icons: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }[];
    }
  | {
      // Catch Them By Surprise (Empire/Ozzel): immediate fleet move during
      // Assignment. Pick a source system adjacent to Ozzel's system, pick
      // units. Transport-validated on submit.
      kind: 'CatchThemBySurpriseMovePick';
      side: Side; // 'Empire'
      targetSystemId: SystemId; // Ozzel's placement system
      candidateSourceSystemIds: SystemId[]; // adjacent systems with Empire units
    }
  | {
      // Scouting Mission (Empire): pick up to 4 TIE Fighters from any
      // systems to relocate to the leader's system. Ignores transport &
      // adjacency. If Rebel ships present at the destination, combat fires.
      kind: 'ScoutingMissionTIEPick';
      side: Side; // 'Empire'
      targetSystemId: SystemId;
      candidateUnitIds: UnitInstanceId[]; // all TIE Fighters anywhere
      maxPicks: 4;
    }
  | {
      kind: 'OurMostDesperateHourPick';
      side: Side; // 'Rebel'
      candidates: string[]; // missionIds in the Rebel's deck
    }
  | {
      // FFG FAQ (May 2019): an ability used during the ASSIGNMENT phase that
      // places a leader on a mission (Our Most Desperate Hour, Proceeding As
      // Planned) lets the player assign a SECOND leader to that mission — the
      // 2-leader assignment limit. Offered after the first leader is placed; the
      // player may decline (null). (#309)
      kind: 'AssignSecondLeaderPick';
      side: Side;
      missionId: string;
      // The leader the card just placed on this mission (Leia for OMDH, the
      // resolver leader for Proceeding As Planned). Used to pin the exact
      // leadersOnMissions entry — missionId alone is ambiguous when a duplicate
      // copy of the same mission is already assigned (that bug soft-locked the
      // second-leader prompt — #390-adjacent).
      placedLeaderId: LeaderId;
      candidates: LeaderId[]; // the side's pool leaders
      cardName: string;
    }
  | {
      // Proceeding As Planned (Empire action card): Empire searches the
      // project deck for 1 project and assigns this leader to it.
      kind: 'ProceedingAsPlannedPick';
      side: Side; // 'Empire'
      leaderId: LeaderId;
      candidates: string[]; // project missionIds in the Empire deck
    }
  | {
      // Start The Evacuation (Rebel action card, Rieekan): Rebel picks a
      // target system without Imperial units and which units from the Rebel
      // Base space to move there (transport-validated on submit).
      kind: 'StartEvacuationPick';
      side: Side; // 'Rebel'
      candidateSystemIds: SystemId[];
      candidateUnitIds: UnitInstanceId[];
    }
  | {
      // Independent Operation (Rebel action card, Lando): the Empire picks
      // which Imperial system the evicted ground units evacuate to. Triggered
      // when Lando is placed in a subjugated system that has Imperial ground.
      kind: 'IndependentOperationEvacPick';
      side: Side; // 'Empire' — opponent of the card player picks
      fromSystemId: SystemId;
      candidateSystemIds: SystemId[];
      groundUnitIds: UnitInstanceId[];
    }
  | {
      kind: 'HiddenFleetUnitPick';
      side: Side; // 'Rebel'
      targetSystemId: SystemId;
      candidateUnitIds: UnitInstanceId[];
    }
  | {
      // Temporary Alliance (Rebel action card): Rebel picks which unit type
      // to queue for each of the chosen system's resource icons. Each icon
      // is independent; legal types are constrained by the icon's
      // theater + tier (lower-tier units are legal for higher-tier icons).
      kind: 'TemporaryAllianceBuildPick';
      side: Side; // 'Rebel'
      systemId: SystemId;
      icons: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }[];
    }
  | {
      // Generic "build units from this system's resource icons" choice — the
      // player picks a unit type per icon (or skips it). Used by effects that
      // build from resource icons (Construct Factory, Address Delays, Establish
      // Trade Relations). Those previously auto-picked a fixed default unit,
      // which both removed the choice and (for Rebel ground) always built a
      // trooper regardless of icon shape. `label` is the card/mission name for
      // the modal title + log.
      kind: 'BuildFromIconsPick';
      side: Side;
      systemId: SystemId;
      icons: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }[];
      label: string;
    }
  | {
      kind: 'ContingencyPlanPick';
      side: Side; // always 'Rebel'
      leaderId: LeaderId; // the leader being reassigned
      candidates: string[]; // starting missionIds in Rebel hand
    }
  | {
      // Rapid Mobilization (Rebel starting mission): Rebel chooses between
      // moving up to 5 units from a system to the Rebel Base space, or
      // establishing a new Rebel Base. Sub-picks (source system + unit
      // selection, or new-base system) follow via separate ChoiceRequests.
      kind: 'RapidMobilizationBranch';
      side: Side; // always 'Rebel'
      twoLeaders: boolean;
      baseRevealed: boolean;
      // Whether the move-units option is available (only if base unrevealed).
      moveUnitsAvailable: boolean;
      // RR p.11: drawing/looking at the probe cards is PART OF establishing a
      // new base — the Rebel must commit to that option BEFORE seeing the
      // candidates (player report #365). So no probes are drawn here; they're
      // drawn only when the Rebel chooses 'establish-base'.
    }
  | {
      // Rapid Mobilization sub-choice: pick source system + up to 5 units
      // to move to the Rebel Base space.
      kind: 'RapidMobilizationMovePick';
      side: Side; // always 'Rebel'
      // We let the UI present all systems with Rebel units; engine will
      // validate the picks.
    }
  | {
      // Rapid Mobilization sub-choice: establish a new Rebel Base. If
      // unrevealed, draw N probes (4 or 8) and pick one. If revealed, pick
      // any system on the map.
      kind: 'RapidMobilizationBasePick';
      side: Side; // always 'Rebel'
      baseRevealed: boolean;
      // Candidates if unrevealed (probe-card-derived system IDs).
      probeSystemIds?: SystemId[];
      // The probe cards drawn for this base pick. RR p.11: the Rebel may look
      // and DECLINE to establish a new base — on decline these are shuffled to
      // the bottom of the deck. Carried so the decline path can return them.
      drawnProbeIds?: string[];
    }
  | {
      // Player wants to play an action card during the Assignment phase.
      // Engine lists cards in their hand whose timing === 'Assignment'
      // AND whose leaderRequirement leader is currently in their pool
      // (or eliminated; not yet placed on the board this round).
      kind: 'PlayAssignmentActionCard';
      side: Side;
      candidates: string[];
    }
  | {
      // RoE False Orders: played at the END of the Assignment phase (after the
      // Empire has finished assigning). The Rebel may return 1 lone Imperial
      // leader to the pool and its mission to the Imperial hand — or decline
      // and keep the card. `candidates` lists each lone Imperial assignment.
      kind: 'FalseOrdersWindow';
      side: Side; // 'Rebel'
      cardId: string;
      candidates: { missionId: string; leaderId: LeaderId }[];
    }
  | {
      // Some action cards need a system target. Posted after the card
      // is picked; legal systems are pre-filtered per the card's text.
      kind: 'ActionCardSystemPick';
      side: Side;
      cardId: string;
      candidates: SystemId[];
      // For a card that places one of 2+ eligible leaders (e.g. Trust in the
      // Force — Jyn OR Chirrut), the leader the player already chose in the
      // preceding leader-pick step. Carried here so it survives the online
      // round-trip between the two choices. Undefined = auto-pick (0/1 eligible).
      chosenLeaderId?: LeaderId;
    }
  | {
      // Droid ring (R2-D2 / C-3PO): the Rebel attaches the ring to one of
      // their leaders. The ring's discard effect later triggers only in that
      // leader's system. Posted when the player plays the droid action card.
      kind: 'AttachRingPick';
      side: Side; // 'Rebel'
      cardId: string; // 'resourceful-astromech' | 'human-cyborg-relations' | 'he-means-well'
      ringId: 'r2d2' | 'c3po' | 'k2so';
      candidates: LeaderId[];
      // Set when the prompt is offered the instant the card is recruited
      // (issue #221), so the resolver resumes the recruit flow afterward.
      viaRecruit?: boolean;
      // Set when offered for a droid ring sitting in the opening hand at game
      // start, so the resolver chains to the next un-attached starting ring.
      viaStartingHand?: boolean;
    }
  | {
      // Refresh recruit step: drew (at least) 2 action cards, keep 1 (into
      // hand) which determines a leader to recruit if eligible; the rest go
      // to the bottom. Per-side; processed Rebel first, then Empire.
      // RAW: if none of the drawn cards shows a still-recruitable leader, the
      // player MAY draw more cards one at a time until one does (canDrawMore).
      // drawnIds grows as the player draws deeper.
      kind: 'RecruitActionCardPick';
      side: Side;
      drawnIds: string[];
      canDrawMore: boolean;
    }
  | {
      // The kept recruit card lists more than one leader (e.g. One in a
      // Million → Luke or Wedge) and more than one is still eligible — the
      // player chooses which leader to recruit. (#62)
      kind: 'RecruitLeaderPick';
      side: Side;
      cardId: string;
      candidates: LeaderId[];
    }
  | {
      // Plant False Lead: the Rebel took these probe cards from the Empire's
      // hand and chooses how to return each — top or bottom of the deck, in
      // any order, hidden from the Empire (RR). cards are probe-card ids.
      kind: 'PlantFalseLeadPlacement';
      side: Side;
      cards: string[];
    }
  | {
      // Research & Development — Stage 1: Empire picks between
      //   A: draw 2 project cards, keep 1, bottom 1
      //   B: remove sabotage marker from target + draw 1 project card
      // Option B is only available if the target has a sabotage marker.
      kind: 'ResearchAndDevelopmentOption';
      side: Side;             // always 'Empire'
      targetSystemId: SystemId;
      hasSabotage: boolean;
      projectDeckSize: number;
    }
  | {
      // Research & Development — Stage 2 (only if Option A chosen):
      // Empire drew 2 project cards; picks which to keep, which to
      // bottom of the project deck. Same shape as CovertOperationPick
      // but the cards are projects (isProject missions).
      kind: 'ResearchAndDevelopmentProjectPick';
      side: Side;             // always 'Empire'
      drawnIds: [string, string];
    }
  | {
      // Misdirection: Rebel picks which of their own leaders the
      // mission's protection applies to (defaults to the resolver
      // but RAW lets the player pick any Rebel leader).
      kind: 'MisdirectionPick';
      side: Side;
      candidates: LeaderId[];
    }
  | {
      kind: 'StolenPlansReorder';
      side: Side;
      missionId: string;
      remaining: string[];      // card IDs still to be picked
      orderedTop: string[];     // accumulated pick order (index 0 = topmost)
      // Which deck the reordered cards go back on top of. Defaults to the Rebel
      // objective deck (Stolen Plans / Lord Vader's Orders). Prepare For Battle
      // reorders a base tactic deck instead (#329).
      deckKind?: 'objective' | 'space-tactic' | 'ground-tactic';
    }
  | {
      // Prepare For Battle (Rebel/RoE, base combat): "look at the top 4 cards of
      // ANY tactic deck and place them top/bottom in any order" — first pick
      // which tactic deck, then reorder via StolenPlansReorder (#329).
      kind: 'PrepareForBattleDeckPick';
      side: Side; // 'Rebel'
      options: ('space-tactic' | 'ground-tactic')[];
    }
  | {
      // Attacker's window to play tactic cards after rolling their attack:
      // Concentrate Fire (reroll up to 2 blanks) and/or damage-boost tactics
      // (Take It Down +2, Critical Hit +1, Onslaught +2). All decisions are
      // made in a single modal; engine applies them in order.
      kind: 'CombatAttackerTactics';
      side: Side;
      theater: Theater;
      dice: DieResult[];        // current dice (pre-reroll)
      hand: string[];            // attacker's tactic-card IDs of this theater
      attackerUnits: number;
      systemId: SystemId;
    }
  | {
      // Defender's window after attacker tactics resolved: choose how many
      // incoming hits to block. Each block requires one defensive card; a
      // single defensive-formation blocks 1 free; dig-in/outmaneuver block
      // 1 but require an extra hand card to discard.
      kind: 'CombatDefenderTactics';
      side: Side;
      theater: Theater;
      incomingHits: number;     // base hits (post-reroll) + bonus damage
      hand: string[];            // defender's tactic-card IDs of this theater
      systemId: SystemId;
    }
  | {
      // Build-phase choice. Refresh pauses after enumerating which icons
      // each side gets to build for; the human player picks one unit type
      // per icon from the legal alternatives. Picks resolve in order;
      // each side gets its own BuildPick choice (Rebel first, then Empire).
      kind: 'BuildPick';
      side: Side;
      picks: {
        sourceSystemId: SystemId | 'rebel-base';
        slot: 1 | 2 | 3;
        iconType: Theater;
        iconShape: 'triangle' | 'circle' | 'square';
        legalUnitTypes: UnitTypeId[];
        /** Holding-pool supply remaining per legal type at the moment this
         *  pick was enumerated. The UI greys out / warns on any type at 0 so
         *  the player doesn't waste the icon; the engine also hard-rejects a
         *  pick with no supply left. */
        available?: Record<UnitTypeId, number>;
      }[];
      /** Builds already auto-applied to this side's queue earlier in
       *  the same refresh (icons with only one legal unit type). Shown
       *  as context in the modal so the player sees the full build
       *  picture, not just the ambiguous icons. */
      autoApplied: {
        sourceSystemId: SystemId | 'rebel-base';
        slot: 1 | 2 | 3;
        unitTypeId: UnitTypeId;
      }[];
    }
  | {
      // Mission hand-limit discard (RR p.12): after the Refresh draw, a player
      // over the 10-card limit chooses which non-starting, non-project missions
      // to discard down to 10. `count` is how many must go; `discardable` is the
      // legal set to pick from (starting + project cards excluded).
      kind: 'HandLimitDiscard';
      side: Side;
      count: number;
      discardable: string[];
    }
  | {
      // Plan The Assault: Rebel picks which ships in rebel-base-space to
      // move to the target system (which then triggers combat).
      kind: 'PlanTheAssaultShips';
      side: Side;            // always 'Rebel'
      targetSystemId: SystemId;
      availableShipIds: UnitInstanceId[];
      // Origin of the ships: Rebel Base space, or the base's system once
      // revealed (RR p.11). Defaulted on read for back-compat.
      sourceSystemId?: SystemId;
    }
  | {
      // Lead The Strike Team: Rebel picks up to 4 GROUND units in
      // rebel-base-space to move to the target system (ignoring transport
      // restriction and adjacency), which then triggers combat.
      kind: 'LeadStrikeTeamUnits';
      side: Side;            // always 'Rebel'
      targetSystemId: SystemId;
      availableUnitIds: UnitInstanceId[];
      // Where the units are moving FROM: the Rebel Base space, or — once the
      // base is revealed (RR p.11) — the base's system. Defaulted on read for
      // back-compat with choices serialized before this field existed.
      sourceSystemId?: SystemId;
      max: number;           // up to 4
    }
  | {
      // Rebel may reroll one blank die via Yoda's ring (once per round, only
      // if the Yoda holder is at this system). Posted after the dice roll
      // but before tactic-card windows.
      kind: 'YodaReroll';
      side: Side;        // always 'Rebel' but kept for consistency
      // 'combat' = re-roll a blank in pendingCombat.pendingAttack.dice
      // 'mission' = re-roll a blank in the stashed mission roll
      // 'dsplans' = re-roll a blank in the Death Star Plans objective roll
      context: 'combat' | 'mission' | 'dsplans';
      // Combat-only: which theater (for the panel header).
      theater?: Theater;
      systemId: SystemId;
      // Indices into the relevant faces array that are blank.
      blankIndices: number[];
      holderLeaderId: LeaderId;
      // Mission-only: snapshot of the roll's faces (for display in the
      // panel). The resolver re-reads them from pm.r2d2Pending stash.
      missionFaces?: string[];
      // Mission-only: the FULL picture so the player decides the reroll with
      // both sides' results visible (#121). Resolver's own successes so far,
      // the opposer's rolled faces + successes, and whether the resolver is
      // currently winning (successes strictly greater than the opposer's).
      missionOwnSuccesses?: number;
      missionOppFaces?: string[];
      missionOppSuccesses?: number;
    }
  | {
      // RR p.5 "Combat Actions": each special die produced by an attacker's
      // attack may be spent to (a) draw 1 tactic card from a theater deck,
      // or (b) play a tactic card from hand that requires a special icon.
      // `specialCount` is the number of specials available to spend.
      kind: 'SpecialDieSpend';
      side: Side;
      theater: Theater;
      systemId: SystemId;
      specialCount: number;
      // Tactic-card IDs in the side's hand whose text references "Special"
      // (the engine treats these as the spend-to-play candidates).
      specialCards: string[];
    }
  | {
      // Each side may play one or more action cards with timing
      // 'StartOfCombat' (RR pp.4-5). Posted after AddLeader + DrawTactics
      // but before round 1's first theater step.
      kind: 'CombatStartActionCards';
      side: Side;
      systemId: SystemId;
      // Action-card IDs in the side's hand whose timing is StartOfCombat
      // AND whose leaderRequirement is satisfied by leaders at the system.
      playable: string[];
    }
  | {
      // "More Dangerous Than You Realize" picks 3 tactic cards from either
      // the space or ground deck. Posted mid-resolution of the start-of-
      // combat window when the card is played.
      kind: 'MoreDangerousTheaterPick';
      side: Side;
      cardId: string;
    }
  | {
      // CINEMATIC follow-up to More Dangerous Than You Realize: RoE rulebook,
      // "if an ability lets a player draw tactic cards, he retrieves that many
      // cards OF HIS CHOICE from his discard pile and returns them to his
      // deck" (#449). Posted when the chosen theater's cinematic discard holds
      // more than 3 retrievable cards; the player picks which 3 come back.
      kind: 'MoreDangerousRetrievePick';
      side: Side;
      cardId: string;
      theater: 'space' | 'ground';
      candidates: string[];
      count: number;
    }
  | {
      // "Fully Operational" (Moff Jerjerrod): if a Death Star or Death Star
      // Under Construction is in the system, Empire picks one Rebel ship to
      // destroy. `candidates` are eligible Rebel ship instance ids.
      kind: 'FullyOperationalTargetPick';
      side: Side;
      systemId: SystemId;
      candidates: string[]; // unit instanceIds
    }
  | {
      // "Baze's Loyalty" (Chirrut): the playing side destroys up to `budget`
      // health-worth of enemy units in the system, picking which ones one at a
      // time. `candidates` are enemy unit instanceIds whose health value is
      // <= the remaining budget. Re-posts itself after each pick until the
      // budget is spent or no affordable target remains (player report #316).
      kind: 'BazesLoyaltyTarget';
      side: Side;
      systemId: SystemId;
      candidates: string[]; // unit instanceIds affordable within `budget`
      budget: number; // remaining health-worth to destroy
    }
  | {
      // "Target the Generator" (General Veers): Empire picks one structure
      // (ion-cannon / shield-generator) in the system to destroy.
      // `candidates` are eligible structure instance ids.
      kind: 'TargetTheGeneratorPick';
      side: Side;
      systemId: SystemId;
      candidates: string[]; // unit instanceIds
    }
  | {
      // "Ready For Action" (Piett / Veers): Empire picks a leader from pool
      // to place in combat; returns to pool at end of combat. `candidates`
      // are leader ids currently in Empire pool.
      kind: 'ReadyForActionLeaderPick';
      side: Side;
      systemId: SystemId;
      candidates: LeaderId[];
    }
  | {
      // RR p.4-5 Combat step 1: "If a player does not have a leader with
      // tactic values in the system, he MAY take one leader from his leader
      // pool and place it in the system." Optional — the player can decline,
      // accepting 0 tactic-card draws (and any morale-cost from missing
      // leadership). Posted once per combat per side that qualifies.
      kind: 'CombatAddLeaderPick';
      side: Side;
      systemId: SystemId;
      candidates: LeaderId[]; // pool leaders with tactic values > 0
    }
  | {
      // End-of-round retreat choice (RR pp.5-6). The attacker may retreat
      // to the system they moved from; the defender may retreat to any
      // adjacent system (and not the attacker's source). Each side may
      // retreat at most once per combat — tracked via c.retreated.
      kind: 'RetreatDecision';
      side: Side;
      systemId: SystemId;
      // System IDs the side may retreat to (filtered for legality).
      legalDestinations: SystemId[];
      // Unit instance IDs the side currently has in the combat system
      // (split into space + ground by the UI).
      availableUnits: UnitInstanceId[];
      // Leaders the side has in the combat system. RAW (rr p.5): retreat is
      // led by a leader — the player moves ONE leader to the destination and
      // the units follow. One of these must lead; any others stay behind.
      leadersInSystem: LeaderId[];
    }
  | {
      // Attacker assigns each attack hit to a specific enemy unit (RR p.5).
      // Posted after both sides' tactic-card windows close. `hits` is the
      // ordered list of dice that produced damage (red/black hit, direct-hit,
      // or "bonus" from damage-boost tactics). For each hit, `targetsByHit[i]`
      // lists the legal target unit instance IDs the attacker may pick.
      kind: 'CombatAssignDamage';
      side: Side;          // attacker (the side picking targets)
      theater: Theater;
      systemId: SystemId;
      hits: {
        color: 'red' | 'black' | null; // null = bonus damage from tactic
        face: 'hit' | 'direct-hit';
        // Source tactic card id if this hit came from a damage-boost card.
        // Used to enforce per-card target constraints in the assignment
        // resolver:
        //   - take-it-down: all hits from this card must go to the same target
        //   - onslaught:    hits from this card must go to different targets
        source?: string;
      }[];
      // Per-hit list of eligible defender unit instance IDs (already filtered
      // for color matching and "not already staged for destruction"). Same
      // length as `hits`.
      targetsByHit: UnitInstanceId[][];
    }
  | {
      // Cinematic targeted-deal pick (RoE p.9). Cards like Tow Cables ("Deal 4
      // damage to 1 AT-AT or AT-ST") and Ion Blast let the playing side choose
      // which eligible enemy unit takes the burst, when 2+ are legal (#290).
      kind: 'CinematicTargetPick';
      side: Side;
      theater: Theater;
      systemId: SystemId;
      amount: number;
      candidates: UnitInstanceId[];
    }
  | {
      // Tractor Beam (Empire/RoE cinematic): "if you have a Star Destroyer but
      // the Rebels have no ships, capture 1 leader." When 2+ Rebel leaders are
      // in the combat the Empire chooses which to capture (#316 audit).
      // `candidates` are Rebel leader ids in the system.
      kind: 'TractorBeamCapturePick';
      side: Side; // 'Empire'
      systemId: SystemId;
      candidates: LeaderId[];
    }
  | {
      // Trust in the Force (Rebel/RoE): after placing the leader and gaining
      // loyalty, "destroy 1 triangle ground unit in the system" — the Rebel
      // chooses which when 2+ exist (a stormtrooper vs an assault-tank are
      // different; #316 audit). `candidates` are eligible Imperial triangle
      // ground unit instanceIds.
      kind: 'TrustInTheForceDestroyPick';
      side: Side; // 'Rebel'
      systemId: SystemId;
      candidates: UnitInstanceId[];
    }
  | {
      // Cinematic "destroy 1 X without rolling" pick (Intercept / Hold Them Back
      // / Support of the 501st / cinematic Target the Generator). The playing
      // side picks which eligible enemy unit is removed when 2+ are legal,
      // instead of an auto-pick (#316 audit). `candidates` are the eligible
      // enemy unit instanceIds.
      kind: 'CinematicDestroyPick';
      side: Side;
      theater: Theater;
      systemId: SystemId;
      candidates: UnitInstanceId[];
    }
  // ---------------------------------------------------------------------------
  // Generic, data-driven choice (the unified choice framework — see
  // src/engine/choices.ts). ONE kind that most new/migrated choices use, backed
  // by a tag -> resolver registry, so a new prompt needs no new union member, no
  // new resolver export, no new UI modal, no new AI branch, and no new online
  // adapter action. Everything about the interaction lives in this serializable
  // payload; the follow-up logic is looked up by `tag`.
  // ---------------------------------------------------------------------------
  | GenericChoice;

/** What the candidate ids in a GenericChoice refer to — drives which picker the
 *  generic UI renders and how the id is looked up for display. */
export type ChoiceDomain = 'system' | 'unit' | 'card' | 'leader' | 'option';

/** One selectable item in a GenericChoice. `id` is the domain-native id (system
 *  id / unit instanceId / card id / leader id / opaque option value). `label`
 *  overrides the UI's default catalog lookup; omit it for systems/units/cards/
 *  leaders (the UI resolves the name from G). For the `option` domain a label
 *  is required (there's nothing to look up). */
export type ChoiceCandidate = {
  id: string;
  label?: string;
  sublabel?: string;
  disabled?: boolean;
};

/** Serializable payload handed back to a choice's tag resolver. MUST be plain
 *  JSON (no functions) so it round-trips through codec.encodeFull for online
 *  play. Nested objects/arrays of primitives are fine. */
export type ChoiceContext = {
  [k: string]: string | number | boolean | null | string[] | number[] | ChoiceContext | ChoiceContext[];
};

export type GenericChoice = {
  kind: 'Choice';
  /** Registry key: identifies both the resume/effect resolver (engine) and the
   *  optional AI heuristic. Kebab-case, unique per logical choice. */
  tag: string;
  /** Side that owns (must answer) this choice — matches choiceOwner's default. */
  side: Side;
  domain: ChoiceDomain;
  /** Modal title. */
  prompt: string;
  /** Optional sub-instructions under the title. */
  detail?: string;
  candidates: ChoiceCandidate[];
  /** Minimum selections required to submit. 0 => the player may pick nothing
   *  (decline / "select none"). */
  min: number;
  /** Maximum selections allowed. */
  max: number;
  /** Optional custom confirm-button label. */
  submitLabel?: string;
  /** Serializable data forwarded to the tag resolver on submit. */
  context?: ChoiceContext;
};

export type CombatActionOption =
  | { kind: 'draw-tactic' }
  | { kind: 'play-tactic'; cardId: string }
  | { kind: 'done' };

export type DieColor = 'red' | 'black' | 'green';
export type DieFace = 'blank' | 'hit' | 'direct-hit' | 'special';
export type DieResult = { color: DieColor; face: DieFace };

// ---------- Combat ----------

export type CombatState = {
  systemId: SystemId;
  attackerSide: Side;
  attackerSourceSystemId: SystemId; // for retreat-not-to-source rule (rr p.5)
  step: 'AddLeader' | 'DrawTactics' | 'Round' | 'Ended';
  round: number;
  // RoE Cinematic Combat (rules p.9). The round structure, retreat, and end
  // conditions are the SAME as standard combat; what differs is (a) leaders
  // enable per-attack dice REROLLS (up to their tactic value) instead of
  // determining how many tactic cards are drawn, and (b) the tactic-card
  // subsystem (full-deck access, side-specific advanced cards). Set at
  // beginCombat from expansion.cinematicCombat. Phase 7b wires (a) and skips
  // the standard tactic draw; Phase 7c adds the cinematic tactic subsystem.
  cinematic?: boolean;
  // RoE Cinematic Combat hit-prevention accumulator (Phase 7c). A "Prevent
  // N red/black/special" tactic ability is set against the OPPONENT's next
  // attack in this theatre. Keyed by the side whose roll it applies to;
  // consumed (zeroed) by beginAttack, which stashes it on pendingAttack and
  // applies it to the ROLLED dice (removing matching HIT/★ results — it does
  // NOT reduce how many dice are rolled; RAW RotE "PREVENTING HITS", #401/#408).
  // Reset per theatre step.
  cinematicPrevent?: {
    Rebel?: { red: number; black: number; special: number };
    Empire?: { red: number; black: number; special: number };
  };
  // RoE Cinematic "remove damage after the opponent assigns damage" heals
  // (Draw Their Fire / Energy Shield). These are reactive: they must run AFTER
  // this theatre's attacks but BEFORE the end-of-theatre destruction step, so
  // they can pull a just-damaged ship back below lethal and save it. Tactic
  // abilities otherwise resolve at round start (before any attack), which is
  // too early — applied then they heal nothing (#225). Drained per theatre by
  // applyDeferredCinematicHeals just before finalizeTheaterDestructions.
  // `exceptTypeId` = plain remove-damage heal (Draw Their Fire / Energy Shield).
  // `structureTypeId` = shield-absorb (Planetary Shield / Armored Position): move
  // up to `amount` damage onto that structure, cancelling it from ground units (#431).
  cinematicDeferredHeal?: { side: Side; theater: Theater; amount: number; exceptTypeId?: string; structureTypeId?: string }[];
  // Which (side, theatre) cinematic tactic sub-steps have been resolved this
  // round, so re-entry doesn't replay them.
  cinematicTacticDoneThisRound?: string[]; // entries like 'Rebel:space'
  // RoE Cinematic "resolve attacks first" (Energy Shield / Armored Position /
  // Draw Their Fire / Planetary Shield secondaries): the named side attacks
  // FIRST in that theatre for the rest of the combat (overrides the default
  // attacker-first order).
  cinematicResolveFirst?: { space?: Side; ground?: Side };
  // Seize Control (RoE objective): set when the objective scored in a system that
  // still has a sabotage marker, so finishCombatTail can raise the optional
  // "may remove the marker" choice (#505/#496 — RAW is a "may", not automatic).
  seizeControlMarkerPending?: boolean;
  // RAW ("Objective Cards", RR p.10): "Only one objective can be played during
  // each combat." Set the moment ANY objective scores off this combat — the
  // combat-end Death Star Plans window AND the decisive-victory/liberation/etc.
  // combat-objective play both check it so a single fight can't score two
  // (player report #487: destroying the Death Star scored Death Star Plans AND
  // Decisive Victory in the same combat).
  objectivePlayedThisCombat?: boolean;
  // RoE Cinematic deck lock (Entrapment / Air Superiority / Outrun Them /
  // Escape Plan secondaries): `${side}:${theatre}` -> the round through which
  // that side is barred from playing a tactic card in that theatre.
  cinematicDeckLock?: Record<string, number>;
  // RoE Cinematic card-cancel (Entrapment / Air Superiority / Outrun Them
  // primaries): `${side}:${theatre}:${round}` -> true means that side's tactic
  // play THIS round in this theatre is cancelled (skipped). Set when the
  // opponent plays a cancel card before them.
  cinematicCancel?: Record<string, boolean>;
  // RoE Cinematic end-of-round effects queued during the round. `capture`
  // (Tractor Beam) resolves after both theatres' attacks, before retreat;
  // `rogueOne` (Rogue One: "if 1+ units retreat this round, rescue a leader OR
  // remove a target marker") resolves AFTER the retreat step.
  cinematicEndOfRound?: { side: Side; kind: 'capture' | 'rogueOne' | 'confrontation' }[];
  // Guard so the end-of-round capture resolution runs once per round.
  cinematicEndOfRoundDoneRound?: number;
  // Set when an actual retreat (not a decline) happens this round — read by
  // Rogue One's end-of-round trigger. Reset at round advance.
  retreatHappenedThisRound?: boolean;
  // RoE Cinematic "you may play an extra card" (Imposing Presence / Fleet
  // Logistics / Confrontation): `${side}:${theatre}:${round}` -> count of
  // additional tactic plays that side may make this round in this theatre.
  cinematicExtraPlays?: Record<string, number>;
  // RoE Cinematic special-die damage-removal lock (Intercept / Imposing
  // Presence / Deployment / Rogue One bottoms): `${side}:${theatre}:${round}`
  // -> true means that side may NOT spend ★ dice to remove damage from its
  // units of that theatre this round (rules: "Removing damage" combat action).
  cinematicSpecialLock?: Record<string, boolean>;
  // RoE Cinematic simultaneous selection: each side's chosen FIRST card this
  // theatre/round, collected BEFORE either resolves (keyed `${side}:${theatre}:
  // ${round}`; null = chose to skip). Once both are in, they resolve in order
  // (the defender resolves first if their card uses "cancel" — rulebook).
  // `noAbility` = the side must play (discard) a card but resolves none of its
  // abilities (RoE p.8: "you may choose not to resolve its abilities and discard
  // the card"). null = genuinely no card available (after deck recycle).
  cinematicSelections?: Record<string, { cardId: string; useTop: boolean; noAbility?: boolean } | null>;
  attackerHand: string[]; // tactic card ids
  defenderHand: string[];
  retreated: Side[]; // each side at most once
  report: CombatReport; // accumulated play-by-play
  // Mid-attack resumable state. Set when an attack pauses mid-resolution to
  // ask a side which tactic cards to play. Cleared at the end of the attack.
  pendingAttack?: {
    side: Side;          // who's currently attacking
    theater: Theater;
    phase: 'awaitingYodaReroll' | 'awaitingR2D2Flip' | 'awaitingOneInAMillion' | 'awaitingCinematicReroll' | 'awaitingCinematicHeal' | 'awaitingSpecialSpend' | 'awaitingAttackerTactics' | 'awaitingDefenderTactics' | 'awaitingDamageAssignment';
    dice: DieResult[];   // current dice (may be modified by reroll)
    attackerUnits: number;
    bonusDamage: number; // accumulated from damage-boost tactics
    // Per-source breakdown of bonus damage. Used by the damage-assignment
    // step to enforce per-card target constraints (take-it-down: must
    // concentrate on 1 target; onslaught: must spread across different
    // targets). bonusDamage above is the sum of `amount` here.
    bonusDamageSources?: { source: string; amount: number }[];
    tacticsPlayed: { card: string; detail: string }[];
    // True once the SpecialDieSpend window has been resolved for this
    // attack, so re-entry doesn't queue it again.
    specialsResolved?: boolean;
    // True once the R2-D2 flip window has been resolved for this attack so
    // re-entry (after another pause) doesn't re-prompt the Rebel.
    r2d2Resolved?: boolean;
    // True once the One In A Million window has been resolved for this
    // attack so re-entry doesn't re-prompt the Rebel.
    oneInAMillionResolved?: boolean;
    // RoE Cinematic Combat (#15): true once the once-per-attack reroll window
    // (pick up to the leader's tactic value of dice to reroll) and the
    // ★-spend "Removing damage" heal window have each been resolved for this
    // attack, so re-entry after another pause doesn't re-prompt.
    cinematicRerollResolved?: boolean;
    cinematicHealResolved?: boolean;
    // CINEMATIC "Prevent N red/black/special" set against THIS attack by the
    // opponent's tactic card. Stashed at roll time (the dice are NOT reduced);
    // applied to the rolled dice — removing matching HIT/★ results — after the
    // reroll window. `cinematicPreventApplied` guards against re-applying it on
    // re-entry. RAW: RotE rulebook "PREVENTING HITS" (#401, #408).
    cinematicPrevent?: { red: number; black: number; special: number };
    cinematicPreventApplied?: boolean;
    // Set when entering 'awaitingDamageAssignment'. Frozen list of hits
    // the attacker must assign (post-blocks), and the legal targets per
    // hit (computed when the choice is queued).
    pendingAssignment?: {
      blocksApplied: number;
      applicableHits: {
        color: 'red' | 'black' | null;
        face: 'hit' | 'direct-hit';
        source?: string;
      }[];
    };
  };
  // Unit instance IDs already destroyed earlier in the current theater step.
  // Excluded from damage-target picking (can't kill the same unit twice) but
  // included in attacker eligibility (RR p.5 — dying units still attack).
  // Cleared at the end of each theater step.
  theaterStaged?: string[];
  // Every unit destroyed during this combat (any cause), in order, for the
  // combat screen's "units removed" panel (player request: Foggy Leggy). Lives
  // and dies with the CombatState, so it resets each battle.
  removed?: { typeId: UnitTypeId; side: Side }[];
  // Index of the round bucket within report.rounds that the current theater
  // step is writing into. Persists across pauses so post-resume attack
  // reports attach to the right round.
  currentRoundReportIdx?: number;
  // The theater step currently being resolved (if any). Set when entering
  // a theater step; cleared at end of step.
  activeTheater?: Theater;
  // Sides that have already attacked in the current theater step. Used to
  // know which side(s) still need to roll after a resume.
  theaterAttackersDone?: Side[];
  // Theaters that have been completed within the current round. Reset at
  // the start of each new round. Lets the resumable round loop skip
  // already-finished theater steps after a tactic-choice pause.
  roundTheatersDone?: Theater[];
  // Sides that have already been offered the Combat-step-1 "add a leader
  // from pool" choice. Prevents re-prompting after the player resolves.
  // Same pattern as startOfCombatSidesOffered.
  addLeaderSidesOffered?: Side[];
  // Whether the Start-of-Combat action-card window has been resolved.
  // Set after both sides confirm their picks (or skip); never re-prompted.
  startOfCombatActionsDone?: boolean;
  // Mid-resolution state for the start-of-combat batch: when a played card
  // needs a sub-choice (e.g. "More Dangerous Than You Realize" theater
  // pick), we stash the remaining cards + acting side here so the choice
  // resolver can continue processing.
  startOfCombatBatch?: { side: Side; remaining: string[] };
  // Sides whose Start-of-Combat action-card window has already been offered
  // (resolved or skipped). Prevents the ping-pong where both sides re-prompt
  // each other forever after both pass with no cards.
  startOfCombatSidesOffered?: Side[];
  // Whether the end-of-round retreat window has been resolved for the
  // current round. Reset at the start of each new round.
  retreatStepDoneThisRound?: boolean;
  // Whether the Death Star Plans window has been offered after THIS round's
  // space battle step. Reset each round. Prevents re-offering every loop
  // re-entry and avoids a duplicate offer at combat end.
  dsPlansOfferedThisRound?: boolean;
  // Sides that have decided this round's retreat window (whether by
  // retreating or declining). Without this, declining doesn't mark the
  // decision and the engine infinite-loops re-posting RetreatDecision.
  // Reset at the start of each new round.
  retreatDecidedThisRound?: Side[];
  // Sides that have used their Yoda reroll during the current round
  // (resets each round, mirrors G.yodaRerollUsedThisRound semantics).
  yodaRerollUsedRound?: number;
  // Stalemate guard. Combat ends only when one side is cleared from every
  // shared theater — but if neither side can deal lethal damage (e.g. both
  // sides hold only 0-attack units like transports/structures, or a defender
  // perpetually blocks), the round loop never terminates (observed round 960).
  // We track the total unit count at the system; if it doesn't drop for
  // STALEMATE_ROUND_LIMIT consecutive rounds (no kill, no retreat), the combat
  // is making no progress and is ended as inconclusive. The local
  // safetyCounter can't catch this — it resets every time runCombat re-enters
  // after a per-round tactic/retreat choice pause.
  stalemateBaselineCount?: number;
  stalemateRounds?: number;
  // Per-side flags from active tactic cards. Reset where appropriate.
  // - cannotBlockUntilStepEnd[side]: defender (side) cannot play any
  //   block cards for the remainder of the current theater step.
  //   Cleared at end of step. Set by Unstoppable Assault.
  // - cannotRetreatThisRound[side]: side cannot retreat this round.
  //   Cleared at end of round. Set by No Escape.
  // - retreatIgnoresTransport[side]: side's next retreat ignores
  //   transport-capacity (relevant once transport is enforced; logged
  //   regardless for the combat report). Set by Escape Plan.
  flags?: {
    cannotBlockUntilStepEnd?: Partial<Record<Side, boolean>>;
    cannotRetreatThisRound?: Partial<Record<Side, boolean>>;
    retreatIgnoresTransport?: Partial<Record<Side, boolean>>;
    // RoE Cinematic Escape Plan (primary): a retreat is being offered mid-tactic
    // step; if the player actually retreats, cancel the opponent's tactic card
    // at this key (`${opp}:${theatre}:${round}`). Cleared when the retreat
    // resolves (whether or not they retreated).
    escapePlanCancel?: { cancelKey: string };
    // RoE Cinematic targeted-deal (Tow Cables / Ion Blast): a CinematicTargetPick
    // is open; once the player chooses a unit, apply `amount` damage to it. The
    // card is already discarded; this just carries the pending application (#290).
    cinematicTargetPick?: { side: Side; theater: Theater; cardId: string; useTop: boolean; amount: number };
    // Start-of-combat action card flags:
    // - accordingToMyDesignActive: Rebel rolls 1 fewer red die and 2 fewer
    //   black dice in round 1 (both theaters).
    accordingToMyDesignActive?: boolean;
    // - opponentCannotRetreat: list of sides that cannot retreat this combat.
    //   Set by "Keep Them From Escaping".
    opponentCannotRetreat?: Side[];
    // - opponentNoSpaceTacticsRound: integer round number (1-based) in which
    //   the named side may not play space tactic cards. Set by "It's a Trap".
    opponentNoSpaceTacticsRound?: number;
    // - noSpaceTacticsRound1Side: the side that cannot play space cinematic
    //   tactic cards during round 1 (the opponent of whoever played It's a
    //   Trap). Consulted by isCinematicLocked (#272).
    noSpaceTacticsRound1Side?: Side;
    // - allUnitsMinusOneHealthApplied: marker that Point Blank Assault has
    //   already been applied (so a second play in the same combat is a no-op).
    allUnitsMinusOneHealthApplied?: boolean;
    // - targetTheStarDestroyersActive: Wedge's "Target the Star Destroyers"
    //   — Rebel converts up to 2 black hits to red during EACH space-battle
    //   round (whole-combat flag, applied per attack).
    targetTheStarDestroyersActive?: boolean;
    // - readyForActionReturn: leader id placed in combat via "Ready For
    //   Action"; needs to be returned to the Empire leader pool at end of
    //   combat. Stored per leader so the end-of-combat hook can return them.
    readyForActionReturn?: LeaderId[];
    // - goodIntelActive: the Empire played "Good Intel" this combat. Its RoE
    //   clause delays the Empire's advanced-tactic choice until AFTER the Rebel
    //   has chosen and revealed each round — so the cinematic SELECT order is
    //   forced to Rebel-first and the Rebel's card is shown to the Empire before
    //   it picks. Whole-combat flag (Good Intel is StartOfCombat timing).
    goodIntelActive?: boolean;
  };
};

// ---------- Combat reports (display layer) ----------

export type CombatAttackReport = {
  side: Side;
  theater: 'space' | 'ground';
  attackerUnits: number;
  dice: { color: 'red' | 'black' | 'green'; face: string }[];
  tacticsPlayed: { card: string; detail: string }[];
  hitsRolled: number;
  bonusDamage: number;          // from take-it-down / critical-hit / onslaught
  blockedDamage: number;        // from defender's defensive cards
  damageApplied: number;        // final damage that landed
  destroyed: { typeId: string; instanceId: string }[];
};

export type CombatRoundReport = {
  round: number;
  attacks: CombatAttackReport[];
};

// ---------- Mission reports (display layer) ----------

export type MissionResolutionReport = {
  missionId: string;
  resolverSide: Side;
  targetSystemId: SystemId;
  attackerLeaders: LeaderId[];
  opposerSide: Side;
  opposerLeaders: LeaderId[];        // any opposer leaders at the target after the send-from-pool choice
  skill: string;
  // Roll data — undefined if unopposed (auto-success).
  // colors[] parallels faces[] (red/black/green) — green = RoE minor-skill
  // dice, so the report modal can render them distinctly. Optional: reports
  // recorded before this field existed have faces only (render as red).
  attackerDice?: { count: number; faces: string[]; colors?: string[]; successes: number };
  opposerDice?: { count: number; faces: string[]; colors?: string[]; successes: number };
  portraitBonus?: number;            // +2 if the assigned leader matches the card's portrait
  attackerTotal?: number;            // dice successes + portrait
  result: 'success' | 'failure' | 'auto-success';
  /** Monotonic ordering stamp (turnLog length at queue time) — see
   *  CombatReport.seq. */
  seq?: number;
  /** Human-readable notes for response-card interventions that fired during
   *  resolution (Undercover relocate, Blindside, Wookie Guardian, etc.).
   *  Surfaced in MissionReportModal so the player understands WHY a mission
   *  succeeded / failed / was diverted — "nothing happened" was opaque. */
  interventions?: string[];
};

/** Surfaced (both sides) when a leader activates a system and moves units, so
 *  movements are legible the way mission/combat outcomes are. Public info only
 *  (board positions are visible to both players); redaction drops any report
 *  that would name the hidden Rebel base. */
export type SystemActivationReport = {
  side: Side;
  leaderId: LeaderId;
  targetSystemId: SystemId;
  /** Unit groups that moved into the target, grouped by source system and unit
   *  type. Empty if the leader activated without moving any army units. */
  moves: { fromSystemId: SystemId; units: { typeId: UnitTypeId; count: number }[] }[];
  /** True if this activation brought both sides into the target and a battle
   *  began (the combat board / combat report follows). */
  startedCombat: boolean;
  /** Monotonic ordering stamp (turnLog length at queue time) so reports of all
   *  kinds display in true chronological order, not by a fixed priority. */
  seq?: number;
};

export type CombatReport = {
  systemId: SystemId;
  attackerSide: Side;
  /** Whether the system was subjugated when combat began. Winning the
   *  battle can liberate it (clearing the flag) before the objective check
   *  runs, so the Liberation objective reads this snapshot, not the live
   *  flag. (Issue #53.) Optional for backward-compat with old saved reports. */
  systemSubjugatedAtStart?: boolean;
  addedLeaders: { side: Side; leaderId: LeaderId; tacticValue: number }[];
  drawnTactics: { side: Side; spaceCount: number; groundCount: number };
  rounds: CombatRoundReport[];
  structureDestructions: { side: Side; typeIds: string[] }[];
  // Units destroyed during retreat (no-transport drops + units explicitly
  // left behind). Per RR p.5-6 these count as "destroyed in this combat"
  // for objective-trigger purposes (e.g. Crippling Blow counts retreat
  // losses toward the 3+ ground HP threshold). Tracked here so the
  // combat-end objective check sees them. Same shape as
  // structureDestructions — one entry per retreat decision.
  retreatDestructions: { side: Side; typeIds: string[] }[];
  // Units destroyed DURING the combat by a card effect rather than by dice —
  // Baze's Loyalty, Target the Generator, Fully Operational, etc. Per RAW these
  // were "destroyed in this combat" and so count toward combat objectives like
  // Crippling Blow (player report #317: a stormtrooper killed by Baze's Loyalty
  // plus an AT-ST killed by dice = 3 ground HP, but the card kill wasn't being
  // counted). Optional for backward-compat with old saved reports.
  cardDestructions?: { side: Side; typeId: string }[];
  /** Retreats that happened during this combat — who pulled out and to where,
   *  so the end-of-combat report can say "Empire retreated to X" instead of
   *  the player having to scan the log/map (player request: MightyFaben).
   *  Optional for backward-compat with old saved reports. */
  retreats?: { side: Side; toSystemId: SystemId; leaderId?: LeaderId }[];
  winner: Side | 'draw' | null;
  totalRounds: number;
  /** Monotonic ordering stamp (turnLog length at queue time) so the UI can
   *  show queued combat/mission reports in true chronological order. */
  seq?: number;
};

// ---------- Refresh-phase summary ----------
// One report per side per refresh, shown sequentially. Both players see both
// reports — refresh events are public information. The per-side split keeps
// each modal compact and focused.
export type RefreshReport = {
  /** Which side this report covers. */
  side: Side;
  /** The turn number this refresh produced (the new timeMarker value). */
  newTurn: number;
  /** Leaders that returned to this side's leader pool during step 1. */
  retrievedLeaders: LeaderId[];
  /** Mission cards drawn into this side's hand. */
  missionsDrawn: { count: number; missionIds: string[] };
  /** Probe cards drawn (Empire side only — empty for Rebel). */
  probesDrawn: { count: number; probeIds: string[] };
  /** Objective card drawn (Rebel side only — empty for Empire). */
  objectivesDrawn: { count: number; objectiveIds: string[] };
  /** StartOfRefresh objectives this side auto-played and the rep gained. */
  objectivesPlayed: { objectiveId: string; reputation: number }[];
  /** Recruit results (action card drawn, leader recruited if any). */
  recruits: { cardId: string; leaderId: LeaderId | null }[];
  /** Units that hit this side's build queue this refresh. */
  builds: { systemId: SystemId | 'rebel-base'; unitTypeId: string; slot: 1 | 2 | 3 }[];
  /** Units that deployed off this side's build queue (slid off slot 1). */
  deployed: { unitTypeId: string; systemId: SystemId }[];
  /** Monotonic ordering stamp (turnLog length at queue time). */
  seq?: number;
};

// ---------- Pending state ----------

export type MissionResolution = {
  missionId: string;
  resolverSide: Side;
  targetSystemId: SystemId;
  // For leader-target missions (e.g. Collect Bounty, Detained): the specific
  // Rebel leader the Empire is going after, when multiple are co-located.
  // Undefined for system-target missions or when there's only one candidate.
  targetLeaderId?: LeaderId;
  // Blindside flag: if true, the opposer cannot send pool leaders to oppose
  // this mission. Set during the Blindside pre-opposition trigger.
  blindsideActive?: boolean;
  // Wookie Guardian: set once its offer has been presented for this mission (so
  // it isn't re-offered on a declined-then-resumed opposition). The subversion
  // +1 die is computed at opposition time and stashed so a Wookie DECLINE can
  // resume the opposition roll (finishOpposition).
  wookieOffered?: boolean;
  oppositionSubversionBonus?: number;
  /** Human-readable notes accumulated during reveal/oppose for response-card
   *  triggers (Undercover, Blindside, Wookie Guardian, etc.). Copied into the
   *  MissionResolutionReport when the report is pushed. */
  interventions?: string[];
  leaderIds: LeaderId[];
  stage: 'reveal' | 'oppose' | 'roll' | 'effect' | 'failed' | 'done';
  // RoE: the resolver's winning margin (resolver total successes − opposer
  // successes), clamped to >= 0. Set when the mission is resolved via a
  // roll. Used by "destroy up to the difference in successes" effects
  // (Plant Explosives, Assault). Undefined for auto-success (unopposed,
  // non-rolling) missions.
  successMargin?: number;
  // Mid-roll stash for R2-D2 mission flip. resolveOpposition pauses here
  // when Empire just rolled and Rebel holds R2-D2; the resolver applies
  // the flip (if accepted) and continues success calc + report push.
  r2d2Pending?: {
    attDice: number;
    opposerDice: number;
    attFaces: string[];
    attColors: ('red' | 'black' | 'green')[];
    attSuccesses: number;
    oppFaces: string[];
    oppColors: ('red' | 'black' | 'green')[];
    oppSuccesses: number;
    portrait: number;
    oppLeaderIds: LeaderId[];
    // Which side is Empire (= the one R2-D2 affects).
    empireSide: 'attacker' | 'opposer';
  };
};

// ---------- Game state ----------

export type LogEntry = {
  turn: number;
  side?: Side;
  kind: string;
  payload?: Record<string, unknown>;
};

export type SeededRngState = { state: number };

export type GameState = {
  // Rise of the Empire configuration this game was created with. Always
  // present as a fully-resolved object (defaults applied at createGame), so
  // engine code and UI can read flags without ?? chains. `enabled: false` is
  // the base game — every other field is forced false in that case and every
  // 'rote'-tagged content item was filtered out at setup.
  expansion: ExpansionConfig;

  // Time / reputation
  timeMarker: number;          // 1..N (8 in base game)
  reputationMarker: number;    // starts at 14, decreases toward time marker
  trackLength: number;         // 16 in the base game

  // Phase
  phase: Phase;
  currentPlayer: Side;
  passedThisCommand: Side[];

  // Factions
  rebel: FactionState;
  empire: FactionState;

  // Map
  map: MapState;
  rebelBaseSystemId: SystemId; // secret; masked via playerView
  rebelBaseRevealed: boolean;
  // Systems the Empire has ruled out as the base by SEARCHING (not probes):
  // any system that has been subjugated (Empire ground) or held Imperial
  // loyalty since the base's last placement — if the base were there, it would
  // have been revealed. Cleared & re-seeded with still-qualifying systems when
  // the base relocates. Not secret (these are systems ruled OUT).
  empireSearchedRuledOut?: SystemId[];

  // Online-only: the probe-deck-derived ruled-out systems, computed server-side
  // and attached to the EMPIRE's redacted view. The deck itself is hidden online
  // (it would leak the base — the base's probe is absent from it), so the UI
  // can't derive rule-outs from the deck and reads this instead. Excludes the
  // base, so it's safe to send. Absent in hotseat (UI computes from the deck).
  empireProbeRuledOut?: SystemId[];

  // Shared decks
  probeDeck: string[];
  spaceTacticDeck: string[];
  spaceTacticDiscard: string[];
  groundTacticDeck: string[];
  groundTacticDiscard: string[];

  // Mid-resolution scratch
  pendingMission?: MissionResolution;
  pendingCombat?: CombatState;
  pendingChoice?: ChoiceRequest;

  // Setup-phase deployment state (rr p.15 step 8). Empty when setup is complete.
  // Each side has a list of unit type ids still to be placed. Rebel only:
  // rebelDeployTarget records which non-base-space system (if any) Rebel
  // chose to place starting units in — once chosen, all subsequent Rebel
  // starting units must go to either Rebel Base space or that system.
  pendingDeployment?: {
    Rebel: UnitTypeId[];
    Empire: UnitTypeId[];
  };
  rebelDeployTarget?: SystemId | null;
  // RoE only (rules p.8): the single remote system the Empire chose to hold its
  // Death Star Under Construction (+ companion units). Once chosen, it is the
  // ONE remote system Empire starting units may be placed in (in addition to
  // Imperial-loyalty / subjugated systems). Null in base-game setup.
  empireDeployTarget?: SystemId | null;

  // 5 candidate base-location systems shown to the Rebel during Setup (rr p.15
  // step 9). When set, the Rebel must call pickRebelBase before deployment
  // completes. If undefined, the base has already been finalised.
  pendingRebelBasePick?: SystemId[];

  // Queue of "not yet implemented" notices. The play tab pops a modal for each
  // and clears them on acknowledgement. Lets us surface known gaps to the
  // tester immediately rather than have them logged as bugs.
  // `kind` distinguishes real game-info notices (pushNotice) from unfinished
  // code-path notices (notImplemented) so the UI can title each correctly.
  // Absent ⇒ treat as 'notImplemented' for back-compat with old logs.
  // `side`, when set, scopes the notice to that player — online, only that seat
  // is shown it (a Rebel-only "Rapid Mobilization queued" notice must NOT pop for
  // the Empire). Untagged notices are global (shown to whoever's acting).
  pendingNotices?: { id: string; title: string; details?: string; kind?: 'info' | 'notImplemented'; side?: Side }[];

  // Persistent leader attachments ("attachment rings", RR p.3). Per the
  // rulebook, a leader can have only one ring at a time — a new ring replaces
  // the old. The capture / carbonite rings live in capturedLeaders.ring;
  // these are the *other* rings (Yoda, dark-side, R2D2, etc).
  leaderAttachments?: Record<string, ('yoda' | 'dark-side' | 'r2d2' | 'c3po' | 'bounty' | 'k2so')[]>;

  // Leaders who can't be opposed by pool leaders this round (Misdirection).
  // Cleared at end of Command phase. The protection only blocks pool
  // recruits — opposing leaders already at the target system still oppose.
  misdirectionProtected?: string[];

  // Per-round Yoda-ring reroll state: once the Yoda-ring leader rerolls a
  // die this round, sets to true. Reset on entering Refresh.
  yodaRerollUsedThisRound?: boolean;

  // Transient state for a Death Star Plans objective roll that's paused for
  // One-in-a-Million / Yoda reroll offers (both apply to the DSP roll per the
  // card text + rr). Holds the rolled faces while the player decides, then
  // the success/miss is finalized against the (possibly modified) faces.
  dsPlansAttempt?: {
    objectiveId: string;
    systemId: SystemId;
    deathStarInstanceIds: string[];
    deathStarInstanceId?: string;   // chosen target (if multiple Death Stars)
    faces: string[];
    oimOffered?: boolean;           // One-in-a-Million already offered
    yodaOffered?: boolean;          // Yoda reroll already offered
  };

  // Combat reports queued for the UI to display. Each is consumed (dismissed)
  // by the player after combat ends; the engine just appends.
  combatReports?: CombatReport[];

  // Mission resolution reports queued for the UI. Same lifecycle as
  // combatReports: engine appends, player dismisses one at a time.
  missionReports?: MissionResolutionReport[];

  // System-activation reports (both sides) queued for the UI — leader moved
  // units / triggered combat. Same append/dismiss lifecycle.
  activationReports?: SystemActivationReport[];

  // Objective-completion notices queued for the UI (issue #71: scoring an
  // objective like Major Victory gained reputation silently). Same lifecycle:
  // engine appends when a Rebel objective is scored, player dismisses one at a
  // time. `via` describes how it scored (combat / refresh / death-star-plans).
  objectiveReports?: { objectiveId: string; reputation: number; via: string; seq?: number }[];

  // RoE Cinematic Confrontation: Imperial leaders marked for elimination at the
  // end of the current Command phase (the last Imperial ground unit was
  // destroyed in a combat where the Rebel played Confrontation). Eliminated and
  // cleared when the Command phase ends (start of enterRefreshPhase).
  cinematicMarkedForElimination?: LeaderId[];

  // Refresh-phase summary, generated each time the refresh phase runs.
  // The UI shows a single modal with everything that happened (objective
  // drawn, missions drawn, probes drawn, leaders retrieved, time advanced,
  // units built per system). Dismissed by the player. One at a time.
  refreshReports?: RefreshReport[];

  // Mid-refresh resumable state. When the refresh phase pauses for a
  // BuildPick choice, we stash:
  //   - logStart: where the refresh's log slice began (so the final report
  //     covers the whole phase even though it spans multiple resume calls)
  //   - pendingBuildPicks: ordered list of per-side build-pick packs still
  //     to resolve (Rebel first, then Empire). Each entry is queued as a
  //     BuildPick ChoiceRequest one at a time.
  // RoE refresh pre-step cursor: drives the resumable sequence of persistent
  // objective steps (Show No Fear / Raid Outposts scoring + placement / Rebel
  // Cell placement + discard) that run before the one-shot objective step.
  // Reset to 0 each enterRefreshPhase; survives the pause/resume of each
  // placement/discard choice so scoring isn't repeated on resume.
  refreshPreStep?: number;
  // Set when the Rebel takes Rebel Cell's "discard for reputation" option this
  // Refresh — it replaces playing a one-shot objective, so that step is skipped.
  refreshRebelCellDiscardTaken?: boolean;
  refreshPaused?: {
    logStart: number;
    // Recruit-step picks queued before the build-step picks. Processed
    // Rebel first, then Empire. Each side picks 1 of 2 drawn action
    // cards to keep (and recruits the matching leader if able).
    pendingRecruitPicks?: { side: Side; drawnIds: string[] }[];
    pendingBuildPicks: {
      side: Side;
      picks: {
        sourceSystemId: SystemId | 'rebel-base';
        slot: 1 | 2 | 3;
        iconType: Theater;
        iconShape: 'triangle' | 'circle' | 'square';
        legalUnitTypes: UnitTypeId[];
        available?: Record<UnitTypeId, number>;
      }[];
      // Single-choice icon builds already applied this refresh — shown
      // in the BuildPick modal as context.
      autoApplied: {
        sourceSystemId: SystemId | 'rebel-base';
        slot: 1 | 2 | 3;
        unitTypeId: UnitTypeId;
      }[];
    }[];
    // Deploy-step queue: units that fell off slot 1 of the build queue
    // and need a player-chosen target system. Each entry processed one
    // at a time as a DeployUnitPick ChoiceRequest.
    pendingDeployPicks?: { side: Side; typeId: UnitTypeId }[];
    // Per-side, per-system count of units deployed THIS refresh phase.
    // RR p.7 caps deployment at 2 units per system per side per Refresh.
    deployedThisPhase?: Partial<Record<Side, Record<SystemId, number>>>;
  };
  // Hand-limit discard queue (Refresh step 2). After drawing missions, any side
  // over the 10-card limit must discard down — processed one side at a time as a
  // HandLimitDiscard choice. Steps 3-6 of Refresh resume once the queue drains.
  pendingHandLimitDiscards?: {
    logStart: number;
    queue: { side: Side; count: number; discardable: string[] }[];
  };

  // "You may reveal" offer queue for armed Empire cards (#396): Secret Facility
  // at the start of an Empire Command turn ('command-start'), Sweep the Area at
  // the end of the Command phase ('command-end'). One ArmedCardRevealOffer is
  // posted per card; declining keeps the card armed for a future turn. `phase`
  // selects the continuation once the queue drains (command-end resumes the
  // end-of-phase Rapid Mobilization / Refresh transition). Transient.
  pendingArmedReveals?: {
    phase: 'command-start' | 'command-end';
    remaining: ArmedActionCard[];
  };

  // Flags set by Assignment-timed action cards. Cleared at appropriate
  // points (end of turn / start of next refresh). Out-of-band of the
  // formal phase machinery — UI and engine read them opportunistically.
  actionCardFlags?: {
    // Public Support: Janus Greejatus does NOT pin units in this system this turn.
    greejatusFreeMoveSystemId?: SystemId;
    // Brilliant Administrator: Tarkin has earned a free build action at this system.
    tarkinFreeBuildSystemId?: SystemId;
    // Boba Fett, Where? — Rebels cannot mission/use action cards in any of these systems this turn.
    bobaBlockSystemIds?: SystemId[];
    // Contingency Plan: Lando gains +2 successes on his next mission attempt this round.
    landoContingencyBonus?: boolean;
  };

  // Leaders the Detained mission has flagged to skip the NEXT refresh
  // retrieval. Cleared after the skip fires (one-time effect per RAW).
  detainedLeadersNextRefresh?: { side: Side; leaderId: LeaderId }[];

  // Rapid Mobilization missions that have been resolved this Command phase
  // and are waiting for their end-of-phase choice. Drained one entry at a
  // time after both players pass, posting RapidMobilizationBranch choices
  // before Refresh begins.
  pendingRapidMobilizations?: { twoLeaders: boolean }[];

  // End conditions
  isGameOver: boolean;
  winner?: Side;
  winReason?: string;

  // Online "vs AI": sides controlled by the server-side heuristic AI. Set at
  // game creation for online-vs-AI games; the engine ignores it (it's metadata
  // the online server reads to auto-play those seats). Absent/empty = all
  // seats are human.
  aiSides?: Side[];

  // Determinism
  rng: SeededRngState;
  controllerSeeds: { rebel: number; empire: number };

  // Log
  turnLog: LogEntry[];

  // Static data loaded at setup (references; not mutated)
  // We hold references so engine functions can be pure and not require global lookups.
  catalog: GameCatalog;
};

export type GameCatalog = {
  systems: Record<SystemId, SystemDef>;
  adjacency: Record<SystemId, SystemId[]>;
  leaders: Record<LeaderId, LeaderData>;
  unitTypes: Record<UnitTypeId, UnitType>;
  actions: Record<string, ActionCard>;
  missions: Record<string, MissionCard>;
  objectives: Record<string, ObjectiveCard>;
  tactics: Record<string, TacticCard>;
  probes: Record<string, ProbeCard>;
};

export type SystemDef = {
  id: SystemId;
  name: string;
  region: number;
  isRemote: boolean;
  isCoruscant: boolean;
  resources: ResourceIcon[];
  buildSlot: 1 | 2 | 3 | null;
  set?: 'base' | 'rote'; // undefined = base game; 'rote' = Rise of the Empire
};
