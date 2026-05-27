// Verifier: exercise the loader logic from src/play/vmodArtCache.ts
// against both real and synthetic .vmod files. Catches bugs that
// `vite build` can't, like "the nested-zip recursion doesn't fire",
// "the Map-Redux.png alias doesn't resolve", or "the LoadFailure for
// the not-a-zip case doesn't surface the right reason."
//
// Run: node scripts/verify-vmod-loader.mjs [<path-to-real-vmod>]
//   With no argument: runs synthetic-input tests only.
//   With a real .vmod path: also runs the happy-path assertion suite
//   against it.
//
// Exit codes:
//   0 = all assertions passed
//   1 = at least one assertion failed (loader bug)

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

// ---------- The loader logic, mirrored from vmodArtCache.ts ----------
// Keep in lockstep with src/play/vmodArtCache.ts loadVmodFromFile.

class LoadFailure extends Error {
  constructor(reason, report, message) {
    super(message);
    this.reason = reason;
    this.report = report;
  }
}

async function loadVmod(buf, inputName = 'test.vmod') {
  const report = {
    inputFilename: inputName,
    inputSizeBytes: buf.length,
    parsedAsZip: false,
    topLevelEntryCount: 0,
    topLevelSample: [],
    topLevelPngCount: 0,
    nestedArchiveNames: [],
    recursedInto: null,
    finalPngCount: 0,
    totalStoredBytes: 0,
  };

  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    throw new LoadFailure('not-a-zip', report, `Not a ZIP: ${e.message}`);
  }
  report.parsedAsZip = true;

  const topLevelEntries = [];
  zip.forEach((_p, e) => {
    if (e.dir) return;
    topLevelEntries.push({
      name: e.name,
      isPng: /\.png$/i.test(e.name),
      isArchive: /\.(vmod|zip)$/i.test(e.name),
    });
  });
  report.topLevelEntryCount = topLevelEntries.length;
  report.topLevelSample = topLevelEntries.map((e) => e.name).sort().slice(0, 8);
  report.topLevelPngCount = topLevelEntries.filter((e) => e.isPng).length;
  report.nestedArchiveNames = topLevelEntries.filter((e) => e.isArchive).map((e) => e.name);

  let pngEntries = [];
  zip.forEach((_p, e) => {
    if (e.dir) return;
    if (!/\.png$/i.test(e.name)) return;
    pngEntries.push(e);
  });

  if (pngEntries.length === 0) {
    if (report.nestedArchiveNames.length === 0) {
      throw new LoadFailure('no-pngs-no-nested', report, 'No PNGs and no nested archives.');
    }
    if (report.nestedArchiveNames.length > 1) {
      throw new LoadFailure('no-pngs-multiple-nested', report, `${report.nestedArchiveNames.length} nested archives, ambiguous.`);
    }
    const inner = zip.file(report.nestedArchiveNames[0]);
    if (!inner) throw new LoadFailure('no-pngs-no-nested', report, 'Internal: nested entry not readable.');
    report.recursedInto = inner.name;
    const innerBuf = await inner.async('arraybuffer');
    zip = await JSZip.loadAsync(innerBuf);
    zip.forEach((_p, e) => {
      if (e.dir) return;
      if (!/\.png$/i.test(e.name)) return;
      pngEntries.push(e);
    });
    if (pngEntries.length === 0) {
      throw new LoadFailure('nested-also-empty', report, 'Recursed into nested archive but it also has no PNGs.');
    }
  }

  const stored = new Map();
  for (const entry of pngEntries) {
    const basename = entry.name.split('/').pop() || entry.name;
    const blob = await entry.async('uint8array');
    stored.set(basename, blob);
  }
  report.finalPngCount = pngEntries.length;
  return { stored, report };
}

// ---------- Alias resolver, mirrored from getCachedArtUrlSync ----------

