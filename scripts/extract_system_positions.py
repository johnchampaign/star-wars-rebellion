"""Extract system pixel positions from the .vmod buildFile and generate
per-system map crops for adjacency tracing.

Outputs:
  scripts/system_positions.json  — {systemId: {x, y}} with average of SpaceEmpire / SpaceRebellion coords
  map_tiles/sys_<system>.png     — 700x500 crop centered on each system, for visual edge tracing
"""

import json
import re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent.parent
BUILDFILE = ROOT / "vmod_extracted" / "buildFile"
MAP = ROOT / "vmod_extracted" / "images" / "Map.png"
OUT_JSON = ROOT / "scripts" / "system_positions.json"
OUT_DIR = ROOT / "map_tiles"
OUT_DIR.mkdir(exist_ok=True)

text = BUILDFILE.read_text(encoding="utf-8")
# match: Region name="SpaceEmpireFoo" originx="123" originy="456"
pat = re.compile(r'Region name="Space(Empire|Rebellion)([A-Z][A-Za-z]+)" originx="(\d+)" originy="(\d+)"')

acc: dict[str, list[tuple[int, int]]] = {}
for m in pat.finditer(text):
    _, name, x, y = m.groups()
    if name == "RebelBase":
        continue
    acc.setdefault(name, []).append((int(x), int(y)))

positions: dict[str, dict[str, int]] = {}
for name, pts in acc.items():
    xs = sum(p[0] for p in pts) / len(pts)
    ys = sum(p[1] for p in pts) / len(pts)
    positions[name] = {"x": round(xs), "y": round(ys)}

# Camel → kebab
def kebab(n: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "-", n).lower()

positions_kebab = {kebab(k): v for k, v in positions.items()}
OUT_JSON.write_text(json.dumps(positions_kebab, indent=2, sort_keys=True))
print(f"wrote {OUT_JSON} with {len(positions_kebab)} systems")

# Crop per system: 800w x 600h centered, with name label burned in
im = Image.open(MAP)
W, H = im.size
CW, CH = 800, 600
font = ImageFont.load_default()
for k, v in positions_kebab.items():
    x, y = v["x"], v["y"]
    x0 = max(0, x - CW // 2)
    y0 = max(0, y - CH // 2)
    x1 = min(W, x0 + CW)
    y1 = min(H, y0 + CH)
    crop = im.crop((x0, y0, x1, y1)).copy()
    d = ImageDraw.Draw(crop)
    # crosshair on the target system
    cx, cy = x - x0, y - y0
    d.line([(cx - 30, cy), (cx + 30, cy)], fill="yellow", width=3)
    d.line([(cx, cy - 30), (cx, cy + 30)], fill="yellow", width=3)
    d.text((10, 10), f"{k}  ({x},{y})", fill="yellow", font=font)
    crop.save(OUT_DIR / f"sys_{k}.png")

print(f"wrote {len(positions_kebab)} per-system crops to {OUT_DIR}")
