// Report #461 — Construct Factory built NOTHING. Corellia's two space icons are
// triangle + square. The AI's picker used `tier <= need` (so a square icon could
// land on a project-only Star Destroyer variant) and ignored supply (so a triangle
// icon whose only exact-tier unit, the TIE Fighter, is out of supply produced an
// invalid pick). Any single invalid pick made the WHOLE submission fail, and the
// fail-safe then nulled EVERY icon — so the Empire built nothing even though a
// Star Destroyer was available on the square icon.
// This test drives the AI's BuildFromIconsPick handler through stepOnce and
// confirms the valid icon still builds when a sibling icon has no legal unit.
// Run: node scripts/test-build-from-icons-461.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const ai = await import('../src/play/randomAI.ts');

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

handlers.registerAll();
ai.seedAI(1);

// Exhaust TIE Fighter supply so the triangle (space, tier 0) icon has NO legal
// exact-tier unit — the exact condition from the report.
function exhaustSupply(G, typeId) {
  const cap = G.catalog.unitTypes[typeId]?.supplyCount ?? 0;
  // Park them all on a far system so they count as committed.
  for (let i = 0; i < cap; i++) M.deployUnit(G, 'Empire', typeId, 'coruscant');
}

console.log('\n[ #461 Construct Factory: valid icon still builds when a sibling icon is unfillable ]');
{
  const G = createGame(data, { seed: 1, expansion: { enabled: true, roeUnits: true } });
  exhaustSupply(G, 'tie-fighter');
  const sdBefore = M.unitsAvailableInSupply(G, 'star-destroyer');
  const queueBefore = G.empire.buildQueue[3].length;

  // Corellia's real icons: space triangle + space square.
  G.pendingChoice = {
    kind: 'BuildFromIconsPick', side: 'Empire', systemId: 'corellia',
    icons: [{ theater: 'space', shape: 'triangle' }, { theater: 'space', shape: 'square' }],
    label: 'Construct Factory',
  };

  const ok = ai.stepOnce(G, 'Empire');
  const queueAfter = G.empire.buildQueue[3].length;
  const added = queueAfter - queueBefore;
  const queuedTypes = G.empire.buildQueue[3].slice(queueBefore);

  check('AI resolved the choice', ok);
  check('AI built at least one unit (not the old added:0 bug)', added >= 1, `added ${added}`);
  check('the built unit is a Star Destroyer (the square icon)',
    queuedTypes.includes('star-destroyer'), `queued ${JSON.stringify(queuedTypes)}`);
  check('no project-only / illegal type queued',
    queuedTypes.every((t) => !['super-star-destroyer', 'death-star', 'death-star-under-construction', 'interdictor'].includes(t)),
    `queued ${JSON.stringify(queuedTypes)}`);
  check('TIE Fighter (out of supply) NOT queued', !queuedTypes.includes('tie-fighter'));
  check('choice cleared', G.pendingChoice === undefined);
  void sdBefore;
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
