// Good Intel (#352) — RoE clause: when the Empire plays Good Intel, it does not
// choose its advanced (cinematic) tactic card until AFTER the Rebel has chosen
// and revealed each round. So the cinematic SELECT order is forced Rebel-first
// (even when the Empire is the attacker), and the Empire's choice carries the
// Rebel's revealed card. Run: node scripts/test-good-intel-352.mjs
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

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
const baseOpts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true },
});

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

// Empire-attacker ground combat with a tactic leader on each side (so AddLeader
// auto-skips and the cinematic SELECT step runs immediately).
function setupCombat(seed, goodIntel) {
  const G = createGame(data, baseOpts(seed));
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  (G.empire.leadersOnBoard.felucia ??= []).push('general-veers');
  (G.rebel.leadersOnBoard.felucia ??= []).push('general-madine');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  if (goodIntel) {
    G.pendingCombat.flags = G.pendingCombat.flags ?? {};
    G.pendingCombat.flags.goodIntelActive = true;
  }
  combat.runCombat(G);
  return G;
}

console.log('\n[ control: without Good Intel, the attacking Empire chooses first ]');
{
  const G = setupCombat(700, false);
  const pc = G.pendingChoice;
  check('paused on a CinematicTacticSelect', pc?.kind === 'CinematicTacticSelect',
    `kind=${pc?.kind}`);
  check('the attacker (Empire) is prompted first', pc?.side === 'Empire', `side=${pc?.side}`);
  check('no revealed-opponent card on the control choice', pc?.revealedOpponentTactic === undefined);
}

console.log('\n[ #352: with Good Intel, the Rebel chooses first and the Empire sees it ]');
{
  const G = setupCombat(700, true);
  const first = G.pendingChoice;
  check('paused on a CinematicTacticSelect', first?.kind === 'CinematicTacticSelect',
    `kind=${first?.kind}`);
  check('the REBEL is prompted first (despite Empire attacking)', first?.side === 'Rebel',
    `side=${first?.side}`);

  // Resolve the Rebel's pick (play the first option's bottom ability), then the
  // Empire should be prompted with the Rebel's revealed card.
  const rebelCard = first.options[0]?.cardId;
  const r = combat.resolveCinematicTacticSelect(G, rebelCard, false);
  check('Rebel selection resolved', r.ok, r.reason);
  combat.runCombat(G);
  const second = G.pendingChoice;
  check('Empire is now prompted', second?.kind === 'CinematicTacticSelect' && second?.side === 'Empire',
    `kind=${second?.kind} side=${second?.side}`);
  check('Empire choice carries the Rebel revealed tactic',
    second?.revealedOpponentTactic != null && second.revealedOpponentTactic.cardId === rebelCard,
    `revealed=${JSON.stringify(second?.revealedOpponentTactic)} expected=${rebelCard}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
