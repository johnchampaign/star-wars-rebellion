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
  // Place the DSUC on a chosen remote — allowed, and it LOCKS that remote as the
  // Death Star site (master's RAW model: one chosen remote, mirroring the
  // Rebel's single off-base populous system).
  const r1 = phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', remote);
  check('DSUC accepted on a remote system', r1.ok, r1.reason);
  check('DSUC is now in that remote', G.map.systems[remote].units.some((u) => u.typeId === 'death-star-under-construction'));
  check('empireDeployTarget locked to the chosen remote', G.empireDeployTarget === remote, G.empireDeployTarget);
  // Companions (4 TIE + 1 Stormtrooper) may now join the chosen remote.
  const r2 = phases.setupDeployUnit(G, 'Empire', 'tie-fighter', remote);
  check('TIE Fighter accepted on the chosen remote', r2.ok, r2.reason);
  const r3 = phases.setupDeployUnit(G, 'Empire', 'stormtrooper', remote);
  check('Stormtrooper accepted on the chosen remote', r3.ok, r3.reason);
  // A DIFFERENT remote is now rejected — the site is already chosen.
  const otherRemote = Object.keys(G.map.systems).find((id) => id !== remote && G.catalog.systems[id]?.isRemote && !G.map.systems[id].destroyed);
  const r4 = phases.setupDeployUnit(G, 'Empire', 'tie-fighter', otherRemote);
  check('unit rejected on a different remote (site already chosen)', !r4.ok, r4.reason);
  // The DSUC package is not complete yet, so its required TIE Fighters cannot
  // be siphoned off to regular Imperial systems.
  const imp = imperialOf(G);
  const r5 = phases.setupDeployUnit(G, 'Empire', 'tie-fighter', imp);
  check('required companion rejected outside the DSUC remote until the package is complete',
    !r5.ok && r5.reason === 'dsuc-remote-package-incomplete', r5.reason);
}

console.log('[ #360: Empire auto-fill completes the chosen DSUC remote package ]');
{
  const G = createGame(data, { seed: 3, autoSetupUnits: false, expansion: { enabled: true } });
  const remote = remoteOf(G);
  const r1 = phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', remote);
  check('manual DSUC placement accepted before auto-fill', r1.ok, r1.reason);
  const r2 = phases.setupAutoFill(G, 'Empire');
  check('Empire auto-fill succeeds after manual DSUC placement', r2.ok, r2.reason);
  const units = G.map.systems[remote].units.filter((u) => u.side === 'Empire');
  const count = (typeId) => units.filter((u) => u.typeId === typeId).length;
  check('auto-fill leaves DSUC in the chosen remote', count('death-star-under-construction') === 1, count('death-star-under-construction'));
  check('auto-fill adds all 4 required TIE Fighters to the chosen remote', count('tie-fighter') === 4, count('tie-fighter'));
  check('auto-fill adds the required Stormtrooper to the chosen remote', count('stormtrooper') === 1, count('stormtrooper'));
}

console.log('[ #163: the DSUC may ONLY go on a remote, never an Imperial world ]');
{
  const G = createGame(data, { seed: 3, autoSetupUnits: false, expansion: { enabled: true } });
  const imp = imperialOf(G);
  const r = phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', imp);
  check('DSUC rejected on an Imperial-loyalty system', !r.ok && r.reason === 'dsuc-must-be-remote', r.reason);
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
