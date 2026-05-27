// VASSAL-module art cache. The deployed site ships zero FFG art; players
// instead supply their own copy of the VASSAL swr.vmod (downloadable from
// vassalengine.org or the Google Drive mirror linked in the load-art
// prompt). We unzip the .vmod client-side with JSZip, store each PNG
// from its images/ folder as a Blob in IndexedDB keyed by basename, and
// then serve <img src="blob:..."> URLs from in-memory object URLs.
//
// Why this approach (vs. hot-linking a CDN):
//   - Each player brings their own legally-acquired copy of the module.
//     We never touch FFG bytes; the page is functionally identical to the
//     local `npm run copy-assets` workflow, just moved into the browser.
//   - Browser caches persist across sessions (IndexedDB), so the upload
//     is a one-time step. Clearing site data forces a re-upload.
//   - No CORS, no third-party host failure modes, no rate limits.
//
// What this DOESN'T cover: the silhouette/token unit styles (custom-derived
// from the reference sheets — not present in the .vmod). When art is
// loaded from a .vmod we fall back to the raw Unit*.png in those positions
// and the style toggle becomes a no-op until the player loads the
// style packs separately (future work).

import JSZip from 'jszip';

const DB_NAME = 'rebellion-vmod-art';
const STORE_NAME = 'images';
const DB_VERSION = 1;
const META_KEY = '__meta__';

type ArtMeta = {
  loadedAt: string;          // ISO timestamp
  fileCount: number;
  totalBytes: number;
  vmodFilename?: string;
};

// ---------- IndexedDB plumbing ----------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet<T = unknown>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbKeys(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

// ---------- In-memory blob URL cache ----------
//
// IndexedDB returns Blobs; <img src> needs a URL. URL.createObjectURL is
// cheap but the URLs leak unless we revoke them. We hold a process-lifetime
// cache (filename → blob URL) — the leak is bounded by the unique-filename
// count (~250 max) and the URLs are valid until page unload.

const blobUrlCache = new Map<string, string | null>(); // null = known missing
const pendingFetches = new Map<string, Promise<string | null>>();
// Case-insensitive lookup index: lowercased-filename → actual stored key.
// Different .vmod versions and even the same version on different
// filesystems can serve files with case-varied names (Map.png vs map.png).
// Building this index after preload lets the URL helpers ignore case.
const caseIndex = new Map<string, string>();

// Filename aliases for .vmod versions that renamed/replaced files. Keyed
// by what our URL helpers ask for; values are alternative filenames to
// try if the primary lookup misses. Each entry should be specific to a
// known version mismatch — don't add speculative aliases.
const FILENAME_ALIASES: Record<string, string[]> = {
  // v1.2e renamed the board to Map-Redux.png. Older modules ship Map.png.
  'Map.png': ['Map-Redux.png'],
};

/** Get the blob: URL for a logical filename (e.g. "UnitTIE.png"). Returns
 *  null if the file isn't in the cache (either no .vmod loaded, or that
 *  particular file wasn't present in the .vmod). Synchronous fast path
 *  via the in-memory cache; falls through to an async IndexedDB lookup
 *  the first time each filename is requested. */
export function getCachedArtUrlSync(filename: string): string | null | undefined {
  // undefined = haven't looked yet, null = looked + missing, string = found
  if (blobUrlCache.has(filename)) return blobUrlCache.get(filename) ?? null;
  // Fall back to case-insensitive match — many .vmod versions ship the
  // same file under different cases (e.g. Map.png vs map.png vs MAP.png).
  const ciKey = caseIndex.get(filename.toLowerCase());
  if (ciKey && blobUrlCache.has(ciKey)) return blobUrlCache.get(ciKey) ?? null;
  // Try explicit aliases for known cross-version renames.
  const aliases = FILENAME_ALIASES[filename];
  if (aliases) {
    for (const alt of aliases) {
      if (blobUrlCache.has(alt)) return blobUrlCache.get(alt) ?? null;
      const ciAlt = caseIndex.get(alt.toLowerCase());
      if (ciAlt && blobUrlCache.has(ciAlt)) return blobUrlCache.get(ciAlt) ?? null;
    }
  }
  return undefined;
}

// Expose a globalThis handle so non-React URL helpers (unitImages.ts,
// loadAssets.ts) can consult the sync cache without importing this module
// and pulling React into their dependency chain. Set once at module load.
(globalThis as { __rebellionArtCache?: unknown }).__rebellionArtCache = {
  getSync: getCachedArtUrlSync,
};

