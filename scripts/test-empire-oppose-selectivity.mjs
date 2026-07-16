// Empire oppose selectivity (forum: jocke01; #516 fold) — the Empire AI opposes
// ONLY high-impact Rebel missions, at ANY time marker. Every leader spent
// opposing is an activation foregone; reporters watched the Empire burn its
// pool opposing low-impact missions (sabotage/infiltration) while its fleets
// sat idle. Was previously selective only on T1-4.
// Run: node scripts/test-empire-oppose-selectivity.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const setup = (missionId, hero, target, tm) => {
  const G = createGame(data, { seed: 9, autoSetupUnits: true });
  G.timeMarker = tm;
  G.currentPlayer = 'Rebel';
  G.phase = 'Command';
  G.rebel.missionHand = [missionId];
  // Put the hero on the mission per the assignment model.
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== hero);
  G.rebel.leadersOnMissions = [{ missionId, leaderIds: [hero], targetSystemId: target }];
  return G;
};

console.log('[ LOW-impact mission at T6: Empire AI declines to send a pool leader ]');
{
  // Sabotage: not in the Empire high-impact set.
  const G = setup('sabotage', 'han-solo', 'corellia', 6);
  const r = phases.revealMission(G, 'Rebel', 'sabotage', 'corellia', undefined, ['han-solo']);
  check('reveal ok', r.ok, r.reason);
  if (G.pendingChoice?.kind === 'OpposeMission') {
    const poolBefore = G.pendingChoice.poolLeaders.length;
    check('Empire has pool leaders it COULD send', poolBefore > 0, `pool=${poolBefore}`);
    const onBoardBefore = Object.values(G.empire.leadersOnBoard).flat().length;
    check('AI resolved the oppose choice', AI.stepOnce(G, 'Empire'));
    const onBoardAfter = Object.values(G.empire.leadersOnBoard).flat().length;
    check('no pool leader was spent opposing (low impact)', onBoardAfter === onBoardBefore,
      `onBoard ${onBoardBefore} -> ${onBoardAfter}`);
  } else {
    check('OpposeMission choice was posted', false, G.pendingChoice?.kind);
  }
}

console.log('\n[ HIGH-impact mission at T6: Empire AI still opposes ]');
{
  // Wookie Uprising: in the Empire high-impact set. Needs specOps 3 → Chewbacca.
  const G = setup('wookie-uprising', 'chewbacca', 'kashyyyk', 6);
  const r = phases.revealMission(G, 'Rebel', 'wookie-uprising', 'kashyyyk', undefined, ['chewbacca']);
  check('reveal ok', r.ok, r.reason);
  if (G.pendingChoice?.kind === 'OpposeMission') {
    check('Empire has pool leaders it could send', G.pendingChoice.poolLeaders.length > 0);
    const onBoardBefore = Object.values(G.empire.leadersOnBoard).flat().length;
    check('AI resolved the oppose choice', AI.stepOnce(G, 'Empire'));
    const onBoardAfter = Object.values(G.empire.leadersOnBoard).flat().length;
    check('a pool leader WAS sent to oppose (high impact)', onBoardAfter === onBoardBefore + 1,
      `onBoard ${onBoardBefore} -> ${onBoardAfter}`);
  } else {
    check('OpposeMission choice was posted', false, G.pendingChoice?.kind);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
