// jocke01: "The empire ai do use action cards, but not many. Granted the
// situations might not have come up, but the ai sit most games with 4-5 action
// cards that they never play."
//
// One concrete reason: the AI's Start-of-Combat handler returned an empty array
// with the note "effects aren't wired anyway". That stopped being true — the
// engine's processStartOfCombatBatch calls applyStartOfCombatActionCardEffect
// for every card played, and the audit that wired all 48 action cards covered
// these — but the stub was never revisited. So the AI declined the window in
// every combat of every game: measured 0 cards played across 40 self-play
// games, against 24 once it chooses properly.
//
// This pins the chooser: it plays cards whose effect bites in THIS combat, and
// leaves alone the ones whose precondition is absent. The scorer is a heuristic
// and may be retuned, so assertions test the GUARDS (applicable vs not) rather
// than exact rankings.
//
// Run: node scripts/test-combat-action-cards.mjs
//   Counterfactual: SWR_COMBAT_CARDS=0 node scripts/test-combat-action-cards.mjs
//   must FAIL — that flag restores the old decline-everything stub.
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

if (typeof ai.chooseStartOfCombatCards !== 'function') {
  console.log('  ✗ chooseStartOfCombatCards is not exported — cannot test the chooser');
  process.exit(1);
}

/** A contested system: Imperial ships + ground vs Rebel ships + ground, so
 *  both theaters are live and every card below has something to act on. */
function board(seed, { rebelStructure = false, empireDeathStar = false } = {}) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  const sys = Object.keys(G.map.systems).find((s) => s !== G.rebelBaseSystemId);
  G.map.systems[sys].units = [];
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Empire', 'star-destroyer', sys);
  for (let i = 0; i < 2; i++) M.deployUnit(G, 'Empire', 'stormtrooper', sys);
  M.deployUnit(G, 'Rebel', 'corellian-corvette', sys);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
  if (rebelStructure) M.deployUnit(G, 'Rebel', 'shield-generator', sys);
  if (empireDeathStar) M.deployUnit(G, 'Empire', 'death-star', sys);
  return { G, sys };
}

const choose = (G, side, sys, cards) => ai.chooseStartOfCombatCards(G, side, sys, cards);

console.log('\n[ the AI now actually plays an applicable card ]');
{
  const { G, sys } = board(1);
  const picks = choose(G, 'Empire', sys, ['according-to-my-design']);
  check('an unconditionally-useful card is played',
    picks.includes('according-to-my-design'), JSON.stringify(picks));
}

console.log('\n[ guards: a card whose precondition is absent is left in hand ]');
{
  const { G, sys } = board(2); // no Rebel structure, no Death Star
  check('Target the Generator is NOT played with no enemy structure',
    !choose(G, 'Empire', sys, ['target-the-generator']).includes('target-the-generator'));
  check('Fully Operational is NOT played without a Death Star present',
    !choose(G, 'Empire', sys, ['fully-operational']).includes('fully-operational'));

  const withStruct = board(3, { rebelStructure: true });
  check('Target the Generator IS played when a structure is there',
    choose(withStruct.G, 'Empire', withStruct.sys, ['target-the-generator'])
      .includes('target-the-generator'));

  const withDS = board(4, { empireDeathStar: true });
  check('Fully Operational IS played with a Death Star and enemy ships',
    choose(withDS.G, 'Empire', withDS.sys, ['fully-operational'])
      .includes('fully-operational'));
}

console.log('\n[ Ready For Action stays unplayed — it has an open bug against it ]');
{
  const { G, sys } = board(5);
  check('Ready For Action is never chosen',
    !choose(G, 'Empire', sys, ['ready-for-action']).includes('ready-for-action'));
}

console.log('\n[ it does not dump the whole hand into one fight ]');
{
  const { G, sys } = board(6, { rebelStructure: true, empireDeathStar: true });
  const many = ['according-to-my-design', 'fully-operational', 'target-the-generator',
    'good-intel', 'more-dangerous-than-you-realize', 'keep-them-from-escaping'];
  const picks = choose(G, 'Empire', sys, many);
  check('at most 2 cards spent per combat', picks.length <= 2, `picked ${picks.length}`);
  check('unknown cards are never played',
    choose(G, 'Empire', sys, ['some-unwired-future-card']).length === 0);
}

console.log('\n[ no fight, no spend ]');
{
  const { G, sys } = board(7);
  G.map.systems[sys].units = G.map.systems[sys].units.filter((u) => u.side === 'Empire');
  check('nothing is played when the enemy has no units there',
    choose(G, 'Empire', sys, ['according-to-my-design']).length === 0);
}

// The sections above exercise the chooser directly, which the env flag does NOT
// gate -- it gates the handler that calls it. So they prove the guards are right
// but would pass even with the feature switched off. This last section drives
// real self-play and counts cards actually played in combat, which is what the
// flag controls and what was measured at 0 before the fix.
console.log('\n[ end-to-end: real combats actually spend cards ]');
{
  let played = 0, windows = 0;
  for (let seed = 1; seed <= 15; seed++) {
    ai.seedAI(seed);
    const G = createGame(data, { seed, autoSetupUnits: true,
      expansion: { enabled: true, roeUnits: true, roeMissions: true } });
    let guard = 0;
    while (!G.isGameOver && guard++ < 6000) {
      const side = G.currentPlayer;
      const before = G.turnLog.length;
      if (!ai.stepOnce(G, side)) {
        const o = side === 'Rebel' ? 'Empire' : 'Rebel';
        if (!ai.stepOnce(G, o)) break;
        continue;
      }
      for (const e of G.turnLog.slice(before)) {
        if (e.kind === 'combat-action-card') played++;
        if (e.kind === 'choice-request' && e.payload?.kind === 'CombatStartActionCards') windows++;
      }
    }
  }
  check('the start-of-combat window does come up in real games', windows > 0, `windows=${windows}`);
  check('the bug: cards are actually played in combat', played > 0,
    `played=${played} across 15 games (was 0 before the fix)`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
