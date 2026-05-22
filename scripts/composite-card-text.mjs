// Composite rules text onto card PNGs whose source art lacks it.
//
// VASSAL strips card rules text from its exported PNGs because the live
// module renders text from data at runtime. For our digital port we need
// the text baked in (or a sidecar — see HandTip's typeset fallback).
// This script does the bake: it reads each card catalog (objectives,
// missions, actions, tactics) and, for any card whose PNG visibly lacks
// its rules text, draws a semi-transparent text overlay on the lower
// portion of the card.
//
// For now only OBJECTIVE cards get composited — those are the ones with
// text stripped. Mission and action cards in our extract already carry
// their text. Re-run this script after re-extracting from a fresh .vmod
// to regenerate.
//
// Output: public/dev-assets/cards/ (overwrites the existing PNG in-place).
// `public/dev-assets/` is gitignored so this stays local-only.

import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ASSETS = join(ROOT, 'assets');
// Read source PNGs from the pristine vmod extract so re-runs are
// idempotent (never composite on top of a previous composite).
const CARDS_SRC = join(ROOT, 'vmod_extracted', 'images');
const CARDS_DST = join(ROOT, 'public', 'dev-assets', 'cards');

const objectives = JSON.parse(readFileSync(join(ASSETS, 'objectives.json'), 'utf8')).objectives;

// Word-wrap helper. Returns an array of lines that fit within maxWidth
// at the given font size.
function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const test = current ? current + ' ' + w : w;
    const width = ctx.measureText(test).width;
    if (width > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function compositeObjective(card) {
  if (!card.image || !card.rulesText) return false;
  const srcPath = join(CARDS_SRC, card.image);
  const dstPath = join(CARDS_DST, card.image);
  if (!existsSync(srcPath)) {
    console.warn(`[composite] skip ${card.id}: missing source ${card.image}`);
    return false;
  }
  const img = await loadImage(srcPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // Overlay box sits in the white textbox area at the top of the card,
  // below the rep number / timing badge and ABOVE the art. Matches the
  // canonical FFG objective-card layout (see "Defend the People" etc).
  const boxX = Math.round(img.width * 0.05);
  const boxW = img.width - boxX * 2;
  const boxY = Math.round(img.height * 0.13);
  const boxH = Math.round(img.height * 0.24);

  // Match the printed card's look: opaque cream/off-white background,
  // thin dark border, black text. The card's original PNG already has a
  // small "table" there (LFL/FFG branding strip is just below it); we
  // paint over the whole region so the text reads cleanly.
  ctx.fillStyle = 'rgba(245, 240, 225, 0.97)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = 'rgba(60, 50, 30, 0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);

  // Text. Scale font with card width so it renders consistently across
  // any source resolution.
  const fontSize = Math.max(9, Math.round(img.width * 0.058));
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = '#1a1410';
  ctx.textBaseline = 'top';

  const pad = Math.round(img.width * 0.025);
  const lines = wrapText(ctx, card.rulesText, boxW - pad * 2);
  const lineH = Math.round(fontSize * 1.18);
  // If text is taller than the box, shrink the font until it fits.
  let actualFontSize = fontSize;
  let actualLines = lines;
  let actualLineH = lineH;
  while (actualLineH * actualLines.length > boxH - pad * 2 && actualFontSize > 7) {
    actualFontSize -= 1;
    ctx.font = `${actualFontSize}px sans-serif`;
    actualLines = wrapText(ctx, card.rulesText, boxW - pad * 2);
    actualLineH = Math.round(actualFontSize * 1.18);
  }
  let y = boxY + pad;
  for (const line of actualLines) {
    ctx.fillText(line, boxX + pad, y);
    y += actualLineH;
  }

  const out = canvas.toBuffer('image/png');
  writeFileSync(dstPath, out);
  return true;
}

async function main() {
  let composited = 0;
  let skipped = 0;
  for (const card of objectives) {
    const ok = await compositeObjective(card);
    if (ok) composited++; else skipped++;
  }
  console.log(`[composite] objectives: ${composited} updated, ${skipped} skipped`);
}

main().catch((err) => {
  console.error('[composite] failed:', err);
  process.exit(1);
});
