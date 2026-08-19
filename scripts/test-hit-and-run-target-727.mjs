// #727 — "The Rebel AI revealed Hit and Run and used it to destroy two TIE
// fighters at Corellia, quite possibly the two most useless units in the game.
// He could have destroyed vital transportation at Naboo, but didn't."
//
// The reporter was right, and the cause was a missing scoring case rather than
// a bad one. `rebelMissionTargetScore` had NO branch for hit-and-run, so every
// system holding any destroyable Imperial unit scored identically — a lone
// TIE Fighter and a loaded Assault Carrier were worth exactly the same target
// score, and the pick fell to the base-distance term and the tie-break.
//
// Hit And Run reads: "Attempt in any system. If successful, destroy up to
// 2-health worth of units of your choice in this system." Two health buys
// either two triangle chaff units or one Assault Carrier — and the carrier is
// four transport capacity, i.e. an entire invasion's ride home.
//
// Empire's Hunt Them Down is the exact mirror ("destroy up to 2 health") and
// had the same hole, so it is asserted here too.
//
// Run: node scripts/test-hit-and-run-target-727.mjs
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
// Clear the two systems, then rebuild the reporter's board.
const clear = (sid) => { G.map.systems[sid].units = []; };
clear('corellia'); clear('naboo');
// Corellia: the chaff the AI actually attacked.
M.deployUnit(G, 'Empire', 'tie-fighter', 'corellia');
M.deployUnit(G, 'Empire', 'tie-fighter', 'corellia');
M.deployUnit(G, 'Empire', 'stormtrooper', 'corellia');
// Naboo: the "vital transportation" plus its cargo.
M.deployUnit(G, 'Empire', 'assault-carrier', 'naboo');
M.deployUnit(G, 'Empire', 'at-st', 'naboo');
M.deployUnit(G, 'Empire', 'stormtrooper', 'naboo');
M.deployUnit(G, 'Empire', 'stormtrooper', 'naboo');

console.log('\n[ #727 — Hit And Run must prefer the transport over the chaff ]');
{
  const cor = ai.rebelMissionTargetScore(G, 'hit-and-run', 'corellia', null);
  const nab = ai.rebelMissionTargetScore(G, 'hit-and-run', 'naboo', null);
  console.log(`    corellia=${cor.toFixed(1)}  naboo=${nab.toFixed(1)}`);
  check('naboo (Assault Carrier) outscores corellia (2 TIE Fighters)', nab > cor,
    `naboo ${nab} !> corellia ${cor} — the destroy-value term is not firing`);
}

console.log('\n[ an empty system is never a target ]');
{
  clear('rodia');
  const rodia = ai.rebelMissionTargetScore(G, 'hit-and-run', 'rodia', null);
  const nab = ai.rebelMissionTargetScore(G, 'hit-and-run', 'naboo', null);
  check('naboo outscores a system with nothing to kill', nab > rodia,
    `naboo ${nab} !> rodia ${rodia}`);
  // The pointless-guard is the real gate for the empty case; assert it too.
  check('hit-and-run on an empty system is flagged pointless',
    ai.missionRevealIsPointless(G, 'Rebel', 'hit-and-run', 'rodia'));
}

console.log('\n[ Empire mirror — Hunt Them Down scores its target too ]');
{
  clear('sullust'); clear('mon-calamari');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'sullust');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'sullust');
  M.deployUnit(G, 'Rebel', 'rebel-transport', 'mon-calamari');
  const sul = ai.empireMissionTargetScore(G, 'hunt-them-down', 'sullust');
  const mon = ai.empireMissionTargetScore(G, 'hunt-them-down', 'mon-calamari');
  console.log(`    sullust=${sul.toFixed(1)}  mon-calamari=${mon.toFixed(1)}`);
  check('mon-calamari (Rebel Transport) outscores sullust (2 Rebel Troopers)', mon > sul,
    `mon-calamari ${mon} !> sullust ${sul}`);
}

console.log('\n[ and the pick INSIDE the system spends the budget on the transport ]');
{
  clear('rodia');
  M.deployUnit(G, 'Empire', 'assault-carrier', 'rodia');   // health 2, capacity 4
  M.deployUnit(G, 'Empire', 'tie-fighter', 'rodia');       // health 1, needs a ride
  M.deployUnit(G, 'Empire', 'tie-fighter', 'rodia');
  const ss = G.map.systems['rodia'];
  const carrier = ss.units.find((u) => u.typeId === 'assault-carrier');
  G.pendingChoice = {
    kind: 'DestroyUpToHealth', side: 'Rebel', systemId: 'rodia',
    candidates: ss.units.map((u) => u.instanceId), budget: 2, cardName: 'Hit And Run',
  };
  ai.stepOnce(G, 'Rebel');
  const survivors = G.map.systems['rodia'].units.map((u) => u.typeId).sort();
  console.log(`    survivors: ${survivors.join(', ') || '(none)'}`);
  check('the Assault Carrier is the unit that dies',
    !G.map.systems['rodia'].units.some((u) => u.instanceId === carrier.instanceId),
    `carrier survived; killed ${JSON.stringify(survivors)} instead`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
