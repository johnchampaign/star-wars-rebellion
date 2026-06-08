// Wire the first 4 RoE action cards into the engine's action-card dispatch
// paths. Unlike mission handlers, action cards aren't in the central
// registry — each has bespoke logic in phases.ts (Assignment) or combat.ts
// (StartOfCombat). This script only adjusts JSON metadata (timing) where
// needed so the existing dispatch reaches the new switch cases.
//
// Bound this pass:
//   trust-in-the-force    (Rebel Assignment)
//   false-orders          (Rebel Assignment, was already Assignment)
//   lord-vader-s-orders   (Empire Assignment — was Immediate; reclassified)
//   baze-s-loyalty        (Rebel StartOfCombat — already correct)
//
// We also stamp effectKey on each so the JSON reflects "this card has
// engine effects wired." For action cards effectKey isn't called by the
// registry, but populating it gives us a clean filter ("which RoE cards
// still need wiring").

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/actions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const updates = {
  'trust-in-the-force':  { effectKey: 'trust-in-the-force' },
  'false-orders':        { effectKey: 'false-orders' },
  'lord-vader-s-orders': { timing: 'Assignment', effectKey: 'lord-vader-s-orders' },
  'baze-s-loyalty':      { effectKey: 'baze-s-loyalty' },
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
  `Phase 5d-handlers Wave D: wired ${touched} RoE action cards (Trust in ` +
  `the Force, False Orders, Lord Vader's Orders, Baze's Loyalty). ` +
  `Lord Vader's Orders timing changed from Immediate to Assignment so it ` +
  `dispatches through the existing Assignment-card path.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Wired ${touched} action cards.`);
