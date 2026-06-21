// DSUC system probe removal (#372): the remote system that holds the Death Star
// Under Construction at setup has its probe card removed from the deck (like the
// Imperial-loyalty systems), so it can't be the Rebel base and can't reappear
// via Intercepted Transmissions. Run: node scripts/test-dsuc-probe-removed-372.mjs
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
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};
const probeIdFor = (G, sysId) => Object.values(G.catalog.probes).find((p) => p.systemId === sysId)?.id;
const inDeck = (G, pid) => (G.probeDeck ?? []).includes(pid);
const inHand = (G, pid) => (G.empire.probeHand ?? []).includes(pid);

console.log('\n[ auto-setup: DSUC system probe is out of the deck and the Empire hand ]');
for (const seed of [1, 7, 42, 213]) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  const dsuc = G.empireDeployTarget;
  const pid = dsuc ? probeIdFor(G, dsuc) : undefined;
  check(`(seed ${seed}) DSUC system chosen + has a probe card`, !!dsuc && !!pid, `dsuc=${dsuc}`);
  if (pid) {
    // Probe gone from the deck = the base-search UI derives it as ruled out
    // (hotseat). (Auto-setup removes from the deck directly; the runtime
    // empireProbeRuledOut list is populated on the interactive deploy path.)
    check(`  DSUC probe not in the deck`, !inDeck(G, pid), `${pid} (${dsuc})`);
    check(`  DSUC probe not in the Empire's hand`, !inHand(G, pid));
  }
}

console.log('\n[ interactive setup (auto-fill): same removal ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  if (G.pendingRebelBasePick?.length) phases.pickRebelBase(G, G.pendingRebelBasePick[0]);
  const r = phases.setupAutoFill(G, 'Empire');
  check('Empire auto-fill ok', r.ok, r.reason);
  const dsuc = G.empireDeployTarget;
  const pid = dsuc ? probeIdFor(G, dsuc) : undefined;
  check('DSUC system chosen', !!dsuc, String(dsuc));
  if (pid) {
    check('DSUC probe not in the deck', !inDeck(G, pid));
    check('DSUC probe not in the Empire hand', !inHand(G, pid));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
