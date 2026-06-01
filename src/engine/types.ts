// Engine state types. Distinct from src/types.ts which holds data-file shapes.
// See docs/core-model.md for the rules-level model.

import type {
  Side, SystemId, ResourceIcon,
  Leader as LeaderData,
  ActionCard, MissionCard, ObjectiveCard, TacticCard, ProbeCard,
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
  attack: { red: number; black: number };
  transport: { capacity: number; restriction: boolean; immobile: boolean };
  buildResource: 1 | 2 | 3;
  supplyCount: number;
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

  // Card piles
  actionDeck: string[];
  actionHand: string[];
  actionDiscard: string[]; // returned to the box, kept for analytics only

  missionDeck: string[];
  missionHand: string[];
  missionDiscard: string[];

  // Build
  buildQueue: BuildQueue;

  // Rebel-only
  objectiveDeck?: string[];
  objectiveHand?: string[];
  objectiveDiscard?: string[];

  // Empire-only
  probeHand?: string[];
  projectDeck?: string[];
  projectDiscard?: string[];
  capturedLeaders?: CapturedLeader[];
};

// ---------- Game flow ----------

export type Phase = 'Setup' | 'Assignment' | 'Command' | 'Refresh' | 'GameOver';

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
      poolLeaders: LeaderId[];  // opposer's pool leaders available to send
      existingAtTarget: LeaderId[]; // already-there opposer leaders (auto-oppose)
    }
  | { kind: 'AssignDamage'; dice: DieResult[]; targets: UnitInstanceId[] }
  | { kind: 'PlayTacticCard'; hand: string[]; allowSkip: boolean }
  | { kind: 'CombatAction'; options: CombatActionOption[] }
  | { kind: 'RetreatTo'; legal: SystemId[]; allowSkip: boolean }
  | { kind: 'DeployTarget'; unitTypeId: UnitTypeId; legal: SystemId[] }
  | { kind: 'PickProbeForNewBase'; cards: string[] }
  | { kind: 'PlayObjective'; legal: string[]; window: 'combat' | 'refresh' }
  | { kind: 'YesNo'; prompt: string }
  | { kind: 'ChooseActionCard'; from: string[] }
  | { kind: 'InfiltrationPick'; missionId: string; topId: string; bottomId: string }
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
      side: Side;             // always 'Empire'
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
      context: 'combat' | 'mission';
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
      // Some action cards need a system target. Posted after the card
      // is picked; legal systems are pre-filtered per the card's text.
      kind: 'ActionCardSystemPick';
      side: Side;
      cardId: string;
      candidates: SystemId[];
    }
  | {
      // Droid ring (R2-D2 / C-3PO): the Rebel attaches the ring to one of
      // their leaders. The ring's discard effect later triggers only in that
      // leader's system. Posted when the player plays the droid action card.
      kind: 'AttachRingPick';
      side: Side; // 'Rebel'
      cardId: string; // 'resourceful-astromech' | 'human-cyborg-relations'
      ringId: 'r2d2' | 'c3po';
      candidates: LeaderId[];
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
      missionId: string;
      remaining: string[];      // objective card IDs still to be picked
      orderedTop: string[];     // accumulated pick order (index 0 = topmost)
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
      // Plan The Assault: Rebel picks which ships in rebel-base-space to
      // move to the target system (which then triggers combat).
      kind: 'PlanTheAssaultShips';
      side: Side;            // always 'Rebel'
      targetSystemId: SystemId;
      availableShipIds: UnitInstanceId[];
    }
  | {
      // Lead The Strike Team: Rebel picks up to 4 GROUND units in
      // rebel-base-space to move to the target system (ignoring transport
      // restriction and adjacency), which then triggers combat.
      kind: 'LeadStrikeTeamUnits';
      side: Side;            // always 'Rebel'
      targetSystemId: SystemId;
      availableUnitIds: UnitInstanceId[];
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
      context: 'combat' | 'mission';
      // Combat-only: which theater (for the panel header).
      theater?: Theater;
      systemId: SystemId;
      // Indices into the relevant faces array that are blank.
      blankIndices: number[];
      holderLeaderId: LeaderId;
      // Mission-only: snapshot of the roll's faces (for display in the
      // panel). The resolver re-reads them from pm.r2d2Pending stash.
      missionFaces?: string[];
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
      // "Fully Operational" (Moff Jerjerrod): if a Death Star or Death Star
      // Under Construction is in the system, Empire picks one Rebel ship to
      // destroy. `candidates` are eligible Rebel ship instance ids.
      kind: 'FullyOperationalTargetPick';
      side: Side;
      systemId: SystemId;
      candidates: string[]; // unit instanceIds
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
  attackerHand: string[]; // tactic card ids
  defenderHand: string[];
  retreated: Side[]; // each side at most once
  report: CombatReport; // accumulated play-by-play
  // Mid-attack resumable state. Set when an attack pauses mid-resolution to
  // ask a side which tactic cards to play. Cleared at the end of the attack.
  pendingAttack?: {
    side: Side;          // who's currently attacking
    theater: Theater;
    phase: 'awaitingYodaReroll' | 'awaitingR2D2Flip' | 'awaitingOneInAMillion' | 'awaitingSpecialSpend' | 'awaitingAttackerTactics' | 'awaitingDefenderTactics' | 'awaitingDamageAssignment';
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
  attackerDice?: { count: number; faces: string[]; successes: number };
  opposerDice?: { count: number; faces: string[]; successes: number };
  portraitBonus?: number;            // +2 if the assigned leader matches the card's portrait
  attackerTotal?: number;            // dice successes + portrait
  result: 'success' | 'failure' | 'auto-success';
  /** Human-readable notes for response-card interventions that fired during
   *  resolution (Undercover relocate, Blindside, Wookie Guardian, etc.).
   *  Surfaced in MissionReportModal so the player understands WHY a mission
   *  succeeded / failed / was diverted — "nothing happened" was opaque. */
  interventions?: string[];
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
  winner: Side | 'draw' | null;
  totalRounds: number;
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
  /** Human-readable notes accumulated during reveal/oppose for response-card
   *  triggers (Undercover, Blindside, Wookie Guardian, etc.). Copied into the
   *  MissionResolutionReport when the report is pushed. */
  interventions?: string[];
  leaderIds: LeaderId[];
  stage: 'reveal' | 'oppose' | 'roll' | 'effect' | 'failed' | 'done';
  // Mid-roll stash for R2-D2 mission flip. resolveOpposition pauses here
  // when Empire just rolled and Rebel holds R2-D2; the resolver applies
  // the flip (if accepted) and continues success calc + report push.
  r2d2Pending?: {
    attDice: number;
    opposerDice: number;
    attFaces: string[];
    attColors: ('red' | 'black')[];
    attSuccesses: number;
    oppFaces: string[];
    oppColors: ('red' | 'black')[];
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

  // 5 candidate base-location systems shown to the Rebel during Setup (rr p.15
  // step 9). When set, the Rebel must call pickRebelBase before deployment
  // completes. If undefined, the base has already been finalised.
  pendingRebelBasePick?: SystemId[];

  // Queue of "not yet implemented" notices. The play tab pops a modal for each
  // and clears them on acknowledgement. Lets us surface known gaps to the
  // tester immediately rather than have them logged as bugs.
  pendingNotices?: { id: string; title: string; details?: string }[];

  // Persistent leader attachments ("attachment rings", RR p.3). Per the
  // rulebook, a leader can have only one ring at a time — a new ring replaces
  // the old. The capture / carbonite rings live in capturedLeaders.ring;
  // these are the *other* rings (Yoda, dark-side, R2D2, etc).
  leaderAttachments?: Record<string, ('yoda' | 'dark-side' | 'r2d2' | 'c3po')[]>;

  // Leaders who can't be opposed by pool leaders this round (Misdirection).
  // Cleared at end of Command phase. The protection only blocks pool
  // recruits — opposing leaders already at the target system still oppose.
  misdirectionProtected?: string[];

  // Per-round Yoda-ring reroll state: once the Yoda-ring leader rerolls a
  // die this round, sets to true. Reset on entering Refresh.
  yodaRerollUsedThisRound?: boolean;

  // Combat reports queued for the UI to display. Each is consumed (dismissed)
  // by the player after combat ends; the engine just appends.
  combatReports?: CombatReport[];

  // Mission resolution reports queued for the UI. Same lifecycle as
  // combatReports: engine appends, player dismisses one at a time.
  missionReports?: MissionResolutionReport[];

  // Objective-completion notices queued for the UI (issue #71: scoring an
  // objective like Major Victory gained reputation silently). Same lifecycle:
  // engine appends when a Rebel objective is scored, player dismisses one at a
  // time. `via` describes how it scored (combat / refresh / death-star-plans).
  objectiveReports?: { objectiveId: string; reputation: number; via: string }[];

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
};
