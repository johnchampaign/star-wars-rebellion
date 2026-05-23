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

/** Build URL for a unit's image based on current style. */
export function unitImageUrl(typeId: string, base: string, style: UnitImageStyle): string | null {
  if (!UNIT_IMAGE[typeId]) return null;
  if (style === 'silhouette') return `${base}/silhouette/${typeId}.png${UNIT_IMG_BUST}`;
  return `${base}/token/${typeId}.png${UNIT_IMG_BUST}`;
}

export function groupByType<T extends { typeId: string }>(units: T[]): { typeId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const u of units) counts.set(u.typeId, (counts.get(u.typeId) ?? 0) + 1);
  return [...counts.entries()].map(([typeId, count]) => ({ typeId, count }));
}

export function groupTypeIds(typeIds: string[]): { typeId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of typeIds) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([typeId, count]) => ({ typeId, count }));
}
