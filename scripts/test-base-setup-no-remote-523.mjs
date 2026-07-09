// #523 — under the base-game-setup-units variant (#519) the Empire has no Death
// Star Under Construction, so the RoE "deploy to a chosen REMOTE (neutral)
// system" option must NOT be offered. The Empire may deploy only to its own
// Imperial-loyalty / subjugated worlds (base-game setup). Regression: remote
// deployment was allowed whenever expansion.enabled, ignoring the variant.
// Run: node scripts/test-base-setup-no-remote-523.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const remoteSystemId = (G) => Object.keys(G.map.systems).find((id) => G.catalog.systems[id]?.isRemote);
const anyImperialSystemId = (G) => Object.keys(G.map.systems).find((id) => G.map.systems[id].loyalty === 'imperial');
// A pending Empire unit that is neither the DSUC nor the completed Death Star
// (those have special placement rules) — a plain reinforcement unit.
const plainPending = (G) => (G.pendingDeployment?.Empire ?? []).find((t) => t !== 'death-star' && t !== 'death-star-under-construction');

console.log('[ #523 base-setup-units variant: Empire cannot deploy to a remote system ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true, baseSetupUnits: true } });
  check('setup is pending (units not auto-filled)', !!G.pendingDeployment?.Empire?.length,
    'no pending deployment — cannot exercise setupDeployUnit');
  const remote = remoteSystemId(G);
  const unit = plainPending(G);
  check('found a remote system + a plain pending Empire unit', !!remote && !!unit, `remote=${remote} unit=${unit}`);
  if (remote && unit) {
    const r = phases.setupDeployUnit(G, 'Empire', unit, remote);
    check('remote deployment is REJECTED under the variant', r.ok === false, `got ok=${r.ok} reason=${r.reason}`);
    check('rejection reason is must-be-imperial-or-subjugated', r.reason === 'must-be-imperial-or-subjugated', `reason=${r.reason}`);
    // Sanity: the same unit CAN go on an Imperial world.
    const imp = anyImperialSystemId(G);
    const r2 = phases.setupDeployUnit(G, 'Empire', unit, imp);
    check('same unit deploys fine on an Imperial-loyalty world', r2.ok === true, `reason=${r2.reason}`);
  }
}

console.log('[ normal RoE game (no variant): remote Death Star site IS allowed ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true } });
  const remote = remoteSystemId(G);
  // In a normal RoE game the DSUC is placed on the chosen remote system.
  const r = phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', remote);
  check('DSUC deploys onto a remote system in a normal RoE game', r.ok === true, `reason=${r.reason}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
