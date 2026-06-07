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
  /** Use the New Starter Units deployment list (vs the Old RoE list). */
  newStarterUnits: boolean;
  /** Swap base mission deck for the RoE deck (starting/project always in). */
  roeMissions: boolean;
  /** Use the optional Cinematic Combat module. */
  cinematicCombat: boolean;
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
};

export type ObjectiveTiming = 'Combat' | 'StartOfRefresh' | 'Special' | '';

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
