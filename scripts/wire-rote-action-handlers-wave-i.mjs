// Phase 5d-handlers Wave I: Secret Facility + Sweep the Area. Both Empire
// Immediate cards that arm with a facedown probe and auto-reveal at
// their RAW trigger windows.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/actions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const updates = {
  'secret-facility': { effectKey: 'secret-facility' },
  'sweep-the-area':  { effectKey: 'sweep-the-area' },
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
  `Phase 5d-handlers Wave I: wired ${touched} RoE Empire Immediate cards ` +
  `(Secret Facility, Sweep the Area). Adds ArmedActionCard state + ` +
  `ArmCardProbePick choice. Cards auto-reveal at the start of an Empire ` +
  `Command turn (Secret Facility) or at end of Command phase ` +
  `(Sweep the Area).`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Wired ${touched} action cards.`);
