// #316 audit — Trust in the Force ("destroy 1 triangle ground unit") lets the
// Rebel choose which when 2+ exist (e.g. a stormtrooper vs an assault-tank),
// instead of auto-picking the first one found.
// Run: node scripts/test-trust-in-the-force-316.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
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

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

console.log('\n[ #316 the Rebel picks which triangle ground unit to destroy ]');
{
  const G = createGame(data, opts(90));
  const sys = 'felucia';
  G.map.systems[sys].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', sys);   // triangle, 1 hp
  M.deployUnit(G, 'Empire', 'assault-tank', sys);    // triangle (RoE), higher hp
  const trooper = G.map.systems[sys].units.find((u) => u.typeId === 'stormtrooper');
  const tank = G.map.systems[sys].units.find((u) => u.typeId === 'assault-tank');
  // Post the choice the way the engine does (both are valid triangle targets).
  G.pendingChoice = {
    kind: 'TrustInTheForceDestroyPick', side: 'Rebel', systemId: sys,
    candidates: [trooper.instanceId, tank.instanceId],
  };
  // Reject a non-candidate.
  const bad = phases.resolveTrustInTheForceDestroyPick(G, 'nope');
  check('non-candidate rejected', !bad.ok);
  // Choose the assault-tank.
  const r = phases.resolveTrustInTheForceDestroyPick(G, tank.instanceId);
  check('resolve ok', r.ok, r.reason);
  check('assault-tank destroyed', !G.map.systems[sys].units.some((u) => u.instanceId === tank.instanceId));
  check('stormtrooper survived', G.map.systems[sys].units.some((u) => u.instanceId === trooper.instanceId));
  check('choice cleared', !G.pendingChoice);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
