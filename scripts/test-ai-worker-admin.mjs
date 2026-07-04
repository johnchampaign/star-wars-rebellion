// AI-worker admin surface (/api/admin/ai-*): auth + the ai-due filter + the
// ai-move optimistic-concurrency/validation guards. This is the "verification
// system" gating the off-Cloudflare worker that computes stronger AI moves.
// Run: node scripts/test-ai-worker-admin.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { makeRebellionCodec } = await import('../src/adapter/codec.ts');
const gs = await import('../functions/_lib/gameServer.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const base = createGame(data, { seed: 5, autoSetupUnits: true });
const codec = makeRebellionCodec(base.catalog);
/** Build a stored snapshot string for a state at `currentPlayer`'s Command turn,
 *  with `aiSides` AI-controlled and optional game-over. */
function snap(currentPlayer, aiSides, over = false) {
  const g = createGame(data, { seed: 5, autoSetupUnits: true });
  g.phase = 'Command'; g.currentPlayer = currentPlayer; g.aiSides = aiSides;
  g.pendingChoice = undefined; g.isGameOver = over;
  return gs.encodeSnapshot(codec, g);
}
const req = (headers) => new Request('https://x/api/admin/ai-due', { headers });

console.log('\n[ requireAdmin — fails CLOSED, constant-time token check ]');
{
  const tok = 'super-secret-worker-token-123';
  check('no SWR_ADMIN_TOKEN configured → denied (503, fail closed)',
    gs.requireAdmin(req({}), {})?.status === 503);
  check('token configured, no header → 401',
    gs.requireAdmin(req({}), { SWR_ADMIN_TOKEN: tok })?.status === 401);
  check('token configured, wrong token → 401',
    gs.requireAdmin(req({ authorization: 'Bearer nope' }), { SWR_ADMIN_TOKEN: tok })?.status === 401);
  check('correct token via Authorization: Bearer → allowed (null)',
    gs.requireAdmin(req({ authorization: `Bearer ${tok}` }), { SWR_ADMIN_TOKEN: tok }) === null);
  check('correct token via x-admin-token → allowed (null)',
    gs.requireAdmin(req({ 'x-admin-token': tok }), { SWR_ADMIN_TOKEN: tok }) === null);
  check('a token that is a prefix of the real one → 401 (length check)',
    gs.requireAdmin(req({ 'x-admin-token': tok.slice(0, -1) }), { SWR_ADMIN_TOKEN: tok })?.status === 401);
}

console.log('\n[ listAiDueGames — only AI-turn, live games; undecodable skipped ]');
{
  const games = {
    'g-ai-rebel': { turn: 3, state: snap('Rebel', ['Rebel']) },   // AI's turn → due
    'g-human':    { turn: 4, state: snap('Rebel', ['Empire']) },  // human Rebel's turn → NOT due
    'g-over':     { turn: 9, state: snap('Empire', ['Empire'], true) }, // game over → NOT due
    'g-garbage':  { turn: 1, state: 'v1:{not valid json' },        // undecodable → skipped
  };
  const store = {
    listActiveGames: async () => Object.keys(games).map((id) => ({ gameId: id, createdAt: '' })),
    getLatest: async (id) => games[id] ?? null,
    putSnapshot: async () => {},
  };
  // Fallback path (no supabase): full listActiveGames scan.
  const due = await gs.listAiDueGames(store, codec);
  const ids = due.map((d) => d.gameId).sort();
  check('fallback scan: exactly the AI-turn live game is returned', JSON.stringify(ids) === JSON.stringify(['g-ai-rebel']), JSON.stringify(ids));
  check('due entry carries turn + actor + snapshot', due[0]?.turn === 3 && due[0]?.actor === 'Rebel' && !!due[0]?.snapshot);

  // Fast path: the indexed actor_is_ai query narrows candidates (no
  // listActiveGames scan) and returns the RAW snapshot WITHOUT decoding — the
  // worker + applyAiWorkerMove re-verify, so the server pays no decode CPU
  // (the fix for the ai-due Cloudflare 1102). `.eq(...).limit(...)` chains.
  const mkSupabase = (result, onFrom) => ({ from: (t) => { onFrom?.(t); return { select: () => ({ eq: () => ({ limit: () => Promise.resolve(result) }) }) }; } });
  let scanned = false;
  const noScanStore = { ...store, listActiveGames: async () => { scanned = true; return []; } };
  const sbFast = mkSupabase({ data: [{ game_id: 'g-ai-rebel', actor: 'Rebel' }], error: null });
  const dueFast = await gs.listAiDueGames(noScanStore, codec, sbFast);
  check('fast path: uses the flag query, does NOT scan all games', !scanned);
  check('fast path: returns the flagged game with stored actor + raw snapshot',
    dueFast.length === 1 && dueFast[0].gameId === 'g-ai-rebel' && dueFast[0].actor === 'Rebel'
    && dueFast[0].turn === 3 && !!dueFast[0].snapshot, JSON.stringify(dueFast));

  // Fast path trusts the flag (no server decode): a flagged game is returned
  // even if its snapshot would now show a human turn — the worker re-checks and
  // skips it, and applyAiWorkerMove refreshes the flag on the next real move.
  const sbStale = mkSupabase({ data: [{ game_id: 'g-human', actor: 'Rebel' }], error: null });
  const dueStale = await gs.listAiDueGames(store, codec, sbStale);
  check('fast path: returns the flagged candidate without a server decode', dueStale.length === 1 && dueStale[0].gameId === 'g-human');

  // A flagged game whose snapshot is missing (getLatest null) is dropped.
  const sbGone = mkSupabase({ data: [{ game_id: 'g-does-not-exist', actor: 'Empire' }], error: null });
  const dueGone = await gs.listAiDueGames(store, codec, sbGone);
  check('fast path: a flagged game with no snapshot is skipped', dueGone.length === 0, JSON.stringify(dueGone.map((d) => d.gameId)));

  // Column-missing (pre-migration): the flag query errors → falls back to the scan.
  scanned = false;
  const sbNoCol = mkSupabase({ data: null, error: { message: 'column actor_is_ai does not exist' } });
  const dueFallback = await gs.listAiDueGames({ ...store, listActiveGames: async () => { scanned = true; return Object.keys(games).map((id) => ({ gameId: id, createdAt: '' })); } }, codec, sbNoCol);
  check('column missing → falls back to full scan (decodes, capped)', scanned && dueFallback.length === 1 && dueFallback[0].gameId === 'g-ai-rebel');
}

console.log('\n[ applyAiWorkerMove — concurrency + turn-ownership + validity guards ]');
{
  const good = snap('Rebel', ['Rebel']);          // AI Rebel to move
  const human = snap('Rebel', ['Empire']);         // human Rebel to move
  const nextGood = snap('Empire', ['Rebel']);      // a plausible post-move snapshot
  const mk = (state, turn = 5) => {
    const puts = [];
    const store = {
      listActiveGames: async () => [],
      getLatest: async () => ({ turn, state }),
      putSnapshot: async (id, row) => { puts.push({ id, row }); },
    };
    return { store, puts };
  };

  let { store, puts } = mk(good, 5);
  let r = await gs.applyAiWorkerMove(store, codec, 'g1', 5, nextGood);
  check('valid AI move at the right baseTurn → 200 and stored at turn+1',
    r.ok && r.status === 200 && puts.length === 1 && puts[0].row.turn === 6 && puts[0].row.state === nextGood, JSON.stringify(r));

  ({ store, puts } = mk(good, 7));
  r = await gs.applyAiWorkerMove(store, codec, 'g1', 5, nextGood);
  check('stale baseTurn (someone else advanced) → 409, nothing stored', !r.ok && r.status === 409 && puts.length === 0, JSON.stringify(r));

  ({ store, puts } = mk(human, 5));
  r = await gs.applyAiWorkerMove(store, codec, 'g1', 5, nextGood);
  check('current turn is a HUMAN seat → 409, refused', !r.ok && r.status === 409 && puts.length === 0, r.reason);

  ({ store, puts } = mk(good, 5));
  r = await gs.applyAiWorkerMove(store, codec, 'g1', 5, 'v1:{garbage');
  check('undecodable new snapshot → 400, nothing stored', !r.ok && r.status === 400 && puts.length === 0, r.reason);

  r = await gs.applyAiWorkerMove({ getLatest: async () => null, putSnapshot: async () => {} }, codec, 'gone', 0, nextGood);
  check('missing game → 404', !r.ok && r.status === 404);

  // With supabase passed, a successful move refreshes swr_turn_notify with the
  // NEW actor so the ai-due flag stops matching once the turn passes to a human
  // (nextGood = Empire's turn, aiSides=['Rebel'] → human's turn → actor_is_ai:false).
  {
    const upserts = [];
    const sb = { from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { actor: 'Rebel' } }) }) }),
      upsert: async (row) => { upserts.push(row); return { error: null }; },
    }) };
    const { store: st, puts: p } = mk(good, 5);
    const rr = await gs.applyAiWorkerMove(st, codec, 'g1', 5, nextGood, sb);
    check('flag-refresh: move stored AND swr_turn_notify updated to the new (human) actor',
      rr.ok && p.length === 1 && upserts.length === 1
      && upserts[0].actor === 'Empire' && upserts[0].actor_is_ai === false, JSON.stringify(upserts));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
