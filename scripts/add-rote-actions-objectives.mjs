// One-shot script: append Rise of the Empire action cards and objectives to
// assets/actions.json and assets/objectives.json, tagged set: 'rote'.
// Idempotent on id. Data-only — effectKey is empty pending Phase 5b/d
// handler bindings.
//
// Source: MissionReference_RotE_Final.pdf
//   - p.5  Imperial action cards
//   - p.6  Rebel action cards
//   - p.7  Rebel objectives
//
// Notes:
// - The RoE printing of some base cards (C-3PO ↔ Human Cyborg Relations,
//   R2-D2 ↔ Resourceful Astromech) uses the character name; these are
//   treated as duplicates and skipped — base entries already cover them.
// - Action cards that list two leader options (e.g. Trust in the Force:
//   Jyn Erso OR Chirrut Imwe) get both slugs in leaderRequirement[].
// - Leaders that don't exist yet (Krennic, Motti, Jabba, Jyn Erso, Chirrut,
//   Andor, Saw Gerrera, Krennic's Finest) are still referenced by slug —
//   when Phase 5c lands those leaders, the wiring is already correct.
// - Objective VP ranges (e.g. "1-2", "1-3") are stored as the minimum value
//   in `reputation`; the variable bit is in rulesText.

import { readFileSync, writeFileSync } from 'node:fs';

const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- ACTIONS ----------

const A_PATH = 'assets/actions.json';
const A_DATA = JSON.parse(readFileSync(A_PATH, 'utf8'));
const A_EXISTING = new Set(A_DATA.actions.map((a) => a.id));
const A_NAMES = new Set(A_DATA.actions.map((a) => a.name.toLowerCase()));

const ROTE_ACTIONS = [
  // ===== Imperial =====
  { name: 'Early Promotion', side: 'Empire', isStarting: true, timing: 'Immediate',
    leaders: [],
    rules: 'Draw 1 starting card, or recruit Motti (Space 2, Ground 1). Place Motti and Tarkin in any Imperial system.' },
  { name: 'Track Them', side: 'Empire', isStarting: false, timing: 'Special',
    leaders: [],
    rules: "After a Rebel unit retreats from combat, choose an Imperial leader in the combat's system and return them to the leader pool." },
  { name: 'Ambitions of Power', side: 'Empire', isStarting: false, timing: 'Special',
    leaders: ['motti', 'jabba'],
    rules: 'Play if you have more than 8 leaders in your leader pool. Your leader pool limit is increased by 1 for the rest of the game.' },
  { name: 'Secret Facility', side: 'Empire', isStarting: false, timing: 'Immediate',
    leaders: ['krennic', 'krennics-finest'],
    rules: "Place 1 of your probe cards facedown under this card. On your turn in the Command phase, reveal it to place 1 Shield Bunker and 1 triangle ground unit in that system. Resolve any combat. Doesn't require Krennic or Krennic's Finest." },
  { name: "Lord Vader's Orders", side: 'Empire', isStarting: false, timing: 'Immediate',
    leaders: ['krennic'],
    rules: 'Look at the top 3 objective cards and replace them on top of the deck in any order.' },
  { name: 'Post Bounty', side: 'Empire', isStarting: false, timing: 'Special',
    leaders: ['jabba'],
    rules: "Use after a leader fails a mission in this leader's system. Attach a bounty ring to 1 un-ringed leader. When that leader is captured, Rebels lose 1 reputation." },
  { name: 'Sweep the Area', side: 'Empire', isStarting: false, timing: 'Immediate',
    leaders: ['krennics-finest'],
    rules: "Place 1 of your probe cards facedown under this card. At the end of any Command phase, reveal it to capture 1 leader in that system (doesn't require Krennic's Finest). Move the captured leader to the closest system containing Imperial units." },

  // ===== Rebel =====
  { name: 'False Orders', side: 'Rebel', isStarting: true, timing: 'Assignment',
    leaders: [],
    rules: 'Play at the end of the Assignment phase. Choose 1 lone Imperial leader assigned to a mission. Return that leader to the leader pool and the mission to the Imperial hand.' },
  { name: 'Rebel Extremist', side: 'Rebel', isStarting: true, timing: 'Immediate',
    leaders: [],
    rules: 'Either draw another starting action card, OR lose 1 reputation and recruit Saw Gerrera (Space 1, Ground 3).' },
  { name: 'Trust in the Force', side: 'Rebel', isStarting: false, timing: 'Assignment',
    leaders: ['jyn-erso', 'chirrut-imwe'],
    rules: 'Place this leader in a subjugated system. Gain 1 loyalty and destroy 1 triangle ground unit in the system.' },
  { name: 'Under the Radar', side: 'Rebel', isStarting: false, timing: 'Immediate',
    leaders: ['cassian-andor', 'saw-gerrera'],
    rules: 'Look at the top 4 probe cards. Keep 1 facedown and replace the others at the top or bottom of the deck in any order. At the start of your turn in the Command phase, you may return that probe card to the top of the probe deck.' },
  { name: "Baze's Loyalty", side: 'Rebel', isStarting: false, timing: 'StartOfCombat',
    leaders: ['chirrut-imwe'],
    rules: 'Destroy 2 health-worth of units.' },
  { name: 'He Means Well', side: 'Rebel', isStarting: false, timing: 'Immediate',
    leaders: ['cassian-andor'],
    rules: 'Add a K-2SO ring to a non-ringed leader. That leader gains minor SpecOps and minor Intel icons.' },
  { name: 'Something to Fight For', side: 'Rebel', isStarting: false, timing: 'Special',
    leaders: ['jyn-erso'],
    rules: 'After you win a battle, choose a discarded objective card and place it on top of the deck.' },
];

