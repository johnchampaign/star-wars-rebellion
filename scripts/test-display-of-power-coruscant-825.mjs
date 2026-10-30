// #825 — eu46ho: "Empire used display of power in Coruscant which is literally
// the only system that mission does nothing in..."
//
// Display of Power reads "Attempt in any populous system. If successful, gain 2
// loyalty in this system." Coruscant is always Imperial and its loyalty is
// locked (gainLoyalty logs `coruscant-locked` and returns), so a success there
// changes nothing. empireMissionTargetScore had the "already Imperial = wasted"
// -30 for Rule by Fear / Trade Negotiations but not for Display of Power, so
// every populous target scored the same and the pick fell to the tiebreak.
//
// Pins, on the reporter's own board (scripts/fixtures/display-of-power-coruscant-825.json,
// rewound so Palpatine is back on the face-down Display of Power):
//   - the target score for Coruscant is well below a non-Imperial populous world
//   - the Empire's Display of Power reveal no longer targets Coruscant, or any
//     Imperial system, across seeds
// Counterfactual: change the `missionId === 'display-of-power'` guard in
// src/play/randomAI.ts to `false &&` and the assertions must FAIL.
//
// Run: node scripts/test-display-of-power-coruscant-825.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const raw = readFileSync(join(ROOT, 'scripts/fixtures/display-of-power-coruscant-825.json'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** The moment before the reveal: Palpatine back on the face-down Display of
 *  Power, Empire to act. */
function board(seed) {
  ai.seedAI(seed);
  const G = codec.decode(raw, catalog);
  const lob = G.empire.leadersOnBoard;
  for (const sid of Object.keys(lob)) {
    lob[sid] = lob[sid].filter((l) => l !== 'emperor-palpatine');
    if (lob[sid].length === 0) delete lob[sid];
  }
  G.empire.missionDiscard = (G.empire.missionDiscard ?? []).filter((m) => m !== 'display-of-power');
  G.empire.leadersOnMissions = [
    ...(G.empire.leadersOnMissions ?? []).filter((m) => m.missionId !== 'display-of-power'),
    { missionId: 'display-of-power', leaderIds: ['emperor-palpatine'] },
  ];
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  return G;
}

console.log('[ the reporter\'s board ]');
{
  const G = board(1);
  check('Coruscant is Imperial on this board', G.map.systems.coruscant.loyalty === 'imperial');
  const nonImp = Object.entries(G.map.systems)
    .filter(([sid, ss]) => G.catalog.systems[sid]?.isPopulous !== false && !G.catalog.systems[sid]?.isRemote
      && !G.catalog.systems[sid]?.isCoruscant && ss.loyalty !== 'imperial' && !ss.destroyed)
    .map(([sid]) => sid);
  check('there are non-Imperial populous alternatives', nonImp.length > 0, String(nonImp.length));
  const sc = ai.empireMissionTargetScore(G, 'display-of-power', 'coruscant');
  const best = Math.max(...nonImp.map((sid) => ai.empireMissionTargetScore(G, 'display-of-power', sid)));
  check('Coruscant scores ≥25 below the best non-Imperial target', best - sc >= 25, `coruscant ${sc}, best ${best}`);
}

console.log('[ the Display of Power reveal, 12 seeds ]');
{
  const targets = [];
  for (const seed of [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31]) {
    const G = board(seed);
    const dop = ai.bestCommandAction(G, 'Empire').find((a) => a.kind === 'reveal' && a.missionId === 'display-of-power');
    if (dop) targets.push([dop.targetSystemId, G.map.systems[dop.targetSystemId]?.loyalty]);
  }
  check('Display of Power is still offered as a reveal', targets.length > 0);
  check('never targets Coruscant', targets.every(([t]) => t !== 'coruscant'), JSON.stringify(targets));
  check('never targets an Imperial system', targets.every(([, l]) => l !== 'imperial'), JSON.stringify(targets));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
