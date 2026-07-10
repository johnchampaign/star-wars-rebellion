// Unit catalog. Base-game stats verified against the printed FFG faction
// reference sheets (Rebel Alliance + Galactic Empire). Rise of the Empire
// expansion units are tagged `set: 'rote'` and filtered out at createGame
// when the `roeUnits` flag is off, so a base-only game is byte-identical to
// the original behaviour.
//
// supplyCount for base units verified against the Learn to Play component
// manifest (p.3: 89 Imperial + 64 Rebel minis — per-type sums match both
// totals exactly). The Death Star split (death-star: 2, death-star-under-
// construction: 1) is RAW per Rules Reference p.6 "Building a Death Star":
// "Construct Death Star" builds a SECOND Death Star (2 completed minis) plus
// a separate Death Star Under Construction piece. The holding-pool cap rule
// is RR p.6 "Component Limitations → Units": "a player cannot build a unit
// type if there are none available."
//
// RoE supply counts (TIE Striker, Assault Tank, Shield Bunker, Interdictor,
// U-Wing, Nebulon-B, Rebel Vanguard, Golan Arms Turret) are estimates pending
// a component-manifest check against the RoE box contents; they cover the
// starter-deployment quantities from StarWarsRebellion_v2.5.pdf p.8 with
// reasonable headroom. Refine when the RoE manifest is in hand.

import type { UnitType } from './types';

const I = (u: Omit<UnitType, 'side'>): UnitType => ({ ...u, side: 'Empire' });
const R = (u: Omit<UnitType, 'side'>): UnitType => ({ ...u, side: 'Rebel' });

/** Units that can ONLY enter play via their project/research card (Construct
 *  Super Star Destroyer / Construct Death Star) — never via a normal build
 *  action, even though they share the square build icon with Star Destroyers.
 *  Used to filter build-action unit choices (RAW). */
export const PROJECT_ONLY_UNIT_IDS: ReadonlySet<string> = new Set([
  'super-star-destroyer',
  'death-star',
  'death-star-under-construction',
  // The Interdictor only enters the queue via the "Interdictor Development"
  // project — never as a normal icon-build/recruit (player report #349).
  'interdictor',
]);

