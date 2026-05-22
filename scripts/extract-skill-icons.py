"""Crop the 4 mission-skill icons from .vmod mission card images.

Output: public/dev-assets/icons/skill-{diplomacy,intel,spec-ops,logistics}.png

Each mission card has its required-skill icon in the top-left area, below the
yellow cost shield. Source images are 180 x 270 px. We crop a small region
containing just the colored circular skill icon, then scale up 3× for crisp
display in the leaders dev tab.

The transformation is deterministic and identical regardless of which mission
card we pick for each skill — they all use the same canonical icon art.

Pixel-perfect reproduction:
  skill-diplomacy.png  = ReferenceMissionRebelBuildAlliance.png  crop (32, 2, 72, 38) scaled 3×
  skill-intel.png      = ReferenceMissionEmpireGatherIntel.png  crop (32, 2, 72, 38) scaled 3×
  skill-spec-ops.png   = ReferenceMissionRebelSabotage.png      crop (32, 2, 72, 38) scaled 3×
  skill-logistics.png  = ReferenceMissionRebelHiddenFleet.png   crop (32, 2, 72, 38) scaled 3×
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).parent.parent
IMG_SRC = ROOT / 'vmod_extracted' / 'images'
OUT_DIR = ROOT / 'public' / 'dev-assets' / 'icons'
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Each skill: (output filename, source mission card, crop bbox, upscale factor)
SOURCES = {
    'skill-diplomacy.png':  ('MissionRebelBuildAlliance.png', (32, 2, 72, 38), 3),
    'skill-intel.png':      ('MissionEmpireGatherIntel.png',  (32, 2, 72, 38), 3),
    'skill-spec-ops.png':   ('MissionRebelSabotage.png',      (32, 2, 72, 38), 3),
    'skill-logistics.png':  ('MissionRebelHiddenFleet.png',   (32, 2, 72, 38), 3),
}

for out_name, (src_name, bbox, scale) in SOURCES.items():
    src = IMG_SRC / src_name
    if not src.exists():
        print(f'  skip {out_name}: source {src_name} not found')
        continue
    im = Image.open(src)
    crop = im.crop(bbox)
    crop = crop.resize((crop.size[0] * scale, crop.size[1] * scale), Image.LANCZOS)
    out = OUT_DIR / out_name
    crop.save(out)
    print(f'  {out_name}: {src_name} {bbox} ×{scale} -> {crop.size}')

print(f'\nWrote {len(SOURCES)} skill icons to {OUT_DIR}')
