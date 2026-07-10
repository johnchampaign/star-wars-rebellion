// Tripwire: every event kind the source can emit must be documented in
// docs/log-events.md (log-format v2 registry). Fails when a new kind ships
// undocumented — fix by running `node scripts/gen-log-registry.mjs` and
// filling in the new kind's Description.
//
// Documented-but-no-longer-emitted kinds are reported as info, not failure:
// old logs still contain them, so their rows stay useful for analyzers.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractKindsFromSource } from './lib/log-kinds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(ROOT, 'docs', 'log-events.md');

if (!existsSync(DOC)) {
  console.error('FAIL: docs/log-events.md missing — run node scripts/gen-log-registry.mjs');
  process.exit(1);
}
const doc = readFileSync(DOC, 'utf8');
const documented = new Set([...doc.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]));
const source = extractKindsFromSource();

const missing = [...source.keys()].filter((k) => !documented.has(k)).sort();
const stale = [...documented].filter((k) => !source.has(k)).sort();

if (stale.length) console.log(`info: ${stale.length} documented kind(s) no longer emitted (kept for old logs): ${stale.join(', ')}`);
if (missing.length) {
  console.error(`FAIL: ${missing.length} event kind(s) emitted by source but missing from docs/log-events.md:`);
  for (const k of missing) console.error(`  - ${k}  (${[...source.get(k)].join(', ')})`);
  console.error('Fix: node scripts/gen-log-registry.mjs, then describe the new kind(s).');
  process.exit(1);
}
console.log(`OK: all ${source.size} source event kinds documented (${documented.size} rows).`);