export const UNIT_TYPES: UnitType[] = [
  // ===== Imperial — base =====
  I({
    id: 'tie-fighter', name: 'TIE Fighter', theater: 'space', class: 'fighter', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 1, green: 0 },
    transport: { capacity: 0, restriction: true, immobile: false }, // TIE requires transport (rr p.14)
    buildResource: 1, supplyCount: 24,
  }),
  I({
    id: 'assault-carrier', name: 'Assault Carrier', theater: 'space', class: 'capital', tier: 'circle',
    health: { color: 'red', value: 2 },
    attack: { red: 1, black: 1, green: 0 },
    transport: { capacity: 4, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 8,
  }),
  I({
    id: 'star-destroyer', name: 'Star Destroyer', theater: 'space', class: 'capital', tier: 'square',
    health: { color: 'red', value: 4 },
    attack: { red: 2, black: 1, green: 0 },
    transport: { capacity: 6, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 8,
  }),
  I({
    id: 'super-star-destroyer', name: 'Super Star Destroyer', theater: 'space', class: 'capital', tier: 'square',
    health: { color: 'red', value: 6 },
    attack: { red: 3, black: 2, green: 0 },
    transport: { capacity: 8, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 2,
  }),
  I({
    id: 'death-star', name: 'Death Star', theater: 'space', class: 'station', tier: 'square',
    health: { color: null, value: 0 }, // cannot be damaged except via Death Star Plans (rr p.6)
    attack: { red: 4, black: 0, green: 0 }, // rolls 4 red dice per faction sheet
    transport: { capacity: 8, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 2,
  }),
  I({
    id: 'death-star-under-construction', name: 'Death Star Under Construction', theater: 'space', class: 'station', tier: 'square',
    health: { color: 'red', value: 4 },
    attack: { red: 0, black: 0, green: 0 },
    transport: { capacity: 0, restriction: false, immobile: true }, // rr p.6
    buildResource: 3, supplyCount: 1,
  }),
  I({
    id: 'stormtrooper', name: 'Stormtrooper', theater: 'ground', class: 'ground', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 1, green: 0 },
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 1, supplyCount: 30,
  }),
  I({
    id: 'at-st', name: 'AT-ST', theater: 'ground', class: 'ground', tier: 'circle',
    health: { color: 'red', value: 2 },
    attack: { red: 1, black: 1, green: 0 },
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 10,
  }),
  I({
    id: 'at-at', name: 'AT-AT', theater: 'ground', class: 'ground', tier: 'square',
    health: { color: 'red', value: 3 },
    attack: { red: 2, black: 1, green: 0 },
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 4,
  }),

  // ===== Imperial — Rise of the Empire =====
  // Stats transcribed from images/ReferenceEmpire2P.png (2-player battle mat).
  // Setup quantities are from StarWarsRebellion_v2.5.pdf p.8 "Rise of the
  // Empire Expansion → Setup" (the "New Starter Units" deployment).
  I({
    id: 'tie-striker', name: 'TIE Striker', theater: 'space', class: 'fighter', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 0, green: 1 },
    // TIE Strikers carry the same "must be transported" badge as the base TIE
    // Fighter on the reference mat (images/ReferenceEmpire2P.png) — they each
    // consume 1 transport capacity and can't move without a carrier (#438).
    transport: { capacity: 0, restriction: true, immobile: false },
    buildResource: 1, supplyCount: 6, set: 'rote',
  }),
  I({
    id: 'assault-tank', name: 'Assault Tank', theater: 'ground', class: 'ground', tier: 'triangle',
    health: { color: 'red', value: 1 },
    attack: { red: 0, black: 0, green: 1 },
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 1, supplyCount: 6, set: 'rote',
  }),
  I({
    id: 'shield-bunker', name: 'Shield Bunker', theater: 'ground', class: 'structure', tier: 'circle',
    // Ability (rules p.8): Death Stars and DSUC in the system can't be
    // destroyed/damaged while a Shield Bunker is present. Easy-deployment
    // and Local-reinforcement clauses follow. Wired in Phase 6 (unit-
    // abilities module); here we just carry the stats.
    health: { color: 'red', value: 3 },
    attack: { red: 0, black: 0, green: 0 },
    transport: { capacity: 0, restriction: false, immobile: true },
    buildResource: 2, supplyCount: 3, set: 'rote',
  }),
  I({
    id: 'interdictor', name: 'Interdictor', theater: 'space', class: 'capital', tier: 'square',
    // Ability (rules p.8): "Rebel units in this system cannot retreat."
    // Phase 6 wires retreat-blocking; stats stand alone.
    health: { color: 'red', value: 4 },
    attack: { red: 0, black: 0, green: 2 },
    // Transport capacity 4 (RoE reference sheet: bottom-left badge on the ship
    // mini reads 4; was wrongly 0, #542).
    transport: { capacity: 4, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 3, set: 'rote',
  }),

  // ===== Rebel — base =====
  R({
    id: 'x-wing', name: 'X-Wing', theater: 'space', class: 'fighter', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 1, green: 0 },
    // Rebel fighters do NOT carry the transport-restriction icon (only the
    // TIE Fighter does, per the printed reference mats — TIEs have no
    // hyperdrive and must be carried; X/Y-wings move on their own). So no
    // transport capacity is required to move them. (Issue #47.)
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 1, supplyCount: 8,
  }),
  R({
    id: 'y-wing', name: 'Y-Wing', theater: 'space', class: 'fighter', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 1, black: 0, green: 0 }, // bombers
    // No transport-restriction icon on the Rebel fighters (see X-Wing note;
    // only the TIE Fighter requires transport). Issue #47.
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 1, supplyCount: 12,
  }),
  R({
    id: 'corellian-corvette', name: 'Corellian Corvette', theater: 'space', class: 'capital', tier: 'circle',
    health: { color: 'red', value: 2 },
    attack: { red: 1, black: 1, green: 0 },
    transport: { capacity: 2, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 4,
  }),
  R({
    // Build icon on the reference mat is a BLUE (space) TRIANGLE, not a
    // circle — so it builds from a space-triangle resource, alongside the
    // X-Wing and Y-Wing. (Issue #50.)
    id: 'rebel-transport', name: 'Rebel Transport', theater: 'space', class: 'capital', tier: 'triangle',
    health: { color: 'red', value: 2 },
    attack: { red: 0, black: 0, green: 0 }, // does not attack
    transport: { capacity: 4, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 4,
  }),
  R({
    id: 'mon-cala-cruiser', name: 'Mon Calamari Cruiser', theater: 'space', class: 'capital', tier: 'square',
    health: { color: 'red', value: 4 },
    attack: { red: 2, black: 1, green: 0 },
    transport: { capacity: 4, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 3,
  }),
  R({
    id: 'rebel-trooper', name: 'Rebel Trooper', theater: 'ground', class: 'ground', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 1, green: 0 },
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 1, supplyCount: 21,
  }),
  R({
    id: 'airspeeder', name: 'Airspeeder', theater: 'ground', class: 'ground', tier: 'circle',
    health: { color: 'red', value: 2 },
    attack: { red: 1, black: 1, green: 0 },
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 6,
  }),
  R({
    id: 'shield-generator', name: 'Shield Generator', theater: 'ground', class: 'structure', tier: 'square',
    health: { color: 'red', value: 3 }, // structure, special rules
    attack: { red: 0, black: 0, green: 0 },
    transport: { capacity: 0, restriction: false, immobile: true },
    buildResource: 3, supplyCount: 3, // orange (ground) SQUARE per printed components (#129)
  }),
  R({
    id: 'ion-cannon', name: 'Ion Cannon', theater: 'ground', class: 'structure', tier: 'square',
    health: { color: 'red', value: 3 }, // structure, special rules
    attack: { red: 0, black: 0, green: 0 },
    transport: { capacity: 0, restriction: false, immobile: true },
    buildResource: 3, supplyCount: 3, // orange (ground) SQUARE per printed components (#129)
  }),

  // ===== Rebel — Rise of the Empire =====
  // Stats transcribed from images/ReferenceRebel2P.png. Setup quantities
  // are from StarWarsRebellion_v2.5.pdf p.8.
  R({
    id: 'u-wing', name: 'U-Wing', theater: 'space', class: 'capital', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 0, green: 1 },
    // Per the reference mat the U-Wing carries a transport-capacity-1 badge
    // — small but it counts as a carrier for ground-unit movement.
    transport: { capacity: 1, restriction: false, immobile: false },
    buildResource: 1, supplyCount: 4, set: 'rote',
  }),
  R({
    id: 'nebulon-b-frigate', name: 'Nebulon-B Frigate', theater: 'space', class: 'capital', tier: 'circle',
    health: { color: 'red', value: 3 },
    attack: { red: 0, black: 0, green: 2 },
    // Transport capacity 3, read off the printed Rebel RoE faction reference
    // sheet (the bottom-left badge on the ship mini): Rebel Transport=4,
    // Corellian Corvette=2, Nebulon-B=3. Was 0 (a placeholder estimate).
    transport: { capacity: 3, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 4, set: 'rote',
  }),
  R({
    id: 'rebel-vanguard', name: 'Rebel Vanguard', theater: 'ground', class: 'ground', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 0, green: 1 },
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 1, supplyCount: 6, set: 'rote',
  }),
  R({
    id: 'golan-arms-turret', name: 'Golan Arms Turret', theater: 'ground', class: 'structure', tier: 'circle',
    health: { color: 'red', value: 3 },
    attack: { red: 0, black: 0, green: 2 },
    transport: { capacity: 0, restriction: false, immobile: true },
    buildResource: 2, supplyCount: 3, set: 'rote',
  }),
];

export const UNIT_TYPES_BY_ID: Record<string, UnitType> = Object.fromEntries(
  UNIT_TYPES.map((u) => [u.id, u])
);
