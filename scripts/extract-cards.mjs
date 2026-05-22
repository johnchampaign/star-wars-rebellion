// Build scaffolds for the 5 card data files from .vmod card filenames.
// User fills in rules text / metadata via the cards dev tab.

import { mkdirSync, readdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IMG_SRC = join(ROOT, 'vmod_extracted', 'images');
const IMG_DST = join(ROOT, 'public', 'dev-assets', 'cards');
const ASSETS = join(ROOT, 'assets');

mkdirSync(IMG_DST, { recursive: true });

const files = readdirSync(IMG_SRC).filter((f) => f.endsWith('.png'));

// CamelCase → "Title Case With Spaces"
function spaced(camel) {
  return camel.replace(/([A-Z])/g, ' $1').trim();
}

// "Title Case" → "title-case"
function kebab(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================
// ACTIONS
// ============================================================
const actionRe = /^ActionCard(Empire|Rebel)(Starting|Start)?([A-Z][A-Za-z]+)?\.png$/;
const actions = [];
for (const f of files) {
  const m = f.match(actionRe);
  if (!m) continue;
  const [, sideRaw, startingPrefix, rest] = m;
  // Skip card backs
  if (!rest && (f.includes('CardBack') || f.includes('StartCardBack'))) continue;
  if (rest && rest.match(/^CardBack/)) continue;
  const isStarting = !!startingPrefix;
  const name = spaced(rest ?? '');
  if (!name) continue; // pure card back
  actions.push({
    id: kebab(name),
    name,
    side: sideRaw,
    isStarting,
    timing: '',          // Assignment | StartOfCombat | Immediate | Special
    leaderRequirement: [],
    effectKey: '',
    rulesText: '',
    image: f,
  });
}
actions.sort((a, b) => (a.side === b.side ? a.id.localeCompare(b.id) : a.side.localeCompare(b.side)));

// ============================================================
// MISSIONS (includes projects)
// ============================================================
// Filename forms:
//   MissionEmpireXxx.png
//   MIssionEmpireXxx.png  (typo in two files)
//   MissionEmpireProjectXxx.png  (project missions)
//   MissionRebelXxx.png
const missionRe = /^M[Ii]ssion(Empire|Rebel)(Project)?([A-Z][A-Za-z]+)\.png$/;
const missions = [];
for (const f of files) {
  const m = f.match(missionRe);
  if (!m) continue;
  const [, side, projectPrefix, rest] = m;
  if (rest === 'CardBack') continue;
  const isProject = !!projectPrefix;
  const name = spaced(rest);
  missions.push({
    id: kebab(name),
    name,
    side,
    isStarting: false,    // user verifies — starting missions have a yellow arrow at the bottom
    isProject,
    skill: '',            // diplomacy | intel | specOps | logistics
    skillCost: 0,         // number printed in the top-left cost shield
    isAttempt: true,      // attempt vs resolve — user verifies
    leaderPortrait: null, // leader id whose portrait is in the top-left, if any
    effectKey: '',
    rulesText: '',
    image: f,
  });
}
missions.sort((a, b) => (a.side === b.side ? a.id.localeCompare(b.id) : a.side.localeCompare(b.side)));

// ============================================================
// OBJECTIVES (Rebel only)
// ============================================================
const objectiveRe = /^ObjectiveLvl([123])([A-Z][A-Za-z]+)\.png$/;
const objectives = [];
for (const f of files) {
  const m = f.match(objectiveRe);
  if (!m) continue;
  const [, stageStr, rest] = m;
  const stage = Number(stageStr);
  const name = spaced(rest);
  // Two Death Star Plans cards exist (stage 2 and stage 3) — give them distinct ids
  const id = `${kebab(name)}-${stage}`;
  objectives.push({
    id,
    name,
    stage,
    reputation: 0,        // number printed in the top-left
    timing: '',           // Combat | StartOfRefresh | Special
    effectKey: '',
    rulesText: '',
    image: f,
  });
}
objectives.sort((a, b) => (a.stage - b.stage) || a.id.localeCompare(b.id));

// ============================================================
// TACTICS (10 ground + 10 space typically, minus duplicates)
// ============================================================
const tacticRe = /^Tactic(Ground|Space)([A-Z][A-Za-z]+)\.png$/;
const tactics = [];
for (const f of files) {
  const m = f.match(tacticRe);
  if (!m) continue;
  const [, theaterRaw, rest] = m;
  if (rest === 'CardBack') continue;
  const theater = theaterRaw.toLowerCase();
  const name = spaced(rest);
  tactics.push({
    id: `${theater}-${kebab(name)}`,
    name,
    theater,
    requiresSpecial: false, // ⚡ icon present
    effectKey: '',
    rulesText: '',
    image: f,
  });
}
tactics.sort((a, b) => (a.theater === b.theater ? a.id.localeCompare(b.id) : a.theater.localeCompare(b.theater)));

// ============================================================
// PROBE CARDS (synthesized from systems.json — 1 per non-Coruscant system)
// ============================================================
const systemsData = JSON.parse(readFileSync(join(ASSETS, 'systems.json'), 'utf-8'));
const probes = systemsData.systems
  .filter((s) => !s.isCoruscant)
  .map((s) => ({
    id: `probe-${s.id}`,
    systemId: s.id,
    systemName: s.name,
  }));

// ============================================================
// Write
// ============================================================
function write(name, obj) {
  writeFileSync(join(ASSETS, `${name}.json`), JSON.stringify(obj, null, 2));
}

write('actions', {
  _meta: {
    schema: 'actions-v1',
    provenance: 'vmod-parsed-skeleton',
    source: 'vmod_extracted/images/ActionCard*.png; all editable fields default to empty pending transcription via dev tab',
    notes: [
      `${actions.length} action cards (Empire + Rebel, starting + recruit).`,
      'timing: Assignment | StartOfCombat | Immediate | Special. User reads from the bold phrase above the ability on the card.',
      'leaderRequirement: list of leader ids (e.g. ["darth-vader"]) shown on the card. Used by the rule that requires one of the named leaders to be in the system/combat (rr p.2).',
      'effectKey: bound to a registered handler in code. Left blank until handlers exist.',
      'rulesText: copy verbatim from the card.',
    ],
  },
  actions,
});

write('missions', {
  _meta: {
    schema: 'missions-v1',
    provenance: 'vmod-parsed-skeleton',
    source: 'vmod_extracted/images/Mission*.png; all editable fields default to empty/false pending transcription via dev tab',
    notes: [
      `${missions.length} mission cards (includes ${missions.filter((m) => m.isProject).length} project cards).`,
      'isStarting: true for the 4 starting missions per side (yellow arrow at the bottom of the card).',
      'skill: diplomacy | intel | specOps | logistics — the icon in the top-left.',
      'skillCost: number printed in the top-left cost shield.',
      'isAttempt: true if the card says "attempt" (opposable); false if it says "resolve" (auto).',
      'leaderPortrait: leader id whose face appears in the top-left corner (rr p.9 +2 successes bonus).',
      'effectKey: bound to a registered handler in code.',
      'rulesText: copy verbatim from the card.',
    ],
  },
  missions,
});

write('objectives', {
  _meta: {
    schema: 'objectives-v1',
    provenance: 'vmod-parsed-skeleton',
    source: 'vmod_extracted/images/ObjectiveLvl*.png',
    notes: [
      `${objectives.length} objective cards (Rebel only). Stage I/II/III deck structure (rr p.10).`,
      'reputation: number printed in the top-left corner (how many spaces the reputation marker moves).',
      'timing: Combat | StartOfRefresh | Special — read from the bold text at the top of the card.',
      'Two "Death Star Plans" cards exist (stage 2 and stage 3); their ids include the stage suffix to disambiguate.',
    ],
  },
  objectives,
});

write('tactics', {
  _meta: {
    schema: 'tactics-v1',
    provenance: 'vmod-parsed-skeleton',
    source: 'vmod_extracted/images/Tactic*.png',
    notes: [
      `${tactics.length} tactic cards (ground + space). Two decks; each player draws from the matching deck per their leader's tactic value (rr p.14).`,
      'requiresSpecial: true if the card has a ⚡ icon — playing the card costs a special die in addition to the play.',
      'theater: ground | space.',
    ],
  },
  tactics,
});

write('probes', {
  _meta: {
    schema: 'probes-v1',
    provenance: 'derived-from-systems',
    source: 'assets/systems.json; one probe card per non-Coruscant system (rr p.10)',
    notes: [
      `${probes.length} probe cards (32 systems - 1 for Coruscant = 31).`,
      'Probe cards have no rules text; they are just system identifiers used by the Empire to narrow the Rebel base location.',
    ],
  },
  probes,
});

console.log(`actions:    ${actions.length}`);
console.log(`missions:   ${missions.length}  (${missions.filter((m) => m.isProject).length} projects)`);
console.log(`objectives: ${objectives.length}`);
console.log(`tactics:    ${tactics.length}`);
console.log(`probes:     ${probes.length}`);

// Copy card images
let copied = 0;
for (const list of [actions, missions, objectives, tactics]) {
  for (const c of list) {
    const from = join(IMG_SRC, c.image);
    const to = join(IMG_DST, c.image);
    if (!existsSync(from)) continue;
    copyFileSync(from, to);
    copied++;
  }
}
console.log(`copied ${copied} card images to ${IMG_DST}`);