const FILENAME_ALIASES = {
  'Map.png': ['Map-Redux.png'],
  'DiceBlackBlank.png':   ['Black 1.PNG', 'Black 2.PNG'],
  'DiceBlackHit.png':     ['Black 3.PNG', 'Black 4.PNG'],
  'DiceBlackDirect.png':  ['Black 5.PNG'],
  'DiceBlackSpecial.png': ['Black 6.PNG'],
  'DiceRedBlank.png':     ['Red 12.PNG'],
  'DiceRedHit.png':       ['Red 34.PNG'],
  'DiceRedDirect.png':    ['Red 5.PNG'],
  'DiceRedSpecial.png':   ['Red 6.PNG'],
  'DiceGreenBlank.png':   ['Green 1.PNG'],
  'DiceGreenDirect.png':  ['Green 5_6.PNG'],
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

// ---------- Test harness ----------

let totalPass = 0;
let totalFail = 0;
const fails = [];

function record(name, ok, detail = '') {
  if (ok) {
    totalPass++;
    console.log(`  ✓ ${name}`);
  } else {
    totalFail++;
    fails.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectFailure(label, buf, expectedReason) {
  try {
    await loadVmod(buf, label);
    record(`${label} → expected LoadFailure(${expectedReason})`, false, 'load succeeded unexpectedly');
  } catch (e) {
    if (e instanceof LoadFailure) {
      record(`${label} → LoadFailure(${e.reason})`, e.reason === expectedReason,
        e.reason === expectedReason ? '' : `got '${e.reason}', want '${expectedReason}'`);
    } else {
      record(`${label} → LoadFailure(${expectedReason})`, false, `threw non-LoadFailure: ${e.message}`);
    }
  }
}

// ---------- Synthetic-input tests ----------

console.log('--- Synthetic input tests (failure paths) ---');

// 1. Not a ZIP at all.
await expectFailure('Not a ZIP (plain text)',
  Buffer.from('this is just text, not a zip file'),
  'not-a-zip',
);

// 2. ZIP with no PNGs and no nested archives.
{
  const z = new JSZip();
  z.file('readme.txt', 'hi');
  z.file('notes.md', '# notes');
  const buf = await z.generateAsync({ type: 'nodebuffer' });
  await expectFailure('ZIP with no PNGs, no nested archives', buf, 'no-pngs-no-nested');
}

// 3. ZIP with multiple nested archives (ambiguous).
{
  const inner1 = await new JSZip().file('readme.txt', 'a').generateAsync({ type: 'nodebuffer' });
  const inner2 = await new JSZip().file('readme.txt', 'b').generateAsync({ type: 'nodebuffer' });
  const z = new JSZip();
  z.file('module-a.vmod', inner1);
  z.file('module-b.vmod', inner2);
  const buf = await z.generateAsync({ type: 'nodebuffer' });
  await expectFailure('ZIP with multiple nested archives', buf, 'no-pngs-multiple-nested');
}

// 4. ZIP with exactly one nested archive that is ALSO empty.
{
  const inner = await new JSZip().file('readme.txt', 'no images here').generateAsync({ type: 'nodebuffer' });
  const z = new JSZip();
  z.file('inner.vmod', inner);
  const buf = await z.generateAsync({ type: 'nodebuffer' });
  await expectFailure('ZIP with one empty nested archive', buf, 'nested-also-empty');
}

// 5. ZIP with PNGs directly — happy path, no recursion.
{
  const z = new JSZip();
  z.file('images/Map.png', Buffer.alloc(100));
  z.file('images/UnitTIE.png', Buffer.alloc(50));
  const buf = await z.generateAsync({ type: 'nodebuffer' });
  try {
    const { stored, report } = await loadVmod(buf, 'happy-direct.vmod');
    record('ZIP with PNGs directly → loads', stored.size === 2);
    record('  → no recursion', report.recursedInto === null);
    record('  → finalPngCount = 2', report.finalPngCount === 2);
  } catch (e) {
    record('ZIP with PNGs directly → loads', false, e.message);
  }
}

// 6. ZIP wrapping a nested .vmod with PNGs inside.
{
  const inner = new JSZip();
  inner.file('images/Map.png', Buffer.alloc(100));
  inner.file('images/UnitTIE.png', Buffer.alloc(50));
  const innerBuf = await inner.generateAsync({ type: 'nodebuffer' });
  const outer = new JSZip();
  outer.file('Star Wars Rebellion_v1.2e.vmod', innerBuf);
  outer.file('readme.txt', 'unzip this');
  const buf = await outer.generateAsync({ type: 'nodebuffer' });
  try {
    const { stored, report } = await loadVmod(buf, 'happy-nested.vmod');
    record('ZIP wrapping a vmod with PNGs → recurses + loads', stored.size === 2);
    record('  → recursedInto = inner name', report.recursedInto === 'Star Wars Rebellion_v1.2e.vmod');
    record('  → topLevelPngCount = 0', report.topLevelPngCount === 0);
    record('  → finalPngCount = 2', report.finalPngCount === 2);
  } catch (e) {
    record('ZIP wrapping a vmod with PNGs → recurses + loads', false, e.message);
  }
}

// ---------- Alias resolution tests ----------

console.log('\n--- Alias resolution tests ---');

{
  // Stored as Map-Redux.png (v1.2e). Resolver should hit via alias.
  const stored = new Map();
  stored.set('Map-Redux.png', new Uint8Array([1]));
  stored.set('UnitTIE.png', new Uint8Array([2]));
  const caseIndex = new Map();
  for (const k of stored.keys()) caseIndex.set(k.toLowerCase(), k);
  record('Map.png resolves via Map-Redux.png alias',
    resolve(stored, caseIndex, 'Map.png') === 'Map-Redux.png');
  record('UnitTIE.png resolves directly',
    resolve(stored, caseIndex, 'UnitTIE.png') === 'UnitTIE.png');
  record('case-insensitive lookup: unittie.png',
    resolve(stored, caseIndex, 'unittie.png') === 'UnitTIE.png');
  record('missing file returns null',
    resolve(stored, caseIndex, 'DoesNotExist.png') === null);
}

// ---------- Real-file test (optional) ----------

const realPath = process.argv[2];
if (realPath) {
  console.log(`\n--- Real-file test: ${realPath} ---`);
  const buf = readFileSync(realPath);
  console.log(`(${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  const { stored, report } = await loadVmod(buf, realPath);
  console.log(`Extracted ${stored.size} PNGs.${report.recursedInto ? ` (recursed into ${report.recursedInto})` : ''}`);

  const caseIndex = new Map();
  for (const k of stored.keys()) caseIndex.set(k.toLowerCase(), k);

  const core = [
    'Map.png',
    'MarkerLoyaltyRebel.png', 'MarkerLoyaltyEmpire.png',
    'MarkerLoyaltySubjugated.png', 'MarkerLoyaltyNeutral.png',
    'UnitTIE.png', 'UnitAssaultCarrier.png', 'UnitStarDestroyer.png',
    'UnitSuperStarDestroyer.png', 'UnitDeathStar.png',
    'UnitDeathStarUC.png', 'UnitStormtrooper.png', 'UnitATST.png',
    'UnitATAT.png', 'UnitXWing.png', 'UnitYWing.png',
    'UnitCorellianCorvette.png', 'UnitRebelTransport.png',
    'UnitMonCalamari.png', 'UnitRebelTrooper.png', 'UnitAirspeeder.png',
    'UnitShieldGenerator.png', 'UnitIonCannon.png',
    'LeaderEmpireDarthVader.png', 'LeaderRebelLukeSkywalker.png',
    'ActionCardEmpireBlindside.png', 'MissionEmpireRuleByFear.png',
    // Dice — all 10 semantic names resolved via v1.2e numbered-face aliases.
    'DiceBlackBlank.png', 'DiceBlackHit.png',
    'DiceBlackDirect.png', 'DiceBlackSpecial.png',
    'DiceRedBlank.png', 'DiceRedHit.png',
    'DiceRedDirect.png', 'DiceRedSpecial.png',
    'DiceGreenBlank.png', 'DiceGreenDirect.png',
  ];
  for (const name of core) {
    const r = resolve(stored, caseIndex, name);
    record(`real-file: ${name}`, r !== null, r === null ? 'missing' : (r === name ? '' : `via alias → ${r}`));
  }
}

// ---------- Final report ----------

console.log(`\n=== ${totalPass}/${totalPass + totalFail} assertions passed ===`);
if (totalFail > 0) {
  console.log('\nFAILURES:');
  for (const f of fails) console.log(`  ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS');
process.exit(0);
