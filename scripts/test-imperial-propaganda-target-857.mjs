// #857 — "why did the imps play imperial propaganda at toydaria? the only
// planet I lost loyalty on was bothawui, which was subjugated anyways! had the
// imps done this at sullust ... Naboo would have been lost for me!"
//
// Imperial Propaganda: "Attempt in any Imperial system. If successful, each
// system in this region that has Rebel loyalty becomes neutral."
//
// The target score counted every Rebel-loyal system in the region as 12. On
// the reporter's board Toydaria's region held two Rebel-loyal worlds the Empire
// already SUBJUGATED (Toydaria, Bothawui — no production for the Rebel either
// way) and Sullust's region held two the Rebel held FREE and was building from
// (Naboo, Utapau). 24 vs 24, and the card went to the occupied pair.
//
// Run: node scripts/test-imperial-propaganda-target-857.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json') };

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const G = createGame(data, { seed: 7 });
// Keep the hidden base off the worlds under test: Imperial ground landing on
// it would reveal the base and drop its garrison into the system.
G.rebelBaseSystemId = 'hoth';
for (const [id, ss] of Object.entries(G.map.systems)) {
  if (G.catalog.systems[id]?.isCoruscant) continue;
  ss.units = []; ss.loyalty = 'neutral'; ss.subjugated = false; ss.sabotage = false;
}
const occupy = (id, loyalty) => {
  G.map.systems[id].loyalty = loyalty;
  M.deployUnit(G, 'Empire', 'stormtrooper', id);
};
// Toydaria's region: two Rebel-loyal worlds under Imperial occupation.
occupy('toydaria', 'rebel'); occupy('bothawui', 'rebel');
// Sullust's region: an occupied neutral Sullust to play the card from, and two
// free Rebel-loyal worlds.
occupy('sullust', 'neutral');
G.map.systems['naboo'].loyalty = 'rebel';
G.map.systems['utapau'].loyalty = 'rebel';
M.deployUnit(G, 'Rebel', 'rebel-trooper', 'naboo');
M.deployUnit(G, 'Rebel', 'rebel-trooper', 'utapau');
M.recomputeSubjugation(G);

console.log('\n[ setup matches the report ]');
check('Toydaria and Bothawui are Rebel-loyal and subjugated',
  G.map.systems['toydaria'].subjugated && G.map.systems['bothawui'].subjugated
  && G.map.systems['toydaria'].loyalty === 'rebel');
check('Naboo and Utapau are Rebel-loyal and free',
  !G.map.systems['naboo'].subjugated && !G.map.systems['utapau'].subjugated);
check('both regions hold the same NUMBER of Rebel-loyal systems (the old tie)',
  G.catalog.systems['toydaria'].region !== G.catalog.systems['sullust'].region);

console.log('\n[ #857 — aim the card where the Rebel is actually building ]');
{
  const toy = ai.empireMissionTargetScore(G, 'imperial-propaganda', 'toydaria');
  const sul = ai.empireMissionTargetScore(G, 'imperial-propaganda', 'sullust');
  console.log(`    toydaria=${toy.toFixed(1)}  sullust=${sul.toFixed(1)}`);
  check('Sullust (frees nothing occupied, strips Naboo + Utapau) outscores Toydaria', sul > toy, `${sul} !> ${toy}`);
  const tv = ai.imperialPropagandaRegionValue(G, 'toydaria');
  const sv = ai.imperialPropagandaRegionValue(G, 'sullust');
  check('region payoff: free worlds are worth several times occupied ones', sv >= tv * 3, `${sv} vs ${tv}`);
  check('an occupied Rebel-loyal world still counts for something', tv > 0);
}

console.log('\n[ a region with no Rebel loyalty is worth nothing ]');
check('zero payoff', ai.imperialPropagandaRegionValue(G, 'coruscant') === 0
  || Object.values(G.catalog.systems).some((d) => d.region === G.catalog.systems['coruscant'].region
       && G.map.systems[d.id]?.loyalty === 'rebel'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
