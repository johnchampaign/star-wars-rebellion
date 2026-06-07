// Patch script v3 — corrections from user verification against the
// physical chart. The chart's icon-size distinction is ambiguous at PDF
// rendering resolution for some pairs; user-confirmed reads are
// authoritative.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/leaders.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const skills = (d, i, s, l) => ({ diplomacy: d, intel: i, specOps: s, logistics: l });

const PATCHES = {
  // Krennic: "Logistics (Major) + Intel (Major) + 2 Intel (Minor) + SpecOps
  // (Minor)." SpecOps moves from major → minor.
  'krennic':         { skills: skills(0, 1, 0, 1), minorSkills: skills(0, 2, 1, 0) },

  // Krennic's Finest: "2 SpecOps (Major) + 2 SpecOps (Minor)." Major drops
  // from 3 → 2; minor goes from 1 → 2.
  'krennics-finest': { skills: skills(0, 0, 2, 0), minorSkills: skills(0, 0, 2, 0) },

  // Motti: "Logistics (Major) + Intel and Diplomacy (both minor)." The
  // orange diamond is the minor Diplomacy, not a major. Diplomacy moves
  // from major → minor.
  'motti':           { skills: skills(0, 0, 0, 1), minorSkills: skills(1, 1, 0, 0) },

  // Jabba unchanged — user confirmed "2 Intel (Major) + Intel + Dipl (both
  // minor) + 2 Diplomacy (Major)" which matches current data exactly.
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
  `Phase 5c patch v3: user-verified corrections to Krennic, Krennic's Finest, ` +
  `and Motti (icon-size distinction at PDF resolution was ambiguous for ` +
  `these three; user read the physical chart). Jabba's data was already correct.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Patched ${touched} leaders.`);
