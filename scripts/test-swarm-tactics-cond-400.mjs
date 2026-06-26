// #400: Swarm Tactics' TOP ability ("If you have more Imperial fighters than
// Rebel fighters, deal 1 damage") must not be offered as a usable top play
// while the condition fails — otherwise it would resolve to nothing. The bottom
// ability ("Deal 1 black damage") stays available either way.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/cinematicTactics.ts');
const core = await import('../src/engine/combat.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
const baseOpts = (seed) => ({ seed, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo','corellia','kashyyyk'], forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'], expansion: { enabled: true, cinematicCombat: true } });
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };

const swarmOption = (G, c) => combat.cinematicSelectOptions(G, c, 'Empire', 'space')
  .find((o) => o.cardId === 'cin-empire-space-swarm-tactics');

console.log('[ Rebels have MORE fighters → Swarm Tactics top NOT usable ]');
{
  const G = createGame(data, baseOpts(700));
  M.deployUnit(G, 'Empire', 'tie-fighter', 'felucia');                 // 1 Imperial fighter
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');                       // 2 Rebel fighters
  core.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'space'; c.theaterStaged = []; c.theaterAttackersDone = [];
  const opt = swarmOption(G, c);
  check('Swarm Tactics is in hand', !!opt, 'card not offered');
  check('top (primary) is NOT usable while down on fighters', opt && opt.primaryUsable === false, `primaryUsable=${opt?.primaryUsable}`);
}

console.log('[ Empire has MORE fighters → Swarm Tactics top usable ]');
{
  const G = createGame(data, baseOpts(701));
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Empire', 'tie-fighter', 'felucia'); // 3 Imperial fighters
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');                                    // 1 Rebel fighter
  core.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'space'; c.theaterStaged = []; c.theaterAttackersDone = [];
  const opt = swarmOption(G, c);
  check('top (primary) IS usable when ahead on fighters', opt && opt.primaryUsable === true, `primaryUsable=${opt?.primaryUsable}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #400 Swarm-Tactics tests passed');
process.exit(fail ? 1 : 0);
