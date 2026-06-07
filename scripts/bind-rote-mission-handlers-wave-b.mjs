// Phase 5b Wave B: wire effectKey for 9 more RoE missions. Idempotent.
// "Were the Bait" is stored in the JSON as id 'were-the-bait' (the slug of
// the original "We're the Bait" — leading apostrophe stripped); the handler
// shares that key. Break Their Will is deferred to Wave C.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/missions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const BINDINGS = {
  // Imperial
  'secure-the-plans':  'secure-the-plans',
  'make-an-example':   'make-an-example',
  'imperial-might':    'imperial-might',
  'were-the-bait':     'were-the-bait',
  'exploit-weakness':  'exploit-weakness',
  // Rebel
  'heist':             'heist',
  'plant-explosives':  'plant-explosives',
  'assault':           'assault',
  'safe-haven':        'safe-haven',
};

let touched = 0;
for (const m of data.missions) {
  const key = BINDINGS[m.id];
  if (!key) continue;
  if (m.effectKey === key) continue;
  m.effectKey = key;
  touched++;
}

data._meta = data._meta || {};
data._meta.notes = data._meta.notes || [];
data._meta.notes.push(`Phase 5b Wave B: bound effectKey for ${touched} more RoE missions.`);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Bound ${touched} missions.`);
