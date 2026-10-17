// Player report #812 — "Rebel AI is not deploying after empire deploys in beg
// of game." Online game, human Empire vs AI Rebel; the board was correct (the
// AI Rebel on the clock, #797's fix doing its job), but the off-Cloudflare
// worker never saw the game.
//
// /api/admin/ai-due listed AI-due games with ONE unordered query capped at 8.
// Eight long-dead flagged games (stuck since July: snapshot 503s, abandoned
// seats) filled every slot, so any NEW AI-due game fell outside the window and
// its AI seat never moved. listAiDueRefs must order newest-turn-first and use a
// window wide enough that stale rows can't crowd out a live game.
//
// The fake Supabase below implements eq/order/limit with real semantics, so the
// test fails on the old query (unordered .limit(8) returns the 8 stale rows).
//
// Run: node scripts/test-ai-due-stale-window-812.mjs
const { register } = await import('tsx/esm/api');
register();
const gs = await import('../functions/_lib/gameServer.ts');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

function fakeSupabase(rows) {
  return {
    from() {
      let out = [...rows];
      const q = {
        select() { return q; },
        eq(col, v) { out = out.filter((r) => r[col] === v); return q; },
        order(col, { ascending = true } = {}) {
          out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
          return q;
        },
        limit(n) { out = out.slice(0, n); return q; },
        then(res, rej) { return Promise.resolve({ data: out, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

// Insertion order = the order an unordered heap scan would plausibly return.
const stale = [
  ['bthzvjj5ncqi5l85', 'Empire', '2026-07-05T01:58:06Z'],
  ['nlzmzhxb2sezqtpl', 'Rebel', '2026-07-24T16:13:43Z'],
  ['d5c9b5e4xxxtmjwf', 'Rebel', '2026-07-07T18:30:51Z'],
  ['lsykg4u6spsfitzo', 'Empire', '2026-07-07T09:56:55Z'],
  ['2ilx79wizakf3z8q', 'Empire', '2026-08-12T13:53:58Z'],
  ['i7mb5nw0rx2illca', 'Empire', '2026-08-24T11:08:40Z'],
  ['koxylwwk2bxpiw4y', 'Empire', '2026-10-08T14:49:20Z'],
  ['51c1usm5p754slnc', 'Rebel', '2026-10-07T01:01:17Z'],
].map(([game_id, actor, started_at]) => ({ game_id, actor, started_at, actor_is_ai: true }));
const humanTurn = { game_id: 'humansturn000000', actor: 'Empire', started_at: '2026-10-17T10:50:00Z', actor_is_ai: false };
const fresh = { game_id: 'fresh812setup000', actor: 'Rebel', started_at: '2026-10-17T10:55:20Z', actor_is_ai: true };

console.log('\n[ listAiDueRefs — stale flagged games cannot hide a new AI turn (#812) ]');
{
  const refs = await gs.listAiDueRefs(fakeSupabase([...stale, humanTurn, fresh]));
  check('query succeeds', Array.isArray(refs));
  check('the new AI-due game is listed', !!refs?.some((r) => r.gameId === fresh.game_id),
    `got ${refs?.map((r) => r.gameId).join(', ')}`);
  check('it comes first (newest turn first)', refs?.[0]?.gameId === fresh.game_id);
  check('a human-turn row is never listed', !refs?.some((r) => r.gameId === humanTurn.game_id));
  check('the stale games are still listed (window is wide enough)', stale.every((s) => refs?.some((r) => r.gameId === s.game_id)));
  check('`since` is carried for the worker\'s once-per-turn skip', refs?.[0]?.since === fresh.started_at);
}

console.log('\n[ a much larger stale backlog still leaves room for the newest turn ]');
{
  const many = Array.from({ length: 250 }, (_, i) => ({
    game_id: `stale${String(i).padStart(11, '0')}`, actor: 'Empire',
    started_at: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`, actor_is_ai: true,
  }));
  const refs = await gs.listAiDueRefs(fakeSupabase([...many, fresh]));
  check('newest AI turn listed despite 250 stale rows', refs?.[0]?.gameId === fresh.game_id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
