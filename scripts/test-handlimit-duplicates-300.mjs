// #300 — the Refresh-phase mission hand-limit discard no longer freezes when the
// hand holds duplicate mission copies (#287). Discarding two copies of one
// mission id is legal and the AI can resolve it.
// Run: node scripts/test-handlimit-duplicates-300.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');

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
  expansion: { enabled: true, roeUnits: true },
});

console.log('\n[ #300 resolver accepts discarding two copies of one mission id ]');
{
  const G = createGame(data, opts(980));
  // Build an over-limit Rebel hand: 11 non-starting missions, two of which are
  // duplicate copies of "reconnaissance" (a copies:2 mission).
  const filler = ['plant-explosives', 'safe-haven', 'assault', 'hit-and-run',
    'stolen-intel', 'exploit-weakness', 'daring-rescue', 'deployment', 'address-delays'];
  G.rebel.missionHand = ['reconnaissance', 'reconnaissance', ...filler];
  G.rebel.missionDiscard = [];
  // Post a HandLimitDiscard directly via the queue machinery.
  const discardable = G.rebel.missionHand.filter((id) => {
    const c = G.catalog.missions[id];
    return c && !c.isStarting && !c.isProject;
  });
  const over = discardable.length - 10;
  check('hand is over the limit', over > 0, `over=${over}`);
  G.pendingHandLimitDiscards = { logStart: 0, queue: [{ side: 'Rebel', count: over, discardable }] };
  G.pendingChoice = { kind: 'HandLimitDiscard', side: 'Rebel', count: over, discardable };

  // Discard two copies of the SAME id — this used to be rejected as a duplicate.
  const picks = over >= 2 ? ['reconnaissance', 'reconnaissance'] : ['reconnaissance'];
  const r = phases.resolveHandLimitDiscard(G, picks);
  check('resolver accepts duplicate-id discards', r.ok, r.reason);
  const remaining = G.rebel.missionHand.filter((id) => id === 'reconnaissance').length;
  check('both reconnaissance copies were discarded',
    over >= 2 ? remaining === 0 : remaining === 1, `remaining=${remaining}`);
}

console.log('\n[ #300 AI auto-resolves a hand-limit discard with duplicate copies (no freeze) ]');
{
  const G = createGame(data, opts(981));
  const filler = ['plant-explosives', 'safe-haven', 'assault', 'hit-and-run',
    'stolen-intel', 'exploit-weakness', 'daring-rescue', 'deployment', 'address-delays'];
  G.empire.missionHand = []; // keep empire out of it
  G.rebel.missionHand = ['reconnaissance', 'reconnaissance', ...filler];
  const discardable = [...G.rebel.missionHand];
  const over = discardable.length - 10;
  G.pendingHandLimitDiscards = { logStart: 0, queue: [{ side: 'Rebel', count: over, discardable }] };
  G.pendingChoice = { kind: 'HandLimitDiscard', side: 'Rebel', count: over, discardable };
  const did = stepOnce(G, 'Rebel');
  check('AI step resolved the discard', did === true);
  check('choice cleared (no freeze)', G.pendingChoice?.kind !== 'HandLimitDiscard',
    `pc=${G.pendingChoice?.kind}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
