// Capture strips the leader's attachment ring (#804). RR p.3 "Attachment Rings":
// "A leader can have only one ring at a time; if a leader gains a second ring,
// remove the previous one" — and "If an attachment ring is removed from a
// leader, it is returned to the supply and its effect no longer applies to that
// leader." The captured ring is a ring, so a captured Luke loses Master Yoda's
// ring and does NOT get it back on rescue. Before the fix the Yoda ring rode
// through capture and a rescued Luke kept offering the once-per-round reroll.
// Run: node scripts/test-capture-strips-ring-804.mjs
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

function setup(seed, lid) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  if (!G.rebel.leaderPool.includes(lid)) G.rebel.leaderPool.push(lid);
  M.placeLeader(G, 'Rebel', lid, 'corellia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'corellia'); // no auto-rescue
  return G;
}

console.log('\n[ #804: capturing the Yoda-ring bearer removes the ring for good ]');
{
  const G = setup(11, 'luke-skywalker-jedi');
  M.attachRing(G, 'luke-skywalker-jedi', 'yoda');
  check('precondition: Luke bears the Yoda ring', M.findRingHolder(G, 'yoda') === 'luke-skywalker-jedi');

  M.captureLeader(G, 'luke-skywalker-jedi', 'captured', { deferAutoRescue: true });
  check('Luke is captured', capturedIds(G).includes('luke-skywalker-jedi'));
  check('Yoda ring removed on capture', M.findRingHolder(G, 'yoda') === null,
    JSON.stringify(G.leaderAttachments));

  M.rescueLeader(G, 'luke-skywalker-jedi', 'test');
  check('Luke rescued', !capturedIds(G).includes('luke-skywalker-jedi'));
  check('rescue does NOT restore the Yoda ring', M.findRingHolder(G, 'yoda') === null);
}

console.log('\n[ carbonite capture strips the ring too ]');
{
  const G = setup(12, 'luke-skywalker-jedi');
  M.attachRing(G, 'luke-skywalker-jedi', 'yoda');
  M.captureLeader(G, 'luke-skywalker-jedi', 'carbonite', { deferAutoRescue: true });
  check('Yoda ring removed by carbonite', M.findRingHolder(G, 'yoda') === null);
}

console.log('\n[ capturing the Falcon bearer spends the ring and its reminder card ]');
{
  const G = setup(13, 'han-solo');
  if (!G.rebel.actionHand.includes('the-milleninium-falcon')) G.rebel.actionHand.push('the-milleninium-falcon');
  M.attachRing(G, 'han-solo', 'falcon');
  M.captureLeader(G, 'han-solo', 'captured', { deferAutoRescue: true });
  check('Falcon ring removed', M.findRingHolder(G, 'falcon') === null);
  check('Falcon card left the hand', !G.rebel.actionHand.includes('the-milleninium-falcon'));
  check('Falcon card discarded', G.rebel.actionDiscard.includes('the-milleninium-falcon'));
}

console.log('\n[ an uncaptured leader keeps its ring ]');
{
  const G = setup(14, 'luke-skywalker-jedi');
  if (!G.rebel.leaderPool.includes('mon-mothma')) G.rebel.leaderPool.push('mon-mothma');
  M.placeLeader(G, 'Rebel', 'mon-mothma', 'corellia');
  M.attachRing(G, 'luke-skywalker-jedi', 'yoda');
  M.captureLeader(G, 'mon-mothma', 'captured', { deferAutoRescue: true });
  check('Luke still bears the Yoda ring', M.findRingHolder(G, 'yoda') === 'luke-skywalker-jedi');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
