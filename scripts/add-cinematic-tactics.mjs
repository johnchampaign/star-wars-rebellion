// Phase 7a: append the 32 Cinematic Combat "advanced tactic cards" to
// assets/tactics.json, tagged cinematic:true + set:'rote'. Idempotent on id.
//
// Source: MissionReference_RotE_Final.pdf p.8 "Advanced Tactic Cards".
// Each card is side-specific and theatre-specific, with a primary ability
// (top) — gated on having >= 1 of its primary unit in the system — and a
// secondary ability (bottom, always available). effectKeys are left empty;
// Phase 7c binds them. requiresSpecial is false for all (the special-die
// gating in Cinematic Combat works differently — abilities reference dice
// directly in their text).

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/tactics.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));
const existing = new Set(data.tactics.map((t) => t.id));

// [name, side, theater, primaryUnit (type id or null), primaryText, secondaryText]
const CARDS = [
  // ===== Imperial Space =====
  ['Swarm Tactics', 'Empire', 'space', 'tie-fighter',
    'If you have more Imperial fighters than Rebel fighters, deal 1 damage.',
    'Deal 1 black damage.'],
  ['Reinforcements', 'Empire', 'space', 'assault-carrier',
    'Gain 1 TIE Fighter. Prevent 2 black.',
    'Prevent 2 black.'],
  ['Tractor Beam', 'Empire', 'space', 'star-destroyer',
    'At the end of the round, if you have a Star Destroyer but the Rebels have no ships, capture 1 leader.',
    'Deal 1 red damage.'],
  ['Overwhelming Presence', 'Empire', 'space', 'super-star-destroyer',
    'Prevent 2 red and 1 special.',
    'Prevent 2 red.'],
  ['Superlaser Blast', 'Empire', 'space', 'death-star',
    'Deal 5 damage to a capital ship.',
    'Deal 1 damage.'],
  ['Entrapment', 'Empire', 'space', 'interdictor',
    'Cancel the Rebel tactic card. You may play another card.',
    'Next turn, the Rebels cannot play a space tactic card.'],
  ['Energy Shield', 'Empire', 'space', 'shield-bunker',
    'After the Rebels assign damage, remove up to 2 damage from Imperial ships.',
    'During space battles this combat, the Rebels resolve their attacks first.'],
  ['Intercept', 'Empire', 'space', 'tie-striker',
    'Destroy 1 triangle ground unit (it does not roll dice).',
    'The Rebel ships cannot remove damage with special dice this round.'],

  // ===== Imperial Ground =====
  ['Support of the 501st', 'Empire', 'ground', 'stormtrooper',
    'Destroy 1 triangle ground unit (it does not roll dice).',
    'Deal 1 black damage.'],
  ['Armored Patrol', 'Empire', 'ground', 'assault-tank',
    'Prevent 2 red and 2 black.',
    'Prevent 1 red and 1 black.'],
  ['Overrun', 'Empire', 'ground', 'at-st',
    'Deal 2 damage.',
    'Deal 1 damage.'],
  ['Target the Generator', 'Empire', 'ground', 'at-at',
    'Destroy 1 structure (it does not roll dice).',
    'Deal 1 red damage.'],
  ['Air Superiority', 'Empire', 'ground', 'tie-striker',
    'Cancel the Rebel tactic card.',
    'Next turn, the Rebels cannot play a ground tactic card.'],
  ['Armored Position', 'Empire', 'ground', 'shield-bunker',
    'After the Rebels assign damage, assign up to 3 damage to 1 Shield Bunker, then cancel that damage from ground units.',
    'During ground battles this combat, the Rebels resolve their attacks first.'],
  ['Bombardment', 'Empire', 'ground', 'star-destroyer',
    'If there is no Shield Generator in the system, assign 2 black damage.',
    'Deal 1 damage.'],
  ['Imposing Presence', 'Empire', 'ground', null,
    'Rebel ground units cannot remove damage with special dice this round.',
    'You may play an extra card.'],

  // ===== Rebel Space =====
  ['Rogue Squadron Support', 'Rebel', 'space', 'x-wing',
    'Deal 2 black damage.',
    'Deal 1 black damage.'],
  ['Bombing Run', 'Rebel', 'space', 'y-wing',
    'Deal 2 red damage.',
    'Deal 1 red damage.'],
  ['Deployment', 'Rebel', 'space', 'u-wing',
    'Gain 1 triangle ground unit. Resolve a ground battle this round.',
    'Imperial ships cannot remove damage with special dice this round.'],
  ['Fleet Logistics', 'Rebel', 'space', 'mon-cala-cruiser',
    'Prevent 2 red. You may play an extra card.',
    'Prevent 2 red.'],
  ['Ion Blast', 'Rebel', 'space', 'ion-cannon',
    'Deal 1 damage to a capital ship, which cannot remove damage this round.',
    'Deal 1 damage.'],
  ['Outrun Them', 'Rebel', 'space', 'corellian-corvette',
    'Cancel the Imperial tactic card.',
    'Next turn, the Imperials cannot play a space tactic card.'],
  ['Draw Their Fire', 'Rebel', 'space', 'nebulon-b-frigate',
    'After the Imperials assign damage, remove up to 2 damage from Rebel ships (except Nebulon-B Frigates).',
    'During space battles this combat, the Imperials resolve their attacks first.'],
  ['Escort', 'Rebel', 'space', 'rebel-transport',
    'Prevent 1 red, 1 black, and 1 special.',
    'Prevent 2 black.'],

  // ===== Rebel Ground =====
  ['Hold Them Back', 'Rebel', 'ground', 'rebel-trooper',
    'Destroy 1 triangle ground unit (it does not roll dice).',
    'Deal 1 black damage.'],
  ['Take It Down', 'Rebel', 'ground', 'rebel-vanguard',
    'Deal 2 red damage.',
    'Deal 1 red damage.'],
  ['Tow Cables', 'Rebel', 'ground', 'airspeeder',
    'Deal 4 damage to 1 AT-AT or AT-ST.',
    'Deal 1 damage.'],
  ['Take Cover', 'Rebel', 'ground', 'golan-arms-turret',
    'Prevent 2 red and 2 black.',
    'Prevent 1 red and 1 black.'],
  ['Planetary Shield', 'Rebel', 'ground', 'shield-generator',
    'After the Imperials assign damage, assign up to 3 damage to 1 Shield Generator, then cancel that damage from ground units.',
    'During ground battles this combat, the Imperials resolve their attacks first.'],
  ['Rogue One', 'Rebel', 'ground', 'u-wing',
    'If 1 or more units retreat this round, rescue 1 captured leader OR remove 1 target marker from this system.',
    'Imperial ground units cannot remove damage with special dice this round.'],
  ['Escape Plan', 'Rebel', 'ground', 'rebel-transport',
    'You may immediately retreat. If you do, cancel the Imperial tactic card.',
    'Next turn, the Imperials cannot play a ground tactic card.'],
  ['Confrontation', 'Rebel', 'ground', null,
    'If the last Imperial ground unit is destroyed this round, mark 1 Imperial leader for elimination at the end of this Command phase and eliminate this card.',
    'You may play an extra card.'],
];

