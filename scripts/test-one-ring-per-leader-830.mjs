// #830 — "Princess Leia has both the Bounty ring and the Yoda ring." RR p.3
// "Attachment Rings": "A leader can have only one ring at a time; if a leader
// gains a second ring, remove the previous one." attachRing appended instead of
// replacing, on the mistaken belief that distinct tokens could share a leader.
// Run: node scripts/test-one-ring-per-leader-830.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };
handlers.registerAll();
const LEIA = 'princess-leia';
const game = () => createGame(data, { seed: 1, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
const rings = (G, l) => G.leaderAttachments?.[l] ?? [];
const seekYoda = (G, l) => {
  G.rebel.leadersOnBoard['dagobah'] = [l];
  registry.invokeByKey(G, 'seek-yoda',
    registry.makeContext('Rebel', { kind: 'mission', id: 'seek-yoda' }, { targetSystemId: 'dagobah', leaderIds: [l] }));
};

console.log('[ #830 — a leader bears one ring at a time ]');
{
  const G = game();
  M.attachRing(G, LEIA, 'bounty');
  seekYoda(G, LEIA);
  check('the reporter\'s case: Seek Yoda replaces the bounty ring', rings(G, LEIA).join() === 'yoda', rings(G, LEIA).join());
  check('the replaced ring no longer has a bearer', M.findRingHolder(G, 'bounty') === null);
  const rep = G.reputationMarker;
  M.deployUnit(G, 'Empire', 'stormtrooper', 'dagobah');
  M.captureLeader(G, LEIA, 'captured', { deferAutoRescue: true });
  check('and capturing her no longer costs the bounty reputation', G.reputationMarker === rep, `${rep} -> ${G.reputationMarker}`);
}
{
  const G = game();
  G.rebel.actionHand.push('the-milleninium-falcon');
  M.attachRing(G, 'han-solo', 'falcon');
  seekYoda(G, 'han-solo');
  check('Yoda replaces the Falcon ring', rings(G, 'han-solo').join() === 'yoda', rings(G, 'han-solo').join());
  check('the Falcon reminder card is discarded, so the ring cannot be re-placed',
    !G.rebel.actionHand.includes('the-milleninium-falcon') && G.rebel.actionDiscard.includes('the-milleninium-falcon'));
}
for (const [ring, card] of [['r2d2', 'resourceful-astromech'], ['c3po', 'human-cyborg-relations'], ['k2so', 'he-means-well']]) {
  const G = game();
  M.attachRing(G, LEIA, ring);
  M.attachRing(G, LEIA, 'bounty');
  check(`${ring} is replaced`, rings(G, LEIA).join() === 'bounty', rings(G, LEIA).join());
  check(`  and its card goes to the discard`, G.rebel.actionDiscard.includes(card));
}
{
  const G = game();
  G.rebel.actionHand.push('the-milleninium-falcon');
  M.attachRing(G, 'han-solo', 'falcon');
  M.attachRing(G, 'han-solo', 'falcon');
  check('re-attaching the same ring keeps it and its card',
    rings(G, 'han-solo').join() === 'falcon' && G.rebel.actionHand.includes('the-milleninium-falcon'));
  M.attachRing(G, LEIA, 'yoda');
  check('another leader\'s ring is untouched',
    rings(G, 'han-solo').join() === 'falcon' && rings(G, LEIA).join() === 'yoda');
}
{
  const G = game();
  G.rebel.leadersOnBoard['dagobah'] = ['luke-skywalker'];
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== 'luke-skywalker');
  M.attachRing(G, 'luke-skywalker', 'c3po');
  registry.invokeByKey(G, 'seek-yoda',
    registry.makeContext('Rebel', { kind: 'mission', id: 'seek-yoda' }, { targetSystemId: 'dagobah', leaderIds: ['luke-skywalker'] }));
  check('Luke\'s swap to Jedi carries only the Yoda ring',
    rings(G, 'luke-skywalker-jedi').join() === 'yoda' && rings(G, 'luke-skywalker').length === 0,
    JSON.stringify(G.leaderAttachments));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
