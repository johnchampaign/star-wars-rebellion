// Composite either rules text OR an FFG-policy notice onto objective
// card PNGs whose VASSAL-sourced art has the text blacked out.
//
// Background: the VASSAL module author intentionally redacts objective
// rules text per FFG's informal "block out text on key cards" policy
// for fan-made tools, expecting players to own the cards. This script
// supports two modes:
//
//   default (no flag)  — bake the verbatim rulesText from the catalog.
//                         This is the LOCAL-PLAY build. The output dir
//                         (`public/dev-assets/cards/`) is gitignored so
//                         this never ships from this repo.
//   --notice           — bake a small notice into the same textbox
//                         explaining why the text is redacted, with
//                         link/encouragement to buy the game. This is
//                         the PUBLIC-DEPLOY build (if the site is ever
//                         hosted publicly).
//
// Re-run after `npm run copy-assets` (which re-extracts the pristine
// source PNGs from vmod_extracted/).

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

// Pick mode from CLI flag.
const NOTICE_MODE = process.argv.includes('--notice');

// Notice text used in --notice mode. Kept short so it fits the textbox
// at a readable size; sized to roughly match a 4-line rules card.
const NOTICE_TEXT = 'Text redacted: FFG has an informal policy allowing fan tools if text on key cards is blocked out. Buy the game to reference the actual cards.';

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
  if (!card.image) return false;
  // In notice mode we don't need rulesText; in default mode we do.
  if (!NOTICE_MODE && !card.rulesText) return false;
  const textToBake = NOTICE_MODE ? NOTICE_TEXT : card.rulesText;
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
  // boxH below is the MAX — actual height shrinks to fit the wrapped
  // text so short-text cards don't have empty padding below.
  const boxX = Math.round(img.width * 0.05);
  const boxW = img.width - boxX * 2;
  const boxY = Math.round(img.height * 0.15);
  const boxHMax = Math.round(img.height * 0.24);

  // Pre-measure text. Same font / pad calculation as the draw step.
  const fontSize = Math.max(9, Math.round(img.width * 0.058));
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = 'top';
  const pad = Math.round(img.width * 0.025);
  const lines = wrapText(ctx, textToBake, boxW - pad * 2);
  const lineH = Math.round(fontSize * 1.18);

  // If text would overflow boxHMax, shrink font until it fits (long-text
  // cards like Death Star Plans).
  let actualFontSize = fontSize;
  let actualLines = lines;
  let actualLineH = lineH;
  while (actualLineH * actualLines.length > boxHMax - pad * 2 && actualFontSize > 7) {
    actualFontSize -= 1;
    ctx.font = `${actualFontSize}px sans-serif`;
    actualLines = wrapText(ctx, textToBake, boxW - pad * 2);
    actualLineH = Math.round(actualFontSize * 1.18);
  }

  // Final box height = exactly the text height + padding. Short-text
  // cards get a small box; long-text cards fill boxHMax.
  const boxH = Math.min(boxHMax, actualLineH * actualLines.length + pad * 2);

  // Match the printed card's look: opaque cream/off-white background,
  // thin dark border, black text.
  ctx.fillStyle = 'rgba(245, 240, 225, 0.97)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = 'rgba(60, 50, 30, 0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);

  // Re-set the font + text style for the draw pass (the shrink loop
  // may have left ctx on a smaller size, which is what we want).
  ctx.font = `${actualFontSize}px sans-serif`;
  ctx.fillStyle = '#1a1410';
  ctx.textBaseline = 'top';
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
  console.log(`[composite] mode=${NOTICE_MODE ? 'notice' : 'rules-text'}: ${composited} updated, ${skipped} skipped`);
}

main().catch((err) => {
  console.error('[composite] failed:', err);
  process.exit(1);
});
