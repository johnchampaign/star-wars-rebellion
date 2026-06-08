// Phase 5d-handlers Wave F: wire Post Bounty + Ambitions of Power.
// Both are Empire Special-timing RoE cards that need new persistent
// state (bounty attachment ring + leaderPoolCapBonus). effectKey is
// informational here — these dispatch through inline triggers, not
// the mission-handler registry.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/actions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const updates = {
  'post-bounty':         { effectKey: 'post-bounty' },
  'ambitions-of-power':  { effectKey: 'ambitions-of-power' },
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
  `Phase 5d-handlers Wave F: wired ${touched} RoE Empire Special cards ` +
  `(Post Bounty, Ambitions of Power). Post Bounty introduces a new ` +
  `'bounty' attachment ring; Ambitions of Power adds the ` +
  `FactionState.leaderPoolCapBonus field.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Wired ${touched} action cards.`);
