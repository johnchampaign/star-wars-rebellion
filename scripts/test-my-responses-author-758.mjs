// @timeout 60000
// SECURITY — only the maintainer's words may be shown to a player in-game.
//
// /api/my-responses feeds the "your report was answered" modal: it picks a
// comment off the closed GitHub issue and PlayTab renders that text to the
// person who filed the report, as though the project wrote it. It used to take
// "the newest comment that isn't a bot or a screenshot notice", with no check
// on WHO wrote it. Every from-game issue is public, so any GitHub account could
// comment after a closure and have their text delivered inside the game.
//
// Not hypothetical: while #758 was open, an account with no association to the
// repo posted a fabricated "technical proposal" on it (it cited three source
// files that do not exist). That issue happened to be closed with a maintainer
// comment afterwards, so nothing reached the player — ordering was the only
// thing protecting us. Note that hiding/minimising a comment on GitHub does NOT
// drop it from the REST listing this endpoint reads, so moderation cannot
// substitute for this filter.
//
// Run: node scripts/test-my-responses-author-758.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { pickResolutionComment } = await import('../functions/api/my-responses.ts');
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const OWNER = 'johnchampaign';
const c = (o) => ({ body: o.body, user: { login: o.login ?? 'someone', type: o.type ?? 'User' }, author_association: o.assoc ?? 'NONE', created_at: o.at });

console.log('[ the #758 shape: a stranger comments, we still show OUR reply ]');
{
  const comments = [
    c({ body: 'our closing reply to the player', login: OWNER, assoc: 'OWNER', at: '2026-09-10T19:54:00Z' }),
    c({ body: 'Technical Proposal - Fix AI target validation...', login: 'OgK1lua', assoc: 'NONE', at: '2026-09-10T19:14:00Z' }),
  ];
  check('the maintainer comment is chosen', pickResolutionComment(comments, OWNER) === 'our closing reply to the player');
  // The dangerous ordering: the stranger comments LAST.
  const after = [...comments, c({ body: 'stranger text posted after closure', login: 'OgK1lua', assoc: 'NONE', at: '2026-09-11T08:00:00Z' })];
  check('a stranger commenting AFTER the closure does not displace it', pickResolutionComment(after, OWNER) === 'our closing reply to the player',
    String(pickResolutionComment(after, OWNER)));
}

console.log('[ it fails CLOSED ]');
{
  const strangersOnly = [c({ body: 'please assign this to me', login: 'nobody', assoc: 'NONE', at: '2026-09-10T19:14:00Z' })];
  check('no maintainer comment yields null (client then shows no modal)', pickResolutionComment(strangersOnly, OWNER) === null);
  check('an empty thread yields null', pickResolutionComment([], OWNER) === null);
  check('CONTRIBUTOR is not a maintainer (an outside PR author is still the public)',
    pickResolutionComment([c({ body: 'x', login: 'drive-by', assoc: 'CONTRIBUTOR', at: '2026-09-10T19:14:00Z' })], OWNER) === null);
}

console.log('[ the pre-existing exclusions still hold ]');
{
  const withNoise = [
    c({ body: 'the real reply', login: OWNER, assoc: 'OWNER', at: '2026-09-10T10:00:00Z' }),
    c({ body: 'Screenshot for problem report 2026-09-10T15-13-32', login: OWNER, assoc: 'OWNER', at: '2026-09-10T11:00:00Z' }),
    c({ body: 'beep boop', login: 'github-actions', type: 'Bot', assoc: 'OWNER', at: '2026-09-10T12:00:00Z' }),
  ];
  check('screenshot notices and bots are still skipped, newest maintainer text wins', pickResolutionComment(withNoise, OWNER) === 'the real reply',
    String(pickResolutionComment(withNoise, OWNER)));
  const two = [
    c({ body: 'older', login: OWNER, assoc: 'OWNER', at: '2026-09-01T10:00:00Z' }),
    c({ body: 'newer', login: OWNER, assoc: 'OWNER', at: '2026-09-09T10:00:00Z' }),
  ];
  check('among maintainer comments the newest is used', pickResolutionComment(two, OWNER) === 'newer');
}

console.log('[ owner-login fallback, if GitHub omits the association ]');
{
  const noAssoc = [{ body: 'reply', user: { login: 'JohnChampaign', type: 'User' }, created_at: '2026-09-10T10:00:00Z' }];
  check('login matching the repo owner is accepted, case-insensitively', pickResolutionComment(noAssoc, OWNER) === 'reply');
  check('and a different login is not', pickResolutionComment([{ ...noAssoc[0], user: { login: 'someone-else', type: 'User' } }], OWNER) === null);
}

console.log('[ tripwire: the endpoint and the client must keep using this ]');
{
  const src = readFileSync(join(ROOT, 'functions/api/my-responses.ts'), 'utf8');
  check('the handler routes through pickResolutionComment', /response = pickResolutionComment\(comments, repo\.split\('\/'\)\[0\]/.test(src));
  check('the owner is derived from the configured repo, not hardcoded', !/'johnchampaign'/.test(src));
  const pt = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
  check('the client still drops entries with no response (the fail-closed half)', /\.filter\(\(r\) => r\.response && !seen\.has\(r\.number\)\)/.test(pt));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
