// #329 — Prepare For Battle's deck effect now actually resolves (it was a stub).
//   - Cinematic combat: returns the Rebel's discarded advanced tactic cards to
//     availability (keeping eliminated ones gone).
//   - Base combat: peek the top 4 of a chosen tactic deck and reorder them.
// Run: node scripts/test-prepare-for-battle-329.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');

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

console.log('\n[ #329 cinematic: returns discarded advanced cards, keeps eliminated gone ]');
{
  const G = createGame(data, { seed: 70, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true } });
  G.rebel.cinematicTacticDiscard = ['cin-rebel-space-bombing-run', 'cin-rebel-ground-confrontation', 'cin-rebel-space-ion-blast'];
  G.rebel.cinematicTacticEliminated = ['cin-rebel-ground-confrontation'];
  const done = registry.invokeByKey(G, 'prepare-for-battle', { leaderIds: [] });
  check('handler completed (no pause in cinematic mode)', done === true);
  check('eliminated card stays in the discard (still gone)',
    G.rebel.cinematicTacticDiscard.includes('cin-rebel-ground-confrontation'));
  check('non-eliminated discards returned to availability',
    !G.rebel.cinematicTacticDiscard.includes('cin-rebel-space-bombing-run')
    && !G.rebel.cinematicTacticDiscard.includes('cin-rebel-space-ion-blast'),
    JSON.stringify(G.rebel.cinematicTacticDiscard));
}

console.log('\n[ #329 base: peek a tactic deck and reorder its top 4 ]');
{
  const G = createGame(data, { seed: 71, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  // Force a known space tactic deck.
  G.spaceTacticDeck = ['s1', 's2', 's3', 's4', 's5'];
  const paused = registry.invokeByKey(G, 'prepare-for-battle', { leaderIds: [] });
  check('handler paused for a deck pick (base mode)', paused === false);
  check('PrepareForBattleDeckPick posted', G.pendingChoice?.kind === 'PrepareForBattleDeckPick',
    G.pendingChoice?.kind);
  check('space-tactic is an option', (G.pendingChoice?.options ?? []).includes('space-tactic'));

  const r = phases.resolvePrepareForBattleDeckPick(G, 'space-tactic');
  check('deck pick resolves', r.ok, r.reason);
  check('reorder choice posted with the top 4', G.pendingChoice?.kind === 'StolenPlansReorder'
    && G.pendingChoice.remaining.length === 4 && G.pendingChoice.deckKind === 'space-tactic',
    JSON.stringify({ k: G.pendingChoice?.kind, n: G.pendingChoice?.remaining?.length }));

  // Reorder: place s4, s3, s2, s1 on top (reverse of the drawn order).
  for (const cid of ['s4', 's3', 's2', 's1']) phases.resolveStolenPlansPick(G, cid);
  check('top 4 of the space deck are now reordered',
    G.spaceTacticDeck.slice(0, 5).join(',') === 's4,s3,s2,s1,s5',
    G.spaceTacticDeck.join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
