// Provenance tag on in-game problem reports.
//
// WHY THIS EXISTS: every report filed by the in-game "Report a problem" button
// is created with the repo owner's API token, so GitHub shows `johnchampaign`
// as the author of all of them. The `from-game` label is supposed to mark them,
// but labels don't render in GitHub's notification emails — which is where they
// actually get read. #714 was consequently mistaken for a duplicate that we had
// filed ourselves while fixing #676. The title is the one field that survives
// every surface, so provenance goes there.
//
// Two things have to hold, and they are separate failure modes:
//
//   1. The tag round-trips. /api/my-responses shows the issue title back to the
//      reporter in a modal; it must strip the tag, or the player reads
//      "[player 0rrh3z] my bug" in their own reply. A strip regex that drifts
//      from the emit format fails silently and only the player sees it.
//
//   2. The two emit paths agree. functions/api/report.ts (production) and the
//      vite.config.ts dev middleware are hand-mirrored — Cloudflare functions
//      and vite config can't share a module without new build risk for four
//      lines. They have ALREADY drifted once: the dev path dropped reporterId
//      entirely, so dev-filed reports carried no `<!-- reporter:... -->` tag and
//      /api/my-responses could never match them back to their reporter. This is
//      a tripwire for the next such drift.
//
// Run: node scripts/test-report-player-tag.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const reportSrc = read('functions/api/report.ts');
const viteSrc = read('vite.config.ts');
const respSrc = read('functions/api/my-responses.ts');

// Pull the REAL strip regex out of my-responses.ts rather than restating it —
// restating it here would let the source drift while the test stayed green.
const stripLiteral = respSrc.match(/title:\s*issue\.title\.replace\((\/.*?\/)\s*,/)?.[1];
const strip = stripLiteral ? new RegExp(stripLiteral.slice(1, -1)) : null;

// Mirror of the emit format. Asserted against both sources below, so this can't
// silently disagree with what actually ships.
const titleOf = (description, reporterId) => {
  const rid = (reporterId || '').replace(/[^a-zA-Z0-9-]/g, '');
  const tag = rid ? `[player ${rid.slice(0, 6)}]` : '[player]';
  return `${tag} ${description.split('\n')[0].slice(0, 80) || 'Problem report'}`;
};

console.log('\n[ the tag marks provenance in the title ]');
{
  const t = titleOf('Rebels scored regional support on Coruscant', '0rrh3zbvutm6ay8g');
  check('title carries a [player] tag', t.startsWith('[player '), t);
  check('and a short reporter hash', t.startsWith('[player 0rrh3z]'), t);
  check('the full reporter id is NOT in the title', !t.includes('0rrh3zbvutm6ay8g'), t);
  check('the description survives', t.includes('Rebels scored regional support'), t);

  const anon = titleOf('something broke', '');
  check('a report with no reporter id still gets tagged', anon === '[player] something broke', anon);
}

console.log('\n[ my-responses strips it before showing the reporter their own title ]');
{
  check('a strip regex was found in my-responses.ts', strip !== null, 'no .replace(/.../) on issue.title');
  if (strip) {
    for (const [desc, rid] of [
      ['Rebels scored regional support on Coruscant', '0rrh3zbvutm6ay8g'],
      ['something broke', ''],
      ['Yoda froze the game', 'AB-12cd'],
    ]) {
      const stripped = titleOf(desc, rid).replace(strip, '');
      check(`round-trips clean for ${JSON.stringify(rid || '(none)')}`,
        stripped === desc, `got ${JSON.stringify(stripped)}`);
    }
    // The modal shows historical issues too — titles filed before this change
    // have no tag and must pass through untouched.
    const legacy = 'An old report from before the tag existed';
    check('legacy untagged titles are left alone', legacy.replace(strip, '') === legacy);
    // And it must not eat a bracket the player themselves typed.
    const bracketed = '[bug] the map is wrong';
    check('a player-typed [bracket] is not mistaken for the tag',
      bracketed.replace(strip, '') === bracketed, bracketed.replace(strip, ''));
  }
}

console.log('\n[ tripwire: production and dev report paths still agree ]');
{
  // Both must build the title the same way and both must emit the reporter tag.
  for (const [name, src] of [['functions/api/report.ts', reportSrc], ['vite.config.ts', viteSrc]]) {
    check(`${name}: sanitizes reporterId`,
      /replace\(\/\[\^a-zA-Z0-9-\]\/g, ''\)/.test(src));
    check(`${name}: builds the [player ...] title tag`,
      /\[player \$\{reporterId\.slice\(0, 6\)\}\]/.test(src) && /'\[player\]'/.test(src));
    check(`${name}: emits the <!-- reporter:... --> body tag`,
      /<!-- reporter:\$\{reporterId\} -->/.test(src));
    check(`${name}: title is tag + first line, capped at 80`,
      /\$\{titleTag\} \$\{description\.split\('\\n'\)\[0\]\.slice\(0, 80\)/.test(src));
  }
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
