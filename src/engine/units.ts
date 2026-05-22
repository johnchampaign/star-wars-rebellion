// Base-game unit catalog. Stats marked [VERIFY] should be cross-checked against
// the printed faction sheets (vmod_extracted/images/ReferenceEmpire2P.png and
// ReferenceRebel2P.png) before any combat math is trusted.

import type { UnitType } from './types';

const I = (u: Omit<UnitType, 'side'>): UnitType => ({ ...u, side: 'Empire' });
const R = (u: Omit<UnitType, 'side'>): UnitType => ({ ...u, side: 'Rebel' });

export const UNIT_TYPES: UnitType[] = [
  // ===== Imperial =====
  I({
    id: 'tie-fighter', name: 'TIE Fighter', theater: 'space', class: 'fighter', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 1 }, // [VERIFY]
    transport: { capacity: 0, restriction: true, immobile: false }, // TIE requires transport (rr p.14)
    buildResource: 1, supplyCount: 24,
  }),
  I({
    id: 'assault-carrier', name: 'Assault Carrier', theater: 'space', class: 'capital', tier: 'circle',
    health: { color: 'red', value: 1 }, // [VERIFY]
    attack: { red: 1, black: 0 }, // [VERIFY]
    transport: { capacity: 2, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 8,
  }),
  I({
    id: 'star-destroyer', name: 'Star Destroyer', theater: 'space', class: 'capital', tier: 'square',
    health: { color: 'red', value: 3 }, // [VERIFY]
    attack: { red: 2, black: 1 }, // [VERIFY]
    transport: { capacity: 3, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 8,
  }),
  I({
    id: 'super-star-destroyer', name: 'Super Star Destroyer', theater: 'space', class: 'capital', tier: 'square',
    health: { color: 'red', value: 5 }, // [VERIFY]
    attack: { red: 4, black: 2 }, // [VERIFY]
    transport: { capacity: 5, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 2,
  }),
  I({
    id: 'death-star', name: 'Death Star', theater: 'space', class: 'station', tier: 'square',
    health: { color: null, value: 0 }, // cannot be damaged except via Death Star Plans (rr p.6)
    attack: { red: 0, black: 0 }, // does not roll combat dice
    transport: { capacity: 6, restriction: false, immobile: false }, // [VERIFY]
    buildResource: 3, supplyCount: 2,
  }),
  I({
    id: 'death-star-under-construction', name: 'Death Star Under Construction', theater: 'space', class: 'station', tier: 'square',
    health: { color: 'red', value: 5 }, // [VERIFY]
    attack: { red: 0, black: 0 },
    transport: { capacity: 0, restriction: false, immobile: true }, // rr p.6
    buildResource: 3, supplyCount: 1,
  }),
  I({
    id: 'stormtrooper', name: 'Stormtrooper', theater: 'ground', class: 'ground', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 1 }, // [VERIFY]
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 1, supplyCount: 30,
  }),
  I({
    id: 'at-st', name: 'AT-ST', theater: 'ground', class: 'ground', tier: 'circle',
    health: { color: 'black', value: 2 }, // [VERIFY]
    attack: { red: 1, black: 0 }, // [VERIFY]
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 10,
  }),
  I({
    id: 'at-at', name: 'AT-AT', theater: 'ground', class: 'ground', tier: 'square',
    health: { color: 'red', value: 3 }, // [VERIFY]
    attack: { red: 2, black: 1 }, // [VERIFY]
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 4,
  }),

  // ===== Rebel =====
  R({
    id: 'x-wing', name: 'X-Wing', theater: 'space', class: 'fighter', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 1 }, // [VERIFY]
    transport: { capacity: 0, restriction: true, immobile: false },
    buildResource: 1, supplyCount: 8,
  }),
  R({
    id: 'y-wing', name: 'Y-Wing', theater: 'space', class: 'fighter', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 1, black: 0 }, // [VERIFY] — Y-wings are slower bombers
    transport: { capacity: 0, restriction: true, immobile: false },
    buildResource: 1, supplyCount: 12,
  }),
  R({
    id: 'corellian-corvette', name: 'Corellian Corvette', theater: 'space', class: 'capital', tier: 'circle',
    health: { color: 'red', value: 1 }, // [VERIFY]
    attack: { red: 1, black: 0 }, // [VERIFY]
    transport: { capacity: 1, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 4,
  }),
  R({
    id: 'rebel-transport', name: 'Rebel Transport', theater: 'space', class: 'capital', tier: 'circle',
    health: { color: 'red', value: 1 }, // [VERIFY]
    attack: { red: 0, black: 0 }, // does not attack
    transport: { capacity: 4, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 4,
  }),
  R({
    id: 'mon-cala-cruiser', name: 'Mon Calamari Cruiser', theater: 'space', class: 'capital', tier: 'square',
    health: { color: 'red', value: 3 }, // [VERIFY]
    attack: { red: 2, black: 1 }, // [VERIFY]
    transport: { capacity: 3, restriction: false, immobile: false },
    buildResource: 3, supplyCount: 3,
  }),
  R({
    id: 'rebel-trooper', name: 'Rebel Trooper', theater: 'ground', class: 'ground', tier: 'triangle',
    health: { color: 'black', value: 1 },
    attack: { red: 0, black: 1 }, // [VERIFY]
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 1, supplyCount: 21,
  }),
  R({
    id: 'airspeeder', name: 'Airspeeder', theater: 'ground', class: 'ground', tier: 'circle',
    health: { color: 'black', value: 1 }, // [VERIFY]
    attack: { red: 1, black: 0 }, // [VERIFY]
    transport: { capacity: 0, restriction: false, immobile: false },
    buildResource: 2, supplyCount: 6,
  }),
  R({
    id: 'shield-generator', name: 'Shield Generator', theater: 'ground', class: 'structure', tier: 'circle',
    health: { color: 'red', value: 1 }, // [VERIFY] — structure, special rules
    attack: { red: 0, black: 0 },
    transport: { capacity: 0, restriction: false, immobile: true },
    buildResource: 2, supplyCount: 3,
  }),
  R({
    id: 'ion-cannon', name: 'Ion Cannon', theater: 'ground', class: 'structure', tier: 'circle',
    health: { color: 'red', value: 1 }, // [VERIFY] — structure, special rules
    attack: { red: 0, black: 0 },
    transport: { capacity: 0, restriction: false, immobile: true },
    buildResource: 2, supplyCount: 3,
  }),
];

export const UNIT_TYPES_BY_ID: Record<string, UnitType> = Object.fromEntries(
  UNIT_TYPES.map((u) => [u.id, u])
);
