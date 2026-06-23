// Point Blank Assault not offered when pointless (#386). The card is "All units
// in the system have -1 health (min 1)" — useless if no ENEMY unit has health
// > 1 (e.g. a lone 1-HP TIE Fighter can't be reduced).
// Run: node scripts/test-point-blank-pointless-386.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e='') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e?' — '+e:''}`); fail++; } };

// Drive a combat and collect every CombatStartActionCards offer's playable list for the Rebel.
function rebelStartCards(empireShip) {
  const G = createGame(data, { seed: 3, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  (G.rebel.leadersOnBoard.felucia ??= []).push('admiral-ackbar');
  G.rebel.actionHand = ['point-blank-assault'];
  M.deployUnit(G, 'Empire', empireShip, 'felucia');
  (G.empire.leadersOnBoard.felucia ??= []).push('darth-vader');
  combat.beginCombat(G, 'Rebel', 'naboo', 'felucia');
  combat.runCombat(G);
  // The first StartOfCombat offer is for the attacker (Rebel). Capture it.
  const pc = G.pendingChoice;
  if (pc?.kind === 'CombatStartActionCards' && pc.side === 'Rebel') return pc.playable;
  return null;
}

console.log('\n[ #386: lone 1-HP TIE Fighter → Point Blank Assault NOT offered ]');
{
  const playable = rebelStartCards('tie-fighter');
  // Point Blank was the only card in hand, so filtering it leaves an empty
  // playable list and NO offer is posted (null) — i.e. it isn't offered.
  check('Point Blank Assault is NOT offered (lone 1-HP enemy)',
    playable === null || !playable.includes('point-blank-assault'), JSON.stringify(playable));
}

console.log('\n[ control: enemy has a >1-HP ship → Point Blank Assault IS offered ]');
{
  const playable = rebelStartCards('star-destroyer');
  check('a Rebel StartOfCombat offer was posted', playable !== null);
  check('Point Blank Assault IS in the offer', (playable ?? []).includes('point-blank-assault'),
    JSON.stringify(playable));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
