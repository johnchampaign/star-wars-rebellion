"""Crop unit silhouette icons from the faction reference sheets.

Output: public/dev-assets/units/silhouette/<typeId>.png — clean line-art icons
for use as an alternative to the .vmod miniature photos.

Coordinates hand-picked from visual analysis of the reference sheets. If a
silhouette comes out wrong, adjust its box here and rerun.
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).parent.parent
OUT_DIR = ROOT / 'public' / 'dev-assets' / 'units' / 'silhouette'
OUT_DIR.mkdir(parents=True, exist_ok=True)

# (left, top, right, bottom) in NATIVE pixels of the reference sheet.
# Empire reference is 1600x990. Title bar y=0-75; rows ~80px tall after.
EMPIRE_CROPS: dict[str, tuple[int, int, int, int]] = {
    # User-corrected via the silhouette dev tab on 2026-05-21.
    'tie-fighter':                  (479,  97, 543, 167),
    'stormtrooper':                 (574,  97, 642, 167),
    'assault-carrier':              (479, 249, 543, 317),
    'at-st':                        (574, 249, 638, 317),
    'star-destroyer':               (479, 325, 543, 393),
    'at-at':                        (574, 446, 638, 510),
    'super-star-destroyer':         (474, 517, 543, 581),
    'death-star':                   (474, 593, 543, 662),
    'death-star-under-construction':(795, 593, 865, 662),
}

# Rebel reference is 1600x965. Title bar similar; rows ~100px tall.
REBEL_CROPS: dict[str, tuple[int, int, int, int]] = {
    # User-corrected via the silhouette dev tab on 2026-05-21.
    'x-wing':              (481,  99, 543, 165),
    'rebel-trooper':       (574, 101, 643, 170),
    'y-wing':              (481, 177, 543, 245),
    'airspeeder':          (574, 251, 643, 321),
    'rebel-transport':     (479, 327, 545, 397),
    'corellian-corvette':  (481, 403, 543, 473),
    'shield-generator':    (569, 403, 643, 479),
    'ion-cannon':          (569, 519, 638, 585),
    'mon-cala-cruiser':    (479, 555, 543, 625),
}

def crop_and_save(src_path: Path, mapping: dict[str, tuple[int, int, int, int]], side: str):
    im = Image.open(src_path)
    print(f'{side}: cropping {len(mapping)} silhouettes from {src_path.name} ({im.size})')
    for type_id, box in mapping.items():
        crop = im.crop(box)
        out_path = OUT_DIR / f'{type_id}.png'
        crop.save(out_path)
        print(f'  {type_id:32s} {box} -> {crop.size}')

crop_and_save(ROOT / 'vmod_extracted' / 'images' / 'ReferenceEmpire2P.png', EMPIRE_CROPS, 'Empire')
crop_and_save(ROOT / 'vmod_extracted' / 'images' / 'ReferenceRebel2P.png',  REBEL_CROPS,  'Rebel')

print(f'\nWrote {len(EMPIRE_CROPS) + len(REBEL_CROPS)} silhouettes to {OUT_DIR}')
