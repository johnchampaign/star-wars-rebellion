// Extracts every statically-known turnLog event kind from the source, with the
// files that emit it. Shared by gen-log-registry.mjs (doc generation) and
// test-log-registry.mjs (the tripwire), so both always agree on the kind list.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function extractKindsFromSource() {
  const dirs = [join(ROOT, 'src', 'engine'), join(ROOT, 'src', 'play')];
  const kinds = new Map(); // kind -> Set(files)
  const add = (kind, file) => {
    if (!kinds.has(kind)) kinds.set(kind, new Set());
    kinds.get(kind).add(file);
  };
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f)) continue;
      const src = readFileSync(join(dir, f), 'utf8');
      const rel = `src/${dir.endsWith('engine') ? 'engine' : 'play'}/${f}`;
      // log(G, { kind: '...' }) / logEvent(G, { kind: '...' }) — the event kind
      // is the first property by convention; take the first `kind:` after the
      // call opens (200-char window tolerates comments/line breaks before it).
      for (const m of src.matchAll(/\blog(?:Event)?\(G,\s*\{[\s\S]{0,200}?kind:\s*'([a-z0-9-]+)'/g)) add(m[1], rel);
      // logForSide(G, side, 'kind', ...)
      for (const m of src.matchAll(/\blogForSide\(G,\s*[^,]+,\s*'([a-z0-9-]+)'/g)) add(m[1], rel);
      // logState writes kind 'state'
      if (/\blogState\(G[,)]/.test(src)) add('state', rel);
    }
  }
  return kinds;
}
