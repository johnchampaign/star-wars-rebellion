// #591 — Plan the Assault should route base fighters at a LONE Death Star when
// the plans are in hand, not at a system with a single TIE. The reporter
// watched the AI pick the TIE system (both scored the same +8); a lone DS with
// plans held is a game-winning target, so it now gets +30.
// Run: node scripts/test-plan-assault-ds-591.mjs
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

const DS_SYS = 'tatooine';   // lone Death Star target
const TIE_SYS = 'corellia';  // single-TIE decoy target

const build = (withPlans) => {
  const G = createGame(data, { seed: 4, autoSetupUnits: true });
  // Lone Death Star, single TIE elsewhere.
  M.deployUnit(G, 'Empire', 'death-star', DS_SYS);
  M.deployUnit(G, 'Empire', 'tie-fighter', TIE_SYS);
  // Base fighter wing (Plan the Assault commits these).
  const baseLoc = G.rebelBaseRevealed ? G.rebelBaseSystemId : 'rebel-base-space';
  for (let i = 0; i < 6; i++) M.deployUnit(G, 'Rebel', 'x-wing', baseLoc);
  // Assign Plan the Assault (needs intel 2 → Jan Dodonna).
  const leader = 'jan-dodonna';
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== leader);
  G.rebel.leadersOnMissions = [{ missionId: 'plan-the-assault', leaderIds: [leader], targetSystemId: null }];
  G.rebel.objectiveHand = withPlans ? ['death-star-plans-2'] : [];
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  return G;
};

const planTarget = (G) => {
  const acts = AI.bestCommandAction(G, 'Rebel');
  const a = acts.find((x) => x.kind === 'reveal' && x.missionId === 'plan-the-assault');
  return a ? a.targetSystemId : null;
};

console.log('[ #591 — Plan the Assault targets the lone Death Star with plans in hand ]');
{
  const t = planTarget(build(true));
  check('plan-the-assault is a candidate', t !== null);
  check('targets the Death Star system, not the TIE decoy', t === DS_SYS, `targeted ${t}`);
}

console.log('\n[ without the plans, no DS pull (avoids an unwinnable DS fight) ]');
{
  // A lone DS with NO plans can never be destroyed, so the +30 must not apply —
  // the strike should NOT be steered into the DS system.
  const t = planTarget(build(false));
  check('does NOT target the DS system without plans', t !== DS_SYS, `targeted ${t}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
