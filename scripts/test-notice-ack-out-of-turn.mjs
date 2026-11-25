// Lobby problem report, 2026-11-25 — "my opponent played False Orders. I get a
// popup but clicking 'Got it' doesn't dismiss it."
//
// False Orders resolves at the end of Assignment and bounces a lone Imperial
// leader, posting an Empire-only notice explaining why. The game then enters
// Command, which always opens on the Rebel's turn. So the Empire reads the
// notice while it is NOT its turn — and dismissing a notice is a submitted
// action. Two gates swallowed it:
//   - the online shim (onlineEngine.makeAct) drops any action while yourTurn is
//     false, returning {ok:true}, so the click silently did nothing;
//   - the server (GameServer.submit) rejects off-turn actions unless the adapter
//     marks them allowsOutOfTurn, and Rebellion's returned false for everything.
// The notice modal covers the whole board, so the Empire was stuck behind it
// until the Rebel moved.
//
// Run: node scripts/test-notice-ack-out-of-turn.mjs
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const { makeOnlinePhases } = await import('../src/online/onlineEngine.ts');
const { GameServer, NoopNotifier } = await import('digital-boardgame-framework/server');
const { FsStore } = await import('digital-boardgame-framework/server/node');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};
const empireNotices = (G) => (G.pendingNotices ?? []).filter((n) => n.side === 'Empire');

// Play the real flow up to the reported moment: Rebel holds False Orders, the
// Empire sends one leader alone on a mission, the Rebel bounces it.
function falseOrdersGame() {
  let G = createGame(data, { seed: 9 });
  G.rebel.actionHand.push('false-orders');
  const step = (action, actor) => { G = rebellionAdapter.applyAction(G, action, actor); };
  const lone = G.empire.leaderPool[0];
  const mission = G.empire.missionHand[0];
  step({ kind: 'skipAssignment' }, 'Rebel');
  step({ kind: 'assignLeader', missionId: mission, leaderIds: [lone] }, 'Empire');
  step({ kind: 'skipAssignment' }, 'Empire');
  step({ kind: 'resolveFalseOrders', targetLeaderId: lone }, 'Rebel');
  return { G, lone };
}

console.log('\n[ the reported situation: an Empire notice on the Rebel\'s turn ]');
const { G: start, lone } = falseOrdersGame();
check('False Orders bounced the lone leader back to the Empire pool',
  start.empire.leaderPool.includes(lone));
check('the game is in Command with the Rebel to move', start.phase === 'Command'
  && rebellionAdapter.currentActor(start) === 'Rebel',
  `phase=${start.phase} actor=${rebellionAdapter.currentActor(start)}`);
check('the Empire has a False Orders notice waiting', empireNotices(start).some((n) => n.title === 'False Orders'));
check('so it is NOT the Empire\'s turn when it reads it', !rebellionAdapter.canAct(start, 'Empire'));

console.log('\n[ adapter: only notice dismissal is allowed out of turn ]');
check('acknowledgeNotices is out-of-turn safe',
  rebellionAdapter.allowsOutOfTurn({ kind: 'acknowledgeNotices' }) === true);
for (const kind of ['pass', 'acknowledgeReport', 'skipAssignment', 'resolveFalseOrders']) {
  check(`${kind} still waits for its turn`, rebellionAdapter.allowsOutOfTurn({ kind }) === false);
}

console.log('\n[ server: the Empire dismisses its notice while the Rebel is to move ]');
const dir = mkdtempSync(join(tmpdir(), 'swr-notice-'));
try {
  const codec = { encode: (s) => JSON.stringify(s), decode: (s) => JSON.parse(s) };
  const server = new GameServer({
    adapter: rebellionAdapter, codec, store: new FsStore(dir),
    notifier: new NoopNotifier(), gameUrl: (g, t) => `x/${g}?t=${t}`,
  });
  const { gameId, invites: urls } = await server.createGame({ initialState: start, players: ['Rebel', 'Empire'] });
  // Invites are the gameUrl()s built above; the seat token is the ?t= part.
  const invites = Object.fromEntries(Object.entries(urls).map(([seat, u]) => [seat, u.split('?t=')[1]]));
  const before = await server.fetch(gameId, invites.Empire);
  check('the Empire client sees the notice and is told it is not its turn',
    empireNotices(before.view).length > 0 && before.yourTurn === false);

  let err = null, after = null;
  try { after = await server.submit(gameId, invites.Empire, { kind: 'acknowledgeNotices' }); }
  catch (e) { err = e; }
  check('the server accepts the dismissal (was: "Not your turn")', !err, err?.message);
  check('the notice is gone from the Empire\'s view', after && empireNotices(after.view).length === 0);
  check('the turn still belongs to the Rebel', after && after.yourTurn === false);

  const rebel = await server.fetch(gameId, invites.Rebel);
  check('the Rebel is still to move, untouched', rebel.yourTurn === true && rebel.view.phase === 'Command');

  let passErr = null;
  try { await server.submit(gameId, invites.Empire, { kind: 'pass' }); } catch (e) { passErr = e; }
  check('a real move from the Empire is still refused out of turn',
    /not your turn/i.test(passErr?.message ?? ''), passErr?.message ?? 'accepted');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n[ client shim: the click is submitted even though yourTurn is false ]');
{
  const sent = [];
  const phases = makeOnlinePhases(async (a) => { sent.push(a.kind); }, () => false);
  phases.acknowledgeNotices(start);
  await new Promise((r) => setTimeout(r, 0));
  check('acknowledgeNotices is sent off-turn', sent.includes('acknowledgeNotices'), JSON.stringify(sent));
  phases.pass(start, 'Empire');
  await new Promise((r) => setTimeout(r, 0));
  check('other actions are still held back off-turn', !sent.includes('pass'), JSON.stringify(sent));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
