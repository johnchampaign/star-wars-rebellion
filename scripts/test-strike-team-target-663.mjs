// #663 — "The rebel ai ran the mission lead the strike team on alderaan... It
// might be just targeting the first in alphabetical order again."
//
// It was. `lead-the-strike-team` had NO case in rebelMissionTargetScore, so
// every candidate system scored identically, and the selection loop replaces
// its pick only on a STRICTLY greater score — leaving the first candidate in
// `Object.keys(G.map.systems)` order, which is alphabetical. Alderaan is first.
//
// This pins that the mission now discriminates between targets. The exact
// weights are a heuristic and may be retuned by the AI effort; these assertions
// deliberately test ORDERING (better target beats worse) rather than absolute
// numbers, so tuning doesn't break them.
//
// Run: node scripts/test-strike-team-target-663.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const MISSION = 'lead-the-strike-team';
const score = ai.rebelMissionTargetScore
  ? (G, sid) => ai.rebelMissionTargetScore(G, MISSION, sid, null)
  : null;

function game(seed, { baseGround = 4 } = {}) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.map.rebelBaseSpace.units = [];
  for (let i = 0; i < baseGround; i++) M.deployUnit(G, 'Rebel', 'rebel-trooper', 'rebel-base-space');
  return G;
}
const setSys = (G, sid, { loyalty, subjugated = false, empireGround = 0 }) => {
  const ss = G.map.systems[sid];
  ss.units = ss.units.filter((u) => u.side !== 'Empire');
  ss.loyalty = loyalty; ss.subjugated = subjugated;
  for (let i = 0; i < empireGround; i++) M.deployUnit(G, 'Empire', 'stormtrooper', sid);
  return ss;
};

if (!score) {
  console.log('  ✗ rebelMissionTargetScore is not exported — cannot score directly');
  process.exit(1);
}

console.log('\n[ #663 the mission now discriminates between systems ]');
{
  const G = game(663);
  setSys(G, 'alderaan', { loyalty: 'rebel' });                          // nothing to gain
  setSys(G, 'mustafar', { loyalty: 'imperial', subjugated: true, empireGround: 1 }); // liberate
  const a = score(G, 'alderaan'), m = score(G, 'mustafar');
  check('a subjugated system outranks a quiet Rebel one', m > a, `mustafar=${m} alderaan=${a}`);
  check('scores are not all identical (the tie that caused this)', m !== a);
}

console.log('\n[ prefers a fight it can win ]');
{
  const G = game(664, { baseGround: 4 });
  setSys(G, 'mustafar', { loyalty: 'imperial', subjugated: true, empireGround: 1 });
  setSys(G, 'kessel',   { loyalty: 'imperial', subjugated: true, empireGround: 8 });
  check('lightly-held target beats a heavily-garrisoned one',
    score(G, 'mustafar') > score(G, 'kessel'),
    `mustafar=${score(G, 'mustafar')} kessel=${score(G, 'kessel')}`);
}

console.log('\n[ pointless cases are pushed down ]');
{
  const G = game(665, { baseGround: 4 });
  setSys(G, 'mustafar', { loyalty: 'imperial', subjugated: true, empireGround: 1 });
  const remote = Object.keys(G.map.systems).find((sid) => G.catalog.systems[sid]?.isRemote);
  check('a remote system scores below a real target',
    score(G, remote) < score(G, 'mustafar'), `${remote}=${score(G, remote)}`);

  const empty = game(666, { baseGround: 0 });
  setSys(empty, 'mustafar', { loyalty: 'imperial', subjugated: true, empireGround: 1 });
  check('with no ground units at the base the mission is heavily penalised',
    score(empty, 'mustafar') < 0, `score=${score(empty, 'mustafar')}`);
}

console.log('\n[ Alderaan is no longer favoured just for being first ]');
{
  const G = game(667);
  setSys(G, 'alderaan', { loyalty: 'rebel' });
  const better = ['mustafar', 'kessel', 'rodia'].filter((s) => G.map.systems[s]);
  for (const sid of better) setSys(G, sid, { loyalty: 'imperial', subjugated: true, empireGround: 1 });
  const best = better.reduce((b, s) => (score(G, s) > score(G, b) ? s : b), better[0]);
  check('the top-scoring target is not Alderaan', score(G, best) > score(G, 'alderaan'),
    `best=${best} ${score(G, best)} vs alderaan ${score(G, 'alderaan')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
