// #840 / #841 (mrvvfh, playing Empire): "why on earth would the rebel choose any
// other planet to build an alliance than utapau? ... a mon cal in turn one is
// the most important troop to get for later" and "getting loyalty would prevent
// me from getting a sd there". Replayed from both reporters' turn-1 Command
// boards (scripts/fixtures/rebel-loyalty-yield-84{0,1}.json, the game logs'
// turn-1 snapshots with the recorded assignments applied).
//
// SWR_REBEL_LOYALTY_YIELD prices what a Rebel-loyal flip builds for the Rebel
// and, from neutral, what it stops the Empire claiming with one gain.
//
// Pins: Build Alliance now aims at Utapau on both boards (Nal Hutta / Geonosis
// before); no yield on a world that is already Rebel-loyal, a subjugated one,
// or one a single gain cannot flip; and the =0 control reproduces the old picks.
// Run: node scripts/test-rebel-loyalty-yield-840.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });
const board = (n) => codec.decode(readFileSync(join(ROOT, `scripts/fixtures/rebel-loyalty-yield-${n}.json`), 'utf8'), catalog);
const CONTROL = process.argv[2] === '--control';
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
/** The Build Alliance target the Rebel's candidate list leads with. */
const pick = (G) => AI.bestCommandAction(G, 'Rebel').find((a) => a.missionId === 'build-alliance')?.targetSystemId;
const score = (G, sid) => AI.rebelMissionTargetScore(G, 'build-alliance', sid, null);

if (CONTROL) {
  console.log(`PICK=${pick(board(840))},${pick(board(841))}`);
  process.exit(0);
}

console.log('[ #840: base Ilum, Support of the Hutts held, nothing Imperial next to Utapau ]');
check('Build Alliance aims at Utapau', pick(board(840)) === 'utapau', `pick=${pick(board(840))}`);
console.log('\n[ #841: base Nal Hutta ]');
check('Build Alliance aims at Utapau', pick(board(841)) === 'utapau', `pick=${pick(board(841))}`);

console.log('\n[ the yield only counts when the flip is real ]');
{
  const G = board(840);
  const before = score(G, 'utapau');
  G.map.systems.utapau.loyalty = 'rebel';
  check('already Rebel-loyal: no yield (the -30 waste penalty stands)', score(G, 'utapau') < before - 30);
}
{
  const G = board(840), H = board(840);
  H.map.systems.utapau.subjugated = true;
  check('subjugated: no yield', score(H, 'utapau') < score(G, 'utapau'));
}
{
  const G = board(840), H = board(840);
  H.map.systems.utapau.loyalty = 'imperial';
  check('Imperial-loyal: one gain cannot flip it, so no yield', score(H, 'utapau') < score(G, 'utapau') - 15);
}

console.log('\n[ counterfactual: SWR_REBEL_LOYALTY_YIELD=0 ]');
const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--control'], {
  env: { ...process.env, SWR_REBEL_LOYALTY_YIELD: '0' }, encoding: 'utf8',
});
check('flag off reproduces the reported picks (Nal Hutta / Geonosis)', /PICK=nal-hutta,geonosis/.test(out), out.trim());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
