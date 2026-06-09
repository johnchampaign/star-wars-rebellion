"""Crop the 8 Rise of the Empire unit tokens from the RotE reference sheet.

Source: public/dev-assets/unit-tokens-sheet-rote.png (900x600 — the BGG
        preview; swap in a higher-res original and re-run for crisper art).
Output: public/dev-assets/units/{token,silhouette}/<typeId>.png — circular
        alpha-masked PNGs, matching scripts/extract-unit-tokens.py (base game).

If a crop is off, refine its (cx, cy, r) below and re-run.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent.parent
SRC = ROOT / 'public' / 'dev-assets' / 'unit-tokens-sheet-rote.png'
TOKEN_DIR = ROOT / 'public' / 'dev-assets' / 'units' / 'token'
SIL_DIR = ROOT / 'public' / 'dev-assets' / 'units' / 'silhouette'
TOKEN_DIR.mkdir(parents=True, exist_ok=True)
SIL_DIR.mkdir(parents=True, exist_ok=True)

OUT = 200
# (cx, cy, r) in the 900x600 sheet. Empire row then Rebel row.
TOKENS = {
    # Hand-marked via the "tokens (RoE)" dev tab and exported 2026-06-09.
    'tie-striker':       (138, 163, 80),
    'assault-tank':      (334, 164, 80),
    'shield-bunker':     (531, 163, 80),
    'interdictor':       (737, 163, 80),
    'u-wing':            (128, 449, 80),
    'nebulon-b-frigate': (331, 449, 80),
    'rebel-vanguard':    (541, 449, 80),
    'golan-arms-turret': (754, 445, 80),
}

src = Image.open(SRC).convert('RGBA')
mask = Image.new('L', (OUT, OUT), 0)
ImageDraw.Draw(mask).ellipse([2, 2, OUT - 2, OUT - 2], fill=255)

for name, (cx, cy, r) in TOKENS.items():
    tok = src.crop((cx - r, cy - r, cx + r, cy + r)).resize((OUT, OUT), Image.LANCZOS)
    tok.putalpha(mask)
    tok.save(TOKEN_DIR / f'{name}.png')
    # Silhouette parity (dev-only style): reuse the token crop as a stand-in
    # until dedicated line-art silhouettes exist for the RotE units.
    tok.save(SIL_DIR / f'{name}.png')
    print('wrote', name)
print(f'done — {len(TOKENS)} RotE tokens')