let aAdded = 0, aSkipped = 0;
for (const a of ROTE_ACTIONS) {
  const id = slug(a.name);
  if (A_EXISTING.has(id) || A_NAMES.has(a.name.toLowerCase())) { aSkipped++; continue; }
  A_DATA.actions.push({
    id, name: a.name, side: a.side, isStarting: a.isStarting,
    timing: a.timing, leaderRequirement: a.leaders,
    effectKey: '', // Phase 5d-handlers TODO
    rulesText: a.rules,
    image: '', // TODO: link RoE action art when loaded
    set: 'rote',
  });
  aAdded++;
}
A_DATA._meta = A_DATA._meta || {};
A_DATA._meta.notes = A_DATA._meta.notes || [];
A_DATA._meta.notes.push(
  `Phase 5d (data-only): appended ${aAdded} Rise of the Empire action cards ` +
  `tagged set: "rote". effectKey is empty pending handler bindings.`
);
writeFileSync(A_PATH, JSON.stringify(A_DATA, null, 2));

// ---------- OBJECTIVES ----------

const O_PATH = 'assets/objectives.json';
const O_DATA = JSON.parse(readFileSync(O_PATH, 'utf8'));
const O_EXISTING = new Set(O_DATA.objectives.map((o) => o.id));
const O_NAMES = new Set(O_DATA.objectives.map((o) => `${o.name.toLowerCase()}|${o.stage}`));

const ROTE_OBJECTIVES = [
  // ===== Level I (4 new) =====
  { name: 'Decisive Victory', stage: 1, rep: 1, timing: 'Combat',
    rules: 'Win a space battle and a ground battle in the same combat.' },
  { name: 'Defensive Position', stage: 1, rep: 1, timing: 'Refresh',
    rules: 'A single system (other than the Rebel Base space) contains 3 Rebel structures.' },
  { name: 'Support of the Hutts', stage: 1, rep: 1, timing: 'Refresh',
    rules: "3 or more systems in Nal Hutta's region have Rebel loyalty." },
  { name: 'The Long War', stage: 1, rep: 1, timing: 'Refresh',
    rules: 'Discard 2 other objective cards from your hand.' },
  { name: 'Threaten the Core', stage: 1, rep: 1, timing: 'Refresh',
    rules: '5 or more Rebel units are in and/or adjacent to Coruscant.' },

  // ===== Level II (3 new) =====
  { name: 'A Time for Peace', stage: 2, rep: 1, timing: 'Refresh',
    rules: 'Destroy 2 triangle, 1 circle, and 1 square unit on the Imperial build queue.' },
  { name: 'Raid Outposts', stage: 2, rep: 1, timing: 'Immediate',
    rules: 'Imperial player places 1 target marker in each of 2 remote systems. Rebel gains 1 reputation each time a marker is removed (potential 1–2 total).' },
  { name: 'Rebel Cell', stage: 2, rep: 1, timing: 'Immediate',
    rules: 'Place a target marker in a Rebel system. If the marker is still there at the start of each Refresh phase, discard 1 objective card to gain 1 reputation.' },
  { name: 'Seize Control', stage: 2, rep: 1, timing: 'Combat',
    rules: 'Win a space or ground battle in a system with a sabotage marker. You may then remove the marker.' },

  // ===== Level III (3 new) =====
  { name: 'Raid Imperial Factory', stage: 3, rep: 1, timing: 'Combat',
    rules: 'Win a battle in a combat the Rebels initiated, in a system with a resource icon.' },
  { name: 'Show No Fear', stage: 3, rep: 0, timing: 'Refresh',
    rules: "Place a target marker in the Rebel Base's system. Remove it when a new base is established. If the marker is still present at the start of each Refresh phase, gain 1 reputation." },
  { name: 'Uprising', stage: 3, rep: 2, timing: 'Refresh',
    rules: 'Play if 9 or more systems have Rebel loyalty.' },
];

let oAdded = 0, oSkipped = 0;
for (const o of ROTE_OBJECTIVES) {
  const id = `${slug(o.name)}-${o.stage}`;
  const key = `${o.name.toLowerCase()}|${o.stage}`;
  if (O_EXISTING.has(id) || O_NAMES.has(key)) { oSkipped++; continue; }
  O_DATA.objectives.push({
    id, name: o.name, stage: o.stage, reputation: o.rep,
    timing: o.timing,
    effectKey: '',
    rulesText: o.rules,
    image: '',
    set: 'rote',
  });
  oAdded++;
}
O_DATA._meta = O_DATA._meta || {};
O_DATA._meta.notes = O_DATA._meta.notes || [];
O_DATA._meta.notes.push(
  `Phase 5d (data-only): appended ${oAdded} Rise of the Empire objective cards ` +
  `tagged set: "rote". effectKey is empty pending handler bindings.`
);
writeFileSync(O_PATH, JSON.stringify(O_DATA, null, 2));

console.log(`Actions: +${aAdded}, skipped ${aSkipped}. Total: ${A_DATA.actions.length}.`);
console.log(`Objectives: +${oAdded}, skipped ${oSkipped}. Total: ${O_DATA.objectives.length}.`);
