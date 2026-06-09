// Bug #163: RoE interactive setup must let the Empire place the Death Star
// Under Construction (and companion units) on a chosen remote system.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };

let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };
const remoteOf = (G) => Object.keys(G.map.systems).find((id) => G.catalog.systems[id]?.isRemote && !G.map.systems[id].destroyed);
const imperialOf = (G) => Object.keys(G.map.systems).find((id) => G.map.systems[id].loyalty === 'imperial');

console.log('[ #163: RoE — DSUC placeable on a remote; companions follow ]');
{
  const G = createGame(data, { seed: 3, autoSetupUnits: false, expansion: { enabled: true } });
  check('interactive RoE setup is in the Setup phase', G.phase === 'Setup' && !!G.pendingDeployment);
  check('DSUC is pending for the Empire', G.pendingDeployment.Empire.includes('death-star-under-construction'));
  const remote = remoteOf(G);
  // Before: a normal Imperial unit can't go on a remote (no DSUC there yet).
  const pre = phases.setupDeployUnit(G, 'Empire', 'tie-fighter', remote);
  check('TIE Fighter rejected on a remote with no DSUC', !pre.ok, pre.reason);
  // Place the DSUC on the remote — should now be allowed.
  const r1 = phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', remote);
  check('DSUC accepted on a remote system', r1.ok, r1.reason);
  check('DSUC is now in that remote', G.map.systems[remote].units.some((u) => u.typeId === 'death-star-under-construction'));
  // Companions (4 TIE + 1 Stormtrooper) may now join the DSUC's remote.
  const r2 = phases.setupDeployUnit(G, 'Empire', 'tie-fighter', remote);
  check('TIE Fighter accepted on the DSUC remote', r2.ok, r2.reason);
  const r3 = phases.setupDeployUnit(G, 'Empire', 'stormtrooper', remote);
  check('Stormtrooper accepted on the DSUC remote', r3.ok, r3.reason);
  // A DIFFERENT remote (no DSUC) still rejects a normal unit.
  const otherRemote = Object.keys(G.map.systems).find((id) => id !== remote && G.catalog.systems[id]?.isRemote && !G.map.systems[id].destroyed);
  const r4 = phases.setupDeployUnit(G, 'Empire', 'tie-fighter', otherRemote);
  check('TIE Fighter rejected on a different (DSUC-less) remote', !r4.ok, r4.reason);
  // Imperial systems still legal.
  const imp = imperialOf(G);
  const r5 = phases.setupDeployUnit(G, 'Empire', 'stormtrooper', imp);
  check('Imperial-loyalty system still legal', r5.ok, r5.reason);
}

console.log('[ #163: base game unaffected — Empire still cannot use remotes ]');
{
  const G = createGame(data, { seed: 3, autoSetupUnits: false }); // no expansion
  const remote = remoteOf(G);
  const r = phases.setupDeployUnit(G, 'Empire', 'stormtrooper', remote);
  check('base game: Empire unit rejected on a remote', !r.ok, r.reason);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #163 setup tests passed');
process.exit(fail ? 1 : 0);
