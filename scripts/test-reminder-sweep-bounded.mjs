// #683 — "Turn nudge emails do not appear to send. The initial game email
// does but the nudges do not."
//
// Root cause, measured from outside: /api/cron/sweep-reminders HANGS — no
// response at 30s, still nothing at 5 minutes — while /api/report answers in
// 0.1s. The framework's sweep lists EVERY resolved=false game (unbounded
// select) and serially fetches + decodes each full snapshot. Games are only
// marked resolved BY that sweep, so the first time the backlog outgrew the
// request budget the sweep began dying mid-run, nothing got marked, and the
// set could never shrink again. Every 5 minutes, forever. The ai-due endpoint
// had already died of exactly this ("Decoding N full snapshots per poll is
// what pushed this endpoint past Cloudflare's per-request CPU limit") and got
// the same medicine this test now pins for the sweep: bounded work per tick.
//
// This drives boundedReminderSweep with stubbed deps. What must hold:
//   1. the deadline actually stops the loop (the whole point)
//   2. the reminder-clock semantics match the framework loop VERBATIM —
//      turn change resets the clock, `sent` dedupes, olderThan is respected,
//      game-over marks resolved — so a later return to the stock sweep is a
//      drop-in
//   3. one bad game never kills the sweep for the rest
//
// Run: node scripts/test-reminder-sweep-bounded.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { boundedReminderSweep } = await import('../functions/_lib/gameServer.ts');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const NOW = 1_000_000_000_000;
const meta = (id, over = {}) => ({
  gameId: id, players: {}, tokens: { Rebel: `tok-R-${id}`, Empire: `tok-E-${id}` },
  emails: { Rebel: `${id}-rebel@x.test`, Empire: `${id}-empire@x.test` },
  createdAt: new Date(NOW - 86400000).toISOString(), resolved: false, ...over,
});
/** Standard test harness: games keyed by id -> {meta, turn, actor}. */
function harness(games, { latestDelayMs = 0 } = {}) {
  let clock = NOW;
  const sent = []; const metaWrites = [];
  const deps = {
    listChunks: async () => games.map((g) => g.meta),
    getLatest: async (id) => {
      clock += latestDelayMs;
      const g = games.find((x) => x.meta.gameId === id);
      if (g?.explode) throw new Error(`kaboom:${id}`);
      return g ? { turn: g.turn, state: id } : null;
    },
    putGameMeta: async (m) => { metaWrites.push(m); },
    actorOf: (raw) => games.find((x) => x.meta.gameId === raw)?.actor ?? null,
    notifyYourTurn: async ({ email, meta: m, actor, turn }) => { sent.push({ email, id: m.gameId, actor, turn }); },
    now: () => clock,
  };
  return { deps, sent, metaWrites, tick: (ms) => { clock += ms; } };
}

const OLDER = 15 * 60 * 1000;

console.log('\n[ 1. the deadline stops the loop — the actual #683 fix ]');
{
  // 50 games, each getLatest costs 1s of simulated clock. Deadline 10s.
  const games = Array.from({ length: 50 }, (_, i) => ({ meta: meta(`g${i}`), turn: 3, actor: 'Rebel' }));
  const { deps } = harness(games, { latestDelayMs: 1000 });
  const r = await boundedReminderSweep(deps, { olderThanMs: OLDER, deadlineMs: 10_000 });
  check('the sweep returned instead of running to exhaustion', r.truncated === true,
    JSON.stringify(r));
  check('and it scanned only what fit in the budget', r.scanned > 0 && r.scanned <= 12,
    `scanned ${r.scanned} of 50`);
}

console.log('\n[ 2. framework reminder-clock semantics, verbatim ]');
{
  // First sighting of a turn: start the clock, no email.
  const g = [{ meta: meta('fresh'), turn: 5, actor: 'Empire' }];
  const { deps, sent, metaWrites } = harness(g);
  await boundedReminderSweep(deps, { olderThanMs: OLDER, deadlineMs: 60_000 });
  check('first sighting starts the clock without emailing', sent.length === 0
    && metaWrites.length === 1 && metaWrites[0].reminder?.turn === 5 && metaWrites[0].reminder?.sent === false,
    JSON.stringify({ sent, metaWrites }));
}
{
  // Clock old enough → exactly one email, to the ACTOR, then marked sent.
  const g = [{ meta: meta('due', { reminder: { turn: 5, since: new Date(NOW - OLDER - 1000).toISOString(), sent: false } }), turn: 5, actor: 'Empire' }];
  const { deps, sent, metaWrites } = harness(g);
  await boundedReminderSweep(deps, { olderThanMs: OLDER, deadlineMs: 60_000 });
  check('a due game emails the player on the clock', sent.length === 1 && sent[0].email === 'due-empire@x.test',
    JSON.stringify(sent));
  check('and is marked sent so it cannot double-send', metaWrites.some((m) => m.reminder?.sent === true));
}
{
  // Already sent → silent. Turn advanced → clock resets instead of emailing.
  const g = [
    { meta: meta('sent', { reminder: { turn: 5, since: new Date(NOW - OLDER * 2).toISOString(), sent: true } }), turn: 5, actor: 'Rebel' },
    { meta: meta('moved', { reminder: { turn: 5, since: new Date(NOW - OLDER * 2).toISOString(), sent: true } }), turn: 6, actor: 'Rebel' },
    { meta: meta('young', { reminder: { turn: 4, since: new Date(NOW - 60_000).toISOString(), sent: false } }), turn: 4, actor: 'Rebel' },
  ];
  const { deps, sent, metaWrites } = harness(g);
  await boundedReminderSweep(deps, { olderThanMs: OLDER, deadlineMs: 60_000 });
  check('sent-already and not-yet-due games stay silent', sent.length === 0, JSON.stringify(sent));
  const movedWrite = metaWrites.find((m) => m.gameId === 'moved');
  check('a game that moved on gets a fresh clock for the new turn',
    movedWrite?.reminder?.turn === 6 && movedWrite?.reminder?.sent === false, JSON.stringify(movedWrite));
}
{
  // Game over → marked resolved, which is what lets the backlog finally drain.
  const g = [{ meta: meta('done'), turn: 9, actor: null }];
  g[0].actor = null;
  const { deps, sent, metaWrites } = harness(g);
  const r = await boundedReminderSweep(deps, { olderThanMs: OLDER, deadlineMs: 60_000 });
  check('a finished game is marked resolved', r.resolvedMarked === 1
    && metaWrites.some((m) => m.gameId === 'done' && m.resolved === true), JSON.stringify(metaWrites));
  check('and nobody is emailed about a finished game', sent.length === 0);
}

console.log('\n[ 3. one bad game cannot take down the sweep ]');
{
  const g = [
    { meta: meta('bomb'), turn: 2, actor: 'Rebel', explode: true },
    { meta: meta('after', { reminder: { turn: 7, since: new Date(NOW - OLDER - 1).toISOString(), sent: false } }), turn: 7, actor: 'Rebel' },
  ];
  const { deps, sent } = harness(g);
  const r = await boundedReminderSweep(deps, { olderThanMs: OLDER, deadlineMs: 60_000 });
  check('the game after the failure still gets its nudge', sent.length === 1 && sent[0].id === 'after',
    JSON.stringify({ r, sent }));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
