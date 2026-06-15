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

// #284 — Superlaser Online posts a loyalty-system CHOICE (not auto-pick).
{
  const G = createGame(data, { seed: 6, roeMissions: true, roeUnits: true });
  // pick a populous system with >1 populous neighbour in its region
  const sys = Object.keys(G.map.systems).find((sid) => {
    const d = G.catalog.systems[sid]; if (!d || d.isRemote || d.isCoruscant) return false;
    const region = d.region;
    const peers = Object.values(G.catalog.systems).filter((s)=>s.region===region && !s.isRemote && !s.isCoruscant && s.id!==sid);
    return peers.length >= 2;
  });
  const ctx = registry.makeContext('Empire', { kind: 'mission', id: 'superlaser-online' }, { targetSystemId: sys, leaderIds: [] });
  const r = registry.invokeByKey(G, 'superlaser-online', ctx);
  check('Superlaser destroyed the target system', !!G.map.systems[sys]?.destroyed);
  check('posts SuperlaserLoyaltyPick (a choice, not auto-pick)', G.pendingChoice?.kind === 'SuperlaserLoyaltyPick', `kind=${G.pendingChoice?.kind}`);
  const pick = G.pendingChoice.candidates[1] ?? G.pendingChoice.candidates[0];
  const before = G.map.systems[pick]?.loyalty;
  const r2 = (await import('../src/engine/phases.ts')).resolveSuperlaserLoyaltyPick(G, pick);
  check('resolve ok + loyalty applied at the CHOSEN system', r2.ok && G.map.systems[pick]?.loyalty === 'imperial', `before=${before} after=${G.map.systems[pick]?.loyalty}`);
}

// #285 — Interrogation surfaces a notice to the Empire with the objective names.
{
  const G = createGame(data, { seed: 6, roeMissions: true, roeUnits: true });
  G.rebel.objectiveHand = ['rebel-cell-2'];
  const ctx = registry.makeContext('Empire', { kind: 'mission', id: 'interrogation' }, { leaderIds: [] });
  registry.invokeByKey(G, 'interrogation', ctx);
  const notice = (G.pendingNotices ?? []).find((n) => /Interrogation/.test(n.title));
  check('Interrogation pushes a notice to the Empire', !!notice && notice.side === 'Empire', JSON.stringify(G.pendingNotices));
  check('notice lists the revealed objective name', !!notice && /Rebel Cell|rebel-cell/.test(notice.details ?? ''), notice?.details);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