const slug = (name, side, theater) =>
  `cin-${side.toLowerCase()}-${theater}-` +
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let added = 0, skipped = 0;
for (const [name, side, theater, primaryUnit, primaryText, secondaryText] of CARDS) {
  const id = slug(name, side, theater);
  if (existing.has(id)) { skipped++; continue; }
  data.tactics.push({
    id, name, theater,
    requiresSpecial: false,
    effectKey: '',
    rulesText: `${primaryText} / ${secondaryText}`,
    image: '',
    set: 'rote',
    cinematic: true,
    side,
    primaryUnit: primaryUnit ?? undefined,
    primaryText,
    secondaryText,
    primaryEffectKey: '',
    secondaryEffectKey: '',
    copies: 1,
  });
  added++;
}

data._meta = data._meta || {};
data._meta.notes = data._meta.notes || [];
data._meta.notes.push(
  `Phase 7a: appended ${added} Cinematic Combat advanced tactic cards ` +
  `(cinematic:true, set:'rote'). 8 each: Imperial Space/Ground, Rebel ` +
  `Space/Ground. Primary ability gated on primaryUnit; secondary always ` +
  `available. Effect keys empty pending Phase 7c.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Added ${added}, skipped ${skipped}. Total tactics: ${data.tactics.length}.`);
