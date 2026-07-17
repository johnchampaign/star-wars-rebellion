// Rebel base PLACEMENT heuristic (#539; reporters jocke01 + Dymond) — the AI
// picks the SAFEST setup base, not a random one: distance from Imperial
// presence DOMINANT (+4/hop, cap 4), rebel-loyal as tiebreak (+2). Also
// covers the RoE preset-unit path where the pick survives into Assignment
// (previously unhandled: the game ran on the placeholder candidates[0]).
// Run: node scripts/test-base-placement-heuristic.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const bfsFrom = (G, sources) => {
  const dist = new Map(sources.map((s) => [s, 0]));
  let frontier = sources.slice(); let d = 0;
  while (frontier.length && d < 10) {
    d++; const next = [];
    for (const s of frontier) for (const a of (G.catalog.adjacency[s] ?? [])) {
      if (!dist.has(a)) { dist.set(a, d); next.push(a); }
    }
    frontier = next;
  }
  return dist;
};
const imperialOf = (G) => Object.keys(G.map.systems).filter((sid) =>
  G.map.systems[sid]?.loyalty === 'imperial' || G.map.systems[sid]?.units.some((u) => u.side === 'Empire'));

console.log('[ chooseRebelBaseSystem: distance dominates, loyalty tiebreaks ]');
for (const seed of [3, 9, 21, 40, 55]) {
  const G = createGame(data, { seed, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true } });
  const cands = G.pendingRebelBasePick ?? [];
  if (cands.length === 0) { check(`seed ${seed}: candidates exist`, false); continue; }
  const picked = AI.chooseRebelBaseSystem(G, cands);
  const dist = bfsFrom(G, imperialOf(G));
  const dOf = (sid) => Math.min(dist.get(sid) ?? 8, 4);
  const maxD = Math.max(...cands.map(dOf));
  check(`seed ${seed}: picked ${picked} at max distance (${dOf(picked)}/${maxD})`, dOf(picked) === maxD);
  // Loyalty tiebreak: among max-distance candidates, a loyal one wins if any.
  const atMax = cands.filter((s) => dOf(s) === maxD);
  const loyalAtMax = atMax.filter((s) => G.map.systems[s]?.loyalty === 'rebel');
  if (loyalAtMax.length > 0) {
    check(`seed ${seed}: loyal tiebreak respected`, G.map.systems[picked]?.loyalty === 'rebel');
  }
}

console.log('\n[ setup.ts defaulting fix: omitted autoSetupUnits finalises the pick ]');
{
  // Previously: units auto-placed (autoSetup ?? true) but the base branch read
  // the RAW option, leaving pendingRebelBasePick dangling into Assignment
  // where Setup-gated pickRebelBase could never resolve it.
  const G = createGame(data, { seed: 9, expansion: { enabled: true, roeUnits: true } });
  check('no dangling base pick', !G.pendingRebelBasePick, `phase=${G.phase} pending=${G.pendingRebelBasePick?.length}`);
  check('base finalised', !!G.rebelBaseSystemId);
}

console.log('\n[ interactive path (production config): AI picks a safe base in-game ]');
{
  const G = createGame(data, { seed: 9, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true } });
  let guard = 0;
  while ((G.pendingRebelBasePick || G.phase === 'Setup') && guard++ < 400) {
    if (!AI.stepOnce(G, G.currentPlayer)) {
      const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
      if (!AI.stepOnce(G, o)) break;
    }
  }
  check('setup completed, pick resolved', !G.pendingRebelBasePick, `guard=${guard} phase=${G.phase}`);
  const dist = bfsFrom(G, imperialOf(G));
  check('AI base is 2+ hops from Imperial presence',
    (dist.get(G.rebelBaseSystemId) ?? 8) >= 2,
    `base=${G.rebelBaseSystemId} d=${dist.get(G.rebelBaseSystemId)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
