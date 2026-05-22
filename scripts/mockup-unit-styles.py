"""Generate a side-by-side comparison of unit-rendering styles for the map.

Sample scenario (one sector): 2 Star Destroyers, 3 TIE Fighters,
1 AT-AT, 2 Stormtroopers, 1 Assault Carrier — all Empire.

Outputs: docs/unit-style-mockup.png
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent.parent
OUT = ROOT / 'docs' / 'unit-style-mockup.png'
VMOD_DIR = ROOT / 'public' / 'dev-assets'
SILH_DIR = VMOD_DIR / 'units' / 'silhouette'

# Sample roster: (typeId, label, theater, abbrev, glyph_char, count)
ROSTER = [
    ('star-destroyer',  'Star Destroyer',  'space',  'SD',   '▲', 2),  # ▲
    ('tie-fighter',     'TIE Fighter',     'space',  'TIE',  '◆', 3),  # ◆
    ('assault-carrier', 'Assault Carrier', 'space',  'AC',   '●', 1),  # ●
    ('at-at',           'AT-AT',           'ground', 'AT',   '■', 1),  # ■
    ('stormtrooper',    'Stormtrooper',    'ground', 'ST',   '▪', 2),  # ▪
]

# Color scheme
BG = (12, 13, 16)
SECTOR_BG = (22, 25, 32)
SECTOR_BORDER = (90, 95, 110)
EMPIRE = (200, 70, 70)
EMPIRE_DARK = (110, 30, 30)
TEXT = (230, 230, 235)
SUBTLE = (160, 160, 165)
TITLE = (255, 213, 74)

PANEL_W, PANEL_H = 520, 280
COLS, ROWS = 2, 3
GAP = 20
TOTAL_W = COLS * PANEL_W + (COLS + 1) * GAP
TOTAL_H = ROWS * PANEL_H + (ROWS + 1) * GAP + 60  # +60 for header

img = Image.new('RGB', (TOTAL_W, TOTAL_H), BG)
draw = ImageDraw.Draw(img)

# Fonts — fall back to default if not available
def try_font(name, size):
    try:
        return ImageFont.truetype(name, size)
    except Exception:
        return ImageFont.load_default()

F_TITLE  = try_font('arialbd.ttf', 24)
F_HEADER = try_font('arialbd.ttf', 16)
F_BODY   = try_font('arial.ttf', 13)
F_CHIP   = try_font('arialbd.ttf', 11)
F_CHIP_S = try_font('arialbd.ttf', 9)
F_BIG    = try_font('arialbd.ttf', 18)
F_COUNT  = try_font('arialbd.ttf', 10)

# ---------- Header ----------
draw.text((GAP, 16), 'Unit rendering styles — Empire sector with 9 units across 5 types',
          font=F_TITLE, fill=TITLE)

# ---------- Helpers ----------
def draw_panel(x, y, title, subtitle):
    draw.rectangle([x, y, x + PANEL_W, y + PANEL_H], fill=SECTOR_BG, outline=SECTOR_BORDER, width=2)
    draw.text((x + 12, y + 8), title, font=F_HEADER, fill=TITLE)
    draw.text((x + 12, y + 30), subtitle, font=F_BODY, fill=SUBTLE)

def paste_centered(im, cx, cy, target_size):
    im2 = im.copy()
    im2.thumbnail((target_size, target_size), Image.LANCZOS)
    img.paste(im2, (cx - im2.width // 2, cy - im2.height // 2), im2 if im2.mode == 'RGBA' else None)

def draw_count_badge(cx, cy, count, radius=8):
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(0, 0, 0), outline=(255, 255, 255), width=1)
    bbox = draw.textbbox((0, 0), str(count), font=F_COUNT)
    tw = bbox[2] - bbox[0]; th = bbox[3] - bbox[1]
    draw.text((cx - tw // 2, cy - th // 2 - 1), str(count), font=F_COUNT, fill=(255, 255, 255))

# ---------- Panel 1: vmod photo crops (current) ----------
x = GAP; y = GAP + 50
draw_panel(x, y, '1. vmod photo crops (current)', 'Photo-of-miniature crops, ~32px. Dark, muddy at this size.')
ix0 = x + 24; iy = y + 130
for i, (typeId, _label, _theater, _abbrev, _glyph, count) in enumerate(ROSTER):
    cx = ix0 + i * 90
    src = VMOD_DIR / f'Unit{ {"star-destroyer":"StarDestroyer","tie-fighter":"TIE","assault-carrier":"AssaultCarrier","at-at":"ATAT","stormtrooper":"Stormtrooper"}[typeId] }.png'
    if src.exists():
        im = Image.open(src).convert('RGBA')
        paste_centered(im, cx, iy, 56)
    draw_count_badge(cx + 22, iy + 22, count)
    # type label
    bbox = draw.textbbox((0, 0), _abbrev, font=F_CHIP_S)
    tw = bbox[2] - bbox[0]
    draw.text((cx - tw // 2, iy + 36), _abbrev, font=F_CHIP_S, fill=SUBTLE)

# ---------- Panel 2: silhouette crops (current) ----------
x = GAP * 2 + PANEL_W; y = GAP + 50
draw_panel(x, y, '2. Silhouette crops (current)', 'Line-art from reference sheets. Better than photos, still cramped.')
ix0 = x + 24
for i, (typeId, _label, _theater, _abbrev, _glyph, count) in enumerate(ROSTER):
    cx = ix0 + i * 90
    src = SILH_DIR / f'{typeId}.png'
    if src.exists():
        im = Image.open(src).convert('RGBA')
        paste_centered(im, cx, iy, 56)
    draw_count_badge(cx + 22, iy + 22, count)
    bbox = draw.textbbox((0, 0), _abbrev, font=F_CHIP_S)
    tw = bbox[2] - bbox[0]
    draw.text((cx - tw // 2, iy + 36), _abbrev, font=F_CHIP_S, fill=SUBTLE)

# ---------- Panel 3: NATO chips (recommended) ----------
x = GAP; y = GAP * 2 + PANEL_H + 50
draw_panel(x, y, '3. NATO chips (recommended)', 'Circle = space, square = ground. 2-letter abbrev. Crisp at any size.')
ix0 = x + 36; iy = y + 130
CHIP = 36
for i, (typeId, _label, theater, abbrev, _glyph, count) in enumerate(ROSTER):
    cx = ix0 + i * 90
    half = CHIP // 2
    if theater == 'space':
        draw.ellipse([cx - half, iy - half, cx + half, iy + half], fill=EMPIRE, outline=(255, 255, 255), width=2)
    else:
        draw.rounded_rectangle([cx - half, iy - half, cx + half, iy + half], radius=4, fill=EMPIRE, outline=(255, 255, 255), width=2)
    bbox = draw.textbbox((0, 0), abbrev, font=F_CHIP)
    tw = bbox[2] - bbox[0]; th = bbox[3] - bbox[1]
    draw.text((cx - tw // 2, iy - th // 2 - 1), abbrev, font=F_CHIP, fill=(255, 255, 255))
    draw_count_badge(cx + half - 2, iy + half - 2, count)

# ---------- Panel 4: Class-grouped silhouettes ----------
x = GAP * 2 + PANEL_W; y = GAP * 2 + PANEL_H + 50
draw_panel(x, y, '4. Class-grouped silhouettes', '5 classes share screen-designed glyphs. Fewer assets, better legibility.')
# Simulate class chips: Fighter, Capital, Super, Vehicle, Infantry
CLASSES = [
    ('Fighter', '✈', 'space', 3),   # ✈ — TIE
    ('Capital', '█', 'space', 2),   # █ — Star Destroyer
    ('Transport','◯','space', 1),   # ◯ — Assault Carrier
    ('Vehicle', 'W',     'ground', 1),   # walker
    ('Infantry','i',     'ground', 2),   # infantry
]
ix0 = x + 36; iy = y + 130
for i, (cname, glyph, theater, count) in enumerate(CLASSES):
    cx = ix0 + i * 90
    half = CHIP // 2
    color = EMPIRE if theater == 'space' else EMPIRE_DARK
    draw.rounded_rectangle([cx - half, iy - half, cx + half, iy + half], radius=8, fill=color, outline=(255, 255, 255), width=2)
    bbox = draw.textbbox((0, 0), glyph, font=F_BIG)
    tw = bbox[2] - bbox[0]; th = bbox[3] - bbox[1]
    draw.text((cx - tw // 2, iy - th // 2 - 1), glyph, font=F_BIG, fill=(255, 255, 255))
    draw_count_badge(cx + half - 2, iy + half - 2, count)
    bbox = draw.textbbox((0, 0), cname, font=F_CHIP_S)
    tw = bbox[2] - bbox[0]
    draw.text((cx - tw // 2, iy + half + 6), cname, font=F_CHIP_S, fill=SUBTLE)

# ---------- Panel 5: Bucket aggregate ----------
x = GAP; y = GAP * 3 + PANEL_H * 2 + 50
draw_panel(x, y, '5. Bucket aggregate (most compact)', 'One chip per theater. Big number = total power. Drill-down in hover.')
cx1, cy1 = x + 160, y + 150
cx2, cy2 = x + 360, y + 150
BIG = 64
# Space chip
draw.ellipse([cx1 - BIG, cy1 - BIG, cx1 + BIG, cy1 + BIG], fill=EMPIRE, outline=(255, 255, 255), width=3)
draw.text((cx1 - 36, cy1 - 28), 'SPACE', font=F_HEADER, fill=(255, 255, 255))
big_count = '6'
bbox = draw.textbbox((0, 0), big_count, font=try_font('arialbd.ttf', 48))
tw = bbox[2] - bbox[0]; th = bbox[3] - bbox[1]
draw.text((cx1 - tw // 2, cy1 - th // 2 + 6), big_count, font=try_font('arialbd.ttf', 48), fill=(255, 255, 255))
# Ground chip (rounded square)
draw.rounded_rectangle([cx2 - BIG, cy2 - BIG, cx2 + BIG, cy2 + BIG], radius=12, fill=EMPIRE_DARK, outline=(255, 255, 255), width=3)
draw.text((cx2 - 42, cy2 - 28), 'GROUND', font=F_HEADER, fill=(255, 255, 255))
big_count = '3'
bbox = draw.textbbox((0, 0), big_count, font=try_font('arialbd.ttf', 48))
tw = bbox[2] - bbox[0]
draw.text((cx2 - tw // 2, cy2 - th // 2 + 6), big_count, font=try_font('arialbd.ttf', 48), fill=(255, 255, 255))

# ---------- Panel 6: Hybrid (chip + hover) ----------
x = GAP * 2 + PANEL_W; y = GAP * 3 + PANEL_H * 2 + 50
draw_panel(x, y, '6. Hybrid — chips on map, photos in hover', 'Map stays clean. Hover shows the rich art at full size.')
# Left half: chip view
ix0 = x + 36; iy = y + 110
for i, (typeId, _label, theater, abbrev, _glyph, count) in enumerate(ROSTER):
    cx = ix0 + i * 50
    half = 14
    if theater == 'space':
        draw.ellipse([cx - half, iy - half, cx + half, iy + half], fill=EMPIRE, outline=(255, 255, 255), width=1)
    else:
        draw.rounded_rectangle([cx - half, iy - half, cx + half, iy + half], radius=3, fill=EMPIRE, outline=(255, 255, 255), width=1)
    bbox = draw.textbbox((0, 0), abbrev, font=F_CHIP_S)
    tw = bbox[2] - bbox[0]; th = bbox[3] - bbox[1]
    draw.text((cx - tw // 2, iy - th // 2 - 1), abbrev, font=F_CHIP_S, fill=(255, 255, 255))
    draw_count_badge(cx + half - 2, iy + half - 2, count, radius=6)
draw.text((x + 36, iy + 26), 'map view (compact)', font=F_BODY, fill=SUBTLE)

# Arrow
ax = x + 36 + 5 * 50 + 10
draw.line([(ax, iy), (ax + 30, iy)], fill=TITLE, width=2)
draw.polygon([(ax + 30, iy - 6), (ax + 40, iy), (ax + 30, iy + 6)], fill=TITLE)

# Right half: hover preview with photo silhouettes at proper size
hx0 = ax + 60; hy = iy
for i, (typeId, _, _, _, _, count) in enumerate(ROSTER[:3]):
    cx = hx0 + i * 60
    src = SILH_DIR / f'{typeId}.png'
    if src.exists():
        im = Image.open(src).convert('RGBA')
        paste_centered(im, cx, hy, 50)
    draw_count_badge(cx + 18, hy + 18, count)
draw.text((hx0, hy + 36), 'hover (rich)', font=F_BODY, fill=SUBTLE)

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT)
print(f'Wrote {OUT} ({img.width}x{img.height})')
