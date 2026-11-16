// #835 (fl4qs5, playing Rebel): "empire played deployment on Nal Hutta. This
// revealed rebel base. A stormtropper was deployed here but not ground combat
// was initiated". Replayed from the reporter's own board
// (scripts/fixtures/base-reveal-combat-835.json).
//
// Deployment landed a Stormtrooper on the hidden base, the base revealed and
// three Rebel troopers (plus a transport and a U-wing) came out of the "Rebel
// Base" space — and the armies just sat together. FAQ (Single Reactor
// Ignition): "Any combat resulting from playing a mission card is resolved
// after all mission steps are complete." The system was also marked subjugated
// because the reveal ran AFTER the subjugation check.
//
// Pins: after the mission, a ground combat at Nal Hutta initiated by the Empire;
// the system is not subjugated while contested; the mission discards and the
// turn passes exactly once when the combat ends; a Deployment with no hidden
// base starts no combat.
// Run: node scripts/test-mission-base-reveal-combat-835.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const SYS = 'nal-hutta';
const raw = readFileSync(join(ROOT, 'scripts/fixtures/base-reveal-combat-835.json'), 'utf8');

/** The capture is taken just after the mission: hide the base again, put its
 *  units back in the "Rebel Base" space, lift the Stormtrooper, and put
 *  Palpatine back on the Deployment card. `baseHere` false moves the base away
 *  (control: Deployment on an empty system). */
function board({ baseHere = true } = {}) {
  const G = codec.decode(raw, setup.buildCatalog(data));
  const ss = G.map.systems[SYS];
  const rebels = ss.units.filter((u) => u.side === 'Rebel');
  ss.units = [];
  ss.subjugated = false;
  G.rebelBaseRevealed = false;
  G.map.rebelBaseSpace.units = rebels;
  if (!baseHere) G.rebelBaseSystemId = 'dagobah';
  delete G.empire.leadersOnBoard[SYS];
  G.empire.leadersOnMissions.push({ missionId: 'deployment', leaderIds: ['emperor-palpatine'] });
  G.empire.missionDiscard = G.empire.missionDiscard.filter((m) => m !== 'deployment');
  if (!G.empire.missionHand.includes('deployment')) G.empire.missionHand.push('deployment');
  G.currentPlayer = 'Empire';
  return G;
}
function reveal(G) {
  const r = phases.revealMission(G, 'Empire', 'deployment', SYS);
  if (!r.ok) throw new Error(`reveal refused: ${r.reason}`);
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null);
}

console.log('[ the reporter\'s board ]');
{
  const G = board();
  check('rewound: base hidden, 3 Rebel troopers in the Rebel Base space',
    !G.rebelBaseRevealed && G.map.rebelBaseSpace.units.filter((u) => u.typeId === 'rebel-trooper').length === 3);
  reveal(G);
  const ss = G.map.systems[SYS];
  check('Deployment landed the Stormtrooper and revealed the base',
    G.rebelBaseRevealed && ss.units.some((u) => u.typeId === 'stormtrooper'));
  check('a combat is now running at Nal Hutta', G.pendingCombat?.systemId === SYS, JSON.stringify(G.pendingCombat && G.pendingCombat.systemId));
  check('…initiated by the Empire (the card\'s player)', G.pendingCombat?.attackerSide === 'Empire');
  check('Nal Hutta is not subjugated while contested', ss.subjugated === false);
  check('the mission is still resolving (it ends with its combat)', G.pendingMission?.missionId === 'deployment');
  const kinds = G.turnLog.map((e) => e.kind);
  check('the combat begins after the base reveal',
    kinds.lastIndexOf('combat-begin') > kinds.lastIndexOf('reveal-base'));

  // Play the combat out with the AI on both sides.
  AI.seedAI(835);
  for (let i = 0; i < 400 && (G.pendingCombat || G.pendingChoice) && !G.isGameOver; i++) {
    AI.stepOnce(G, G.pendingChoice?.side ?? G.currentPlayer);
  }
  check('the combat finished', !G.pendingCombat, JSON.stringify(G.pendingChoice?.kind));
  const rep = (G.combatReports ?? []).find((r) => r.systemId === SYS);
  check('a battle was fought and reported at Nal Hutta', !!rep && rep.totalRounds >= 1, JSON.stringify(rep && { rounds: rep.totalRounds, winner: rep.winner }));
  check('…and it left only one side on the ground there',
    !(G.map.systems[SYS].units.some((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')
      && G.map.systems[SYS].units.some((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground')));
  check('the mission discarded exactly once',
    G.empire.missionDiscard.filter((m) => m === 'deployment').length === 1 && !G.pendingMission,
    JSON.stringify(G.empire.missionDiscard));
  check('the turn passed to the Rebel', G.isGameOver || G.currentPlayer === 'Rebel', G.currentPlayer);
}

console.log('[ control: no base there ]');
{
  const G = board({ baseHere: false });
  reveal(G);
  check('no combat when the system holds no hidden base', !G.pendingCombat);
  check('the lone Stormtrooper subjugates the system', G.map.systems[SYS].subjugated === true);
  check('the mission finished and the turn passed', !G.pendingMission && G.currentPlayer === 'Rebel', G.currentPlayer);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('all passed');
