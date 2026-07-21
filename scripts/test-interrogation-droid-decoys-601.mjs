// #601 — "Rebels picked 2 of 3 systems with interrogation that had imperial
// units on it." Interrogation Droid makes the Rebel name 3 systems, one of
// which holds the base. Naming a system that already contains Imperial units
// is a wasted bluff: the Empire is standing in it, so it obviously isn't the
// hidden base, and the three-system answer collapses to one. Same for systems
// the Empire's probe map has already ruled out.
//
// The Rebel AI used to take the first two systems in raw map order. It now
// scores decoys and hard-penalises the giveaways.
// Run: node scripts/test-interrogation-droid-decoys-601.mjs
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

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

console.log('\n[ #601: Interrogation Droid decoys must not be free giveaways ]');
{
  const G = createGame(data, {
    seed: 601, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  });
  G.phase = 'Command';

  // Garrison a spread of systems, including ones that sort early in map order
  // (the old `.slice(0, 2)` would have grabbed those).
  const occupied = Object.keys(G.map.systems).slice(0, 6).filter((s) => s !== G.rebelBaseSystemId);
  for (const sid of occupied) M.deployUnit(G, 'Empire', 'stormtrooper', sid);
  // And mark a couple of systems as already crossed off the Empire's probe map.
  const crossedOff = Object.keys(G.map.systems)
    .filter((s) => s !== G.rebelBaseSystemId && !occupied.includes(s))
    .slice(0, 3);
  G.empireSearchedRuledOut = [...crossedOff];

  const candidates = Object.keys(G.map.systems).filter((s) => s !== G.rebelBaseSystemId);
  G.pendingChoice = {
    kind: 'InterrogationDroidDecoyPick', side: 'Rebel', candidates, count: 2,
  };

  const stepped = ai.stepOnce(G, 'Rebel');
  check('AI resolved the decoy pick', stepped === true);

  const named = G.turnLog.filter((e) => e.kind === 'interrogation-droid-named-systems').pop();
  check('three systems were named', (named?.payload?.named ?? []).length === 3,
    JSON.stringify(named?.payload?.named));

  const decoys = (named?.payload?.named ?? []).filter((s) => s !== G.rebelBaseSystemId);
  const withImperials = decoys.filter((sid) =>
    G.map.systems[sid]?.units.some((u) => u.side === 'Empire'));
  check('no decoy sits under an Imperial garrison', withImperials.length === 0,
    `named ${JSON.stringify(decoys)}, occupied ${JSON.stringify(withImperials)}`);

  const alreadyRuledOut = decoys.filter((sid) => crossedOff.includes(sid));
  check('no decoy is already crossed off the Empire probe map', alreadyRuledOut.length === 0,
    JSON.stringify(alreadyRuledOut));

  check('the real base is still among the three',
    (named?.payload?.named ?? []).includes(G.rebelBaseSystemId));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
