// Phase 5d-handlers Wave J: wire the last two RoE action cards —
// Early Promotion (Empire) and Rebel Extremist (Rebel). Both are
// "starting" Immediate cards with a binary choice; this commit
// implements the recruit branch only (the more powerful side).

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/actions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const updates = {
  'early-promotion':  { effectKey: 'early-promotion' },
  'rebel-extremist':  { effectKey: 'rebel-extremist' },
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
  `Phase 5d-handlers Wave J: wired ${touched} RoE starting action cards ` +
  `(Early Promotion, Rebel Extremist). All 14 RoE action cards are now ` +
  `wired (with sub-choice TODOs noted on these two and on Under the ` +
  `Radar's facedown-and-return).`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Wired ${touched} action cards.`);
