// #272 — It's a Trap actually blocks the opponent's space cinematic tactic
// cards during round 1 (the lock flag was set but never read).
// Run: node scripts/test-its-a-trap-272.mjs
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
const { isCinematicLocked, cinematicSelectOptions } = await import('../src/engine/cinematicTactics.ts');

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

const opts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true },
});

console.log('\n[ #272 isCinematicLocked honours the It\'s a Trap flag ]');
{
  const c = { systemId: 'felucia', round: 1, cinematic: true,
    flags: { noSpaceTacticsRound1Side: 'Empire' } };
  check('Empire space round 1 → locked', isCinematicLocked(c, 'Empire', 'space') === true);
  check('Empire ground round 1 → not locked', isCinematicLocked(c, 'Empire', 'ground') === false);
  check('Rebel space round 1 → not locked', isCinematicLocked(c, 'Rebel', 'space') === false);
  const c2 = { ...c, round: 2 };
  check('Empire space round 2 → not locked', isCinematicLocked(c2, 'Empire', 'space') === false);
}

console.log('\n[ #272 effect records the opponent as the locked side ]');
{
  const G = createGame(data, opts(800));
  // Rebel attacks an Empire fleet in space at felucia; give the Rebel It's a Trap.
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  G.rebel.actionHand = ['its-a-trap'];
  // It's a Trap requires Admiral Ackbar at the combat system — place him.
  M.placeLeader(G, 'Rebel', 'admiral-ackbar', 'felucia');
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);

  // Drive to the Rebel's start-of-combat action card window and play It's a Trap.
  let guard = 0, played = false;
  while (G.pendingCombat && G.pendingChoice && guard++ < 50) {
    const pc = G.pendingChoice;
    if (pc.kind === 'CombatStartActionCards' && pc.side === 'Rebel'
        && pc.playable.includes('its-a-trap')) {
      const r = combat.resolveCombatStartActionCards(G, ['its-a-trap']);
      check('played It\'s a Trap', r.ok, r.reason);
      played = true;
      break;
    }
    // Auto-resolve any earlier add-leader / start-card windows by skipping them.
    if (pc.kind === 'CombatStartActionCards') { combat.resolveCombatStartActionCards(G, []); continue; }
    if (pc.kind === 'CombatAddLeaderPick') { combat.resolveCombatAddLeaderPick(G, null); continue; }
    break;
  }
  check('reached and played the card', played);
  const c = G.pendingCombat;
  check('locked side recorded as Empire', c?.flags?.noSpaceTacticsRound1Side === 'Empire',
    String(c?.flags?.noSpaceTacticsRound1Side));
  // Round is 1 here → the Empire should have NO space tactic options.
  if (c) {
    c.round = 1;
    const opts2 = cinematicSelectOptions(G, c, 'Empire', 'space');
    check('Empire has 0 space tactic options in round 1', opts2.length === 0,
      `got ${opts2.length}`);
    // Sanity: not locked out of GROUND, and Rebel keeps its space cards.
    check('Empire still has ground options available',
      cinematicSelectOptions(G, c, 'Empire', 'ground').length > 0);
    check('Rebel keeps space options', cinematicSelectOptions(G, c, 'Rebel', 'space').length > 0);
    // Round 2 → Empire space unlocked.
    c.round = 2;
    check('Empire space unlocked in round 2',
      cinematicSelectOptions(G, c, 'Empire', 'space').length > 0);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
