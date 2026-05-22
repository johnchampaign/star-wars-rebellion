# Derived Assets

Every image served from `public/dev-assets/` originates in the FFG Vassal
module (`Star Wars Rebellion_v1.02d.vmod`). End-user deployments fetch the
.vmod from vassalengine.org, unpack it in-browser, and must reproduce every
derived image with **pixel-perfect precision** to match what this repo ships.

This document is the authoritative reference for every transformation. If an
image appears on screen and isn't documented here, that's a bug.

The .vmod itself is a zip archive. Image filenames below refer to files
inside the archive's `images/` directory (i.e. `vmod_extracted/images/<name>`
when extracted locally).

---

## 1. Direct-copy assets (no transformation)

These files are byte-identical to their sources inside the .vmod. End-user
deployments copy them straight out of the archive.

| Output path (under `public/dev-assets/`) | Source (under `images/`) | Count |
|---|---|---|
| `Map.png` | `Map.png` | 1 |
| `leaders/<File>.png` | `Leader{Empire,Rebel}*.png` | 25 |
| `cards/<File>.png` | `ActionCard*.png`, `Mission*.png`, `Objective*.png`, `Tactic*.png` (minus card-back variants) | ~121 |
| `markers/MarkerLoyaltyRebel.png` | `MarkerLoyaltyRebel.png` | 1 |
| `markers/MarkerLoyaltyEmpire.png` | `MarkerLoyaltyEmpire.png` | 1 |
| `markers/MarkerLoyaltySubjugated.png` | `MarkerLoyaltySubjugated.png` | 1 |
| `markers/MarkerLoyaltyNeutral.png` | `MarkerLoyaltyNeutral.png` | 1 |
| `units/Unit*.png` | `Unit*.png` (18 base-game units, see list below) | 18 |
| `dice/Dice*.png` | `Dice{Black,Red,Green}{Blank,Hit,Direct,Special}.png` | 10 (Green missing Hit + Special — RoE only) |

Reproducer: `scripts/copy-dev-assets.mjs` (and `scripts/extract-leaders.mjs`
for the per-leader image copy step). Both expect `vmod_extracted/` to
already exist.

### Unit image filename list (direct copies)

```
UnitTIE.png             UnitXWing.png              UnitStormtrooper.png
UnitAssaultCarrier.png  UnitYWing.png              UnitATST.png
UnitStarDestroyer.png   UnitCorellianCorvette.png  UnitATAT.png
UnitSuperStarDestroyer  UnitRebelTransport.png     UnitAirspeeder.png
UnitDeathStar.png       UnitMonCalamari.png        UnitShieldGenerator.png
UnitDeathStarUC.png     UnitRebelTrooper.png       UnitIonCannon.png
```

---

## 2. Derived assets (transformation required)

These files are produced by cropping, scaling, or otherwise transforming
.vmod images. The transformations are deterministic — same input bytes
produce identical output bytes via PIL/Pillow's `Image.crop` and
`Image.resize` with `Image.LANCZOS`.

### 2.1 Mission skill icons

Four skill-type icons cropped from canonical-example mission cards.

| Output | Source | Crop bbox | Resize |
|---|---|---|---|
| `icons/skill-diplomacy.png`  | `MissionRebelBuildAlliance.png` | `(32, 2, 72, 38)` | LANCZOS ×3 |
| `icons/skill-intel.png`      | `MissionEmpireGatherIntel.png`  | `(32, 2, 72, 38)` | LANCZOS ×3 |
| `icons/skill-spec-ops.png`   | `MissionRebelSabotage.png`      | `(32, 2, 72, 38)` | LANCZOS ×3 |
| `icons/skill-logistics.png`  | `MissionRebelHiddenFleet.png`   | `(32, 2, 72, 38)` | LANCZOS ×3 |

Output dimensions after resize: 120×108.

Source dimensions: 180×270 (every mission card image in the .vmod uses this).

Reproducer: `scripts/extract-skill-icons.py`.

Why these source cards: every mission card prints the same canonical icon
art for its required skill. Any mission with the right skill would do; we
arbitrarily pick one per skill type.

### 2.2 Unit silhouettes (alternative icon style)

Line-art unit icons cropped from the printed faction reference sheets.
Used when the play-tab "units" toggle is set to `silhouette` (the default
is `vmod` — the photo-of-miniature crops).

