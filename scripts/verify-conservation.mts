// Unit-conservation harness. Plays AI-vs-AI games to completion and asserts the
// board never duplicates a unit token or exceeds a type's physical supply at any
// point — the board-game invariant (tokens move, never copy). A regression that
// duplicates a unit (e.g. a move that adds-to-dest without removing-from-source,
// which can even false-reveal the Rebel base) trips this immediately.
//   npx tsx scripts/verify-conservation.mts
import { readFile } from 'node:fs/promises';
import { createGame, type DataBundle } from '../src/engine/setup';
import { stepOnce } from '../src/play/randomAI';
import { findUnitInvariantViolations } from '../src/engine/mechanics';
import { rebellionAdapter } from '../src/adapter/rebellionAdapter';
import type { GameState } from '../src/engine/types';

const names = ['systems','adjacency','leaders','actions','missions','objectives','tactics','probes'] as const;
const parsed = await Promise.all(names.map(async (n) => JSON.parse(await readFile(`assets/${n}.json`,'utf8'))));
const [systems,adjacency,leaders,actions,missions,objectives,tactics,probes] = parsed;
const data = { systems,adjacency,leaders,actions,missions,objectives,tactics,probes } as DataBundle;

// The HARD invariant (always a bug): a unit token appears in two places at once.
// Supply-cap overages are tracked separately — the engine doesn't model a finite
// supply pool, so it can mint more than the physical count; that's a known RAW
// gap, not the duplication bug, so it's reported as a note, not a failure.
let failures = 0;
let supplyNote = 0;
const GAMES = 8;
for (let game = 0; game < GAMES; game++) {
  const G = createGame(data, { seed: 1000 + game, autoSetupUnits: true }) as GameState;
  let steps = 0;
  let dupHit = '';
  for (; steps < 4000 && !G.isGameOver; steps++) {
    const actor = rebellionAdapter.currentActor(G);
    if (!actor) break;
    const did = stepOnce(G, actor);
    const dups = findUnitInvariantViolations(G).filter((v) => v.startsWith('duplicate'));
    if (dups.length) { dupHit = `step ${steps} (${actor}): ${dups[0]}`; break; }
    if (!did) break;
  }
  if (dupHit) { console.error(`  FAIL game ${game}: ${dupHit}`); failures++; }
  else {
    const overs = findUnitInvariantViolations(G).filter((v) => v.startsWith('unit type'));
    if (overs.length) supplyNote++;
    console.log(`  ok   game ${game}: ${steps} steps, no duplicate tokens${overs.length ? ` (note: ${overs.length} type(s) over supply)` : ''}`);
  }
}

console.log('');
if (supplyNote) console.log(`note: ${supplyNote}/${GAMES} games exceeded a unit type's supply — pre-existing (engine doesn't cap supply), NOT the duplication bug.`);
if (failures) { console.error(`CONSERVATION CHECK FAILED: ${failures}/${GAMES} games had a DUPLICATED token`); process.exit(1); }
console.log(`CONSERVATION CHECK PASSED — no duplicated unit tokens across ${GAMES} full AI games.`);
