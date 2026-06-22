// Double-capture rescue (#384). RR p.3: "If a second leader is captured, the
// first leader is rescued, and the captured ring is attached to the new leader."
// The ring-replacement code pre-spliced the old captured entry before calling
// rescueLeader, which then couldn't find it and bailed — so the first leader was
// placed nowhere (vanished, reported as "eliminated").
// Run: node scripts/test-double-capture-rescue-384.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');

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

const capturedIds = (G) => (G.empire.capturedLeaders ?? []).map((c) => c.leaderId);
const baseKey = (G) => (G.rebelBaseRevealed ? G.rebelBaseSystemId : 'rebel-base-space');
const atBase = (G, lid) => (G.rebel.leadersOnBoard[baseKey(G)] ?? []).includes(lid);
const eliminated = (G, lid) => (G.rebel.eliminatedLeaders ?? []).includes(lid);
const onBoardSomewhere = (G, lid) =>
  Object.values(G.rebel.leadersOnBoard).some((l) => l.includes(lid))
  || (G.rebel.leaderPool ?? []).includes(lid)
  || capturedIds(G).includes(lid);

console.log('\n[ #384: capturing a second leader rescues the first to the base ]');
{
  const G = createGame(data, { seed: 5, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  for (const lid of ['mon-mothma', 'general-rieekan']) {
    if (!G.rebel.leaderPool.includes(lid)) G.rebel.leaderPool.push(lid);
    M.placeLeader(G, 'Rebel', lid, 'corellia');
  }
  M.deployUnit(G, 'Empire', 'stormtrooper', 'corellia');

  M.captureLeader(G, 'mon-mothma', 'captured', { deferAutoRescue: true });
  check('first capture holds Mon Mothma', capturedIds(G).includes('mon-mothma'));

  M.captureLeader(G, 'general-rieekan', 'captured', { deferAutoRescue: true });
  check('second capture now holds Rieekan', capturedIds(G).includes('general-rieekan'));
  check('Mon Mothma is no longer captured', !capturedIds(G).includes('mon-mothma'));
  check('Mon Mothma was NOT eliminated', !eliminated(G, 'mon-mothma'));
  check('Mon Mothma returned to the Rebel base (rescued)', atBase(G, 'mon-mothma'));
  check('Mon Mothma exists somewhere (did not vanish)', onBoardSomewhere(G, 'mon-mothma'));
  check('only one leader is captured at a time', capturedIds(G).length === 1);
}

console.log('\n[ a carbonite capture does NOT release the captured-ring leader ]');
{
  const G = createGame(data, { seed: 6, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  for (const lid of ['mon-mothma', 'general-rieekan']) {
    if (!G.rebel.leaderPool.includes(lid)) G.rebel.leaderPool.push(lid);
    M.placeLeader(G, 'Rebel', lid, 'corellia');
  }
  M.deployUnit(G, 'Empire', 'stormtrooper', 'corellia');
  M.captureLeader(G, 'mon-mothma', 'captured', { deferAutoRescue: true });
  M.captureLeader(G, 'general-rieekan', 'carbonite', { deferAutoRescue: true });
  // Carbonite is a separate ring — both can be held at once.
  check('both leaders held (captured + carbonite)',
    capturedIds(G).includes('mon-mothma') && capturedIds(G).includes('general-rieekan'),
    JSON.stringify(capturedIds(G)));
  check('neither was eliminated', !eliminated(G, 'mon-mothma') && !eliminated(G, 'general-rieekan'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
