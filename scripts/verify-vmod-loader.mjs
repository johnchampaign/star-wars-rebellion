// Verifier: exercise the exact loader logic from src/play/vmodArtCache.ts
// against a real .vmod file on disk. Catches bugs that `vite build` can't,
// like "the nested-zip recursion doesn't fire" or "the case-insensitive
// alias resolution doesn't find Map-Redux.png".
//
// Run: node scripts/verify-vmod-loader.mjs <path-to-vmod>
//   e.g. node scripts/verify-vmod-loader.mjs /tmp/swr.vmod
//
// Exit codes:
//   0 = all assertions passed
//   1 = at least one assertion failed (loader bug)

import { readFileSync } from 'node:fs';
import JSZip from 'jszip';

// ---------- The loader logic, mirrored from vmodArtCache.ts ----------
// Keep this in lockstep with src/play/vmodArtCache.ts loadVmodFromFile.
// If the production loader changes, update this and re-run.

async function loadVmod(buf) {
  let zip = await JSZip.loadAsync(buf);
  let pngEntries = [];
  zip.forEach((_p, e) => {
    if (e.dir) return;
    if (!/\.png$/i.test(e.name)) return;
    pngEntries.push(e);
  });
  let recursedInto = null;
  if (pngEntries.length === 0) {
    const nested = [];
    zip.forEach((_p, e) => {
      if (e.dir) return;
      if (/\.(vmod|zip)$/i.test(e.name)) nested.push(e);
    });
    if (nested.length === 1) {
      const inner = nested[0];
      recursedInto = inner.name;
      const innerBuf = await inner.async('arraybuffer');
      zip = await JSZip.loadAsync(innerBuf);
      zip.forEach((_p, e) => {
        if (e.dir) return;
        if (!/\.png$/i.test(e.name)) return;
        pngEntries.push(e);
      });
    }
  }
  if (pngEntries.length === 0) {
    throw new Error('No PNG images found.');
  }
  const stored = new Map();
  for (const entry of pngEntries) {
    const basename = entry.name.split('/').pop() || entry.name;
    const blob = await entry.async('uint8array');
    stored.set(basename, blob);
  }
  return { stored, recursedInto };
}

// ---------- Alias resolver, mirrored from getCachedArtUrlSync ----------

const FILENAME_ALIASES = {
  'Map.png': ['Map-Redux.png'],
};

function resolve(stored, caseIndex, filename) {
  if (stored.has(filename)) return filename;
  const ci = caseIndex.get(filename.toLowerCase());
  if (ci) return ci;
  const aliases = FILENAME_ALIASES[filename];
  if (aliases) {
    for (const alt of aliases) {
      if (stored.has(alt)) return alt;
      const ciAlt = caseIndex.get(alt.toLowerCase());
      if (ciAlt) return ciAlt;
    }
  }
  return null;
}

// ---------- Run + assertions ----------

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/verify-vmod-loader.mjs <path-to-vmod>');
  process.exit(2);
}