export async function getCachedArtUrl(filename: string): Promise<string | null> {
  if (blobUrlCache.has(filename)) return blobUrlCache.get(filename) ?? null;
  const pending = pendingFetches.get(filename);
  if (pending) return pending;
  const p = (async () => {
    try {
      const blob = await dbGet<Blob>(filename);
      if (!blob) {
        blobUrlCache.set(filename, null);
        return null;
      }
      const url = URL.createObjectURL(blob);
      blobUrlCache.set(filename, url);
      return url;
    } catch {
      blobUrlCache.set(filename, null);
      return null;
    } finally {
      pendingFetches.delete(filename);
    }
  })();
  pendingFetches.set(filename, p);
  return p;
}

// ---------- .vmod load ----------

export type LoadProgress = {
  phase: 'reading' | 'unzipping' | 'storing' | 'done';
  current?: number;
  total?: number;
  filename?: string;
};

/** Read a .vmod (ZIP) file, extract every PNG under images/, and persist
 *  each as a Blob in IndexedDB keyed by basename (e.g. "UnitTIE.png").
 *  Calls onProgress periodically so the UI can show a progress bar. */
export async function loadVmodFromFile(
  file: File,
  onProgress?: (p: LoadProgress) => void,
): Promise<ArtMeta> {
  onProgress?.({ phase: 'reading' });
  const buf = await file.arrayBuffer();

  onProgress?.({ phase: 'unzipping' });
  let zip = await JSZip.loadAsync(buf);

  // Find every PNG in the zip — VASSAL puts art under images/ but some
  // modules nest deeper. Match anything ending in .png and we'll key by
  // basename so the downstream lookup is consistent regardless of folder.
  let pngEntries: JSZip.JSZipObject[] = [];
  zip.forEach((_path, entry) => {
    if (entry.dir) return;
    if (!/\.png$/i.test(entry.name)) return;
    pngEntries.push(entry);
  });

  // Some redistributions of the SWR module (e.g. the Google Drive copy
  // we link in the load prompt) wrap the real .vmod inside another ZIP
  // along with a readme. If the upload has zero PNGs but contains
  // exactly one nested .vmod / .zip, recurse into it. Two-level deep
  // is enough for every case we've seen.
  if (pngEntries.length === 0) {
    const nestedEntries: JSZip.JSZipObject[] = [];
    zip.forEach((_path, entry) => {
      if (entry.dir) return;
      if (/\.(vmod|zip)$/i.test(entry.name)) nestedEntries.push(entry);
    });
    if (nestedEntries.length === 1) {
      const inner = nestedEntries[0];
      onProgress?.({ phase: 'unzipping', filename: `(nested: ${inner.name})` });
      const innerBuf = await inner.async('arraybuffer');
      zip = await JSZip.loadAsync(innerBuf);
      zip.forEach((_path, entry) => {
        if (entry.dir) return;
        if (!/\.png$/i.test(entry.name)) return;
        pngEntries.push(entry);
      });
    }
  }

  if (pngEntries.length === 0) {
    throw new Error('No PNG images found in the uploaded file. Make sure you picked the .vmod (not the surrounding download wrapper).');
  }

  let totalBytes = 0;
  // Clear any prior cache so the new .vmod fully replaces the old one
  // (avoids stale stuff lingering if the player swaps modules).
  await dbClear();
  blobUrlCache.clear();

  for (let i = 0; i < pngEntries.length; i++) {
    const entry = pngEntries[i];
    const basename = entry.name.split('/').pop() || entry.name;
    onProgress?.({
      phase: 'storing',
      current: i + 1,
      total: pngEntries.length,
      filename: basename,
    });
    const blob = await entry.async('blob');
    totalBytes += blob.size;
    await dbPut(basename, blob);
  }

  const meta: ArtMeta = {
    loadedAt: new Date().toISOString(),
    fileCount: pngEntries.length,
    totalBytes,
    vmodFilename: file.name,
  };
  await dbPut(META_KEY, meta);
  onProgress?.({ phase: 'done', current: pngEntries.length, total: pngEntries.length });
  return meta;
}

/** Look up the metadata for the currently-loaded .vmod, or null if none.
 *  Returns null if metadata exists but reports zero files — this happens
 *  when a previous version of the loader silently persisted an empty cache
 *  (a broken-load state). Treating it as "not loaded" prompts the player
 *  to re-upload instead of leaving them stuck behind an "art: loaded"
 *  button that's actually pointing at nothing. */
