// #819 (danithaca): "a 'Player Note' feature, similar to what BoardGameArena
// has, that allows users to write down some thoughts particularly about the
// current game. This is useful for async player-player game to help keep
// track of things."
//
// John chose on-device notes (2026-10-25): private per game, stored in this
// browser only, never sent anywhere — so the opponent can never see them.
// Pins: the panel is rendered and keyed per game (the server's id online, the
// local game id otherwise); online games pass their id in; nothing that leaves
// the device (problem reports, log uploads, the downloadable log, the online
// submit path) reads the notes.
// Run: node scripts/test-player-notes-819.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const play = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
const online = readFileSync(join(ROOT, 'src/online/OnlinePlay.tsx'), 'utf8');

console.log('[ the notes panel ]');
check('a "My notes" panel is rendered in the game view', /<PlayerNotes storageKey=\{/.test(play) && /My notes/.test(play));
check('it says the notes are private to this device', /kept only on this device, your opponent never sees them/.test(play));
check('online notes are keyed by the server\'s game id', /`\$\{LS_NOTES_PREFIX\}online:\$\{online\.gameId\}`/.test(play));
check('single-player notes are keyed by the local game id', /localStorage\.getItem\(LS_GAME_ID\); return id \? `\$\{LS_NOTES_PREFIX\}\$\{id\}`/.test(play));
check('the online page passes its game id in', /submit, fetchChat, gameId \}\}/.test(online));
check('saving goes through the storage-full guard', /if \(text\) ok = lsSetMakingRoom\(storageKey, text\)/.test(play));

console.log('[ notes never leave the device ]');
{
  // Only the PlayerNotes component and the key builder may touch the prefix.
  const uses = play.split('\n').filter((l) => l.includes('LS_NOTES_PREFIX') || l.includes('rebellion-notes:'));
  check('the notes key is used only by the notes panel', uses.length === 3, uses.join(' | '));
  const sendersDir = ['src/play', 'src/online', 'src/adapter', 'functions/api', 'functions/_lib'];
  let leak = [];
  for (const d of sendersDir) {
    for (const f of readdirSync(join(ROOT, d)).filter((x) => /\.(ts|tsx)$/.test(x))) {
      if (f === 'PlayTab.tsx') continue;
      const src = readFileSync(join(ROOT, d, f), 'utf8');
      if (/rebellion-notes:|LS_NOTES_PREFIX|PlayerNotes/.test(src)) leak.push(`${d}/${f}`);
    }
  }
  check('no report, upload, export or online code reads them', leak.length === 0, leak.join(', '));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
