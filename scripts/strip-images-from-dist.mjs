// Strip all VASSAL-derived images from dist/dev-assets/ before the
// Cloudflare Pages deploy. The deployed site ships only the JSON catalogs;
// players who want visuals clone the repo and run `npm run copy-assets`
// against their own VASSAL extraction locally.
//
// Run by `npm run deploy` after `vite build` and before `wrangler pages
// deploy`.

import { readdirSync, statSync, writeFileSync } from 'node:fs';
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

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else {
      // Keep .json catalogs; replace other files (mostly PNG, also JPG)
      // with a tiny placeholder so the cache invalidates.
      const lower = name.toLowerCase();
      if (lower.endsWith('.json')) {
        kept++;
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
console.log(`[strip-images] kept ${kept} JSON files, replaced ${replaced} image/other files with placeholders in dist/dev-assets/`);
