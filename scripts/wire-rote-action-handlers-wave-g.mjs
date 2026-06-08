// Phase 5d-handlers Wave G: wire He Means Well (Cassian/RoE Immediate).
// Hooked into the existing DROID_RING_CARDS path so it plays as a
// ring-attach during Rebel Assignment. The K-2SO ring grants +1 minor
// SpecOps and +1 minor Intel to the bearer; this commit also wires the
// general RoE rule that minor skill icons count toward mission skill
// requirements (rules p.8) — so the ring's bonus has somewhere to land.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/actions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const updates = {
  'he-means-well': { effectKey: 'he-means-well' },
};

let touched = 0;
for (const c of data.actions) {
  const u = updates[c.id];
  if (!u) continue;
  let changed = false;
  for (const [k, v] of Object.entries(u)) {
    if (c[k] !== v) { c[k] = v; changed = true; }
  }
  if (changed) touched++;
}

data._meta = data._meta || {};
data._meta.notes = data._meta.notes || [];
data._meta.notes.push(
  `Phase 5d-handlers Wave G: wired ${touched} RoE action card (He Means ` +
  `Well). Adds the 'k2so' AttachmentKind; the ring grants +1 minor ` +
  `SpecOps and +1 minor Intel to the bearer. Phase 6 RoE rule "minor ` +
  `skill icons count toward mission skill requirements" lands alongside.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Wired ${touched} action card.`);
