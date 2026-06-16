// #313 — the AI won't fire Superlaser Online (which resolves at its OWN Death
// Star's system, destroying everything there) when there's no Rebel value to
// destroy — i.e. no Rebel units AND the system isn't Rebel-loyal. That was
// pure self-harm (it destroyed its own trooper on a ruled-out Dagobah).
// Run: node scripts/test-superlaser-targeting-313.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const { missionRevealIsPointless } = await import('../src/engine/missionTargets.ts');
function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'), actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'), tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e='') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e?' — '+e:''}`); fail++; } };
const G = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
const SYS = 'dagobah';

console.log('\n[ #313 superlaser targeting heuristic ]');
{
  // Empire Death Star + own trooper, no Rebel presence, neutral → self-harm.
  G.map.systems[SYS].units = [];
  G.map.systems[SYS].loyalty = 'neutral';
  M.deployUnit(G, 'Empire', 'death-star', SYS);
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  check('pointless: own units, no Rebel presence, neutral',
    missionRevealIsPointless(G, 'Empire', 'superlaser-online', SYS) === true);
}
{
  // Add a Rebel unit → now worth firing.
  M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  check('NOT pointless when Rebel units are present',
    missionRevealIsPointless(G, 'Empire', 'superlaser-online', SYS) === false);
}
{
  // Rebel-loyal system, no Rebel units → worth firing (denies loyalty).
  G.map.systems[SYS].units = [];
  M.deployUnit(G, 'Empire', 'death-star', SYS);
  G.map.systems[SYS].loyalty = 'rebel';
  check('NOT pointless when the system is Rebel-loyal',
    missionRevealIsPointless(G, 'Empire', 'superlaser-online', SYS) === false);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
