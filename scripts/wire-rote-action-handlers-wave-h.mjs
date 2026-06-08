// Phase 5d-handlers Wave H: wire Under the Radar + ship the
// play-immediate-action-card affordance. The card itself binds via
// applyImmediateActionCardEffect in phases.ts; effectKey on the JSON is
// informational.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/actions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const updates = {
  'under-the-radar': { effectKey: 'under-the-radar' },
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
  `Phase 5d-handlers Wave H: wired ${touched} RoE action card (Under the ` +
  `Radar) + the new play-immediate-action-card affordance ` +
  `(requestImmediateActionCardPlay / PlayImmediateActionCard / etc.). ` +
  `Under the Radar's MVP peeks the top 4 probes for the Rebel; the ` +
  `multi-turn "keep one facedown and return later" mechanic is a ` +
  `follow-up.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Wired ${touched} action card.`);
