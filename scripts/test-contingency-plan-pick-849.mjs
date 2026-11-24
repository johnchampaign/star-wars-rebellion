// #849 (mrvvfh, playing Empire): General Rieekan resolved Contingency Plan and
// the AI put him on Rapid Mobilization — "a double waste" — with Build Alliance
// in hand and an undefended Mon Calamari on the board. The AI's picker took
// candidates[0], i.e. whichever starting mission sat first in hand.
//
// Board: scripts/fixtures/rebel-loyalty-yield-840.json (a turn-1 Command board
// from a real game log), with the four starting missions offered.
//
// Pins: the pick does not depend on hand order; a leader is never put on a
// mission they lack the skill icons to reveal; a leader with diplomacy takes
// the loyalty mission over Rapid Mobilization; and the AI step resolves the
// pending choice with that pick.
// Run: node scripts/test-contingency-plan-pick-849.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });
const board = () => codec.decode(readFileSync(join(ROOT, 'scripts/fixtures/rebel-loyalty-yield-840.json'), 'utf8'), catalog);
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const STARTING = ['rapid-mobilization', 'sabotage', 'infiltration', 'build-alliance'];
const orders = [STARTING, [...STARTING].reverse(), ['infiltration', 'rapid-mobilization', 'build-alliance', 'sabotage']];
const qualifies = (G, lid, mid) => {
  const c = G.catalog.missions[mid];
  const s = phases.totalSkill(G, [lid], c.skill);
  return s.major + s.minor >= c.skillCost;
};

console.log('[ the pick is the leader\'s best mission, not the first card in hand ]');
for (const lid of ['general-rieekan', 'mon-mothma', 'chewbacca', 'jan-dodonna', 'admiral-ackbar']) {
  const G = board();
  const picks = orders.map((o) => AI.chooseContingencyPlanMission(G, lid, o));
  check(`${lid}: same pick in every hand order (${picks[0]})`, new Set(picks).size === 1, picks.join(','));
  check(`${lid}: has the skill icons for ${picks[0]}`, qualifies(G, lid, picks[0]));
}

console.log('\n[ the reporter\'s case: Rieekan, Rapid Mobilization first in hand ]');
{
  const G = board();
  const pick = AI.chooseContingencyPlanMission(G, 'general-rieekan', STARTING);
  check('Rieekan is not put on Rapid Mobilization', pick !== 'rapid-mobilization', pick);
  check('Rieekan is never put on Infiltration (no intel icon)', pick !== 'infiltration', pick);
}
{
  const G = board();
  check('Mon Mothma takes Build Alliance', AI.chooseContingencyPlanMission(G, 'mon-mothma', STARTING) === 'build-alliance',
    AI.chooseContingencyPlanMission(G, 'mon-mothma', STARTING));
  check('Chewbacca (spec ops only) takes Sabotage', AI.chooseContingencyPlanMission(G, 'chewbacca', STARTING) === 'sabotage',
    AI.chooseContingencyPlanMission(G, 'chewbacca', STARTING));
}

console.log('\n[ fallbacks never soft-lock ]');
{
  const G = board();
  check('only unqualified candidates: falls back to the first', AI.chooseContingencyPlanMission(G, 'chewbacca', ['infiltration', 'build-alliance']) === 'infiltration');
  check('single candidate is returned', AI.chooseContingencyPlanMission(G, 'general-rieekan', ['rapid-mobilization']) === 'rapid-mobilization');
}

console.log('\n[ the AI step resolves the pending choice with that pick ]');
{
  const G = board();
  // Put the four starting missions in hand, Rapid Mobilization first, and free Rieekan.
  for (const m of G.rebel.leadersOnMissions) for (const mid of [m.missionId]) if (STARTING.includes(mid) && !G.rebel.missionHand.includes(mid)) G.rebel.missionHand.push(mid);
  G.rebel.leadersOnMissions = G.rebel.leadersOnMissions.filter((m) => !STARTING.includes(m.missionId));
  G.rebel.missionHand = [...STARTING, ...G.rebel.missionHand.filter((m) => !STARTING.includes(m))];
  const want = AI.chooseContingencyPlanMission(G, 'general-rieekan', STARTING);
  G.pendingChoice = { kind: 'ContingencyPlanPick', side: 'Rebel', leaderId: 'general-rieekan', candidates: [...STARTING] };
  const ok = AI.stepOnce(G, 'Rebel');
  const on = G.rebel.leadersOnMissions.find((m) => m.leaderIds.includes('general-rieekan'));
  check('stepOnce resolved the choice', ok && G.pendingChoice?.kind !== 'ContingencyPlanPick');
  check(`Rieekan is assigned to ${want}`, on?.missionId === want && want !== 'rapid-mobilization', JSON.stringify(on));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
