// #784 (jniabn, Android Chrome): "The Ai is not advancing the tur." Not
// reproduced, but the report carried the PREVIOUS game's id on a fresh setup
// board — New game's storage writes had been refused. archiveCompletedGame packs
// finished games (median ~390 KB, up to 1.2 MB each) right up to the quota, after
// which every write that grows storage fails silently: the resume save stopped
// updating (a phone reload then restores an older board, or none) and New game
// could throw part-way through.
//
// The fix routes the writes that matter through lsSetMakingRoom (shed archived
// games, uploaded first, then oldest, and retry) and drops uploaded games from
// the archive. It was verified live in the browser with storage filled to the
// quota; this tripwire keeps those writes from drifting back to raw setItem.
// Run: node scripts/test-storage-headroom-784.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ #784 — storage writes that matter make room instead of failing silently ]');
for (const key of ['LS_CURRENT', 'LS_HUMAN_SIDE', 'LS_GAME_ID', 'LS_SIDE_PREF', 'LS_UPLOADED']) {
  const raw = src.match(new RegExp(`localStorage\\.setItem\\(${key}\\b`, 'g')) ?? [];
  check(`no raw localStorage.setItem(${key}, …) — use lsSetMakingRoom`, raw.length === 0, `${raw.length} raw write(s)`);
  check(`  …and it is written through lsSetMakingRoom`, new RegExp(`lsSetMakingRoom\\(${key}\\b`).test(src));
}
check('the helper sheds already-uploaded games before the rest',
  /\.\.\.oldestFirst\.filter\(\(i\) => uploaded\.has/.test(src) && /\.\.\.oldestFirst\.filter\(\(i\) => !uploaded\.has/.test(src));
check('archiving drops games that were already uploaded',
  /const uploaded = readUploadedIds\(\);\s*\n\s*for \(let i = history\.length - 1; i >= 0; i--\) if \(uploaded\.has\(history\[i\]\.encodedAt\)\) history\.splice\(i, 1\);/.test(src));
check('a successful upload removes the sent games from the archive',
  /const remaining = allGames\.filter\(\(g\) => !next\.has\(g\.encodedAt\)\);/.test(src));
check('import refuses to resume a stale save when its write is refused',
  /if \(!lsSetMakingRoom\(LS_CURRENT, obj\.codec\)\)/.test(src));

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
