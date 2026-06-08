// Phase 5b polish: bind effectKey for the two Subversion missions
// (informational only — they trigger inline from resolveOpposition,
// not through the handler registry).

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/missions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const updates = {
  'subversion-new':      { effectKey: 'subversion-new' },
  'subversion-original': { effectKey: 'subversion-original' },
};

let touched = 0;
for (const m of data.missions) {
  const u = updates[m.id];
  if (!u) continue;
  let changed = false;
  for (const [k, v] of Object.entries(u)) {
    if (m[k] !== v) { m[k] = v; changed = true; }
  }
  if (changed) touched++;
}

data._meta = data._meta || {};
data._meta.notes = data._meta.notes || [];
data._meta.notes.push(
  `Phase 5b polish: wired ${touched} Subversion missions. The two RoE ` +
  `Oppose-timing missions now auto-fire from resolveOpposition when the ` +
  `opposing side has them assigned (moves leaders to the target system + ` +
  `+1 opposition die). 31 / 31 RoE missions are now functional.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Wired ${touched} missions.`);
