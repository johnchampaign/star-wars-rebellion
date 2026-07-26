// #646 — the Empire AI resolved Oversee Project on a sabotaged Alderaan and the
// queued unit deployed there anyway. RR p.13 "Sabotage Markers": "Abilities
// cannot 'build' or 'deploy' units in a system that contains a sabotage marker,"
// and the FAQ makes the test literal — "If an ability does not use the word
// 'Build' or 'Deploy,' then it is unaffected by sabotage markers." Oversee
// Project and Safe Haven both say DEPLOY, so both are blocked; markers "affect
// both factions equally," so the Rebel's own marker blocks Safe Haven too.
//
// The complement is #640/#468 (test-construct-factory-sabotage-468.mjs): cards
// that PLACE ON THE BUILD QUEUE are NOT blocked. Both directions are asserted
// here so a future "simplification" can't collapse them into one rule.
// Run: node scripts/test-sabotage-blocks-deploy-646.mjs
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

const newGame = () => createGame(data, { seed: 11, autoSetupUnits: true });
const unitsAt = (G, sys, typeId) => (G.map.systems[sys].units ?? []).filter((u) => u.typeId === typeId).length;
const run = (G, effectKey, cardId, side, sys) =>
  registry.invokeByKey(G, effectKey, registry.makeContext(side, { kind: 'mission', id: cardId }, { targetSystemId: sys }));

console.log('[ #646 — a sabotage marker blocks abilities that DEPLOY ]');

// ---- Oversee Project (Empire) ------------------------------------------
{
  const G = newGame();
  const sys = 'alderaan';
  G.map.systems[sys].sabotage = true;
  G.empire.buildQueue[1] = ['stormtrooper'];
  const before = unitsAt(G, sys, 'stormtrooper');

  run(G, 'oversee-project', 'oversee-project', 'Empire', sys);
  check('sabotaged target: no choice is posted', !G.pendingChoice, `pendingChoice=${G.pendingChoice?.kind}`);
  check('sabotaged target: nothing deploys', unitsAt(G, sys, 'stormtrooper') === before,
    `before=${before} after=${unitsAt(G, sys, 'stormtrooper')}`);
  check('sabotaged target: the unit stays on the build queue',
    G.empire.buildQueue[1].length === 1, `queue=${JSON.stringify(G.empire.buildQueue[1])}`);
  check('sabotaged target: reveal is flagged pointless',
    missionRevealIsPointless(G, 'Empire', 'oversee-project', sys) === true);
}
{
  // Control: the SAME board without the marker must still work.
  const G = newGame();
  const sys = 'alderaan';
  G.map.systems[sys].sabotage = false;
  G.empire.buildQueue[1] = ['stormtrooper'];
  run(G, 'oversee-project', 'oversee-project', 'Empire', sys);
  check('clean target: the pick IS posted', G.pendingChoice?.kind === 'OverseeProjectPick',
    `pendingChoice=${G.pendingChoice?.kind}`);
  check('clean target: reveal is NOT pointless',
    missionRevealIsPointless(G, 'Empire', 'oversee-project', sys) === false);
}
{
  // Empty build spaces 1 and 2 → nothing to deploy, so also pointless.
  const G = newGame();
  G.empire.buildQueue[1] = []; G.empire.buildQueue[2] = []; G.empire.buildQueue[3] = ['at-at'];
  check('empty build spaces 1+2: reveal is pointless',
    missionRevealIsPointless(G, 'Empire', 'oversee-project', 'alderaan') === true);
}

// ---- Safe Haven (Rebel) — markers affect both factions equally -----------
{
  const G = newGame();
  const sys = 'alderaan';
  G.map.systems[sys].sabotage = true;
  G.rebel.buildQueue[1] = ['rebel-trooper'];
  const before = unitsAt(G, sys, 'rebel-trooper');

  run(G, 'safe-haven', 'safe-haven', 'Rebel', sys);
  check('Safe Haven on a sabotaged system: no choice is posted', !G.pendingChoice,
    `pendingChoice=${G.pendingChoice?.kind}`);
  check('Safe Haven on a sabotaged system: nothing deploys',
    unitsAt(G, sys, 'rebel-trooper') === before);
  check('Safe Haven on a sabotaged system: units stay queued',
    G.rebel.buildQueue[1].length === 1, `queue=${JSON.stringify(G.rebel.buildQueue[1])}`);
  check('Safe Haven on a sabotaged system: reveal is flagged pointless',
    missionRevealIsPointless(G, 'Rebel', 'safe-haven', sys) === true);
}
{
  const G = newGame();
  const sys = 'alderaan';
  G.rebel.buildQueue[1] = ['rebel-trooper'];
  run(G, 'safe-haven', 'safe-haven', 'Rebel', sys);
  check('Safe Haven on a clean system: the pick IS posted',
    G.pendingChoice?.kind === 'SafeHavenPick', `pendingChoice=${G.pendingChoice?.kind}`);
}

// ---- The other direction (#640): QUEUE placement is NOT blocked ----------
{
  const G = newGame();
  const sys = 'alderaan';
  G.map.systems[sys].sabotage = true;
  const before = G.empire.buildQueue[3].length;
  run(G, 'construct-super-star-destroyer', 'construct-super-star-destroyer', 'Empire', sys);
  check('sabotage does NOT block placing a unit on the build queue (#640)',
    G.empire.buildQueue[3].length === before + 1,
    `before=${before} after=${G.empire.buildQueue[3].length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
