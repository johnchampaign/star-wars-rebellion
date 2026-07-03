// Off-Cloudflare AI worker (runs on the Linode box). Polls /api/admin/ai-due for
// games waiting on an AI seat, computes the move locally with the STRONG depth-2
// board-eval policy (no Cloudflare CPU limit), and posts it back via
// /api/admin/ai-move. Uses the SWR_ADMIN_TOKEN to authenticate.
//
// Safe to run alongside Cloudflare's inline AI advance during rollout: both go
// through optimistic concurrency (ai-move rejects a stale baseTurn 409) and the
// "is it still an AI turn?" check, so the worst case is a wasted computation,
// never a double-move. Flip AI_WORKER_ENABLED on Cloudflare to make the worker
// the sole mover once it's verified.
//
// Config (env, or a KEY=VALUE env file passed as argv[2]):
//   SWR_BASE_URL      e.g. https://star-wars-rebellion.pages.dev   (required)
//   SWR_ADMIN_TOKEN   the admin token                               (required)
//   AI_POLL_MS        poll interval, default 5000
//   AI_DEPTH          search depth, default 2
//   AI_MAX_STEPS      per-turn safety cap, default 4000
// Run: node scripts/ai-worker.mjs [path/to/env-file]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Optional env file (KEY=VALUE lines) so secrets live in a locked-down file, not
// the process table / shell history.
if (process.argv[2]) {
  for (const line of readFileSync(process.argv[2], 'utf-8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const BASE = (process.env.SWR_BASE_URL || '').replace(/\/$/, '');
const TOKEN = process.env.SWR_ADMIN_TOKEN || '';
const POLL_MS = Number(process.env.AI_POLL_MS || 5000);
const DEPTH = Number(process.env.AI_DEPTH || 2);
const MAX_STEPS = Number(process.env.AI_MAX_STEPS || 4000);
if (!BASE || !TOKEN) { console.error('[ai-worker] SWR_BASE_URL and SWR_ADMIN_TOKEN are required'); process.exit(1); }

const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { makeRebellionCodec } = await import('../src/adapter/codec.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const { stepOnce, seedAI, setCommandPolicyOverride } = await import('../src/play/randomAI.ts');
const { evalCommandStepDeep } = await import('../src/play/boardEval.ts');

// Build the catalog + codec once (same data bundle the game ships).
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const codec = makeRebellionCodec(catalog);

// Register the strong depth-2 policy for BOTH sides (the worker is the "strong
// AI" node; depth-2 helps the Rebel a lot and is neutral-or-better for the
// Empire). Wrapped so a search throw falls back to the heuristic, never stalls.
for (const side of ['Rebel', 'Empire']) setCommandPolicyOverride(side, (g, s) => evalCommandStepDeep(g, s, DEPTH));

const strip = (s) => s.replace(/^v\d+:/, '');
const prefix = `v${rebellionAdapter.schemaVersion ?? 1}:`;

/** Play the AI's whole turn on a decoded state (mirrors gameServer.runServerAI
 *  but with the depth-2 policy registered above). Returns whether it advanced. */
function computeAiTurn(state) {
  const ai = state.aiSides;
  if (!ai || ai.length === 0) return false;
  let advanced = false;
  for (let i = 0; i < MAX_STEPS; i++) {
    if (state.isGameOver) break;
    const actor = rebellionAdapter.currentActor(state);
    if (!actor || !ai.includes(actor)) break; // handed back to a human — stop
    let did = false;
    try { did = stepOnce(state, actor); } catch (e) { console.warn('[ai-worker] step threw', e?.message); break; }
    if (!did) break;
    advanced = true;
  }
  return advanced;
}

async function api(path, init) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function tick() {
  const due = await api('/api/admin/ai-due', { method: 'GET' });
  if (due.status !== 200) { console.warn(`[ai-worker] ai-due ${due.status}: ${JSON.stringify(due.body).slice(0, 120)}`); return; }
  const games = due.body.games ?? [];
  for (const g of games) {
    try {
      // Deterministic per (game, turn) so a retry recomputes identically.
      seedAI((hashStr(g.gameId) ^ (g.turn * 2654435761)) >>> 0);
      const state = codec.decode(strip(g.snapshot));
      const actor = rebellionAdapter.currentActor(state);
      if (!actor || !state.aiSides?.includes(actor)) continue; // stale flag — already moved
      if (!computeAiTurn(state)) continue;
      const snapshot = prefix + codec.encode(state);
      const res = await api('/api/admin/ai-move', {
        method: 'POST', body: JSON.stringify({ gameId: g.gameId, baseTurn: g.turn, snapshot }),
      });
      if (res.status === 200) console.log(`[ai-worker] moved ${g.gameId} (${actor}) turn ${g.turn}→${g.turn + 1}`);
      else if (res.status === 409) console.log(`[ai-worker] ${g.gameId} already advanced (409) — skipping`);
      else console.warn(`[ai-worker] ai-move ${res.status} for ${g.gameId}: ${JSON.stringify(res.body).slice(0, 120)}`);
    } catch (e) { console.warn(`[ai-worker] error on ${g.gameId}:`, e?.message); }
  }
}

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`[ai-worker] up — base=${BASE} depth=${DEPTH} poll=${POLL_MS}ms`);
for (;;) {
  try { await tick(); } catch (e) { console.warn('[ai-worker] tick error:', e?.message); }
  await sleep(POLL_MS);
}
