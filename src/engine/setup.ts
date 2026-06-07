// GameSetup.create(seed, ...) — produce a valid initial GameState per rr p.15.

import type {
  SystemsFile, AdjacencyFile, LeadersFile,
  ActionsFile, MissionsFile, ObjectivesFile, TacticsFile, ProbesFile,
  ExpansionConfig,
} from '../types';
import type {
  GameState, GameCatalog, FactionState, SystemState, MapState,
  Phase, BuildQueue, UnitInstance, LeaderId, SystemDef, Side, SystemId,
} from './types';
import { createRng, shuffle, nextInt } from './rng';

// Re-export for use in this module; keeps the import line readable.
const nextIntForSetup = nextInt;
import { UNIT_TYPES_BY_ID } from './units';
import { log } from './log';
import { registerAll as registerHandlers } from './handlers';

registerHandlers();

// ---------- Bundle of loaded JSONs ----------

export type DataBundle = {
  systems: SystemsFile;
  adjacency: AdjacencyFile;
  leaders: LeadersFile;
  actions: ActionsFile;
  missions: MissionsFile;
  objectives: ObjectivesFile;
  tactics: TacticsFile;
  probes: ProbesFile;
};

// Base-game starting units per rr p.15.
const IMPERIAL_STARTING_UNITS_BASE: { typeId: string; count: number }[] = [
  { typeId: 'star-destroyer', count: 3 },
  { typeId: 'assault-carrier', count: 3 },
  { typeId: 'tie-fighter', count: 12 },
  { typeId: 'stormtrooper', count: 12 },
  { typeId: 'at-st', count: 5 },
  { typeId: 'at-at', count: 1 },
  { typeId: 'death-star', count: 1 },
];

const REBEL_STARTING_UNITS_BASE: { typeId: string; count: number }[] = [
  { typeId: 'corellian-corvette', count: 1 },
  { typeId: 'rebel-transport', count: 1 },
  { typeId: 'x-wing', count: 2 },
  { typeId: 'y-wing', count: 2 },
  { typeId: 'rebel-trooper', count: 6 },
  { typeId: 'airspeeder', count: 2 },
];

// Rise of the Empire — "New Starter Units" deployment, per
// StarWarsRebellion_v2.5.pdf p.8 "Rise of the Empire Expansion → Setup".
// The rulebook splits the Imperial setup into (a) one chosen remote system
// that gets a DSUC + 4 TIE Fighters + 1 Stormtrooper, plus a Death Star on
// queue slot 3, and (b) the remaining roster deployed across Imperial
// systems. We collapse both into a single per-unit list — the existing
// auto-setup distributes; the interactive setup leaves placement to the
// Imperial player. Totals: 12 TIE Fighters (4+8), 13 Stormtroopers (1+12),
// 3 Assault Carriers, 3 Star Destroyers, 2 TIE Strikers, 4 AT-STs,
// 2 Assault Tanks, 1 AT-AT, 1 DSUC, 1 Death Star (which the build queue
// gets in this code path).
const IMPERIAL_STARTING_UNITS_RoE_NEW: { typeId: string; count: number }[] = [
  { typeId: 'star-destroyer', count: 3 },
  { typeId: 'assault-carrier', count: 3 },
  { typeId: 'tie-fighter', count: 12 },
  { typeId: 'tie-striker', count: 2 },
  { typeId: 'stormtrooper', count: 13 },
  { typeId: 'at-st', count: 4 },
  { typeId: 'assault-tank', count: 2 },
  { typeId: 'at-at', count: 1 },
  { typeId: 'death-star', count: 1 },
  { typeId: 'death-star-under-construction', count: 1 },
];

// Rebel New Starter Units (rules p.8): all deploy to Rebel Base and/or any
// Rebel/neutral system (except remote systems with a DSUC).
const REBEL_STARTING_UNITS_RoE_NEW: { typeId: string; count: number }[] = [
  { typeId: 'corellian-corvette', count: 1 },
  { typeId: 'rebel-transport', count: 1 },
  { typeId: 'x-wing', count: 1 },
  { typeId: 'y-wing', count: 1 },
  { typeId: 'u-wing', count: 1 },
  { typeId: 'rebel-trooper', count: 5 },
  { typeId: 'rebel-vanguard', count: 1 },
  { typeId: 'airspeeder', count: 2 },
];

