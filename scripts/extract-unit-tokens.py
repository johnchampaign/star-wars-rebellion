"""Crop 18 circular unit tokens from the screen-designed reference sheet.

Source: public/dev-assets/unit-tokens-sheet.png (1536x1024).
Output: public/dev-assets/units/token/<typeId>.png — 200x200 PNGs with the
circle alpha-masked against a transparent background.

If a crop is off, refine its (cx, cy, r) here OR via the dev "tokens" tab,
then re-run.
"""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent.parent
SRC = ROOT / 'public' / 'dev-assets' / 'unit-tokens-sheet.png'
OUT_DIR = ROOT / 'public' / 'dev-assets' / 'units' / 'token'
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Token layout — autodetected via scripts/autodetect-tokens.py.
# Identical radius across all tokens (per design).
TOKENS: dict[str, tuple[int, int, int]] = {
    'tie-fighter':                    (289, 194, 88),
    'assault-carrier':                (492, 194, 88),
    'star-destroyer':                 (706, 194, 88),
    'super-star-destroyer':           (928, 194, 88),
    'death-star':                     (1146, 194, 88),
    'death-star-under-construction':  (1369, 194, 88),
    'stormtrooper':                   (289, 417, 84),
    'at-st':                          (503, 417, 88),
    'at-at':                          (706, 417, 88),
    'x-wing':                         (289, 698, 84),
    'y-wing':                         (529, 698, 88),
    'corellian-corvette':             (771, 698, 88),
    'rebel-transport':                (1038, 698, 88),
    'mon-cala-cruiser':               (1320, 698, 88),
    'rebel-trooper':                  (289, 906, 84),
    'airspeeder':                     (531, 906, 88),
    'shield-generator':               (771, 906, 88),
    'ion-cannon':                     (1000, 906, 88),
}


def crop_circle(src: Image.Image, cx: int, cy: int, r: int) -> Image.Image:
    bbox = (cx - r, cy - r, cx + r, cy + r)
    crop = src.crop(bbox).convert('RGBA')
    mask = Image.new('L', crop.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, crop.size[0] - 1, crop.size[1] - 1), fill=255)
    out = Image.new('RGBA', crop.size, (0, 0, 0, 0))
    out.paste(crop, (0, 0), mask)
    return out


def main():
    src = Image.open(SRC).convert('RGB')
    print(f'Source: {SRC.name} {src.size}')
    for tid, (cx, cy, r) in TOKENS.items():
        out = crop_circle(src, cx, cy, r)
        path = OUT_DIR / f'{tid}.png'
        out.save(path)
        print(f'  {tid:32s} ({cx},{cy}) r={r} -> {out.size}')
    print(f'\nWrote {len(TOKENS)} tokens to {OUT_DIR}')


if __name__ == '__main__':
    main()
