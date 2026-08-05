// #689 — "The empire ran 'Imperial Might' ... The problem is that the empire had
// 0 units on the build queue when they assigned the mission." Confirmed from the
// attached state: all three Imperial build spaces were empty, and the log shows
// `imperial-might-deploy {"unitTypes":[],"auto":true}` — a leader and a mission
// card spent to place nothing.
//
// Imperial Might is the Empire's mirror of Safe Haven / Oversee Project, both of
// which already had an empty-queue pointlessness gate (#594/#646). This card was
// missed. Its whole payoff is the deploy: the only other clause moves your OWN
// two leaders back to Coruscant, which is the card's price, not a reason to run
// it.
//
// The same audit turned up the OTHER half of #646 on this card: Imperial Might
// had no sabotage guard, and it splices units off the queue before calling
// deployUnit — which by contract does not check sabotage. So on a sabotaged
// system the units deployed anyway (and would have vanished if the deploy had
// been blocked further down). Both are asserted here.
// Run: node scripts/test-imperial-might-pointless-689.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');
const { missionRevealIsPointless } = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

handlers.registerAll();

// The reported board: Empire Death Star + escorts on Dagobah, build queue empty.
const newGame = () => {
  const G = createGame(data, { seed: 11, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  G.empire.buildQueue[1] = []; G.empire.buildQueue[2] = []; G.empire.buildQueue[3] = [];
  return G;
};
const unitsAt = (G, sys, typeId) => (G.map.systems[sys].units ?? []).filter((u) => u.typeId === typeId).length;
const run = (G, sys, leaderIds = []) => registry.invokeByKey(G, 'imperial-might',
  registry.makeContext('Empire', { kind: 'mission', id: 'imperial-might' }, { targetSystemId: sys, leaderIds }));

console.log('\n[ #689 — an empty build space 1 makes Imperial Might a no-op ]');
{
  const G = newGame();
  check('all three build spaces empty (the reported state)',
    [1, 2, 3].every((s) => G.empire.buildQueue[s].length === 0));
  check('reveal is flagged pointless — the AI will not spend the card',
    missionRevealIsPointless(G, 'Empire', 'imperial-might', 'dagobah') === true);
}
{
  // Space 1 is the ONLY space the card reads. Units parked further back on the
  // queue do not make it playable this round.
  const G = newGame();
  G.empire.buildQueue[2] = ['at-at']; G.empire.buildQueue[3] = ['star-destroyer'];
  check('units on spaces 2/3 only: still pointless (card reads space 1)',
    missionRevealIsPointless(G, 'Empire', 'imperial-might', 'dagobah') === true);
}
{
  const G = newGame();
  G.empire.buildQueue[1] = ['stormtrooper', 'tie-fighter'];
  check('with space 1 stocked: NOT pointless',
    missionRevealIsPointless(G, 'Empire', 'imperial-might', 'dagobah') === false);
  const before = unitsAt(G, 'dagobah', 'stormtrooper');
  run(G, 'dagobah');
  check('and the units really do deploy', unitsAt(G, 'dagobah', 'stormtrooper') === before + 1,
    `before=${before} after=${unitsAt(G, 'dagobah', 'stormtrooper')}`);
  check('space 1 is emptied by the take', G.empire.buildQueue[1].length === 0,
    JSON.stringify(G.empire.buildQueue[1]));
}

console.log('\n[ #646, on the card it was missed on: sabotage blocks the deploy ]');
{
  const G = newGame();
  G.empire.buildQueue[1] = ['stormtrooper', 'tie-fighter'];
  G.map.systems['dagobah'].sabotage = true;
  const before = unitsAt(G, 'dagobah', 'stormtrooper');
  run(G, 'dagobah');
  check('nothing deploys onto a sabotaged system',
    unitsAt(G, 'dagobah', 'stormtrooper') === before,
    `before=${before} after=${unitsAt(G, 'dagobah', 'stormtrooper')}`);
  check('the units stay on the build queue rather than vanishing',
    G.empire.buildQueue[1].length === 2, JSON.stringify(G.empire.buildQueue[1]));
  check('the block is logged',
    G.turnLog.some((e) => e.kind === 'imperial-might-blocked-by-sabotage'));
  check('and the reveal is flagged pointless too',
    missionRevealIsPointless(G, 'Empire', 'imperial-might', 'dagobah') === true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
