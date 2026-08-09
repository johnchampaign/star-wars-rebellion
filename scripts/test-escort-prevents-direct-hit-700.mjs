// #700 — "it claims a red special (saber cross) is blocked by the rebel combat
// card escort. Escort with a rebel transport does the following effect: Cancel
// 1 black hit, red hit and direct hit. Not special."
//
// He was right, and the card scans settle it:
//
//   images/Escort_s.png                "Prevent 1 red hit, 1 black hit, and
//                                       1 direct hit."
//   images/Overwhelming Presence_s.png "Prevent 2 red hits and 1 direct hit."
//
// Both had been transcribed into assets/tactics.json as "1 special", and the
// prevention machinery carried a red/black/SPECIAL channel with a comment
// asserting "No card in the RoE set prevents direct hits". Two do. So the
// engine removed a star the card cannot touch, and left standing the direct hit
// it should have removed — twice wrong on the same die roll.
//
// This was invisible until #698 started showing WHICH dice were prevented,
// which is how the reporter caught it.
//
// All six prevention cards were re-checked against their scans while fixing
// this; the other four (Fleet Logistics, Reinforcements, Armored Patrol, Take
// Cover) are red/black only and were transcribed correctly. NO card prevents a
// star, so there is no special channel any more.
//
// Run: node scripts/test-escort-prevents-direct-hit-700.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const combat = await import('../src/engine/combat.ts');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const die = (color, face) => ({ color, face });
const faces = (ds) => ds.map((d) => `${d.color}:${d.face}`).join(', ');

if (typeof combat.applyCinematicPrevent !== 'function') {
  console.log('  ✗ applyCinematicPrevent is not exported — cannot test');
  process.exit(1);
}

console.log('\n[ #700 a star is NEVER prevented — no card in the set can do it ]');
{
  // Escort's own numbers: 1 red, 1 black, 1 direct hit.
  const dice = [die('red', 'special'), die('red', 'hit'), die('black', 'hit')];
  const { kept, removed, removedDice } = combat.applyCinematicPrevent(dice,
    { red: 1, black: 1, directHit: 1 });
  check('the red star SURVIVES', kept.some((d) => d.face === 'special'), faces(kept));
  check('no star appears among the prevented dice',
    !removedDice.some((d) => d.face === 'special'), faces(removedDice));
  check('the red hit and black hit are still prevented',
    removed.red === 1 && removed.black === 1, JSON.stringify(removed));
}

console.log('\n[ a direct hit IS prevented when the card says so ]');
{
  const dice = [die('red', 'direct-hit'), die('black', 'hit')];
  const { kept, removed, removedDice } = combat.applyCinematicPrevent(dice,
    { red: 1, black: 1, directHit: 1 });
  check('the direct hit is removed', removed.directHit === 1, JSON.stringify(removed));
  check('it shows up in the prevented dice for the UI',
    removedDice.some((d) => d.face === 'direct-hit'), faces(removedDice));
  check('nothing survives that should not', kept.length === 0, faces(kept));
}

console.log('\n[ RAW #671 still holds: a plain "prevent N hits" leaves direct hits alone ]');
{
  // The rulebook's own worked example — prevent 2 black HITS against
  // 3 black hit / 1 red hit / 1 black direct hit.
  const dice = [die('black', 'hit'), die('black', 'hit'), die('black', 'hit'),
    die('red', 'hit'), die('black', 'direct-hit')];
  const { kept, removed } = combat.applyCinematicPrevent(dice,
    { red: 0, black: 2, directHit: 0 });
  check('exactly 2 black hits removed', removed.black === 2, JSON.stringify(removed));
  check('no direct hit removed without a direct-hit channel', removed.directHit === 0);
  check('the black direct hit survives',
    kept.some((d) => d.color === 'black' && d.face === 'direct-hit'), faces(kept));
  check('1 black hit and 1 red hit survive with it', kept.length === 3, faces(kept));
}

console.log('\n[ the two cards carry the corrected numbers ]');
{
  const tactics = JSON.parse(readFileSync(join(ROOT, 'assets/tactics.json'), 'utf-8')).tactics;
  const byId = Object.fromEntries(tactics.map((t) => [t.id, t]));
  for (const id of ['cin-rebel-space-escort', 'cin-empire-space-overwhelming-presence']) {
    const txt = `${byId[id]?.rulesText ?? ''} ${byId[id]?.primaryText ?? ''}`;
    check(`${id} says "direct hit"`, /direct hit/i.test(txt), txt);
    check(`${id} no longer says "special"`, !/special/i.test(txt), txt);
  }
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
