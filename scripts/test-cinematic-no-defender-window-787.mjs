// #787 — "Cinematic Combat doesn't involve playing tactics cards in response to
// the opponent's moves ... I throw my dice, wait for opponent to respond."
//
// Cinematic combat turns the base tactic deck off, so the defender never has a
// block/sacrifice card to play. The engine still queued the CombatDefenderTactics
// window after every attack: an empty pause that, online, handed the turn to the
// other player and back for nothing. Pins that the window is never queued in
// cinematic combat, and is still queued in base combat (control).
//
// Run: node scripts/test-cinematic-no-defender-window-787.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
const opts = (seed, cinematicCombat) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat },
});

/** Run 60 Felucia combats; count defender-tactics windows and completed attacks. */
function sweep(cinematic) {
  let windows = 0, attacks = 0, finished = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const G = createGame(data, opts(seed, cinematic));
    for (const t of ['star-destroyer', 'tie-fighter', 'tie-fighter', 'at-at', 'stormtrooper']) M.deployUnit(G, 'Empire', t, 'felucia');
    for (const t of ['corellian-corvette', 'x-wing', 'x-wing', 'rebel-trooper', 'rebel-trooper']) M.deployUnit(G, 'Rebel', t, 'felucia');
    const before = G.turnLog.length;
    try {
      combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
      combat.runCombat(G);
      let guard = 0;
      while (G.pendingCombat && G.pendingChoice && guard++ < 800) {
        if (G.pendingChoice.kind === 'CombatDefenderTactics') windows++;
        if (!stepOnce(G, G.pendingChoice.side)) break;
      }
    } catch { continue; }
    if (!G.pendingCombat) finished++;
    attacks += G.turnLog.slice(before).filter((e) => e.kind === 'combat-attack').length;
  }
  return { windows, attacks, finished };
}

console.log('[ #787 — no empty defender-tactics hand-off in cinematic combat ]');
let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); ok ? pass++ : fail++; };

const cin = sweep(true);
check(cin.attacks > 50, `cinematic combats actually rolled attacks (${cin.attacks})`);
check(cin.finished >= 55, `cinematic combats ran to completion (${cin.finished}/60)`);
check(cin.windows === 0, `cinematic: defender-tactics window never queued (${cin.windows})`);

const base = sweep(false);
check(base.windows > 0, `base game control: defender-tactics window still offered (${base.windows})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
