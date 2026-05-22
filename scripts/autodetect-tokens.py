"""Auto-detect the 18 circular tokens on the screen-designed token sheet.

Approach (per user hint):
  - Tokens are circular, background is black.
  - All tokens are the same size.
  - Identify lit regions via threshold, find 4 horizontal row bands
    (Empire space/ground + Rebel space/ground), then find N column peaks
    per row. The peak width in the top half of the row gives diameter.

Writes the detected centers/radius into TOKENS in extract-unit-tokens.py.
"""

from pathlib import Path
from PIL import Image
import numpy as np

ROOT = Path(__file__).parent.parent
SRC  = ROOT / 'public' / 'dev-assets' / 'unit-tokens-sheet.png'

ROWS_EXPECTED = [
    ('empire-space',  6, ['tie-fighter','assault-carrier','star-destroyer','super-star-destroyer','death-star','death-star-under-construction']),
    ('empire-ground', 3, ['stormtrooper','at-st','at-at']),
    ('rebel-space',   5, ['x-wing','y-wing','corellian-corvette','rebel-transport','mon-cala-cruiser']),
    ('rebel-ground',  4, ['rebel-trooper','airspeeder','shield-generator','ion-cannon']),
]

THRESH = 25  # luminance > 25 counts as "lit"


def find_runs(mask_1d: np.ndarray, min_len: int = 5):
    """Return [(start, end_inclusive), ...] of lit runs in a 1D bool array."""
    out = []
    n = len(mask_1d)
    i = 0
    while i < n:
        if mask_1d[i]:
            j = i
            while j < n and mask_1d[j]:
                j += 1
            if j - i >= min_len:
                out.append((i, j - 1))
            i = j
        else:
            i += 1
    return out


def main():
    im = Image.open(SRC).convert('RGB')
    arr = np.array(im)
    h, w = arr.shape[:2]
    print(f'Sheet: {w}x{h}')

    # Greyscale + threshold.
    grey = arr.mean(axis=2)
    lit = grey > THRESH

    # Ignore the leftmost column where "SPACE / GROUND / EMPIRE / REBEL ALLIANCE"
    # labels live — they create false-positive column peaks.
    LEFT_MARGIN = 200
    lit_clean = lit.copy()
    lit_clean[:, :LEFT_MARGIN] = False

    # Row projection: for each y, count lit pixels.
    row_density = lit_clean.sum(axis=1)
    # Find row bands (token row + label row each — labels are short, tokens are tall;
    # we want the four bands that contain BOTH).
    row_thresh = row_density.max() * 0.10
    row_runs_full = find_runs(row_density > row_thresh, min_len=20)
    print(f'  found {len(row_runs_full)} lit row bands (expected ~4 broad ones):')
    for r in row_runs_full:
        print(f'    y={r[0]}..{r[1]}  h={r[1]-r[0]+1}')

    # Heuristic: keep the 4 tallest bands (token rows are tall; pure-label rows
    # if any are shorter).
    row_runs_full.sort(key=lambda r: r[1]-r[0], reverse=True)
    rows = sorted(row_runs_full[:4], key=lambda r: r[0])
    print(f'  selected 4 row bands:')
    for r in rows:
        print(f'    y={r[0]}..{r[1]}')

    # Per row: within the TOP 60% of the band (avoid label glyphs at the bottom),
    # do column projection to find token columns.
    detected: list[tuple[str, int, int, int]] = []  # (typeId, cx, cy, r)
    diameters: list[int] = []

    for (label, expected_n, type_ids), (y0, y1) in zip(ROWS_EXPECTED, rows):
        band_h = y1 - y0 + 1
        top_cut = y0 + int(band_h * 0.65)  # everything below this is label text
        sub = lit_clean[y0:top_cut, :]
        col_density = sub.sum(axis=0)
        col_thresh = col_density.max() * 0.30
        col_runs = find_runs(col_density > col_thresh, min_len=20)
        # Merge runs that are very close (sub-token gaps from anti-aliasing).
        merged: list[tuple[int,int]] = []
        for r in col_runs:
            if merged and r[0] - merged[-1][1] < 15:
                merged[-1] = (merged[-1][0], r[1])
            else:
                merged.append(r)
        print(f'  row {label}: expected {expected_n}, found {len(merged)} column runs')
        if len(merged) != expected_n:
            print(f'    !! mismatch — refine THRESH or row split')
            for r in merged: print(f'      x={r[0]}..{r[1]} w={r[1]-r[0]+1}')
        for (x0, x1), tid in zip(merged, type_ids):
            cx = (x0 + x1) // 2
            diam = x1 - x0 + 1
            diameters.append(diam)
            # cy = vertical midpoint of the *circle*, not the band. Use top-cut as bottom of circle.
            cy = (y0 + top_cut) // 2
            detected.append((tid, cx, cy, diam // 2))

    if not diameters:
        print('No tokens detected. Adjust thresholds.')
        return

    # All tokens identical: use median diameter.
    median_d = int(np.median(diameters))
    r = median_d // 2
    print(f'\nMedian diameter: {median_d}  -> radius {r}')

    # Refine cy: for each token, find the vertical extent of lit pixels
    # in the column [cx-r/2 .. cx+r/2] within the band, and set cy = midpoint.
    refined: list[tuple[str, int, int, int]] = []
    for (tid, cx, _cy, _r) in detected:
        # Find the row band this token belongs to (re-look it up)
        # Use the y range from its containing row in `rows`
        # We didn't preserve it — recompute by scanning lit_clean rows around its center.
        col_band = lit_clean[:, max(0, cx - r // 2):cx + r // 2 + 1].sum(axis=1)
        # Find runs in this column band — pick the run nearest the original cy guess
        runs = find_runs(col_band > col_band.max() * 0.25, min_len=20)
        if runs:
            # Pick the run closest to _cy
            best = min(runs, key=lambda rr: abs((rr[0]+rr[1])//2 - _cy))
            # The circle is the upper portion of this run (label below).
            # Heuristic: circle vertical extent = diameter (=median_d). Top is best[0],
            # bottom of circle = best[0] + median_d.
            top = best[0]
            circle_bottom = min(top + median_d, best[1])
            cy = (top + circle_bottom) // 2
        else:
            cy = _cy
        refined.append((tid, cx, cy, r))

    print('\nDetected tokens:')
    for tid, cx, cy, rr in refined:
        print(f'  {tid:34s} ({cx:4d},{cy:4d}) r={rr}')

    # Emit Python dict literal to drop into extract-unit-tokens.py
    print('\n--- paste into extract-unit-tokens.py ---')
    print('TOKENS: dict[str, tuple[int, int, int]] = {')
    for tid, cx, cy, rr in refined:
        pad = ' ' * max(1, 36 - len(tid) - 5)
        print(f"    '{tid}':{pad}({cx}, {cy}, {rr}),")
    print('}')

    # Also write a python file we can import.
    out_path = ROOT / 'scripts' / '_autodetected_tokens.py'
    with open(out_path, 'w') as f:
        f.write('TOKENS = {\n')
        for tid, cx, cy, rr in refined:
            f.write(f"    '{tid}': ({cx}, {cy}, {rr}),\n")
        f.write('}\n')
    print(f'\nAlso wrote {out_path}')


if __name__ == '__main__':
    main()
