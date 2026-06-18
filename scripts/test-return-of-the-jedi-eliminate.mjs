// Return of the Jedi objective: the "if Luke (Jedi) is in this system, eliminate
// 1 Imperial leader" clause was previously dropped (only the reputation half
// scored). This verifies the elimination now fires when the Rebel wins a battle
// in Vader's system with Luke (Jedi) present.
// Run: node scripts/test-return-of-the-jedi-eliminate.mjs
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
const { stepOnce } = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
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

function driveCombat(G) {
  let guard = 0;
  combat.runCombat(G);
  while (G.pendingCombat && guard++ < 1000) {
    if (G.pendingChoice) { if (!stepOnce(G, G.pendingChoice.side)) break; }
    else combat.runCombat(G);
  }
}

console.log('\n[ Return of the Jedi: Rebel wins in Vader\'s system with Luke (Jedi) → Vader eliminated ]');
{
  // Find a seed where the overwhelming Rebel force wipes the lone Imperial unit.
  let done = false;
  for (let seed = 1; seed <= 40 && !done; seed++) {
    const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
    // Empire: Vader + one weak ground unit at felucia.
    (G.empire.leadersOnBoard.felucia ??= []).push('darth-vader');
    M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
    // Rebel: Luke (Jedi) + an overwhelming ground force, attacking from an adjacency.
    (G.rebel.leadersOnBoard.felucia ??= []).push('luke-skywalker-jedi');
    for (let i = 0; i < 6; i++) M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
    G.rebel.objectiveHand = ['return-of-the-jedi-3'];
    const repBefore = G.reputationMarker;

    combat.beginCombat(G, 'Rebel', 'naboo', 'felucia');
    driveCombat(G);

    const rebelWon = (G.map.systems.felucia.units ?? []).every((u) => u.side === 'Rebel')
      && (G.map.systems.felucia.units ?? []).some((u) => u.side === 'Rebel');
    if (!rebelWon || G.pendingCombat) continue; // need a clean Rebel win this seed
    done = true;

    const vaderGone = !(G.empire.leadersOnBoard.felucia ?? []).includes('darth-vader');
    const vaderEliminated = (G.empire.eliminatedLeaders ?? G.empire.leaderEliminated ?? []).includes?.('darth-vader')
      || !Object.values(G.empire.leadersOnBoard).some((l) => l.includes('darth-vader'));
    check(`(seed ${seed}) Rebel won at felucia`, rebelWon);
    check('Vader was eliminated from the board', vaderGone, JSON.stringify(G.empire.leadersOnBoard.felucia));
    check('objective scored reputation (marker moved toward Rebel)', G.reputationMarker < repBefore,
      `before=${repBefore} after=${G.reputationMarker}`);
    check('return-of-the-jedi-3 left the Rebel hand', !(G.rebel.objectiveHand ?? []).includes('return-of-the-jedi-3'));
  }
  check('found a clean Rebel-win seed', done);
}

console.log('\n[ control: no Luke (Jedi) present → no elimination, still scores ]');
{
  let done = false;
  for (let seed = 1; seed <= 40 && !done; seed++) {
    const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
    (G.empire.leadersOnBoard.felucia ??= []).push('darth-vader');
    M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
    for (let i = 0; i < 6; i++) M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
    G.rebel.objectiveHand = ['return-of-the-jedi-3'];
    combat.beginCombat(G, 'Rebel', 'naboo', 'felucia');
    driveCombat(G);
    const rebelWon = (G.map.systems.felucia.units ?? []).length > 0
      && (G.map.systems.felucia.units ?? []).every((u) => u.side === 'Rebel');
    if (!rebelWon || G.pendingCombat) continue;
    done = true;
    check('without Luke (Jedi), Vader survives', (G.empire.leadersOnBoard.felucia ?? []).includes('darth-vader'));
  }
  check('found a clean control seed', done);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