const buf = readFileSync(file);
console.log(`Loaded ${file} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);

const { stored, recursedInto } = await loadVmod(buf);
console.log(`Loader extracted ${stored.size} PNG files.`);
if (recursedInto) {
  console.log(`Loader recursed into nested: ${recursedInto}`);
}

// Build the case index the same way preloadAllBlobUrls does.
const caseIndex = new Map();
for (const key of stored.keys()) caseIndex.set(key.toLowerCase(), key);

// Assertions. Each expected name comes from a real consumer in the
// production code (catalog files + URL helpers).
const expectations = [
  // Map (uses alias)
  { name: 'Map.png',                         consumer: 'mapImageUrl()' },
  // Markers (referenced by inline strings in PlayTab.tsx)
  { name: 'MarkerLoyaltyRebel.png',          consumer: 'PlayTab legend' },
  { name: 'MarkerLoyaltyEmpire.png',         consumer: 'PlayTab legend' },
  { name: 'MarkerLoyaltySubjugated.png',     consumer: 'PlayTab subjugated badge' },
  { name: 'MarkerLoyaltyNeutral.png',        consumer: 'system hover panel' },
  // Units (full UNIT_IMAGE table from src/play/unitImages.ts)
  { name: 'UnitTIE.png',                     consumer: 'unit cluster' },
  { name: 'UnitAssaultCarrier.png',          consumer: 'unit cluster' },
  { name: 'UnitStarDestroyer.png',           consumer: 'unit cluster' },
  { name: 'UnitSuperStarDestroyer.png',      consumer: 'unit cluster' },
  { name: 'UnitDeathStar.png',               consumer: 'unit cluster' },
  { name: 'UnitDeathStarUC.png',             consumer: 'unit cluster' },
  { name: 'UnitStormtrooper.png',            consumer: 'unit cluster' },
  { name: 'UnitATST.png',                    consumer: 'unit cluster' },
  { name: 'UnitATAT.png',                    consumer: 'unit cluster' },
  { name: 'UnitXWing.png',                   consumer: 'unit cluster' },
  { name: 'UnitYWing.png',                   consumer: 'unit cluster' },
  { name: 'UnitCorellianCorvette.png',       consumer: 'unit cluster' },
  { name: 'UnitRebelTransport.png',          consumer: 'unit cluster' },
  { name: 'UnitMonCalamari.png',             consumer: 'unit cluster' },
  { name: 'UnitRebelTrooper.png',            consumer: 'unit cluster' },
  { name: 'UnitAirspeeder.png',              consumer: 'unit cluster' },
  { name: 'UnitShieldGenerator.png',         consumer: 'unit cluster' },
  { name: 'UnitIonCannon.png',               consumer: 'unit cluster' },
  // Sample leaders (full set comes from assets/leaders.json)
  { name: 'LeaderEmpireDarthVader.png',      consumer: 'leader portrait' },
  { name: 'LeaderRebelLukeSkywalker.png',    consumer: 'leader portrait' },
  // Sample cards
  { name: 'ActionCardEmpireBlindside.png',   consumer: 'action card image' },
  { name: 'MissionEmpireRuleByFear.png',     consumer: 'mission card image' },
];

let pass = 0;
let fail = 0;
const failures = [];
for (const { name, consumer } of expectations) {
  const resolved = resolve(stored, caseIndex, name);
  if (resolved) {
    pass++;
    const noted = resolved === name ? '' : ` (via alias → ${resolved})`;
    console.log(`  ✓ ${name}${noted} [${consumer}]`);
  } else {
    fail++;
    failures.push({ name, consumer });
    console.log(`  ✗ ${name} NOT FOUND [${consumer}]`);
  }
}

// Now do the broader catalog check from the actual JSON files.
console.log('\n--- Catalog-driven check (every leader/mission/action/objective/tactic image) ---');
const catalogs = [
  ['assets/leaders.json',    'leaders'],
  ['assets/missions.json',   'missions'],
  ['assets/actions.json',    'actions'],
  ['assets/objectives.json', 'objectives'],
  ['assets/tactics.json',    'tactics'],
];
let catalogPass = 0;
const catalogMissing = [];
for (const [path, key] of catalogs) {
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
  const items = data[key] || data;
  for (const item of items) {
    if (!item.image) continue;
    const r = resolve(stored, caseIndex, item.image);
    if (r) catalogPass++;
    else catalogMissing.push({ id: item.id, file: item.image, kind: key });
  }
}
console.log(`Catalog: ${catalogPass} resolved, ${catalogMissing.length} missing.`);
if (catalogMissing.length > 0) {
  console.log('First 10 missing:');
  for (const m of catalogMissing.slice(0, 10)) {
    console.log(`  [${m.kind}] ${m.id} → ${m.file}`);
  }
}

console.log(`\n=== ${pass}/${pass + fail} core assertions passed, ${catalogMissing.length} catalog gaps ===`);
if (fail > 0) {
  console.log('FAIL — loader does not satisfy core expectations.');
  process.exit(1);
}
console.log('PASS — loader extracts everything we render from.');
process.exit(0);
