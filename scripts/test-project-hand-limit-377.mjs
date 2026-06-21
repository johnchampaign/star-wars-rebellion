// Mission hand limit counts project cards (#377). RR p.13: "Each player draws
// two mission cards, then discards cards if he is holding more than 10 mission
// cards. Project cards are missions and count toward this limit." The engine was
// excluding project cards from the count, so a hand padded with projects never
// triggered the Refresh-phase discard. Run: node scripts/test-project-hand-limit-377.mjs
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

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
const opts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, roeUnits: true, roeMissions: true },
});
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

console.log('\n[ #377: project cards in the mission hand count toward the 10 limit ]');
{
  const G = createGame(data, opts(900));
  // Drive a clean Command->Refresh transition: clear the Rebel hand and any
  // start-of-refresh objectives so nothing else pauses the Refresh.
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  G.passedThisCommand = [];
  G.pendingRapidMobilizations = [];
  G.rebel.objectiveHand = [];
  G.rebel.missionHand = [];
  // Empire: 8 regular + 3 project = 11 mission cards (no starting), already over
  // the limit by the project cards. After the Refresh draws 2 more (regular),
  // the hand is 13 — over by 3.
  const regular = ['address-delays', 'carbon-freezing', 'collect-bounty', 'detained',
    'display-of-power', 'double-our-efforts', 'hunt-them-down', 'imperial-propaganda'];
  const project = ['construct-factory', 'oversee-project', 'superlaser-online'];
  G.empire.missionHand = [...regular, ...project];
  G.empire.missionDiscard = [];

  phases.pass(G, 'Rebel');
  phases.pass(G, 'Empire'); // both pass -> Refresh runs
  // Let the AI clear any other Refresh prompts (recruit branches etc.) until the
  // hand-limit discard surfaces — but DON'T let it resolve that one (we inspect it).
  let guard = 0;
  while (G.pendingChoice && G.pendingChoice.kind !== 'HandLimitDiscard' && guard++ < 50) {
    if (!stepOnce(G, G.pendingChoice.side)) break;
  }

  const pc = G.pendingChoice;
  check('a HandLimitDiscard is posted', pc?.kind === 'HandLimitDiscard', pc?.kind);
  check('it targets the Empire', pc?.side === 'Empire', pc?.side);
  if (pc?.kind === 'HandLimitDiscard') {
    check('Empire must discard down to 10 (over by 3)', pc.count === 3, `count=${pc.count}`);
    // Project cards ARE discardable (only starting missions are exempt).
    const disc = new Set(pc.discardable ?? []);
    check('project cards are among the discardable options',
      project.some((p) => disc.has(p)), JSON.stringify([...disc]));
    check('the Empire hand is currently over 10', (G.empire.missionHand ?? []).length > 10,
      `${(G.empire.missionHand ?? []).length}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
