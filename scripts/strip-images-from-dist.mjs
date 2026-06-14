// Strip all VASSAL-derived images from dist/dev-assets/ before the
// Cloudflare Pages deploy. The deployed site ships only the JSON catalogs;
// players who want visuals clone the repo and run `npm run copy-assets`
// against their own VASSAL extraction locally.
//
// Run by `npm run deploy` after `vite build` and before `wrangler pages
// deploy`.

import { readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ASSETS_DIR = join(ROOT, 'dist', 'dev-assets');

// IMPORTANT: we OVERWRITE the image files with a tiny 1×1 transparent PNG
// instead of deleting them. Reason: Cloudflare Pages CDN can keep serving
// cached PNGs for up to 7 days (s-maxage=604800) after a file is removed
// from the deployment. Replacing the file changes its content hash and
// forces the CDN cache to invalidate. The 1×1 transparent placeholder is
// ~70 bytes — cheap to serve, invisible in the UI, and triggers the
// global onError handler in index.html if the layout depended on actual
// image content. (The handler hides broken <img> tags via
// visibility:hidden so layout slots stay clean.)
//
// Tiny 1×1 transparent PNG (67 bytes, base64-decoded).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let kept = 0;
let replaced = 0;
let whitelistKept = 0;
let removed = 0;

// The board map specifically is DELETED, not placeholdered: the app now renders
// a vector-galaxy fallback whenever the real map blob isn't available, and never
// fetches dev-assets/Map.png, so a 68-byte transparent placeholder just sits
// there confusingly. (Per-user request.) Cache note: the map was only ever
// shipped as a placeholder, never as real art, so there's no stale real image
// to worry about — the CDN drops the old placeholder within its TTL.
function isMapFile(relPath) {
  const name = relPath.replace(/\\/g, '/').split('/').pop().toLowerCase();
  return name === 'map.png' || name === 'map-redux.png';
}

// Whitelist: paths (relative to dist/dev-assets/) that are ORIGINAL ART
// created by the project author (not FFG-derived), so they ship as-is
// in the deploy. Match by prefix so a whole directory can be allowed
// with one entry.
const WHITELIST_PREFIXES = [
  'units/token/',           // 26 per-unit token portraits (18 base + 8 RoE)
                            // cropped from the author's own composite sheets
                            // (scripts/extract-unit-tokens.py + -rote).
  'unit-tokens-sheet.png',       // base composite sheet
  'unit-tokens-sheet-rote.png',  // Rise of the Empire composite sheet
];

function isWhitelisted(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return WHITELIST_PREFIXES.some((p) => norm === p || norm.startsWith(p));
}

function walk(dir, relDir = '') {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, rel);
    } else {
      // Keep .json catalogs; replace other files (mostly PNG, also JPG)
      // with a tiny placeholder so the cache invalidates.
      const lower = name.toLowerCase();
      if (lower.endsWith('.json')) {
        kept++;
      } else if (isMapFile(rel)) {
        rmSync(full);
        removed++;
      } else if (isWhitelisted(rel)) {
        whitelistKept++;
      } else if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
        writeFileSync(full, TINY_PNG);
        replaced++;
      } else {
        // Unknown file type — replace with empty bytes.
        writeFileSync(full, Buffer.alloc(0));
        replaced++;
      }
    }
  }
}

walk(ASSETS_DIR);
console.log(`[strip-images] kept ${kept} JSON files, ${whitelistKept} whitelisted (author-original) art files, replaced ${replaced} image/other files with placeholders, removed ${removed} map file(s) in dist/dev-assets/`);
