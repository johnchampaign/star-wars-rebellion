import type {
  SystemsFile, AdjacencyFile, LeadersFile,
  ActionsFile, MissionsFile, ObjectivesFile, TacticsFile, ProbesFile,
  BoardMaskFile,
} from '../types';

const BASE = '/dev-assets';
// Build-time-injected cache-bust. Vite's import.meta.env doesn't have a
// natural build id, so we append the build's timestamp via Date.now() at
// module load. Same per page-load, different per deploy because the bundle
// re-evaluates. Avoids the "iPad Safari shows stale objectives.json" issue
// even when HTTP cache headers don't propagate quickly.
const BUST = import.meta.env.PROD ? `?v=${Date.now()}` : '';

export async function loadSystems(): Promise<SystemsFile> {
  const res = await fetch(`${BASE}/systems.json${BUST}`);
  if (!res.ok) throw new Error(`Failed to load systems.json: ${res.status}`);
  return res.json();
}

export async function loadAdjacency(): Promise<AdjacencyFile> {
  const res = await fetch(`${BASE}/adjacency.json${BUST}`);
  if (!res.ok) throw new Error(`Failed to load adjacency.json: ${res.status}`);
  return res.json();
}

export async function loadLeaders(): Promise<LeadersFile> {
  const res = await fetch(`${BASE}/leaders.json${BUST}`);
  if (!res.ok) throw new Error(`Failed to load leaders.json: ${res.status}`);
  return res.json();
}

async function loadJson<T>(file: string): Promise<T> {
  const res = await fetch(`${BASE}/${file}${BUST}`);
  if (!res.ok) throw new Error(`Failed to load ${file}: ${res.status}`);
  return res.json();
}

export const loadBoardMask  = () => loadJson<BoardMaskFile>('board-mask.json').catch(() => ({
  _meta: { schema: 'board-mask-v1', provenance: 'fallback', source: '', notes: [] },
  masks: [],
} as BoardMaskFile));
export const loadActions    = () => loadJson<ActionsFile>('actions.json');
export const loadMissions   = () => loadJson<MissionsFile>('missions.json');
export const loadObjectives = async (): Promise<ObjectivesFile> => {
  const data = await loadJson<ObjectivesFile>('objectives.json');
  // Production builds redact objective rulesText. The engine matches on
  // effectKey + id (never on text), so this is purely a UI redaction.
  // Local dev (vite dev) still shows the full text.
  if (import.meta.env.PROD) {
    return {
      ...data,
      objectives: (data.objectives ?? []).map((c) => ({ ...c, rulesText: '' })),
    };
  }
  return data;
};
export const loadTactics    = () => loadJson<TacticsFile>('tactics.json');
export const loadProbes     = () => loadJson<ProbesFile>('probes.json');

export const MAP_IMAGE_URL = `${BASE}/Map.png${BUST}`;
export const LEADER_IMAGE_BASE = `${BASE}/leaders`;
export const CARD_IMAGE_BASE = `${BASE}/cards`;
export const MARKER_IMAGE_BASE = `${BASE}/markers`;
export const UNIT_IMAGE_BASE = `${BASE}/units`;
export const DICE_IMAGE_BASE = `${BASE}/dice`;
/** Cache-bust suffix consumers append to <img src> URLs so the iPad fetches
 *  fresh PNGs and bypasses Cloudflare's edge cache (which has 7-day TTLs
 *  on static assets and doesn't auto-purge when files are replaced/removed
 *  in a new deployment). Empty in dev. */
export const IMG_BUST = BUST;

/** Build URL for a SWR die face. color: red|black|green; face: hit|direct-hit|special|blank.
 *  Returns null for combos not present in the .vmod (green hit/special are RoE-only). */
export function diceImageUrl(color: 'red' | 'black' | 'green', face: 'hit' | 'direct-hit' | 'special' | 'blank'): string | null {
  const c = color === 'red' ? 'Red' : color === 'black' ? 'Black' : 'Green';
  const f = face === 'hit' ? 'Hit'
          : face === 'direct-hit' ? 'Direct'
          : face === 'special' ? 'Special'
          : 'Blank';
  // Green is base-game-incomplete: only Blank + Direct shipped.
  if (color === 'green' && (face === 'hit' || face === 'special')) return null;
  return `${DICE_IMAGE_BASE}/Dice${c}${f}.png${BUST}`;
}

/** Load all 8 JSON files needed by the engine in parallel. */
export async function loadAllForEngine() {
  const [systems, adjacency, leaders, actions, missions, objectives, tactics, probes] = await Promise.all([
    loadSystems(), loadAdjacency(), loadLeaders(), loadActions(),
    loadMissions(), loadObjectives(), loadTactics(), loadProbes(),
  ]);
  return { systems, adjacency, leaders, actions, missions, objectives, tactics, probes };
}
