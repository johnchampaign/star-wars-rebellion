// Match the data shapes from docs/core-model.md. Engine types come later.

export type SystemId = string;

// A resource icon on a populous system's printed board location.
// Color: space (blue) builds ships; ground (orange) builds ground units.
// Shape: tier hierarchy — triangle < circle < square.
//   - triangle: can build only triangle-tier units (smallest fighters/troopers)
//   - circle:   can build triangle- or circle-tier units (adds carriers/corvettes/etc.)
//   - square:   can build any tier (including capital ships, AT-AT, etc.)
export type ResourceIcon = {
  type: 'space' | 'ground';
  shape: 'triangle' | 'circle' | 'square';
};

export type System = {
  id: SystemId;
  name: string;
  region: number;
  isRemote: boolean;
  isCoruscant: boolean;
  // The build-queue slot (1, 2, or 3) that units built from this system land on.
  // Applies to ALL of this system's resource icons. Null if isRemote (no icons at all).
  buildSlot: 1 | 2 | 3 | null;
  // 0..2 ordered entries. resources[0] is the "left" icon (the only one usable when subjugated, rr p.3).
  resources: ResourceIcon[];
  boardPos: { x: number; y: number };
  // Position of the printed loyalty hex on the board. Null for remote systems
  // and Coruscant (which have no loyalty space).
  loyaltyMarkerPos?: { x: number; y: number } | null;
  // Position of the printed RESOURCE icons on the board — where the sabotage
  // marker belongs (it covers production; player report #174). Calibrated via
  // the dev positions tab. When absent the renderer falls back to the
  // loyalty-hex / planet position.
  sabotageMarkerPos?: { x: number; y: number } | null;
};

export type SystemsFile = {
  _meta: {
    schema: string;
    provenance: string;
    source: string;
    notes: string[];
  };
  systems: System[];
};

export type AdjacencyFile = {
  _meta: {
    schema: string;
    provenance: string;
    source: string;
    notes: string[];
  };
  neighbors: Record<SystemId, SystemId[]>;
};

export type Side = 'Rebel' | 'Empire';

export type SkillCounts = {
  diplomacy: number;
  intel: number;
  specOps: number;
  logistics: number;
};

export type TacticValues = {
  space: number;
  ground: number;
};

/** Which game set a content item belongs to. Absent/undefined is treated as
 *  'base' everywhere — only entries explicitly tagged 'rote' are filtered out
 *  of a game that didn't opt into the Rise of the Empire expansion. */
export type ContentSet = 'base' | 'rote';

/** Per-game Rise of the Empire configuration. `enabled: false` (the default)
 *  is the pure base game — every other field is forced off, and every
 *  `set:'rote'` catalog entry is filtered out at setup, so play is byte-
 *  identical to pre-expansion. When `enabled` flips on, it brings the
 *  expansion's non-optional pieces (leaders, the core new rules — green
 *  dice, 8-leader cap, target markers, unit abilities), and the sub-toggles
 *  cover the parts the rulebook actually lets you mix-and-match. The
 *  swap flags replace, not extend, the corresponding base content. See
 *  docs/rise-of-the-empire.md for the full semantics. */
export type ExpansionConfig = {
  enabled: boolean;
  /** Swap base unit roster + supply for the RoE roster. */
  roeUnits: boolean;
  /** Swap base mission deck for the RoE deck (starting/project always in).
   *  Shared default / back-compat; per-side values below take precedence. */
  roeMissions: boolean;
  /** Per-side mission set. RoE p.2 "Choosing Mission Sets": the Rebel and
   *  Imperial player each pick their set independently and MAY differ (one on
   *  base, one on RoE). Default to `roeMissions` when a game doesn't set them. */
  roeMissionsRebel: boolean;
  roeMissionsEmpire: boolean;
  /** Online only: which seats have LOCKED IN their mission-set choice. In an
   *  async PvP game each human seat picks its own set the first time that player
   *  enters (before the Setup phase ends); an AI seat is locked at creation with
   *  a random set. Absent/false for a seat = not yet chosen (show the chooser).
   *  Single-player leaves this undefined entirely (both sides set at setup). */
  missionSetLocked?: { Rebel?: boolean; Empire?: boolean };
  /** Use the optional Cinematic Combat module. */
  cinematicCombat: boolean;
  /** VARIANT (#519): deploy the BASE-game starting units at setup while still
   *  keeping the full expansion unit roster available to build during the game.
   *  Only meaningful when `roeUnits` is true; otherwise base units are already
   *  used. Default false. */
  baseSetupUnits?: boolean;
};

export type Leader = {
  id: string;
  name: string;
  side: Side;
  isStarting: boolean;
  skills: SkillCounts;
  minorSkills: SkillCounts; // RoE only — always zeros in base game
  tacticValues: TacticValues;
  image: string; // filename inside the .vmod images set
  set?: ContentSet; // undefined = base game
};

