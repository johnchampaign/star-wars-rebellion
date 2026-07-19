// Self-play analytics JSONL schema (selfplay-v1) — GAME-AGNOSTIC envelope.
//
// One JSON object per line, one line per completed game. The envelope fields
// are fixed across game projects; everything game-specific lives inside
// `dims` (per-game strategic dimensions, filled by an adapter like
// dims-rebellion.mjs), `actions` (compact per-turn action list) and
// `snapshots` (cheap per-turn numeric state). Reuse this file verbatim in
// other game repos; only the adapter changes.

/** Fields every record must carry, with cheap runtime type checks. */
const REQUIRED = {
  schema: (v) => v === 'selfplay-v1',
  game: (v) => typeof v === 'string' && v.length > 0,
  seed: (v) => Number.isInteger(v),
  policies: (v) => v && typeof v === 'object',
  winner: (v) => typeof v === 'string',
  winReason: (v) => typeof v === 'string',
  rounds: (v) => Number.isInteger(v) && v >= 0,
  durationMs: (v) => typeof v === 'number' && v >= 0,
  actions: (v) => Array.isArray(v),
  snapshots: (v) => Array.isArray(v),
  dims: (v) => v && typeof v === 'object',
};

/** Validate one record. Returns [] when valid, else a list of problems. */
export function validateRecord(rec) {
  const problems = [];
  if (!rec || typeof rec !== 'object') return ['record is not an object'];
  for (const [field, check] of Object.entries(REQUIRED)) {
    if (!(field in rec)) { problems.push(`missing field: ${field}`); continue; }
    if (!check(rec[field])) problems.push(`bad value for field: ${field}`);
  }
  for (const a of rec.actions ?? []) {
    if (!Number.isInteger(a.t) || typeof a.side !== 'string' || typeof a.kind !== 'string') {
      problems.push('action entries need integer t, string side, string kind');
      break;
    }
  }
  for (const s of rec.snapshots ?? []) {
    if (!Number.isInteger(s.t)) { problems.push('snapshot entries need integer t'); break; }
  }
  for (const [k, v] of Object.entries(rec.dims ?? {})) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      problems.push(`dim "${k}" is not a finite number`);
      break;
    }
  }
  return problems;
}

/** Build a record (throws on invalid — writers should fail loudly, readers softly). */
export function buildRecord(fields) {
  const rec = { schema: 'selfplay-v1', ...fields };
  const problems = validateRecord(rec);
  if (problems.length) throw new Error('invalid selfplay record: ' + problems.join('; '));
  return rec;
}

/** Parse a JSONL buffer/string into records, skipping (and counting) bad lines. */
export function readJsonl(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (validateRecord(rec).length === 0) records.push(rec);
      else skipped++;
    } catch { skipped++; }
  }
  return { records, skipped };
}
