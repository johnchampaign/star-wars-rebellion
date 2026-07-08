// #518 — "Base Defenses" (Rebel action card) deploys an Ion Cannon + Shield
// Generator to protect the base. The engine always placed them in the hidden
// "Rebel Base" space, but once the base is REVEALED its units live in the actual
// system — so the defenses landed in the wrong (hidden) place, disconnected from
// the revealed base on the map. They must follow the base's real location.
// Run: node scripts/test-base-defenses-location-518.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');
handlers.registerAll();
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const STRUCT = ['ion-cannon', 'shield-generator'];
function run(revealed) {
  const G = createGame(data, { seed: 3, expansion: { enabled: true, roeUnits: true } });
  G.rebelBaseRevealed = revealed;
  const baseSys = G.rebelBaseSystemId;
  registry.invokeByKey(G, 'base-defenses', {});
  const inSpace = (G.map.rebelBaseSpace?.units ?? []).filter((u) => STRUCT.includes(u.typeId)).length;
  const inSystem = (G.map.systems[baseSys]?.units ?? []).filter((u) => STRUCT.includes(u.typeId)).length;
  return { baseSys, inSpace, inSystem };
}

console.log("[ #518 Base Defenses deploy to the base's ACTUAL location ]");
const hidden = run(false);
check('hidden base → structures in the Rebel Base space', hidden.inSpace === 2 && hidden.inSystem === 0, JSON.stringify(hidden));
const revealed = run(true);
check('revealed base → structures on the actual planet (not the hidden space)', revealed.inSystem === 2 && revealed.inSpace === 0, JSON.stringify(revealed));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
