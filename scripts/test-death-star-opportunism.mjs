// Death Star opportunism (#539; jocke01: unsupported DS next to 6 fighters,
// plans in hand, no attack). With a death-star-plans objective held and 2+
// fighters bringable, the Rebel activation score for the DS system gets +18 —
// the DS rolls 4 RED dice (can't damage black-health fighters) and every
// round with a surviving fighter is another 3-dice plans attempt.
// Run: node scripts/test-death-star-opportunism.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const DS_SYS = 'mustafar';
const NEIGHBOR = 'kessel'; // adjacent to mustafar? verified below via adjacency

const build = (withPlans) => {
  const G = createGame(data, { seed: 4, autoSetupUnits: true });
  // Find a neighbor of the DS system for the fighter wing.
  const adj = (G.catalog.adjacency[DS_SYS] ?? [])[0];
  // Lone Death Star, no escort.
  M.deployUnit(G, 'Empire', 'death-star', DS_SYS);
  // Six Rebel fighters one hop away, no Rebel leader there (leader-blocked
  // systems can't send units).
  for (let i = 0; i < 6; i++) M.deployUnit(G, 'Rebel', 'x-wing', adj);
  G.rebel.leadersOnBoard[adj] = [];
  G.rebel.objectiveHand = withPlans ? ['death-star-plans-2'] : [];
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  return { G, adj };
};

const activateScore = (G) => {
  const acts = AI.bestCommandAction(G, 'Rebel');
  const a = acts.find((x) => x.kind === 'activate' && x.targetSystemId === DS_SYS);
  return a ? a.score : -Infinity;
};

console.log('[ +18 differential when plans are held ]');
{
  const withPlans = activateScore(build(true).G);
  const without = activateScore(build(false).G);
  check('activation is a candidate at all', withPlans > -Infinity && without > -Infinity,
    `with=${withPlans} without=${without}`);
  check('plans-in-hand adds the opportunism bonus (+18)', withPlans - without >= 17,
    `with=${withPlans} without=${without} diff=${(withPlans - without).toFixed(1)}`);
}

console.log('\n[ no bonus without fighters in range ]');
{
  const { G, adj } = build(true);
  // Swap the fighters for corvettes (not class fighter).
  G.map.systems[adj].units = G.map.systems[adj].units.filter((u) => u.typeId !== 'x-wing');
  for (let i = 0; i < 6; i++) M.deployUnit(G, 'Rebel', 'corellian-corvette', adj);
  const noFighters = activateScore(G);
  const withFighters = activateScore(build(true).G);
  check('fighter requirement enforced', withFighters - noFighters >= 10,
    `fighters=${withFighters} corvettes=${noFighters}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
