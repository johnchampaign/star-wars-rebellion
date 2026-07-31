// #659 — "Ready For Action" only ever moves the leader NAMED ON THE CARD.
//
// Card text (RotE mission/action reference): "Take THIS LEADER from your leader
// pool and place him in this system. This leader cannot retreat, and he returns
// to your leader pool at the end of the combat." The named leaders are Piett
// and Veers.
//
// The engine used to (a) offer the card whenever the pool was non-empty and
// (b) let the player pick ANY leader out of the pool — so the Empire could
// parachute Vader into a fight on a card that never mentions him. #441 had
// correctly established that the leader comes from the POOL rather than
// needing to already be in the system, but dropped the named-leader
// requirement altogether while doing it.
//
// Run: node scripts/test-ready-for-action-659.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');

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
  else { console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`); fail++; }
};

const NAMED = ['admiral-piett', 'general-veers'];
const baseOpts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
});

/** Stand up a contested system with Ready For Action in the Empire's hand and
 *  an Empire leader pool set to exactly `pool`. Returns the game paused on the
 *  Empire's start-of-combat action-card window (if one was offered). */
function setup(pool, seed = 4200) {
  const G = createGame(data, baseOpts(seed));
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  G.empire.actionHand = ['ready-for-action'];
  G.empire.leaderPool = [...pool];
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  combat.runCombat(G);
  // Walk to the Empire's CombatStartActionCards offer. The add-leader prompt
  // comes first for each side; decline both (null) so the leader pool stays
  // exactly as configured, then the action-card window is posted.
  let guard = 0;
  while (G.pendingChoice && guard++ < 50) {
    const pc = G.pendingChoice;
    if (pc.kind === 'CombatStartActionCards' && pc.side === 'Empire') break;
    if (pc.kind === 'CombatAddLeaderPick') { combat.resolveCombatAddLeaderPick(G, null); continue; }
    break; // anything else means the window isn't reachable this way
  }
  return G;
}

const empireWindow = (G) =>
  (G.pendingChoice?.kind === 'CombatStartActionCards' && G.pendingChoice.side === 'Empire')
    ? G.pendingChoice : null;

console.log('[ #659: the card is offered only when Piett or Veers is in the pool ]');
{
  const G = setup(['admiral-piett']);
  const w = empireWindow(G);
  check('window posted with Piett in pool', !!w, `pendingChoice=${G.pendingChoice?.kind}`);
  check('Ready For Action is offered', !!w && w.playable.includes('ready-for-action'),
    JSON.stringify(w?.playable));
}
{
  const G = setup(['general-veers']);
  const w = empireWindow(G);
  check('Veers alone also enables the card', !!w && w.playable.includes('ready-for-action'),
    JSON.stringify(w?.playable));
}
{
  // A pool full of leaders the card never names must NOT enable it (#659).
  const G = setup(['darth-vader', 'emperor-palpatine', 'grand-moff-tarkin']);
  const w = empireWindow(G);
  const offered = !!w && w.playable.includes('ready-for-action');
  check('NOT offered when only unnamed leaders are in the pool', !offered,
    `playable=${JSON.stringify(w?.playable)}`);
}
{
  const G = setup([]);
  const w = empireWindow(G);
  check('NOT offered with an empty pool', !(w && w.playable.includes('ready-for-action')),
    JSON.stringify(w?.playable));
}

console.log('[ #659: the leader pick offers ONLY the named leaders in the pool ]');
{
  // Both named leaders plus a crowd of unnamed ones. The pick must be exactly
  // Piett + Veers — never Vader.
  const G = setup(['darth-vader', 'admiral-piett', 'emperor-palpatine', 'general-veers']);
  const w = empireWindow(G);
  check('window offered the card', !!w && w.playable.includes('ready-for-action'));
  if (w) {
    combat.resolveCombatStartActionCards(G, ['ready-for-action']);
    const pick = G.pendingChoice;
    check('a leader pick was posted', pick?.kind === 'ReadyForActionLeaderPick',
      `got ${pick?.kind}`);
    const cands = pick?.candidates ?? [];
    check('candidates are exactly the two named leaders',
      cands.length === 2 && NAMED.every((l) => cands.includes(l)), JSON.stringify(cands));
    check('Vader is NOT a candidate', !cands.includes('darth-vader'), JSON.stringify(cands));
    check('Palpatine is NOT a candidate', !cands.includes('emperor-palpatine'), JSON.stringify(cands));
  }
}
{
  // Only one named leader in the pool → exactly that one is offered.
  const G = setup(['darth-vader', 'general-veers']);
  const w = empireWindow(G);
  if (w) {
    combat.resolveCombatStartActionCards(G, ['ready-for-action']);
    const cands = G.pendingChoice?.candidates ?? [];
    check('single named leader → exactly that leader offered',
      cands.length === 1 && cands[0] === 'general-veers', JSON.stringify(cands));
  } else {
    check('single named leader → window offered', false, 'no window');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
