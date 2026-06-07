// Phase 5b Wave C: bind effectKey for the remaining RoE missions whose
// handlers landed in this pass. Subversion (New/Original) stays
// data-only — they're opposition-only missions and the engine doesn't
// dispatch them through the normal handler flow yet.

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/missions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const BINDINGS = {
  // Imperial
  'interdictor-development': 'interdictor-development',
  'single-reactor-ignition': 'single-reactor-ignition',
  'break-their-will':        'break-their-will',
  'draw-them-out':           'draw-them-out',
  // Rebel
  'aggressive-negotiations': 'aggressive-negotiations',
  'prepare-for-battle':      'prepare-for-battle',
  'secret-mission':          'secret-mission',
  'behind-enemy-lines':      'behind-enemy-lines',
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
  `Phase 5b Wave C: bound effectKey for ${touched} more RoE missions. ` +
  `Subversion (New/Original) remain data-only — opposition missions don't ` +
  `dispatch through the normal handler flow yet.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Bound ${touched} missions.`);
