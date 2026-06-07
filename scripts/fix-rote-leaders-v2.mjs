// Patch script v2 — corrects RoE leader skill counts after a third pass
// against the user-supplied Leader_Pool_RotE.pdf chart, with rows extracted
// at 400 DPI and each chart row cropped at correct y positions (the first
// pass used the card art directly and had a few small icons misread; the
// chart resolves the ambiguity).
//
// Tactic values unchanged from prior commits (already cross-verified against
// action-card text). Only major/minor skill counts are touched here.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/leaders.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const skills = (d, i, s, l) => ({ diplomacy: d, intel: i, specOps: s, logistics: l });

// Reads from the chart (final transcription). Only leaders whose stats
// changed relative to the data in main are listed; the others (Krennic,
// Motti, Krennic's Finest) already matched the chart.
const PATCHES = {
  // Jabba: minor Intel was 0 → 1 (a small blue eye appears below the small
  // orange diamond in the Jabba row, making total 6 icons: maj D2I2 + min D1I1).
  'jabba':         { skills: skills(2, 2, 0, 0), minorSkills: skills(1, 1, 0, 0) },

  // Cassian: chart shows TWO small blue eyes (minor Intel = 2) and NO
  // small white-square. So minor Intel 1→2 and minor Logistics 1→0.
  // Total 5: maj L1 I2 + min I2.
  'cassian-andor': { skills: skills(0, 2, 0, 1), minorSkills: skills(0, 2, 0, 0) },

  // Jyn: the orange diamond is BIG-sized in the chart (major Diplomacy),
  // not small. Move Diplomacy from minor → major. Two small blue eyes +
  // one small red fist remain as minors. Total stays 6 (the user's
  // canonical "six skill icons"): maj D1 I1 S1 + min I2 S1.
  'jyn-erso':      { skills: skills(1, 1, 1, 0), minorSkills: skills(0, 2, 1, 0) },

  // Chirrut: two small orange diamonds visible in the chart (one alongside
  // the big orange, one above). Minor Dipl 1 → 2. Total 5: maj D1 S2 + min D2.
  'chirrut-imwe':  { skills: skills(1, 0, 2, 0), minorSkills: skills(2, 0, 0, 0) },

  // Saw: two small red fists in the chart (one below the big fist, one
  // upper-right). Minor SpecOps 1 → 2. Total 4: maj L1 S1 + min S2.
  'saw-gerrera':   { skills: skills(0, 0, 1, 1), minorSkills: skills(0, 0, 2, 0) },
};

const same = (a, b) =>
  a.diplomacy === b.diplomacy && a.intel === b.intel &&
  a.specOps === b.specOps && a.logistics === b.logistics;

let touched = 0;
for (const l of data.leaders) {
  const p = PATCHES[l.id];
  if (!p) continue;
  if (same(l.skills, p.skills) && same(l.minorSkills, p.minorSkills)) continue;
  l.skills = p.skills;
  l.minorSkills = p.minorSkills;
  touched++;
}

data._meta = data._meta || {};
data._meta.notes = data._meta.notes || [];
data._meta.notes.push(
  `Phase 5c patch v2: corrected ${touched} RoE leader skill counts after ` +
  `a third pass against Leader_Pool_RotE.pdf rendered at 400 DPI with ` +
  `each leader row cropped at the exact chart y-position. Tactic values ` +
  `unchanged. See scripts/fix-rote-leaders-v2.mjs for the per-leader rationale.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Patched ${touched} leaders.`);
