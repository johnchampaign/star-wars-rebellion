// Patch script — corrects RoE leader skill counts after a second pass over
// the leader-card art at 24× zoom, prompted by the user-supplied
// Leader_Pool_RotE.pdf chart and the canonical quote that Jyn Erso has
// "six skill icons". Idempotent — only writes if the per-leader stats
// differ. Tactic values (cross-verified against action-card text) are not
// touched.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/leaders.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const skills = (d, i, s, l) => ({ diplomacy: d, intel: i, specOps: s, logistics: l });

// Corrected reads (only leaders whose skill counts CHANGED relative to the
// first transcription are listed here). The fix:
//   Jyn   — minor Intel 1 → 2 (her card shows 2 stacked small eyes between
//            the big eye and the big fist; six skill icons total).
//   Cassian — minor Logistics 0 → 1 (a small white-square-arrow sits below
//            the big blue eyes; five icons total).
//   Krennic — minor Log 1 → 0, minor Intel 1 → 2 (both small icons between
//            the big blue eye and the big red fist are blue eyes, not a
//            small white-square; five icons total).
const PATCHES = {
  'jyn-erso':        { skills: skills(0, 1, 1, 0), minorSkills: skills(1, 2, 1, 0) },
  'cassian-andor':   { skills: skills(0, 2, 0, 1), minorSkills: skills(0, 1, 0, 1) },
  'krennic':         { skills: skills(0, 1, 1, 1), minorSkills: skills(0, 2, 0, 0) },
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
  `Phase 5c patch: corrected ${touched} RoE leader skill counts after a ` +
  `second pass over the card art at 24x zoom (prompted by ` +
  `Leader_Pool_RotE.pdf and the canonical "Jyn has six skill icons"). ` +
  `Tactic values unchanged.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Patched ${touched} leaders.`);
