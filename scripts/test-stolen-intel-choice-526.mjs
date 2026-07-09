// #526 — Stolen Intel: "Draw a probe card. Look at the Rebel hand of missions
// and discard one (not a starter)." RAW: the IMPERIAL player chooses which
// non-starter Rebel mission to discard. The engine was auto-picking the first
// one. Now it posts an Empire card-pick when 2+ candidates exist (0–1 resolve
// directly).
// Run: node scripts/test-stolen-intel-choice-526.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');
const choices = await import('../src/engine/choices.ts');
const { pendingChoiceOwner } = await import('../src/engine/choiceOwner.ts');
handlers.registerAll();
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Pick some non-starter Rebel missions from the catalog.
function nonStarters(G, n) {
  return Object.values(G.catalog.missions).filter((m) => m.side === 'Rebel' && !m.isStarting).slice(0, n).map((m) => m.id);
}

console.log('[ #526 — Empire CHOOSES which Rebel mission Stolen Intel discards ]');
{
  const G = createGame(data, { seed: 5, expansion: { enabled: true, roeMissions: true } });
  const [m1, m2, m3] = nonStarters(G, 3);
  G.rebel.missionHand = [m1, m2, m3];
  G.rebel.missionDiscard = [];
  G.pendingChoice = undefined;
  registry.invokeByKey(G, 'stolen-intel', {});
  check('a stolen-intel-discard choice is raised', G.pendingChoice?.kind === 'Choice' && G.pendingChoice.tag === 'stolen-intel-discard', `pc=${G.pendingChoice?.kind}/${G.pendingChoice?.tag}`);
  check('the choice is owned by the Empire', pendingChoiceOwner(G, 'Empire') === true && pendingChoiceOwner(G, 'Rebel') === false);
  check('all three non-starter missions are candidates', (G.pendingChoice?.candidates ?? []).map((c) => c.id).sort().join(',') === [m1, m2, m3].sort().join(','));
  // Empire picks the SECOND one (not the first, proving it's a real choice).
  choices.resolveGenericChoice(G, [m2]);
  check('the chosen mission was discarded', G.rebel.missionDiscard.includes(m2) && !G.rebel.missionHand.includes(m2));
  check('the OTHER missions stayed in the Rebel hand', G.rebel.missionHand.includes(m1) && G.rebel.missionHand.includes(m3));
}

console.log('[ exactly one non-starter → auto-discard, no choice ]');
{
  const G = createGame(data, { seed: 5, expansion: { enabled: true, roeMissions: true } });
  const starter = Object.values(G.catalog.missions).find((m) => m.side === 'Rebel' && m.isStarting)?.id;
  const [only] = nonStarters(G, 1);
  G.rebel.missionHand = [only, starter].filter(Boolean);
  G.rebel.missionDiscard = [];
  G.pendingChoice = undefined;
  registry.invokeByKey(G, 'stolen-intel', {});
  check('no choice raised', G.pendingChoice?.kind !== 'Choice');
  check('the single non-starter was discarded', G.rebel.missionDiscard.includes(only));
  check('the starter mission was NOT discarded', starter ? G.rebel.missionHand.includes(starter) : true);
}

console.log('[ no non-starters → no-op ]');
{
  const G = createGame(data, { seed: 5, expansion: { enabled: true, roeMissions: true } });
  const starter = Object.values(G.catalog.missions).find((m) => m.side === 'Rebel' && m.isStarting)?.id;
  G.rebel.missionHand = starter ? [starter] : [];
  G.rebel.missionDiscard = [];
  G.pendingChoice = undefined;
  registry.invokeByKey(G, 'stolen-intel', {});
  check('nothing discarded, no choice', (G.rebel.missionDiscard ?? []).length === 0 && G.pendingChoice?.kind !== 'Choice');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
