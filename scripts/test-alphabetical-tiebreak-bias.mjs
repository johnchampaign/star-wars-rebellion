// The AI's tie-breaks must not encode the alphabet.
//
// A playtester (jocke01, on BGG) reported that the Empire "often targets
// alderaan with missions" and guessed the cause from the outside: "I think it's
// because it's first in alphabetical order." He was right, and it was two bugs
// with one root:
//
//   assets/systems.json stores systems ALPHABETICALLY, so alderaan is index 0.
//   Candidate lists are built from Object.keys(G.map.systems), which preserves
//   that order. Then:
//     - `if (s > best)` keeps the FIRST maximum          → alderaan wins ties
//     - `.sort((a,b) => b.ts - a.ts)` is STABLE, so equal scores keep input
//       order and `ranked[0]` is again the earliest name
//
// Measured over 40 RoE games, the six alphabetically-first systems (alderaan,
// bespin, bothawui, cato-neimoidia, corellia, coruscant) took 55.8% of all
// Empire mission reveals. An unbiased share for 6 of 32 systems is 18.8%.
// After randomising ties it fell to 21.0%, and the systems that gained were
// exactly the ones he said the Empire never reached — sullust, ryloth, utapau,
// ord-mantell, saleucami, rodia.
//
// That second complaint ("the empire loves shuffling fleets between ord mantel,
// cato nemodia and alderaan ... having a hard time reaching the outer reaches")
// was the SAME bug seen from the board: the Empire wasn't oscillating on
// purpose, it was re-picking the alphabetically-first of several equally-scored
// destinations every single turn.
//
// This test asserts the property directly rather than re-running a tournament:
// given candidates that all score EQUALLY, the choice must spread out. A
// first-wins tiebreak returns index 0 every time and fails immediately.
//
// Run: node scripts/test-alphabetical-tiebreak-bias.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const ai = await import('../src/play/randomAI.ts');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('\n[ the data really is stored alphabetically — the precondition ]');
{
  const sys = JSON.parse(readFileSync(join(ROOT, 'assets', 'systems.json'), 'utf8')).systems;
  const ids = sys.map((s) => s.id);
  check('systems.json is in alphabetical order',
    JSON.stringify(ids) === JSON.stringify([...ids].sort()),
    'not sorted — the bias story below may no longer apply');
  check('and alderaan is index 0', ids[0] === 'alderaan', ids[0]);
}

// The tiebreak is deterministic per position: it hashes the candidate id
// against G.rng.state, which is READ and never advanced. So the spread comes
// from the game moving on (every roll and draw changes rng.state), not from
// repeated calls to the same position. Each `state` below stands for one such
// moment in a game.
const at = (state) => ({ rng: { state } });
const CANDS = ['alderaan', 'bespin', 'bothawui', 'cato-neimoidia', 'corellia', 'coruscant'];

console.log('\n[ tied candidates spread out as the game advances ]');
{
  const N = 600;
  const seen = new Map(CANDS.map((c) => [c, 0]));
  for (let i = 0; i < N; i++) {
    // Every candidate scores identically — the ONLY thing under test is the
    // tiebreak. This is the exact call the mission-target path makes.
    const first = ai.__testArgmaxTie(at(i * 2654435761 % 4294967296), CANDS, (c) => c, () => 7).item;
    seen.set(first, seen.get(first) + 1);
  }
  const counts = CANDS.map((c) => seen.get(c));
  const expected = N / CANDS.length;
  console.log('   ' + CANDS.map((c, i) => `${c}=${counts[i]}`).join('  '));
  check('every tied candidate gets picked sometimes', counts.every((c) => c > 0),
    JSON.stringify(counts));
  check('alderaan does NOT dominate (it was 600/600 with the first-wins tiebreak)',
    seen.get('alderaan') < expected * 2, `alderaan=${seen.get('alderaan')} expected≈${expected}`);
  const worst = Math.max(...counts.map((c) => Math.abs(c - expected) / expected));
  check('the spread is roughly even (within 50%)', worst < 0.5,
    `worst deviation ${(100 * worst).toFixed(0)}%`);
}

console.log('\n[ but the SAME position always answers the same way ]');
{
  // This is why the tiebreak hashes instead of calling Math.random(): the app
  // has undo, and an AI that answered an undone-and-redone position differently
  // would be maddening — and would make every unseeded AI test a coin-flip.
  const once = ai.__testArgmaxTie(at(12345), CANDS, (c) => c, () => 7).item;
  let stable = true;
  for (let i = 0; i < 50; i++) {
    if (ai.__testArgmaxTie(at(12345), CANDS, (c) => c, () => 7).item !== once) stable = false;
  }
  check('repeating an identical position gives an identical answer', stable, `first=${once}`);
  check('and a different position can give a different answer',
    CANDS.some((_, i) => ai.__testArgmaxTie(at(999 + i * 7919), CANDS, (c) => c, () => 7).item !== once));
}

console.log('\n[ ties only — real ranking is untouched ]');
{
  let alwaysBest = true;
  for (let i = 0; i < 200; i++) {
    const r = ai.__testArgmaxTie(at(i * 7919), CANDS, (c) => c, (c) => (c === 'coruscant' ? 99 : 7));
    if (r.item !== 'coruscant' || r.score !== 99) alwaysBest = false;
  }
  check('a strictly higher score always wins', alwaysBest);

  // tieOrdered feeds a stable sort; pre-ordering must not disturb score order.
  const scores = { a: 5, b: 5, c: 9, d: 1, e: 9 };
  let monotone = true; const sawTopNines = new Set();
  for (let i = 0; i < 200; i++) {
    const ranked = ai.__testTieOrdered(at(i * 2246822519), Object.keys(scores))
      .map((k) => ({ k, s: scores[k] }))
      .sort((x, y) => y.s - x.s);
    if (ranked[0].s !== 9) monotone = false;
    sawTopNines.add(ranked[0].k);
    for (let n = 1; n < ranked.length; n++) if (ranked[n].s > ranked[n - 1].s) monotone = false;
  }
  check('the highest score always ranks first', monotone);
  check('and BOTH tied top scorers get a turn at first', sawTopNines.size === 2,
    JSON.stringify([...sawTopNines]));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
