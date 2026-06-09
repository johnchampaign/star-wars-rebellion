// Audit #7: RoE Cinematic Combat retreats current-player(attacker)-first;
// base game stays defender-first.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
const opts = (seed, cinematic) => ({ seed, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo','corellia','kashyyyk'], forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'], expansion: { enabled: true, cinematicCombat: cinematic } });
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };

// Set up a combat positioned right at the retreat step, with BOTH sides able to
// retreat (movable ship + leader + a legal adjacent destination), then run.
function retreatStepSide(cinematic, seed) {
  const G = createGame(data, opts(seed, cinematic));
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  G.empire.leadersOnBoard['felucia'] = ['darth-vader'];
  G.rebel.leadersOnBoard['felucia'] = ['han-solo'];
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  // Jump to the retreat step: both theatres "done", no attacks pending.
  c.step = 'Round';
  c.activeTheater = undefined;
  c.roundTheatersDone = ['space', 'ground'];
  c.dsPlansOfferedThisRound = true;
  c.retreatStepDoneThisRound = false;
  c.retreatDecidedThisRound = [];
  combat.runCombat(G);
  return G.pendingChoice?.kind === 'RetreatDecision' ? G.pendingChoice.side : `no-retreat(${G.pendingChoice?.kind ?? 'none'})`;
}

console.log('[ #7: cinematic vs base retreat order ]');
check('cinematic: attacker (Empire) is offered retreat first', retreatStepSide(true, 900) === 'Empire', retreatStepSide(true, 900));
check('base game: defender (Rebel) is offered retreat first', retreatStepSide(false, 900) === 'Rebel', retreatStepSide(false, 900));

console.log(fail ? `\n${fail} FAILED` : '\nAll #7 retreat-order tests passed');
process.exit(fail ? 1 : 0);
