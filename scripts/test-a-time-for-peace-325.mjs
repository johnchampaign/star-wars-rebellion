// #325 — A Time for Peace no longer auto-scores at Refresh. Because it makes a
// big irreversible board change (destroying 4 Imperial build-queue units), the
// Rebel is now prompted whether to apply it (with a decline option) — RR p.10
// "you MAY play an objective". Declining keeps the units on the queue.
// Run: node scripts/test-a-time-for-peace-325.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

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

function setup(seed) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.rebel.objectiveHand = ['a-time-for-peace-2'];
  G.rebel.buildQueue = { 1: ['tie-fighter', 'star-destroyer'], 2: ['stormtrooper', 'at-st'], 3: ['at-at'] };
  return G;
}
const queueSize = (G) => G.rebel.buildQueue[1].length + G.rebel.buildQueue[2].length + G.rebel.buildQueue[3].length;

console.log('\n[ #325 A Time for Peace prompts instead of auto-scoring ]');
{
  const G = setup(80);
  const before = queueSize(G);
  const paused = phases.refreshPlayStartOfRefreshObjectives(G, 0);
  check('objective step paused for a prompt', paused === true);
  check('PlayObjective choice posted', G.pendingChoice?.kind === 'PlayObjective', G.pendingChoice?.kind);
  check('a-time-for-peace is offered', (G.pendingChoice?.legal ?? []).includes('a-time-for-peace-2'));
  check('decline is allowed', G.pendingChoice?.allowDecline === true);
  check('nothing destroyed yet (still just a prompt)', queueSize(G) === before);
}

console.log('\n[ #325 declining keeps the units on the queue ]');
{
  const G = setup(81);
  const before = queueSize(G);
  phases.refreshPlayStartOfRefreshObjectives(G, 0);
  const r = phases.resolvePlayObjectivePick(G, ''); // '' = decline
  check('decline resolves', r.ok, r.reason);
  check('queue is untouched', queueSize(G) === before, `before=${before} after=${queueSize(G)}`);
  check('objective stays in hand', (G.rebel.objectiveHand ?? []).includes('a-time-for-peace-2'));
}

console.log('\n[ #325 choosing to play it still destroys 2T+1C+1S ]');
{
  const G = setup(82);
  const before = queueSize(G);
  phases.refreshPlayStartOfRefreshObjectives(G, 0);
  const r = phases.resolvePlayObjectivePick(G, 'a-time-for-peace-2');
  check('play resolves', r.ok, r.reason);
  check('4 units destroyed', queueSize(G) === before - 4, `before=${before} after=${queueSize(G)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
