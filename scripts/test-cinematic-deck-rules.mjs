// Audit #4/#5: RoE cinematic deck recycle + "must play a card each round".
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const cin = await import('../src/engine/cinematicTactics.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
const baseOpts = (seed) => ({ seed, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo','corellia','kashyyyk'], forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'], expansion: { enabled: true, cinematicCombat: true } });
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };

// #4: deck recycle when the theatre deck empties.
console.log('[ #4: tactic deck recycles when emptied (keeps the last-resolved) ]');
{
  const G = createGame(data, baseOpts(810));
  const empSpace = Object.values(G.catalog.tactics)
    .filter((t) => t.cinematic && t.side === 'Empire' && t.theater === 'space')
    .map((t) => t.id);
  check('there are 8 Empire space cinematic cards', empSpace.length === 8, `${empSpace.length}`);
  // Simulate every card discarded in play order (deck empty).
  G.empire.cinematicTacticDiscard = [...empSpace];
  cin.recycleCinematicDeck(G, 'Empire', 'space');
  const discAfter = (G.empire.cinematicTacticDiscard ?? []).filter((id) => empSpace.includes(id));
  check('recycle keeps exactly 1 card in the discard', discAfter.length === 1, `${discAfter.length}`);
  check('the kept card is the last-resolved one', discAfter[0] === empSpace[7]);
  // Other theatres unaffected (no cross-theatre recycle).
  cin.recycleCinematicDeck(G, 'Empire', 'space'); // idempotent
  check('second recycle is a no-op (deck no longer empty)', (G.empire.cinematicTacticDiscard ?? []).filter((id) => empSpace.includes(id)).length === 1);
}

// #5: must play a card each round — declining still discards a card.
console.log('[ #5: declining the ability still discards a card (must-play) ]');
{
  const G = createGame(data, baseOpts(811));
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  combat.runCombat(G);
  let guard = 0;
  while (G.pendingChoice?.kind === 'CombatAddLeaderPick' && guard++ < 5) combat.resolveCombatAddLeaderPick(G, null);
  check('Empire is prompted to select', G.pendingChoice?.kind === 'CinematicTacticSelect' && G.pendingChoice.side === 'Empire');
  const empBefore = (G.empire.cinematicTacticDiscard ?? []).length;
  const rebBefore = (G.rebel.cinematicTacticDiscard ?? []).length;
  combat.resolveCinematicTacticSelect(G, null, false); // Empire declines the ability
  if (G.pendingChoice?.kind === 'CinematicTacticSelect') combat.resolveCinematicTacticSelect(G, null, false); // Rebel declines too
  check('Empire still discarded a card (did not skip)', (G.empire.cinematicTacticDiscard ?? []).length === empBefore + 1);
  check('Rebel still discarded a card', (G.rebel.cinematicTacticDiscard ?? []).length === rebBefore + 1);
  // No abilities resolved: no prevent/cancel/etc. were set by the declined cards.
  check('declined plays resolved no ability (no cancel set)', !G.pendingCombat?.cinematicCancel || Object.keys(G.pendingCombat.cinematicCancel).length === 0);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #4/#5 deck-rule tests passed');
process.exit(fail ? 1 : 0);
