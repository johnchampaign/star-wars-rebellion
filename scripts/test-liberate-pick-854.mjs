// #854 — "why did the rebel play hit and run and then not take out my
// stormtrooper? he is the only one who subjugates mon calamari"
//
// The reporter's board: a Rebel-loyal, subjugated Mon Calamari holding one
// Stormtrooper, one TIE Fighter and an Assault Carrier. Hit And Run ("destroy
// up to 2-health worth of units of your choice in this system") has 2 health
// to spend. The AI priced units one at a time, so the carrier (2 health, the
// best single unit) won — and the lone Stormtrooper kept the world occupied.
// Killing the trooper and the TIE instead lifts the subjugation, which hands
// Mon Calamari's icons back to the Rebel. No per-unit value can see that; the
// pick now compares "clear the garrison" as a plan of its own.
//
// Counterfactual: SWR_LIBERATE_PICK=0 restores the old pick (run this file
// with it set and the liberation checks fail, so the test is not vacuous).
//
// Run: node scripts/test-liberate-pick-854.mjs
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

function board(sysId, loyalty, unitTypes) {
  const G = createGame(data, { seed: 7 });
  const ss = G.map.systems[sysId];
  ss.units = []; ss.loyalty = loyalty; ss.sabotage = false;
  for (const t of unitTypes) M.deployUnit(G, 'Empire', t, sysId);
  M.recomputeSubjugation(G, [sysId]);
  return G;
}
function hitAndRun(G, sysId) {
  const ss = G.map.systems[sysId];
  G.pendingChoice = {
    kind: 'DestroyUpToHealth', side: 'Rebel', systemId: sysId,
    candidates: ss.units.filter((u) => u.side === 'Empire').map((u) => u.instanceId),
    budget: 2, cardName: 'Hit And Run',
  };
  ai.stepOnce(G, 'Rebel');
  M.recomputeSubjugation(G, [sysId]);
  return G.map.systems[sysId].units.map((u) => u.typeId).sort();
}

console.log('\n[ #854 — the reporter\'s Mon Calamari ]');
{
  const G = board('mon-calamari', 'rebel', ['stormtrooper', 'tie-fighter', 'assault-carrier']);
  check('setup: Mon Calamari is Rebel-loyal and subjugated', G.map.systems['mon-calamari'].subjugated === true);
  const left = hitAndRun(G, 'mon-calamari');
  console.log(`    survivors: ${left.join(', ') || '(none)'}`);
  check('the Stormtrooper dies', !left.includes('stormtrooper'), `survivors ${JSON.stringify(left)}`);
  check('Mon Calamari is no longer subjugated', G.map.systems['mon-calamari'].subjugated === false);
  check('the Assault Carrier is what is left', left.length === 1 && left[0] === 'assault-carrier',
    `survivors ${JSON.stringify(left)}`);
}

console.log('\n[ a garrison too big to clear: the carrier is still the right kill (#727) ]');
{
  const G = board('mon-calamari', 'rebel', ['stormtrooper', 'stormtrooper', 'at-st', 'assault-carrier']);
  const left = hitAndRun(G, 'mon-calamari');
  console.log(`    survivors: ${left.join(', ')}`);
  check('the Assault Carrier dies', !left.includes('assault-carrier'), `survivors ${JSON.stringify(left)}`);
  check('the world stays subjugated', G.map.systems['mon-calamari'].subjugated === true);
}

console.log('\n[ no subjugation to lift: Imperial-loyal world keeps the #727 pick ]');
{
  const G = board('mon-calamari', 'imperial', ['stormtrooper', 'tie-fighter', 'assault-carrier']);
  const left = hitAndRun(G, 'mon-calamari');
  console.log(`    survivors: ${left.join(', ')}`);
  check('the Assault Carrier dies', !left.includes('assault-carrier'), `survivors ${JSON.stringify(left)}`);
}

console.log('\n[ the target score sees it too ]');
{
  const lib = board('mon-calamari', 'rebel', ['stormtrooper', 'tie-fighter']);
  const imp = board('mon-calamari', 'imperial', ['stormtrooper', 'tie-fighter']);
  const a = ai.rebelMissionTargetScore(lib, 'hit-and-run', 'mon-calamari', null);
  const b = ai.rebelMissionTargetScore(imp, 'hit-and-run', 'mon-calamari', null);
  console.log(`    occupied Rebel-loyal=${a.toFixed(1)}  Imperial-loyal=${b.toFixed(1)}`);
  check('freeing an occupied Rebel-loyal world outscores the same units on an Imperial one', a > b, `${a} !> ${b}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
