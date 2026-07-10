// #533 — the human found the Rebel base, then removed its single ground defender
// with a card (outside combat). The game correctly ended (Empire wins, base
// captured), but the combat board stayed mounted showing "Waiting for AI…" that
// never resolved — blocking the game-over screen and the log submit. The UI fix is
// a render guard (don't mount the combat board once G.isGameOver). This test locks
// the ENGINE behavior the guard relies on: removing the base's last Rebel unit
// while the Empire is present ends the game via recomputeGameEnd, even mid-combat
// (with pendingCombat still set).
// Run: node scripts/test-base-last-defender-removed-533.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ #533 — removing the base\'s last defender ends the game (mid-combat) ]');
{
  const G = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true } });
  const BASE = G.rebelBaseSystemId;
  G.rebelBaseRevealed = true;
  const mk = (t, s) => ({ instanceId: t + Math.random(), typeId: t, side: s, damage: 0 });
  G.map.systems[BASE].units = [mk('stormtrooper', 'Empire'), mk('star-destroyer', 'Empire')];
  const reb = mk('rebel-trooper', 'Rebel');
  G.map.systems[BASE].units.push(reb);
  // Mid-combat state: a pending combat + an AI-owed choice are set (as they would
  // be when a Start-of-Combat card removes the defender before dice are rolled).
  G.pendingCombat = { systemId: BASE };
  G.pendingChoice = { kind: 'CombatAttackerTactics', side: 'Rebel', theater: 'ground' };

  check('game is not over before the removal', !G.isGameOver);
  M.destroyUnit(G, reb.instanceId, 'action-card');
  check('game ends when the last Rebel defender is removed', G.isGameOver === true);
  check('Empire wins by base capture', G.winner === 'Empire' && G.winReason === 'base-captured', `winner=${G.winner} reason=${G.winReason}`);
  // The pending combat/choice intentionally persist in engine state — the UI must
  // stop rendering the combat board once isGameOver, which is the shipped guard.
  check('isGameOver is set for the UI guard to key on', G.isGameOver === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
