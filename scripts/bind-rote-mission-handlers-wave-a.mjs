// Phase 5b Wave A: wire effectKey for 12 RoE missions whose handlers just
// landed in src/engine/handlers/index.ts. Idempotent — only overwrites the
// empty effectKey field.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/missions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

// Mission id → effectKey to bind. For most missions effectKey === id; the
// exception is "Covert Operations" (plural; RoE) which reuses the existing
// base 'covert-operation' (singular) handler since the effect is identical.
const BINDINGS = {
  // Imperial
  'deployment':               'deployment',
  'message-from-high-command':'message-from-high-command',
  'stolen-intel':             'stolen-intel',
  'hire-mercenaries':         'hire-mercenaries',
  'imperial-promotion':       'imperial-promotion',
  'discredit-rebellion':      'discredit-rebellion',
  // Rebel
  'regional-aid':             'regional-aid',
  'reconnaissance':           'reconnaissance',
  'critical-rescue':          'critical-rescue',
  'rebel-promotion':          'rebel-promotion',
  'my-only-hope':             'my-only-hope',
  'covert-operations':        'covert-operations',
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
data._meta.notes.push(
  `Phase 5b Wave A: bound effectKey for ${touched} RoE missions to handlers ` +
  `in src/engine/handlers/index.ts. Choice-heavy missions deferred to Wave B/C.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Bound ${touched} missions.`);
