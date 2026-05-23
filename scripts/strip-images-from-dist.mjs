// Strip all VASSAL-derived images from dist/dev-assets/ before the
// Cloudflare Pages deploy. The deployed site ships only the JSON catalogs;
// players who want visuals clone the repo and run `npm run copy-assets`
// against their own VASSAL extraction locally.
//
// Run by `npm run deploy` after `vite build` and before `wrangler pages
// deploy`.

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ASSETS_DIR = join(ROOT, 'dist', 'dev-assets');

let kept = 0;
let removed = 0;

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      // Try to remove the directory if it's now empty.
      try {
        const remaining = readdirSync(full);
        if (remaining.length === 0) rmSync(full, { recursive: false });
      } catch { /* ignore */ }
    } else {
      // Keep only .json catalogs. Everything else (PNG, JPG, etc) goes.
      if (name.toLowerCase().endsWith('.json')) {
        kept++;
      } else {
        rmSync(full);
        removed++;
      }
    }
  }
}

walk(ASSETS_DIR);
console.log(`[strip-images] kept ${kept} JSON files, removed ${removed} non-JSON files from dist/dev-assets/`);