// Old RoE starter list (the original "Rise of the Empire - Old Starter
// Units" VASSAL setup) is TODO — transcribe from the OLD deployment card
// when needed. Until then, `expansion.newStarterUnits === false` (with
// expansion enabled) falls back to the base starter list.
function pickStartingUnits(expansion: ExpansionConfig, side: 'Empire' | 'Rebel') {
  if (expansion.enabled && expansion.newStarterUnits) {
    return side === 'Empire'
      ? IMPERIAL_STARTING_UNITS_RoE_NEW
      : REBEL_STARTING_UNITS_RoE_NEW;
  }
  return side === 'Empire'
    ? IMPERIAL_STARTING_UNITS_BASE
    : REBEL_STARTING_UNITS_BASE;
}

// ---------- Catalog builder ----------

function byId<T extends { id: string }>(arr: readonly T[]): Record<string, T> {
  return Object.fromEntries(arr.map((x) => [x.id, x]));
}

/** Build the static catalog (systems/leaders/cards) from raw asset data.
 *  Exported so the online server can build the catalog the multiplayer codec
 *  needs to rehydrate snapshots (decode requires it). */
export function buildCatalog(data: DataBundle): GameCatalog {
  const systems: Record<string, SystemDef> = {};
  for (const s of data.systems.systems) {
    systems[s.id] = {
      id: s.id, name: s.name, region: s.region,
      isRemote: s.isRemote, isCoruscant: s.isCoruscant,
      resources: s.resources, buildSlot: s.buildSlot,
      set: (s as { set?: 'base' | 'rote' }).set,
    };
  }

  return {
    systems,
    adjacency: data.adjacency.neighbors,
    leaders: byId(data.leaders.leaders),
    unitTypes: UNIT_TYPES_BY_ID,
    actions: byId(data.actions.actions),
    missions: byId(data.missions.missions),
    objectives: byId(data.objectives.objectives),
    tactics: byId(data.tactics.tactics),
    probes: byId(data.probes.probes),
  };
}

// ---------- Empty state factories ----------

function emptySystemState(): SystemState {
  return {
    loyalty: 'neutral',
    subjugated: false,
    destroyed: false,
    sabotage: false,
    units: [],
  };
}

function emptyBuildQueue(): BuildQueue {
  return { 1: [], 2: [], 3: [] };
}

function emptyFaction(side: 'Rebel' | 'Empire'): FactionState {
  const base: FactionState = {
    side,
    leaderPool: [],
    leadersOnBoard: {},
    leadersOnMissions: [],
    eliminatedLeaders: [],
    attachmentRings: [],
    actionDeck: [],
    actionHand: [],
    actionDiscard: [],
    missionDeck: [],
    missionHand: [],
    missionDiscard: [],
    buildQueue: emptyBuildQueue(),
  };
  if (side === 'Rebel') {
    base.objectiveDeck = [];
    base.objectiveHand = [];
    base.objectiveDiscard = [];
  } else {
    base.probeHand = [];
    base.projectDeck = [];
    base.projectDiscard = [];
    base.capturedLeaders = [];
  }
  return base;
}

// ---------- Setup ----------

export type SetupOptions = {
  seed: number;
  controllerSeeds?: { rebel: number; empire: number };
  // Optional overrides (mostly for tests):
  forcedBaseSystem?: string;     // Rebel's secret base location
  forcedRebelLoyalty?: string[]; // 3 system ids
  forcedImperialLoyalty?: string[]; // 5 system ids (first 2 become subjugated, last 3 loyalty markers)
  // If true (default), starting units are auto-placed using a deterministic
  // round-robin heuristic, and the game starts in the Assignment phase.
  // If false, units go into G.pendingDeployment for interactive placement
  // during a 'Setup' phase (rr p.15 step 8).
  autoSetupUnits?: boolean;
  // Rise of the Empire configuration. Pass a partial — defaults are applied
  // by resolveExpansion(). Omitted/undefined ⇒ pure base game (every
  // 'rote'-tagged catalog entry filtered out at setup). The resolved config
  // is recorded on G.expansion. See ExpansionConfig in src/types.ts.
  expansion?: Partial<ExpansionConfig>;
};

/** Apply defaults to a partial expansion config. When `enabled` is false the
 *  sub-toggles are forced false (they can't matter without the expansion).
 *  When `enabled` is true the defaults follow docs/rise-of-the-empire.md:
 *  RoE units, New starter units, RoE missions ON; Cinematic Combat OFF. */