export type RectKind =
  | 'hide'                          // dark overlay, info shown in parallel panels
  | 'rebel-base'                    // staging area for Rebel units while base is hidden
  | 'build-1-rebel' | 'build-2-rebel' | 'build-3-rebel'
  | 'build-1-empire' | 'build-2-empire' | 'build-3-empire';

export type MaskRect = {
  id: string;
  label: string;
  x: number;       // native pixels
  y: number;
  width: number;
  height: number;
  kind: RectKind;
};

export type BoardMaskFile = {
  _meta: {
    schema: string;
    provenance: string;
    source: string;
    notes: string[];
  };
  masks: MaskRect[];
};

export type LeadersFile = {
  _meta: {
    schema: string;
    provenance: string;
    source: string;
    notes: string[];
  };
  leaders: Leader[];
};

// ===== Cards =====

export type Skill = 'diplomacy' | 'intel' | 'specOps' | 'logistics';

export type ActionTiming = 'Assignment' | 'StartOfCombat' | 'Immediate' | 'Special' | '';

export type ActionCard = {
  id: string;
  name: string;
  side: Side;
  isStarting: boolean;
  timing: ActionTiming;
  leaderRequirement: string[]; // leader ids
  effectKey: string;
  rulesText: string;
  image: string;
  set?: ContentSet;
};

export type MissionCard = {
  id: string;
  name: string;
  side: Side;
  isStarting: boolean;
  isProject: boolean;
  // Project missions only: number of identical copies in the project deck. The
  // base-game project deck is 10 cards across 5 names (rr component list +
  // mission reference: Construct Death Star x1, Construct Factory x2, Construct
  // Super Star Destroyer x2, Oversee Project x2, Superlaser Online x3).
  // Absent/1 for every non-project mission. See setup.ts deck expansion.
  projectCopies?: number;
  skill: Skill | '';
  skillCost: number;
  isAttempt: boolean;
  leaderPortrait: string | null;
  effectKey: string;
  rulesText: string;
  image: string;
  set?: ContentSet;
  // Which RoE mission SET this card belongs to, distinct from `set` (ownership).
  // RAW (RoE rulebook): in an expansion game each player uses EITHER the base
  // mission set OR the Rise of the Empire set, not both. Most cards are derived
  // (base no-icon → base set; base + leader portrait → BOTH sets; rote/Vader-icon
  // → rote set). This explicit field is only needed for the rare card that is
  // RoE-owned (`set: 'rote'`) yet belongs to the BASE set — e.g. the "Core"
  // Subversion. Omit it to use the derived membership.
  missionSet?: 'base' | 'rote' | 'both';
};

// Base objectives use 'StartOfRefresh'; Rise of the Empire objectives use
// 'Refresh' (same start-of-Refresh window) and 'Immediate' (place-on-play
// persistent objectives — wired in the 5d-ii follow-up).
export type ObjectiveTiming = 'Combat' | 'StartOfRefresh' | 'Refresh' | 'Immediate' | 'Special' | '';

export type ObjectiveCard = {
  id: string;
  name: string;
  stage: 1 | 2 | 3;
  reputation: number;
  timing: ObjectiveTiming;
  effectKey: string;
  rulesText: string;
  image: string;
  set?: ContentSet;
};

export type TacticCard = {
  id: string;
  name: string;
  theater: 'ground' | 'space';
  requiresSpecial: boolean;
  effectKey: string;
  rulesText: string;
  image: string;
  set?: ContentSet;
  // ----- Cinematic Combat (RoE advanced tactic cards) -----
  // These fields are present only on `cinematic: true` cards. Cinematic
  // Combat (rules p.9) replaces the standard tactic deck with these
  // side-specific advanced cards, each with a primary + secondary ability
  // and (usually) a primary-unit prerequisite for the primary ability.
  cinematic?: boolean;
  side?: Side;                 // advanced cards are side-specific
  // Primary ability requires at least 1 of this unit type in the system
  // (the "unit icon" prerequisite, rules p.9). Undefined = no prereq.
  primaryUnit?: string;        // unit type id, e.g. 'tie-fighter'
  primaryText?: string;        // verbatim card text for the top (primary) ability
  secondaryText?: string;      // verbatim card text for the bottom (secondary) ability
  // Effect keys wired in Phase 7c; empty until then.
  primaryEffectKey?: string;
  secondaryEffectKey?: string;
};

export type ProbeCard = {
  id: string;
  systemId: string;
  systemName: string;
  set?: ContentSet;
};

type DeckMeta = {
  schema: string;
  provenance: string;
  source: string;
  notes: string[];
};

export type ActionsFile    = { _meta: DeckMeta; actions: ActionCard[] };
export type MissionsFile   = { _meta: DeckMeta; missions: MissionCard[] };
export type ObjectivesFile = { _meta: DeckMeta; objectives: ObjectiveCard[] };
export type TacticsFile    = { _meta: DeckMeta; tactics: TacticCard[] };
export type ProbesFile     = { _meta: DeckMeta; probes: ProbeCard[] };
