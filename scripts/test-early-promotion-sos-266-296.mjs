// #266 — Early Promotion places BOTH Motti and Grand Moff Tarkin (Tarkin's id is
//        'grand-moff-tarkin'; the handler used 'tarkin' and silently skipped him).
// #296 — Son of Skywalker offers the expansion's Critical Rescue (not just Seek
//        Yoda) when it's in the deck.
// Run: node scripts/test-early-promotion-sos-266-296.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

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

const opts = (seed, roeMissions) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, roeUnits: true, roeMissions: !!roeMissions },
});

console.log('\n[ #266 Early Promotion places both Motti and Grand Moff Tarkin ]');
{
  const G = createGame(data, opts(960));
  // Ensure the recruit branch has an empty starting deck so it goes straight
  // to the recruit (no StartingCardBranch prompt).
  G.empire.startingActionDeck = [];
  // Tarkin starts in the Empire pool; make sure Motti is recruitable (not on board).
  if (!G.empire.leaderPool.includes('grand-moff-tarkin')) G.empire.leaderPool.push('grand-moff-tarkin');
  // Play Early Promotion (Immediate). It should recruit Motti and place both.
  G.empire.actionHand = ['early-promotion'];
  G.currentPlayer = 'Empire';
  const r = phases.playImmediateActionCard
    ? null : null; // (call via the immediate path below)
  // Drive it through the immediate-play path:
  G.pendingChoice = { kind: 'PlayImmediateActionCard', side: 'Empire', candidates: ['early-promotion'] };
  phases.playImmediateActionCard(G, 'early-promotion');
  // If a StartingCardBranch was posted (deck non-empty), choose recruit.
  if (G.pendingChoice?.kind === 'StartingCardBranch') {
    phases.resolveStartingCardBranch(G, 'recruit');
  }
  const onBoard = (lid) => Object.values(G.empire.leadersOnBoard).some((list) => list.includes(lid));
  check('Motti recruited and placed on the board', onBoard('motti'),
    `pool=${G.empire.leaderPool.includes('motti')}`);
  check('Grand Moff Tarkin placed on the board (not left in pool)',
    onBoard('grand-moff-tarkin'),
    `inPool=${G.empire.leaderPool.includes('grand-moff-tarkin')}`);
  check('Tarkin no longer in the leader pool', !G.empire.leaderPool.includes('grand-moff-tarkin'));
}

console.log('\n[ #389 Early Promotion relocates Tarkin even when already on the board ]');
{
  const G = createGame(data, opts(960));
  G.empire.startingActionDeck = [];
  G.currentPlayer = 'Empire';
  // Simulate an earlier Gather Intel this turn that already deployed Tarkin to a
  // NON-Imperial system (naboo is Rebel-loyal per forcedRebelLoyalty). He is on
  // the board, NOT in the pool — the case #266's pool-only fix silently skipped.
  const ti = G.empire.leaderPool.indexOf('grand-moff-tarkin');
  if (ti >= 0) G.empire.leaderPool.splice(ti, 1);
  G.empire.leadersOnBoard['naboo'] = [...(G.empire.leadersOnBoard['naboo'] ?? []), 'grand-moff-tarkin'];
  // Play Early Promotion (Immediate) → recruit Motti + place both in an Imperial system.
  G.empire.actionHand = ['early-promotion'];
  G.pendingChoice = { kind: 'PlayImmediateActionCard', side: 'Empire', candidates: ['early-promotion'] };
  phases.playImmediateActionCard(G, 'early-promotion');
  if (G.pendingChoice?.kind === 'StartingCardBranch') {
    phases.resolveStartingCardBranch(G, 'recruit');
  }
  const sysOf = (lid) =>
    Object.entries(G.empire.leadersOnBoard).find(([, list]) => list.includes(lid))?.[0];
  const isImperial = (sid) => {
    const ss = G.map.systems[sid];
    return !!ss && (ss.loyalty === 'imperial' || ss.subjugated);
  };
  const tarkinSys = sysOf('grand-moff-tarkin');
  const mottiSys = sysOf('motti');
  check('Tarkin relocated off the Rebel system (no longer at naboo)', tarkinSys !== 'naboo',
    `tarkinSys=${tarkinSys}`);
  check('Tarkin now in an Imperial system', !!tarkinSys && isImperial(tarkinSys),
    `tarkinSys=${tarkinSys}`);
  check('Motti placed in an Imperial system', !!mottiSys && isImperial(mottiSys),
    `mottiSys=${mottiSys}`);
  check('Motti and Tarkin co-located (card places both in the same system)',
    !!tarkinSys && tarkinSys === mottiSys, `motti=${mottiSys} tarkin=${tarkinSys}`);
  // No stale duplicate left behind at naboo.
  check('No leftover Tarkin at naboo', !(G.empire.leadersOnBoard['naboo'] ?? []).includes('grand-moff-tarkin'));
}

console.log('\n[ #296 expansion deck swaps Daring Rescue → Critical Rescue ]');
{
  const G = createGame(data, opts(961, true)); // roeMissions
  const deck = G.rebel.missionDeck;
  check('expansion Rebel deck contains Critical Rescue',
    deck.includes('critical-rescue'), 'not in deck');
  check('expansion Rebel deck excludes base Daring Rescue',
    !deck.includes('daring-rescue'), 'daring-rescue present in rote deck');
  // The Son of Skywalker filter (seek-yoda | daring-rescue | critical-rescue)
  // must therefore surface critical-rescue. Mirror the filter here:
  const sos = deck.filter((m) => m === 'seek-yoda' || m === 'daring-rescue' || m === 'critical-rescue');
  check('Son of Skywalker candidate set includes Critical Rescue',
    sos.includes('critical-rescue'), `sos=[${sos.join(',')}]`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
