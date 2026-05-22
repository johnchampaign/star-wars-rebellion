// Build a leaders.json scaffold from the .vmod leader card filenames.
// All stat fields default to 0; user fills them in via the leaders dev tab.

import { mkdirSync, readdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IMG_SRC = join(ROOT, 'vmod_extracted', 'images');
const IMG_DST = join(ROOT, 'public', 'dev-assets', 'leaders');
const OUT = join(ROOT, 'assets', 'leaders.json');

// Canonical starting leaders per rr p.15 and the .vmod's known recruit-icon distinction
// (starting = no recruit icon). The .vmod doesn't tag these in metadata; we hard-code based
// on game knowledge. User can override in the dev tab.
const STARTING = new Set([
  'mon-mothma', 'jan-dodonna', 'leia-organa', 'luke-skywalker',
  'emperor-palpatine', 'darth-vader', 'grand-moff-tarkin', 'general-tagge',
]);

// Parse a .vmod filename like "LeaderRebelMonMothma.png" → { side, id, name, image }
function parse(filename) {
  const m = filename.match(/^Leader(Rebel|Empire)([A-Z][A-Za-z]+)\.png$/);
  if (!m) return null;
  const sideRaw = m[1];
  const camel = m[2];
  const side = sideRaw === 'Rebel' ? 'Rebel' : 'Empire';
  // Split CamelCase to words. "LukeSkywalkerJedi" → "Luke Skywalker (Jedi)"; "MonMothma" → "Mon Mothma"
  const words = camel.replace(/([A-Z])/g, ' $1').trim().split(/\s+/);
  // Trailing "Jedi" becomes "(Jedi)"
  let name = words.join(' ');
  if (words[words.length - 1] === 'Jedi') {
    name = words.slice(0, -1).join(' ') + ' (Jedi)';
  }
  const id = name
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, '-');
  return { side, id, name, image: filename };
}

mkdirSync(IMG_DST, { recursive: true });

const files = readdirSync(IMG_SRC).filter((f) => /^Leader(Rebel|Empire)[A-Z]/.test(f) && f.endsWith('.png'));
const leaders = files
  .map(parse)
  .filter(Boolean)
  .sort((a, b) => (a.side === b.side ? a.id.localeCompare(b.id) : a.side.localeCompare(b.side)));

const out = {
  _meta: {
    schema: 'leaders-v1',
    provenance: 'vmod-parsed-skeleton',
    source: 'vmod_extracted/images/Leader*.png filenames; stats default to 0 pending transcription via dev tab',
    notes: [
      `${leaders.length} leaders. Names parsed from .vmod filenames; user verifies via the leaders dev tab.`,
      'isStarting: hard-coded per rr p.15. 4 per side never have a recruit icon: ' +
        'Rebel = Mon Mothma, Jan Dodonna, Leia Organa, Luke Skywalker; ' +
        'Empire = Palpatine, Darth Vader, Tarkin, General Tagge.',
      'skills (diplomacy, intel, specOps, logistics): major skill icons. Count from each leader card. 0..3 typical.',
      'tacticValues (space, ground): printed numbers in the bottom corners of each leader card. 0 = no value (leader cannot activate a system / cannot draw tactic cards in that theater).',
      'minorSkills: RoE expansion only. All zero in base game; field reserved for forward compatibility.',
      'Luke Skywalker (Jedi) is a distinct leader (rr p.8 says "treat as Luke Skywalker for card and action card references" -- modeled here as a separate id with name "Luke Skywalker (Jedi)").',
      'REQUIRES USER VERIFICATION via the ?dev=1 leaders tab.',
    ],
  },
  leaders: leaders.map((l) => ({
    id: l.id,
    name: l.name,
    side: l.side,
    isStarting: STARTING.has(l.id),
    skills: { diplomacy: 0, intel: 0, specOps: 0, logistics: 0 },
    minorSkills: { diplomacy: 0, intel: 0, specOps: 0, logistics: 0 },
    tacticValues: { space: 0, ground: 0 },
    image: l.image,
  })),
};

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT} with ${leaders.length} leaders`);

// Copy card images to public/dev-assets/leaders/
let copied = 0;
for (const l of leaders) {
  const from = join(IMG_SRC, l.image);
  const to = join(IMG_DST, l.image);
  if (!existsSync(from)) continue;
  copyFileSync(from, to);
  copied++;
}
console.log(`copied ${copied} leader images to ${IMG_DST}`);
