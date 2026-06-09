// Map engine UnitTypeId → filename for the unit's miniature image.
// Two visual styles:
//   - 'token':      circular screen-designed portraits (default — best legibility at map scale)
//   - 'silhouette': line-art icons cropped from the printed faction reference sheets
// Style is selected at runtime via the play tab toggle (stored in localStorage).
// (A 'vmod' photo-of-miniature style existed earlier; removed once the
// token style superseded it.)

export type UnitImageStyle = 'token' | 'silhouette';
const STYLE_ORDER: UnitImageStyle[] = ['token', 'silhouette'];
export function nextStyle(s: UnitImageStyle): UnitImageStyle {
  return STYLE_ORDER[(STYLE_ORDER.indexOf(s) + 1) % STYLE_ORDER.length];
}

export const UNIT_IMAGE: Record<string, string> = {
  // Imperial
  'tie-fighter':                    'UnitTIE.png',
  'assault-carrier':                'UnitAssaultCarrier.png',
  'star-destroyer':                 'UnitStarDestroyer.png',
  'super-star-destroyer':           'UnitSuperStarDestroyer.png',
  'death-star':                     'UnitDeathStar.png',
  'death-star-under-construction':  'UnitDeathStarUC.png',
  'stormtrooper':                   'UnitStormtrooper.png',
  'at-st':                          'UnitATST.png',
  'at-at':                          'UnitATAT.png',
  // Imperial — Rise of the Empire
  'tie-striker':                    'UnitTIEStriker.png',
  'assault-tank':                   'UnitAssaultTank.png',
  'shield-bunker':                  'UnitShieldBunker.png',
  'interdictor':                    'UnitInterdictor.png',
  // Rebel
  'x-wing':                         'UnitXWing.png',
  'y-wing':                         'UnitYWing.png',
  'corellian-corvette':             'UnitCorellianCorvette.png',
  'rebel-transport':                'UnitRebelTransport.png',
  'mon-cala-cruiser':               'UnitMonCalamari.png',
  'rebel-trooper':                  'UnitRebelTrooper.png',
  'airspeeder':                     'UnitAirspeeder.png',
  'shield-generator':               'UnitShieldGenerator.png',
  'ion-cannon':                     'UnitIonCannon.png',
  // Rebel — Rise of the Empire
  'u-wing':                         'UnitUWing.png',
  'nebulon-b-frigate':              'UnitNebulonBFrigate.png',
  'rebel-vanguard':                 'UnitRebelVanguard.png',
  'golan-arms-turret':              'UnitGolanArmsTurret.png',
};

const STYLE_KEY = 'rebellion-unit-image-style';

export function getUnitStyle(): UnitImageStyle {
  const stored = localStorage.getItem(STYLE_KEY);
  if (stored === 'silhouette' || stored === 'token') return stored;
  return 'token'; // default
}

export function setUnitStyle(style: UnitImageStyle): void {
  if (style === 'token') localStorage.removeItem(STYLE_KEY);
  else localStorage.setItem(STYLE_KEY, style);
}

// Per-module cache-bust suffix appended to unit image URLs in prod builds.
// Forces Cloudflare's edge cache to fetch fresh PNGs instead of serving
// stale FFG art from older deployments.
const UNIT_IMG_BUST = import.meta.env.PROD ? `?v=${Date.now()}` : '';

/** Build URL for a unit's image based on current style. Priority:
 *    1. 'token' style → author-original art shipped from /dev-assets/
 *       units/token/*.png (whitelisted past the strip-images step).
 *    2. 'silhouette' style → /dev-assets/units/silhouette/*.png
 *       (author-derived from reference sheets; ships in local dev only).
 *    3. .vmod cache (vmod-derived Unit*.png from the player's uploaded
 *       module) — used when neither author-original style has loaded.
 *
 *  Token wins over the .vmod cache because the token sheet is the
 *  player's preferred display style (sized, alpha-masked, color-matched
 *  to system tiles) and ships from our CDN with zero player setup. */
export function unitImageUrl(typeId: string, base: string, style: UnitImageStyle): string | null {
  if (!UNIT_IMAGE[typeId]) return null;
  if (style === 'silhouette') return `${base}/silhouette/${typeId}.png${UNIT_IMG_BUST}`;
  if (style === 'token') return `${base}/token/${typeId}.png${UNIT_IMG_BUST}`;
  // Fallback (style added in the future, or unrecognized): try .vmod cache.
  // Import is lazy to avoid a circular boot dependency; the cache module
  // is React-aware and the URL builder is not.
  const cache = (globalThis as { __rebellionArtCache?: { getSync: (f: string) => string | null | undefined } }).__rebellionArtCache;
  if (cache) {
    const blobUrl = cache.getSync(UNIT_IMAGE[typeId]);
    if (typeof blobUrl === 'string') return blobUrl;
  }
  return `${base}/token/${typeId}.png${UNIT_IMG_BUST}`;
}

export function groupByType<T extends { typeId: string; side?: string }>(
  units: T[],
): { typeId: string; count: number; side?: string }[] {
  // Capture the owning side per type (a unit type only ever belongs to one
  // faction) so the map can color rebel vs empire stacks distinctly.
  const counts = new Map<string, { count: number; side?: string }>();
  for (const u of units) {
    const e = counts.get(u.typeId) ?? { count: 0, side: u.side };
    e.count += 1;
    counts.set(u.typeId, e);
  }
  return [...counts.entries()].map(([typeId, e]) => ({ typeId, count: e.count, side: e.side }));
}

export function groupTypeIds(typeIds: string[]): { typeId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of typeIds) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([typeId, count]) => ({ typeId, count }));
}
