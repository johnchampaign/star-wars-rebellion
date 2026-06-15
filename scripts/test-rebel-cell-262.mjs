// #262 — Rebel Cell (Immediate objective) resolves WHEN DRAWN. With a Rebel
// system it places its marker; with none it resolves to nothing and must NOT
// fire later. Run: node scripts/test-rebel-cell-262.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const opts = {
  seed: 3, roeMissions: true, roeUnits: true, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
};

// Case A: Rebel system present -> places the marker (posts RebelCellPlace).
{
  const G = createGame(data, opts);
  G.rebel.objectiveHand = ['rebel-cell-2'];
  const posted = phases.flushImmediateObjectiveActivations(G, 'command');
  check('with a Rebel system: RebelCellPlace posted', posted && G.pendingChoice?.kind === 'RebelCellPlace',
    `posted=${posted} kind=${G.pendingChoice?.kind}`);
}

// Case B: NO Rebel system -> resolves to nothing, marks activated, never fires
// later even once a Rebel system appears.
{
  const G = createGame(data, opts);
  for (const ss of Object.values(G.map.systems)) if (ss.loyalty === 'rebel') ss.loyalty = 'neutral';
  G.rebel.objectiveHand = ['rebel-cell-2'];
  const posted1 = phases.flushImmediateObjectiveActivations(G, 'command');
  check('no Rebel system: nothing posted at draw', !posted1 && !G.pendingChoice,
    `posted=${posted1} kind=${G.pendingChoice?.kind}`);
  const noTarget = (G.turnLog ?? []).some((e) => e.kind === 'objective-immediate-no-target');
  check('logged immediate-no-target resolution', noTarget);

  // A Rebel system appears later (e.g. a loyalty mission) — must NOT re-trigger.
  G.map.systems['naboo'].loyalty = 'rebel';
  const posted2 = phases.flushImmediateObjectiveActivations(G, 'command');
  check('does NOT fire later when a Rebel system appears', !posted2 && G.pendingChoice?.kind !== 'RebelCellPlace',
    `posted=${posted2} kind=${G.pendingChoice?.kind}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