export async function getVmodMeta(): Promise<ArtMeta | null> {
  try {
    const meta = await dbGet<ArtMeta>(META_KEY);
    if (!meta) return null;
    if (!meta.fileCount || meta.fileCount === 0) {
      // Auto-clean the stale empty state so subsequent boots don't
      // re-check the same junk metadata.
      await dbClear();
      return null;
    }
    return meta;
  } catch {
    return null;
  }
}

/** Walk every cached filename and create an in-memory blob: URL for it.
 *  Lets the sync URL helpers (unitImageUrl, leaderImageUrl, etc.) return
 *  a real URL synchronously after this resolves. Called once at app boot
 *  if cached art exists, and again after a fresh .vmod load. */
export async function preloadAllBlobUrls(): Promise<number> {
  // Revoke any previously-cached blob URLs so a re-preload after vmod
  // clear doesn't leak.
  for (const url of blobUrlCache.values()) {
    if (url) URL.revokeObjectURL(url);
  }
  blobUrlCache.clear();
  caseIndex.clear();

  const keys = await dbKeys();
  let loaded = 0;
  for (const key of keys) {
    if (key === META_KEY) continue;
    try {
      const blob = await dbGet<Blob>(key);
      if (!blob) { blobUrlCache.set(key, null); continue; }
      blobUrlCache.set(key, URL.createObjectURL(blob));
      caseIndex.set(key.toLowerCase(), key);
      loaded++;
    } catch {
      blobUrlCache.set(key, null);
    }
  }
  // Stash the full file list on the global handle so the diagnostic
  // panel + the dev console can introspect what's actually cached
  // without each caller paying an IndexedDB round-trip.
  (globalThis as { __rebellionArtCacheFiles?: string[] }).__rebellionArtCacheFiles =
    [...blobUrlCache.keys()].sort();
  console.log(`[vmod] Preloaded ${loaded} images. Sample filenames:`,
    [...blobUrlCache.keys()].slice(0, 10).sort());
  return loaded;
}

/** List of all filenames currently cached. Used by the diagnostic panel
 *  to surface .vmod-version mismatches (expected name → not found). */
export function getCachedFilenames(): string[] {
  return [...blobUrlCache.keys()].sort();
}

/** Drop the entire art cache (player can re-upload fresh). */
export async function clearVmodCache(): Promise<void> {
  await dbClear();
  for (const url of blobUrlCache.values()) {
    if (url) URL.revokeObjectURL(url);
  }
  blobUrlCache.clear();
  pendingFetches.clear();
}

// ---------- React hook ----------
//
// useCachedArt(filename) → blob: URL string, or null while pending / missing.
// Components that want to render the cached art (or fall back to the
// strict-deploy /dev-assets placeholder) call this hook. Re-renders when
// the IndexedDB lookup completes.

import { useEffect, useState } from 'react';

export function useCachedArt(filename: string | null): string | null {
  const [url, setUrl] = useState<string | null>(() => {
    if (!filename) return null;
    const sync = getCachedArtUrlSync(filename);
    return sync === undefined ? null : sync;
  });
  useEffect(() => {
    if (!filename) { setUrl(null); return; }
    const sync = getCachedArtUrlSync(filename);
    if (sync !== undefined) { setUrl(sync); return; }
    let cancelled = false;
    getCachedArtUrl(filename).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => { cancelled = true; };
  }, [filename]);
  return url;
}

/** Has any art been cached? Hook re-renders when the cache is loaded or
 *  cleared (subscribed via a custom event so components elsewhere in the
 *  tree pick up the change without prop drilling). */
const ART_LOADED_EVENT = 'rebellion-art-loaded';
export function notifyArtChanged(): void {
  window.dispatchEvent(new CustomEvent(ART_LOADED_EVENT));
}

export function useArtLoaded(): { loaded: boolean; meta: ArtMeta | null } {
  const [state, setState] = useState<{ loaded: boolean; meta: ArtMeta | null }>(
    { loaded: false, meta: null },
  );
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const meta = await getVmodMeta();
      if (cancelled) return;
      setState({ loaded: !!meta, meta });
    };
    refresh();
    const handler = () => refresh();
    window.addEventListener(ART_LOADED_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(ART_LOADED_EVENT, handler);
    };
  }, []);
  return state;
}
