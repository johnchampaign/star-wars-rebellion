// #851 — "why play prepare for battle when no battle has taken place so there
// is not even a bit of gain in this move?"
//
// Prepare For Battle: "Attempt on a subjugated system. Return assigned leaders
// to the pool. Look at the top 4 cards of any tactic deck and place them
// top/bottom in any order, or return discarded Rebel advanced tactic cards to
// their decks."
//
// With cinematic combat on there is no ordered tactic deck, so the card's
// effect is the second half only. Before the Rebel has used an advanced tactic
// card there is nothing to return, and the reporter watched the AI Rebel spend
// Han Solo and a Command-phase action on it on turn 2. The shared
// pointless-reveal check now says so, which stops the AI assigning or
// revealing it and warns a human before they waste it.
//
// Run: node scripts/test-prepare-for-battle-noop-851.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { missionRevealIsPointless, missionPointlessReason } = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json') };

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const P = (G) => missionRevealIsPointless(G, 'Rebel', 'prepare-for-battle', 'mon-calamari');

console.log('\n[ cinematic combat ]');
{
  const G = createGame(data, { seed: 70, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true } });
  G.rebel.cinematicTacticDiscard = [];
  check('pointless before any advanced tactic card has been used', P(G) === true);
  const why = missionPointlessReason(G, 'Rebel', 'prepare-for-battle', 'mon-calamari');
  check('and the player is told why', typeof why === 'string' && /tactic/.test(why), String(why));
  G.rebel.cinematicTacticDiscard = ['cin-rebel-ground-confrontation'];
  G.rebel.cinematicTacticEliminated = ['cin-rebel-ground-confrontation'];
  check('still pointless when the only discard is an eliminated card', P(G) === true);
  G.rebel.cinematicTacticDiscard.push('cin-rebel-space-bombing-run');
  check('worth playing once there is a card to bring back', P(G) === false);
}

console.log('\n[ base combat: the deck peek always does something ]');
{
  const G = createGame(data, { seed: 70, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: false } });
  check('never flagged pointless', P(G) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
