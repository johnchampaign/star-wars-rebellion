// @timeout 180000
// #796 (danithaca): "Dump full game logs and messages at game end" — to feed
// the whole game to an AI and get its story back. A "Download log" button (log
// panel, and the game-over screen) saves src/play/logExport.ts's text.
//
// Pins: the text is readable (names, not ids; round headings; no state blobs),
// it never shows more than the on-screen log (the same visibility rules —
// hidden kinds omitted, an opponent's secrets "(private)", draws as counts),
// and online games get the chat appended.
// Run: node scripts/test-log-export-796.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');
const { buildReadableLog, readableEntry } = await import('../src/play/logExport.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// A stand-in for PlayTab's logVisibility (the real one is checked by the
// tripwire at the bottom): hide bookkeeping, make the opponent's assignments
// private, show draws as counts.
const HUMAN = 'Empire';
const vis = {
  visible: (e) => !['state', 'choice-request', 'ai-decision', 'draw-tactic'].includes(e.kind),
  redacted: (e) => !!e.side && e.side !== HUMAN && ['assign-leader', 'unassign-leader'].includes(e.kind),
  countOnly: (e) => ['draw-action', 'draw-mission', 'draw-objective', 'draw-probe'].includes(e.kind),
};

// Play a couple of rounds, AI on both sides.
const G = createGame(data, { seed: 796, autoSetupUnits: true });
let steps = 0;
while (!G.isGameOver && G.timeMarker < 3 && steps++ < 3000) {
  const owner = G.pendingChoice?.side ?? G.currentPlayer;
  if (ai.stepOnce(G, owner)) continue;
  if (ai.stepOnce(G, owner === 'Rebel' ? 'Empire' : 'Rebel')) continue;
  break;
}
check('the game produced a real log', G.turnLog.length > 100, `entries=${G.turnLog.length} round=${G.timeMarker}`);

console.log('[ readable ]');
const text = buildReadableLog(G, { humanSide: HUMAN, vis, now: new Date('2026-10-03T12:00:00Z') });
check('it has a header naming your side', text.includes('You played the Empire. Opponent: the Rebel (the computer).'));
check('it is split into rounds', /=== Round 1 ===/.test(text) && /=== Round 2 ===/.test(text));
const leaderIdUsed = Object.keys(G.catalog.leaders).find((id) => JSON.stringify(G.turnLog).includes(`"${id}"`));
const leaderName = leaderIdUsed ? G.catalog.leaders[leaderIdUsed].name : null;
check('leader ids are turned into names', !!leaderName && text.includes(leaderName), `id=${leaderIdUsed}`);
check('system ids are turned into names', text.includes('Coruscant'));
check('no state snapshots leak in', !text.includes('codec') && !text.includes('rebellion-state-v1'));

console.log('[ never more than the on-screen log ]');
const assign = G.turnLog.find((e) => e.kind === 'assign-leader' && e.side === 'Rebel');
check('an opponent assignment reads "(private)"', !!assign && readableEntry(G, assign, vis) === 'Rebel · assign leader (private)', assign && readableEntry(G, assign, vis));
const draw = G.turnLog.find((e) => e.kind === 'draw-mission' || e.kind === 'draw-action');
check('a card draw shows only the count', !!draw && /drew \d+ \(which cards is hidden\)/.test(readableEntry(G, draw, vis)) && !readableEntry(G, draw, vis).includes(String((draw.payload?.cardIds ?? draw.payload?.missionIds ?? [])[0] ?? '§')), draw && readableEntry(G, draw, vis));
check('hidden kinds are left out entirely', !/\bai decision\b|\bchoice request\b/.test(text));

check('the real visibility rules hide the setup entry\'s base from the Empire', /\|\| \(e\.kind === 'setup' && humanSide === 'Empire'\)/.test(readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8')));
const setupEntry = G.turnLog.find((e) => e.kind === 'setup');
const empireVis = { ...vis, redacted: (e) => vis.redacted(e) || e.kind === 'setup' };
check('with that rule the setup line names no base', !!setupEntry && readableEntry(G, setupEntry, empireVis) === 'setup (private)' && !buildReadableLog(G, { humanSide: HUMAN, vis: empireVis }).includes('base system'), setupEntry && readableEntry(G, setupEntry, empireVis));

console.log('[ online: chat is included ]');
const online = buildReadableLog(G, { humanSide: HUMAN, vis, online: true, chat: [{ seat: 'Rebel', body: 'Endor. How appropriate.', at: '2026-10-02T10:00:00.000Z' }] });
check('the opponent is "another player"', online.includes('Opponent: the Rebel (another player).'));
check('the chat section lists the message', /=== Chat ===\n\[2026-10-02 10:00\] Rebel: Endor\. How appropriate\./.test(online));
const broken = buildReadableLog(G, { humanSide: HUMAN, vis, online: true, chatError: 'HTTP 500' });
check('a chat that will not load says so instead of failing', broken.includes('(chat could not be loaded: HTTP 500)'));
const local = buildReadableLog(G, { humanSide: HUMAN, vis });
check('a local game has no chat section', !local.includes('=== Chat ==='));

console.log('[ tripwires ]');
const src = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
check('the log panel and the download share one visibility function', /const vis = logVisibility\(humanSide\);/.test(src) && /vis: logVisibility\(humanSide\)/.test(src));
check('the log panel offers "Download log"', />\s*Download log\s*</.test(src));
check('the game-over screen offers "Download game log"', />\s*Download game log\s*</.test(src));
check('online games pass the chat in', /submit, fetchChat \}\}/.test(readFileSync(join(ROOT, 'src/online/OnlinePlay.tsx'), 'utf8')));

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
