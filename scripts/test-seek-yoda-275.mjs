import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const registry = await import('../src/engine/handlers/registry.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass=0,fail=0; const check=(n,ok,x='')=>{console.log(`  ${ok?'✓':'✗'} ${n}${ok?'':' — '+x}`);ok?pass++:fail++;};
handlers.registerAll();

const G = createGame(data, { seed: 1, roeMissions: true, roeUnits: true });
G.rebel.leadersOnBoard['dagobah'] = ['princess-leia'];
check('seek-yoda handler registered', registry.has('seek-yoda'));
const ctx = registry.makeContext('Rebel', { kind: 'mission', id: 'seek-yoda' }, { targetSystemId: 'dagobah', leaderIds: ['princess-leia'] });
registry.invokeByKey(G, 'seek-yoda', ctx);
check('Leia received the Yoda ring', (G.leaderAttachments?.['princess-leia'] ?? []).includes('yoda'),
  JSON.stringify(G.leaderAttachments));

// And confirm the Luke -> Luke (Jedi) swap still attaches Yoda to Luke-Jedi
const G2 = createGame(data, { seed: 1, roeMissions: true, roeUnits: true });
G2.rebel.leaderPool = G2.rebel.leaderPool.filter(l=>l!=='luke-skywalker');
G2.rebel.leadersOnBoard['dagobah'] = ['luke-skywalker'];
const ctx2 = registry.makeContext('Rebel', { kind: 'mission', id: 'seek-yoda' }, { targetSystemId: 'dagobah', leaderIds: ['luke-skywalker'] });
registry.invokeByKey(G2, 'seek-yoda', ctx2);
check('Luke swapped to Luke (Jedi) with the ring', (G2.leaderAttachments?.['luke-skywalker-jedi'] ?? []).includes('yoda'),
  JSON.stringify(G2.leaderAttachments));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