Source files: `ReferenceEmpire2P.png` (1600×990) and `ReferenceRebel2P.png` (1600×965).

| Output (under `units/silhouette/`) | Source sheet | Crop bbox |
|---|---|---|
| `tie-fighter.png` | Empire | `(479, 97, 543, 167)` |
| `stormtrooper.png` | Empire | `(574, 97, 642, 167)` |
| `assault-carrier.png` | Empire | `(479, 249, 543, 317)` |
| `at-st.png` | Empire | `(574, 249, 638, 317)` |
| `star-destroyer.png` | Empire | `(479, 325, 543, 393)` |
| `at-at.png` | Empire | `(574, 446, 638, 510)` |
| `super-star-destroyer.png` | Empire | `(474, 517, 543, 581)` |
| `death-star.png` | Empire | `(474, 593, 543, 662)` |
| `death-star-under-construction.png` | Empire | `(795, 593, 865, 662)` |
| `x-wing.png` | Rebel | `(481, 99, 543, 165)` |
| `rebel-trooper.png` | Rebel | `(574, 101, 643, 170)` |
| `y-wing.png` | Rebel | `(481, 177, 543, 245)` |
| `airspeeder.png` | Rebel | `(574, 251, 643, 321)` |
| `rebel-transport.png` | Rebel | `(479, 327, 545, 397)` |
| `corellian-corvette.png` | Rebel | `(481, 403, 543, 473)` |
| `shield-generator.png` | Rebel | `(569, 403, 643, 479)` |
| `ion-cannon.png` | Rebel | `(569, 519, 638, 585)` |
| `mon-cala-cruiser.png` | Rebel | `(479, 555, 543, 625)` |

No resize step.

Reproducer: `scripts/extract-unit-silhouettes.py`.

**Update (2026-05-21):** All Empire and Rebel bboxes recorrected via the
silhouette dev tab.

### 2.3 Unit tokens (default style)

Circular screen-designed unit portraits — the default `units` style on the
play tab. Cropped as circular alpha-masked PNGs from a single screen-designed
reference sheet (not part of the .vmod).

Source: `public/dev-assets/unit-tokens-sheet.png` (1536×1024). This sheet
is NOT in the .vmod — it's a separate authored asset shipped with the repo.

Per-token crop = circular hole-punch at `(cx, cy)` with radius `r`. See the
`TOKENS` dict in `scripts/extract-unit-tokens.py` for all 18 entries. Coords
were auto-detected with `scripts/autodetect-tokens.py` then refined via the
`tokens` dev tab.

Reproducer: `scripts/extract-unit-tokens.py`. Output:
`public/dev-assets/units/token/<typeId>.png`.

---

## 3. Reproducing all derived assets

After `vmod_extracted/` exists (either via `unzip` of the .vmod or via
in-browser JSZip), run:

```bash
node   scripts/copy-dev-assets.mjs        # direct copies + Map + markers + units
node   scripts/extract-leaders.mjs        # per-leader portraits (also direct copies)
python scripts/extract-skill-icons.py     # the 4 skill icons
python scripts/extract-unit-silhouettes.py # the 18 silhouettes
python scripts/extract-unit-tokens.py     # the 18 default circular tokens
```

For end-user browser deployments, equivalent JavaScript implementations using
the Canvas API will replace the Python scripts. The bounding boxes and
resize factors above are the canonical truth; the algorithm is identical
(crop a sub-rectangle, optionally LANCZOS resize).

---

## 4. Schema / change log

This document is normative. Any time someone:

1. Adds a new derived image,
2. Changes a crop bbox or resize factor,
3. Adds or removes a direct-copy file,

…they must update this file in the same commit. CI does not currently
enforce this; commit reviewers do.

| Date | Change |
|---|---|
| 2026-05-20 | Initial document covering all derived assets through this date. |
| 2026-05-21 | Empire silhouette bboxes corrected via the silhouette dev tab. |
| 2026-05-21 | Added circular unit tokens (new default style) — source sheet `unit-tokens-sheet.png` plus `extract-unit-tokens.py`. |
| 2026-05-22 | Added 10 dice-face PNGs (direct copies from .vmod). Green missing Hit + Special (RoE only). |
