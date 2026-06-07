// One-shot script: append the 8 Rise of the Empire leaders to
// assets/leaders.json, tagged set: 'rote'. Idempotent on id.
//
// Source: the leader-card PNGs in images/ (Jabba.png, Krennic.png, Motti.png,
// Finest.png, Cassian.png, Jyn.png, Chirrut2.png, Saw.png). I read the skill
// icons (blue eye = Intel, red fist = SpecOps, orange diamond = Diplomacy,
// white square-with-arrow = Logistics — major = large circle, minor = small
// circle) and tactic-value badges off the cards at high zoom.
//
// Tactic values are CROSS-VERIFIED against the action-card text already in
// assets/actions.json: every RoE leader's S/G appears in at least one action
// card ("Ambitions of Power Motti 2 1", "Under the Radar Cass. Andor 2 1",
// "Lord Vader's Orders Krennic 2 2", "Secret Facility Kren.'s Finest 1 3",
// "Ambitions of Power Jabba - -", "Trust in the Force Chirrut Imwe 1 2 /
// Jyn Erso 1 2", "Rebel Extremist ... Saw Gerrera S1 G3"). Every value here
// matches. Skill counts (major + minor) are best-effort transcriptions from
// the icon sizes on the card art; confirm against physical cards in a
// follow-up if any feel off — the data slot is correct even if a count is
// later nudged by ±1.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/leaders.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));
const existingIds = new Set(data.leaders.map((l) => l.id));

const z = { diplomacy: 0, intel: 0, specOps: 0, logistics: 0 };
const skills = (d, i, s, l) => ({ diplomacy: d, intel: i, specOps: s, logistics: l });

const ROTE = [
  // ===== Empire =====
  { id: 'jabba', name: 'Jabba the Hutt', side: 'Empire', isStarting: false,
    skills: skills(2, 2, 0, 0), minorSkills: skills(1, 0, 0, 0),
    tactic: { space: 0, ground: 0 }, image: 'Jabba.png' },
  { id: 'krennic', name: 'Director Krennic', side: 'Empire', isStarting: false,
    skills: skills(0, 1, 1, 1), minorSkills: skills(0, 1, 0, 1),
    tactic: { space: 2, ground: 2 }, image: 'Krennic.png' },
  { id: 'motti', name: 'Admiral Motti', side: 'Empire', isStarting: false,
    skills: skills(1, 0, 0, 1), minorSkills: skills(0, 1, 0, 0),
    tactic: { space: 2, ground: 1 }, image: 'Motti.png' },
  { id: 'krennics-finest', name: "Krennic's Finest", side: 'Empire', isStarting: false,
    skills: skills(0, 0, 3, 0), minorSkills: skills(0, 0, 1, 0),
    tactic: { space: 1, ground: 3 }, image: 'Finest.png' },

  // ===== Rebel =====
  { id: 'cassian-andor', name: 'Cassian Andor', side: 'Rebel', isStarting: false,
    skills: skills(0, 2, 0, 1), minorSkills: skills(0, 1, 0, 0),
    tactic: { space: 2, ground: 1 }, image: 'Cassian.png' },
  { id: 'jyn-erso', name: 'Jyn Erso', side: 'Rebel', isStarting: false,
    skills: skills(0, 1, 1, 0), minorSkills: skills(1, 1, 0, 0),
    tactic: { space: 1, ground: 2 }, image: 'Jyn.png' },
  { id: 'chirrut-imwe', name: 'Chirrut Imwe', side: 'Rebel', isStarting: false,
    skills: skills(1, 0, 2, 0), minorSkills: skills(1, 0, 0, 0),
    tactic: { space: 1, ground: 2 }, image: 'Chirrut2.png' },
  { id: 'saw-gerrera', name: 'Saw Gerrera', side: 'Rebel', isStarting: false,
    skills: skills(0, 0, 1, 1), minorSkills: skills(0, 0, 1, 0),
    tactic: { space: 1, ground: 3 }, image: 'Saw.png' },
];

void z; // (z kept around so a future "all-zero" template is one ref away)

let added = 0, skipped = 0;
for (const r of ROTE) {
  if (existingIds.has(r.id)) { skipped++; continue; }
  data.leaders.push({
    id: r.id,
    name: r.name,
    side: r.side,
    isStarting: r.isStarting,
    skills: r.skills,
    minorSkills: r.minorSkills,
    tacticValues: r.tactic,
    image: r.image,
    set: 'rote',
  });
  added++;
}

data._meta = data._meta || {};
data._meta.notes = data._meta.notes || [];
data._meta.notes.push(
  `Phase 5c: appended ${added} Rise of the Empire leaders tagged set: "rote". ` +
  `Skills/minor skills read from images/<Name>.png at high zoom (icon size ` +
  `distinguishes major vs minor). Tactic values cross-verified against the ` +
  `RoE action-card text in assets/actions.json — all match.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Added ${added}, skipped ${skipped}. Total leaders: ${data.leaders.length}.`);