export function resolveExpansion(input?: Partial<ExpansionConfig>): ExpansionConfig {
  const enabled = input?.enabled === true;
  if (!enabled) {
    return {
      enabled: false,
      roeUnits: false, newStarterUnits: false, roeMissions: false,
      cinematicCombat: false,
    };
  }
  return {
    enabled: true,
    roeUnits: input?.roeUnits ?? true,
    newStarterUnits: input?.newStarterUnits ?? true,
    roeMissions: input?.roeMissions ?? true,
    cinematicCombat: input?.cinematicCombat ?? false,
  };
}

export function createGame(data: DataBundle, opts: SetupOptions): GameState {
  const rng = createRng(opts.seed);
  const catalog = buildCatalog(data);

  // Rise of the Empire opt-in. When off, every 'rote'-tagged content item is
  // filtered out of the initial state, so a base game never contains expansion
  // systems/leaders/cards/units. (Absent set === base.) The catalog itself
  // stays the full superset — it's just a lookup table; only what setup puts
  // INTO the state matters.
  const expansion = resolveExpansion(opts.expansion);
  // Phase 2: a single gate keyed off `enabled`. Per-content-type swap gating
  // (units on roeUnits, missions on roeMissions) lands with the actual RoE
  // content in Phases 3 & 5 — see docs/rise-of-the-empire.md.
  const inSet = <T extends { set?: 'base' | 'rote' }>(e: T): boolean =>
    expansion.enabled || e.set !== 'rote';

  // ----- Empty map -----
  const map: MapState = {
    systems: {},
    rebelBaseSpace: emptySystemState(),
  };
  for (const s of Object.values(catalog.systems)) {
    if (!inSet(s)) continue;
    map.systems[s.id] = emptySystemState();
  }
  // Coruscant is always Imperial loyalty (rr p.8).
  if (map.systems['coruscant']) map.systems['coruscant'].loyalty = 'imperial';

  // ----- Probe deck -----
  // Setup (rr Advanced Setup): the starting loyalty systems are NOT drawn from
  // the whole galaxy. Each faction has a FIXED pool of candidate systems
  // (printed on the setup-marked probe cards); you draw 3 of the Rebel 5 and
  // 5 of the Empire 7. Picking any populous system at random produced
  // non-RAW, unbalanced openings (Witold G / BGG feedback).
  //   Rebel pool (draw 3): Bothawui, Kashyyyk, Mon Calamari, Naboo, Ryloth
  //   Empire pool (draw 5): Corellia, Mandalore, Mustafar, Mygeeto, Rodia,
  //                         Saleucami, Sullust
  const REBEL_SETUP_LOYALTY_POOL = ['bothawui', 'kashyyyk', 'mon-calamari', 'naboo', 'ryloth'];
  const EMPIRE_SETUP_LOYALTY_POOL = ['corellia', 'mandalore', 'mustafar', 'mygeeto', 'rodia', 'saleucami', 'sullust'];

  const probePoolIds = Object.values(catalog.probes).filter(inSet).map((p) => p.id);
  const probeDeck = shuffle(rng, [...probePoolIds]);

  const rebelLoyaltySystems: string[] = [];
  const imperialLoyaltySystems: string[] = [];
  const probesRemovedForSetup: string[] = []; // these go to the box (not Coruscant!)

  if (opts.forcedRebelLoyalty && opts.forcedImperialLoyalty) {
    rebelLoyaltySystems.push(...opts.forcedRebelLoyalty);
    imperialLoyaltySystems.push(...opts.forcedImperialLoyalty);
  } else {
    // Draw the required count at random from each fixed pool.
    rebelLoyaltySystems.push(...shuffle(rng, [...REBEL_SETUP_LOYALTY_POOL]).slice(0, 3));
    imperialLoyaltySystems.push(...shuffle(rng, [...EMPIRE_SETUP_LOYALTY_POOL]).slice(0, 5));
  }

  // Remove the 5 Imperial-loyalty systems' probe cards from the deck for the
  // rest of the game (rr p.15) — the Rebel base can't be in an Imperial-loyalty
  // system, so those probes are no longer possible base locations. The 3 Rebel
  // -loyalty systems STAY in the deck: they remain valid base candidates.
  for (const sysId of imperialLoyaltySystems) {
    const probe = Object.values(catalog.probes).find((p) => p.systemId === sysId);
    if (!probe) continue;
    const idx = probeDeck.indexOf(probe.id);
    if (idx >= 0) probeDeck.splice(idx, 1);
    if (!probesRemovedForSetup.includes(probe.id)) probesRemovedForSetup.push(probe.id);
  }

  // Place Rebel loyalty markers
  for (const sysId of rebelLoyaltySystems) {
    if (map.systems[sysId]) map.systems[sysId].loyalty = 'rebel';
  }
  // Place Imperial: first 2 -> subjugated (Rebel loyalty underneath unless none); last 3 -> imperial loyalty
  // Per rr p.15: "Place a subjugation marker in each of the first two Imperial systems drawn and an Imperial
  // loyalty marker in each of the other three Imperial systems drawn."
  imperialLoyaltySystems.forEach((sysId, i) => {
    const ss = map.systems[sysId];
    if (!ss) return;
    if (i < 2) {
      ss.subjugated = true;
      // Loyalty underneath the subjugation marker: if it was Rebel, keep it underneath;
      // otherwise the system stays neutral with subjugation on top.
    } else {
      ss.loyalty = 'imperial';
    }
  });

  // ----- Place starting units -----
  let instanceCounter = 0;
  const mkInstance = (typeId: string, side: 'Rebel' | 'Empire'): UnitInstance => ({
    instanceId: `u${(++instanceCounter).toString().padStart(4, '0')}`,
    typeId, side, damage: 0,
  });

  // Expand starting unit lists into flat per-unit arrays. The list itself
  // depends on the RoE config (see pickStartingUnits — "New Starter Units"
  // when expansion.enabled && newStarterUnits, base list otherwise).
  const empireUnitsToPlace: string[] = [];
  for (const stack of pickStartingUnits(expansion, 'Empire')) {
    for (let i = 0; i < stack.count; i++) empireUnitsToPlace.push(stack.typeId);
  }
  const rebelUnitsToPlace: string[] = [];
  for (const stack of pickStartingUnits(expansion, 'Rebel')) {
    for (let i = 0; i < stack.count; i++) rebelUnitsToPlace.push(stack.typeId);
  }

  const autoSetup = opts.autoSetupUnits ?? true;

  let pendingDeployment: GameState['pendingDeployment'] = undefined;
  let rebelDeployTarget: GameState['rebelDeployTarget'] = null;
  let initialPhase: Phase = 'Assignment';

  if (autoSetup) {
    // Backward-compatible automatic deployment (used by tests and existing flows).
    const imperialSystems = [...imperialLoyaltySystems];
    // Guarantee ≥1 ground unit per Imperial system (rr p.15): place a stormtrooper first.
    imperialSystems.forEach((sysId) => {
      map.systems[sysId].units.push(mkInstance('stormtrooper', 'Empire'));
    });
    // Reduce the remaining stormtroopers by the number we already placed.
    const stormtroopersToPlace = empireUnitsToPlace.filter((t) => t === 'stormtrooper').length - imperialSystems.length;
    const remainingEmpire = empireUnitsToPlace.filter((t) => t !== 'stormtrooper')
      .concat(new Array(Math.max(0, stormtroopersToPlace)).fill('stormtrooper'));
    let idx = 0;
    for (const typeId of remainingEmpire) {
      const sys = imperialSystems[idx % imperialSystems.length];
      map.systems[sys].units.push(mkInstance(typeId, 'Empire'));
      idx++;
    }
    // Rebel: all at Rebel Base space.
    for (const typeId of rebelUnitsToPlace) {
      map.rebelBaseSpace.units.push(mkInstance(typeId, 'Rebel'));
    }
  } else {
    // Interactive setup — units go into pendingDeployment instead.
    pendingDeployment = {
      Rebel: rebelUnitsToPlace,
      Empire: empireUnitsToPlace,
    };
    initialPhase = 'Setup';
  }

  // ----- Secret base location -----
  // Per rr p.15 setup step 9: "The Rebel player ensures that all systems that
  // contain Imperial units have been removed from the probe deck. Then, from
  // the remaining probe cards, they secretly choose 1 card and place it
  // facedown under the Rebel Base Location space on the board. Then shuffle
  // the probe deck and place it on the Probe Deck space."
  //
  // The chosen card is REMOVED from the probe deck — Imperial cannot draw it
  // later during Refresh probe draws and learn the base location for free.
  const baseLegal = Object.values(catalog.systems)
    .filter((s) => !s.isCoruscant)
    .filter((s) => !imperialLoyaltySystems.includes(s.id))
    .map((s) => s.id);

  // Per rr p.15 step 9: the Rebel chooses one card from the (full) probe deck.
  // `baseLegal` is exactly that set — every non-Coruscant, non-Imperial-loyalty
  // system. We expose all of them to the Rebel; no random sampling.
  const candidates = [...baseLegal];
  shuffle(rng, candidates); // ordering only — list is shown alphabetised in UI

  let rebelBaseSystemId: SystemId;
  let pendingRebelBasePick: SystemId[] | undefined;

  if (opts.forcedBaseSystem) {
    rebelBaseSystemId = opts.forcedBaseSystem;
    pendingRebelBasePick = undefined;
  } else if (opts.autoSetupUnits) {
    // Pre-pick path (e.g. tests, auto-fill): finalise random base now.
    const pickIdx = nextIntForSetup(rng, candidates.length);
    rebelBaseSystemId = candidates[pickIdx];
    pendingRebelBasePick = undefined;
  } else {
    // Interactive path: leave a placeholder; pickRebelBase finalises later.
    rebelBaseSystemId = candidates[0];
    pendingRebelBasePick = candidates;
  }

  // Remove the chosen/placeholder base's probe card from the probe deck (rr p.15 step 9).
  // For the interactive path, we re-do this when the Rebel actually picks.
  const baseProbe = Object.values(catalog.probes).find((p) => p.systemId === rebelBaseSystemId);
  if (baseProbe) {
    const idx = probeDeck.indexOf(baseProbe.id);
    if (idx >= 0) probeDeck.splice(idx, 1);
  }
  // Reshuffle the probe deck after the base pick.
  shuffle(rng, probeDeck);

  // ----- Factions: leaders -----
  const rebel = emptyFaction('Rebel');
  const empire = emptyFaction('Empire');

  for (const ldr of Object.values(catalog.leaders)) {
    if (!inSet(ldr)) continue;
    if (ldr.isStarting) {
      if (ldr.side === 'Rebel') rebel.leaderPool.push(ldr.id);
      else empire.leaderPool.push(ldr.id);
    }
    // Non-starting leaders are gained via recruit; stay out of the pool.
  }

  // ----- Factions: decks -----
  // Action decks: all action cards with isStarting=false form the recruit deck.
  // Starting action cards are dealt 2 random per side.
  const rebelStartingActions = Object.values(catalog.actions).filter((a) => a.side === 'Rebel' && a.isStarting && inSet(a)).map((a) => a.id);
  const empireStartingActions = Object.values(catalog.actions).filter((a) => a.side === 'Empire' && a.isStarting && inSet(a)).map((a) => a.id);
  shuffle(rng, rebelStartingActions);
  shuffle(rng, empireStartingActions);
  rebel.actionHand = rebelStartingActions.slice(0, 2);
  empire.actionHand = empireStartingActions.slice(0, 2);

  rebel.actionDeck = shuffle(rng, Object.values(catalog.actions).filter((a) => a.side === 'Rebel' && !a.isStarting && inSet(a)).map((a) => a.id));
  empire.actionDeck = shuffle(rng, Object.values(catalog.actions).filter((a) => a.side === 'Empire' && !a.isStarting && inSet(a)).map((a) => a.id));

  // Mission decks: starting missions go into the hand; remaining missions shuffled into the deck.
  // The Empire's project missions form the separate project deck.
  //
  // RoE mission selection is per-category, NOT a single inSet filter:
  // - Starting + Project missions: ADDITIVE — base versions always in;
  //   RoE-tagged versions also in when expansion.enabled.
  // - Regular missions: SWAP — when expansion.roeMissions is on, the deck
  //   uses ONLY the RoE-tagged set; otherwise ONLY the base set. (Rulebook
  //   p.8: "Players choose to use the base set of mission cards or the
  //   Rise of the Empire set.")
  // Implementation note: every RoE mission added in Phase 5 has `set: 'rote'`
  // but `effectKey: ''` (no handler yet) — they appear in the deck so the
  // swap is testable end-to-end, but resolve as no-ops until Phase 5b
  // binds them.
  const isRoe = (m: { set?: 'base' | 'rote' }) => m.set === 'rote';
  const missionInDeck = (m: { isStarting: boolean; isProject: boolean; set?: 'base' | 'rote' }): boolean => {
    if (m.isStarting || m.isProject) {
      // Additive: base always in; rote-tagged in when expansion enabled.
      return expansion.enabled || !isRoe(m);
    }
    // Regular mission: swap.
    return expansion.roeMissions ? isRoe(m) : !isRoe(m);
  };
  const rebelStartingMissions = Object.values(catalog.missions).filter((m) => m.side === 'Rebel' && m.isStarting && missionInDeck(m)).map((m) => m.id);
  const empireStartingMissions = Object.values(catalog.missions).filter((m) => m.side === 'Empire' && m.isStarting && !m.isProject && missionInDeck(m)).map((m) => m.id);
  rebel.missionHand = [...rebelStartingMissions];
  empire.missionHand = [...empireStartingMissions];

  rebel.missionDeck = shuffle(rng, Object.values(catalog.missions).filter((m) => m.side === 'Rebel' && !m.isStarting && missionInDeck(m)).map((m) => m.id));
  empire.missionDeck = shuffle(rng, Object.values(catalog.missions).filter((m) => m.side === 'Empire' && !m.isStarting && !m.isProject && missionInDeck(m)).map((m) => m.id));
  empire.projectDeck = shuffle(rng, Object.values(catalog.missions).filter((m) => m.side === 'Empire' && m.isProject && missionInDeck(m)).map((m) => m.id));

  // Draw 2 more missions each for starting hand (on top of the 4 starting missions).
  for (let i = 0; i < 2; i++) {
    const r = rebel.missionDeck.shift(); if (r) rebel.missionHand.push(r);
    const e = empire.missionDeck.shift(); if (e) empire.missionHand.push(e);
  }

  // Objective deck: stages 1, 2, 3 stacked (3 on bottom, 1 on top per rr p.15).
  // Shuffle each stage individually, then assemble.
  const objsByStage: Record<number, string[]> = { 1: [], 2: [], 3: [] };
  for (const o of Object.values(catalog.objectives)) {
    if (!inSet(o)) continue;
    if (o.stage in objsByStage) objsByStage[o.stage].push(o.id);
  }
  shuffle(rng, objsByStage[1]); shuffle(rng, objsByStage[2]); shuffle(rng, objsByStage[3]);
  const objectiveDeck = [...objsByStage[1], ...objsByStage[2], ...objsByStage[3]];
  rebel.objectiveDeck = objectiveDeck;
  // Rebel draws 1 objective (rr p.15 step 4).
  const firstObj = objectiveDeck.shift();
  if (firstObj) rebel.objectiveHand!.push(firstObj);

  // Tactic decks
  const groundTacticDeck = shuffle(rng, expandTacticDeck(Object.values(catalog.tactics).filter((t) => t.theater === 'ground' && inSet(t))));
  const spaceTacticDeck = shuffle(rng, expandTacticDeck(Object.values(catalog.tactics).filter((t) => t.theater === 'space' && inSet(t))));

  // ----- Assemble GameState -----
  const G: GameState = {
    expansion,
    timeMarker: 1,
    reputationMarker: 14, // rr p.12
    trackLength: 16,

    phase: initialPhase,
    currentPlayer: initialPhase === 'Setup' ? 'Empire' : 'Rebel', // Imperial places first per rr p.15
    passedThisCommand: [],

    rebel,
    empire,
    map,
    rebelBaseSystemId,
    rebelBaseRevealed: false,

    probeDeck,
    spaceTacticDeck, spaceTacticDiscard: [],
    groundTacticDeck, groundTacticDiscard: [],

    isGameOver: false,

    rng,
    controllerSeeds: opts.controllerSeeds ?? { rebel: opts.seed + 1, empire: opts.seed + 2 },

    turnLog: [],

    catalog,

    pendingDeployment,
    rebelDeployTarget,
    pendingRebelBasePick,
  };

  log(G, { kind: 'setup', payload: {
    seed: opts.seed,
    rebelLoyalty: rebelLoyaltySystems,
    imperialLoyalty: imperialLoyaltySystems,
    baseSystem: rebelBaseSystemId,
    probesRemovedForSetup,
  }});

  return G;
}

// Tactic cards have a `copies` field; expand to a multiset for shuffling.
function expandTacticDeck(tactics: { id: string; copies?: number }[]): string[] {
  const out: string[] = [];
  for (const t of tactics) {
    const n = t.copies ?? 1;
    for (let i = 0; i < n; i++) out.push(t.id);
  }
  return out;
}
