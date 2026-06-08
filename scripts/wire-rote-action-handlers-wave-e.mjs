// Wire Track Them and Something to Fight For — the first two RoE Special-
// timing action cards. Each fires from an inline trigger in the engine
// (Track Them after a Rebel retreat; Something to Fight For after a Rebel
// battle win) with a player-offer modal. effectKey on these cards is
// informational — they don't dispatch through the mission-handler
// registry, but stamping it makes "which RoE action cards are wired"
// filterable.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/actions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const updates = {
  'track-them':              { effectKey: 'track-them' },
  'something-to-fight-for':  { effectKey: 'something-to-fight-for' },
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
  `Phase 5d-handlers Wave E: wired ${touched} RoE Special-timing action ` +
  `cards (Track Them, Something to Fight For). Both use inline event ` +
  `triggers + offer modals.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Wired ${touched} action cards.`);
