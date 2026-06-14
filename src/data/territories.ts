// Territory boundary polygons traced from the printed board (Redux v1.2e).
// Coordinates are image-native pixels (matching `image.width` x `image.height`,
// i.e. 3180x1590). Each region's `exterior` is a closed polygon — the first
// point implicitly connects to the last.
//
// Two consumers:
//   - the no-art vector fallback in PlayTab (renders these as the board's
//     territory cells when no map image is available), and
//   - the dev "territories" tab (overlays them on the map image for editing).
//
// The dev tab persists in-progress edits to localStorage under LS_TERRITORIES
// so the fallback reflects them live without re-exporting the JSON.

import territoriesJson from './territories.json';

export type TerritoryRegion = {
  id: number;
  name?: string;
  /** A barrier is an impassable border region, NOT a selectable territory:
   *  it owns no system and is rendered as an impassable line, not a cell. */
  barrier?: boolean;
  area_px: number;
  centroid: [number, number];
  exterior: [number, number][];
};

export type TerritoriesFile = {
  _meta?: { schema: string; provenance: string; source: string; notes: string[] };
  image: { width: number; height: number };
  count: number;
  regions: TerritoryRegion[];
};

export const TERRITORIES = territoriesJson as unknown as TerritoriesFile;

export const LS_TERRITORIES = 'rebellion-dev-territories-edits';

/** Deep-ish clone of the base regions so callers can mutate freely. */
export function cloneRegions(regions: TerritoryRegion[]): TerritoryRegion[] {
  return regions.map((r) => ({
    ...r,
    centroid: [r.centroid[0], r.centroid[1]] as [number, number],
    exterior: r.exterior.map((p) => [p[0], p[1]] as [number, number]),
  })); // spread preserves any optional `name`

}

/** Local dev edits, if any (the dev tab's working copy). */
export function loadTerritoryEdits(): TerritoryRegion[] | null {
  try {
    const s = localStorage.getItem(LS_TERRITORIES);
    if (!s) return null;
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return null;
    return parsed as TerritoryRegion[];
  } catch {
    return null;
  }
}

/** Persist edits, or clear them when they match the canonical base. */
export function saveTerritoryEdits(regions: TerritoryRegion[], base: TerritoryRegion[]): void {
  if (JSON.stringify(regions) === JSON.stringify(base)) {
    localStorage.removeItem(LS_TERRITORIES);
  } else {
    localStorage.setItem(LS_TERRITORIES, JSON.stringify(regions));
  }
}

/** Regions to render: local edits if present, else the canonical traced base. */
export function effectiveRegions(): TerritoryRegion[] {
  return loadTerritoryEdits() ?? cloneRegions(TERRITORIES.regions);
}

/** Signed-area centroid of a polygon (image-native coords). */
export function polygonCentroid(pts: [number, number][]): [number, number] {
  if (pts.length === 0) return [0, 0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-6) {
    // Degenerate / collinear — fall back to vertex average.
    const sx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const sy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return [Math.round(sx * 10) / 10, Math.round(sy * 10) / 10];
  }
  a *= 0.5;
  return [Math.round((cx / (6 * a)) * 10) / 10, Math.round((cy / (6 * a)) * 10) / 10];
}

/** Absolute polygon area in px^2 (image-native coords). */
export function polygonArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.round(Math.abs(a) / 2);
}

/** A muted per-territory fill, stable by id. */
export const TERRITORY_FILL = [
  '#3a4a63', '#5a4a63', '#3a5a52', '#63523a', '#4a3a63', '#3a6352', '#634a4a',
  '#52633a', '#3a4a4a', '#4a5a3a', '#633a52', '#3a6363', '#5a3a3a', '#3a4a52',
];
export function territoryFill(id: number): string {
  return TERRITORY_FILL[((id % TERRITORY_FILL.length) + TERRITORY_FILL.length) % TERRITORY_FILL.length];
}
