// Rebel setup deployment (#371): the Rebel may place starting units on "any one
// Rebel or neutral system". Remote systems are always neutral (RR), so they ARE
// valid deployment targets — they were wrongly rejected before.
// Run: node scripts/test-rebel-setup-remote-371.mjs
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
const newGame = (seed) => {
  const G = createGame(data, { seed, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  // Interactive setup: the Rebel picks a base first, then deployment opens.
  if (G.pendingRebelBasePick?.length) phases.pickRebelBase(G, G.pendingRebelBasePick[0]);
  return G;
};
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};
const remoteSys = (G) => Object.keys(G.catalog.systems).find((s) => G.catalog.systems[s].isRemote && !G.map.systems[s].subjugated && G.map.systems[s].loyalty !== 'imperial');
const populousNeutral = (G) => Object.keys(G.catalog.systems).find((s) => {
  const d = G.catalog.systems[s]; const ss = G.map.systems[s];
  return !d.isRemote && !d.isCoruscant && !ss.subjugated && ss.loyalty !== 'imperial' && s !== G.rebelBaseSystemId;
});
const imperialSys = (G) => Object.keys(G.map.systems).find((s) => G.map.systems[s].loyalty === 'imperial');

console.log('\n[ #371: a remote (neutral) system is a legal Rebel setup target ]');
{
  const G = newGame(213);
  check('game starts in Setup with pending Rebel units', G.phase === 'Setup' && (G.pendingDeployment?.Rebel?.length ?? 0) > 0);
  const unit = G.pendingDeployment.Rebel[0];
  const rem = remoteSys(G);
  check('found a remote neutral system', !!rem, String(rem));
  const r = phases.setupDeployUnit(G, 'Rebel', unit, rem);
  check('deploying to a remote system is accepted', r.ok, r.reason);
  check('the unit landed in the remote system', (G.map.systems[rem].units ?? []).some((u) => u.typeId === unit));
  check('rebelDeployTarget locked to the remote system', G.rebelDeployTarget === rem);
}

console.log('\n[ a populous neutral system still works ]');
{
  const G = newGame(214);
  const unit = G.pendingDeployment.Rebel[0];
  const pop = populousNeutral(G);
  const r = phases.setupDeployUnit(G, 'Rebel', unit, pop);
  check('deploying to a populous neutral system is accepted', r.ok, r.reason);
}

console.log('\n[ Imperial / Coruscant systems remain illegal ]');
{
  const G = newGame(215);
  const unit = G.pendingDeployment.Rebel[0];
  const imp = imperialSys(G);
  const r1 = phases.setupDeployUnit(G, 'Rebel', unit, imp);
  check('an Imperial-loyal system is rejected', !r1.ok, `got ok=${r1.ok}`);
  const cor = Object.keys(G.catalog.systems).find((s) => G.catalog.systems[s].isCoruscant);
  const r2 = phases.setupDeployUnit(G, 'Rebel', unit, cor);
  check('Coruscant is rejected', !r2.ok, `got ok=${r2.ok}`);
}

console.log('\n[ once a remote is chosen, a different system is rejected ]');
{
  const G = newGame(216);
  const rem = remoteSys(G);
  const pop = populousNeutral(G);
  phases.setupDeployUnit(G, 'Rebel', G.pendingDeployment.Rebel[0], rem);
  const r = phases.setupDeployUnit(G, 'Rebel', G.pendingDeployment.Rebel[0], pop);
  check('second off-base system rejected (one system only)', !r.ok, `got ok=${r.ok}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
