// Audit #10: when a system is destroyed (Superlaser), all its target markers
// are removed and each removal effect is resolved (RoE p.8).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };
const markers = (G, sid) => G.map.systems[sid]?.targetMarkers ?? [];

console.log('[ #10: destroying a system removes its target markers + resolves effects ]');
{
  const G = createGame(data, { seed: 5, expansion: { enabled: true } });
  // A non-base, non-Coruscant, non-destroyed system (so destruction doesn't end the game).
  const sysId = Object.keys(G.map.systems).find((id) =>
    id !== G.rebelBaseSystemId && !G.catalog.systems[id]?.isCoruscant && !G.map.systems[id].destroyed);
  G.map.systems[sysId].targetMarkers = [
    { source: 'secure-the-plans', placedBy: 'Empire', placedAt: 0 },
    { source: 'raid-outposts-2', placedBy: 'Empire', placedAt: 0 },
  ];
  const rep0 = G.reputationMarker;
  M.destroySystem(G, sysId);
  check('system is destroyed', G.map.systems[sysId].destroyed === true);
  check('all target markers removed', markers(G, sysId).length === 0);
  check('Raid Outposts removal scored the Rebel +1 reputation', G.reputationMarker === rep0 - 1);
}

console.log('[ #10: destroying a marker-less system is a clean no-op for markers ]');
{
  const G = createGame(data, { seed: 6, expansion: { enabled: true } });
  const sysId = Object.keys(G.map.systems).find((id) =>
    id !== G.rebelBaseSystemId && !G.catalog.systems[id]?.isCoruscant && !G.map.systems[id].destroyed);
  const rep0 = G.reputationMarker;
  M.destroySystem(G, sysId);
  check('system destroyed, no reputation change (no markers)', G.map.systems[sysId].destroyed === true && G.reputationMarker === rep0);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #10 system-destroy-marker tests passed');
process.exit(fail ? 1 : 0);
