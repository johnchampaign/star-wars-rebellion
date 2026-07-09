// #524 — Early Promotion: "Place Motti and Tarkin in ANY Imperial system." RAW is
// the player's choice; the engine was auto-placing at the first Imperial system
// (which, e.g., locked the player out of moving troops from that system that
// round). Now, with 2+ Imperial systems, it posts an Empire system pick and
// places both leaders where the player chooses.
// Run: node scripts/test-early-promotion-place-choice-524.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const choices = await import('../src/engine/choices.ts');
const { pendingChoiceOwner } = await import('../src/engine/choiceOwner.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const sysOf = (G, lid) => Object.entries(G.empire.leadersOnBoard).find(([, l]) => l.includes(lid))?.[0];

console.log('[ #524 — Early Promotion lets the Empire choose the Imperial system ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  G.currentPlayer = 'Empire';
  G.empire.startingActionDeck = []; // straight to recruit (no draw/recruit prompt)
  if (!G.empire.leaderPool.includes('grand-moff-tarkin')) G.empire.leaderPool.push('grand-moff-tarkin');
  G.empire.actionHand = ['early-promotion'];
  G.pendingChoice = { kind: 'PlayImmediateActionCard', side: 'Empire', candidates: ['early-promotion'] };
  phases.playImmediateActionCard(G, 'early-promotion');

  check('a system pick is raised', G.pendingChoice?.kind === 'Choice' && G.pendingChoice.tag === 'early-promotion-place', `pc=${G.pendingChoice?.kind}/${G.pendingChoice?.tag}`);
  check('owned by the Empire', pendingChoiceOwner(G, 'Empire') === true);
  const cands = (G.pendingChoice?.candidates ?? []).map((c) => c.id);
  check('2+ Imperial systems offered', cands.length >= 2, `cands=${cands.length}`);
  // Every candidate is an Imperial (loyalty/subjugated) system.
  const allImperial = cands.every((sid) => { const ss = G.map.systems[sid]; return ss && (ss.loyalty === 'imperial' || ss.subjugated); });
  check('all candidates are Imperial systems', allImperial);

  // Choose the SECOND candidate (not the auto-default first) — proves real choice.
  const chosen = cands[1];
  choices.resolveGenericChoice(G, [chosen]);
  check('Motti placed at the CHOSEN system', sysOf(G, 'motti') === chosen, `motti=${sysOf(G, 'motti')} chosen=${chosen}`);
  check('Tarkin placed at the CHOSEN system', sysOf(G, 'grand-moff-tarkin') === chosen, `tarkin=${sysOf(G, 'grand-moff-tarkin')} chosen=${chosen}`);
  check('NOT auto-placed at the first candidate', sysOf(G, 'motti') !== cands[0] || cands[0] === chosen);
  check('no dangling pending choice', !G.pendingChoice, `pc=${G.pendingChoice?.kind}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
