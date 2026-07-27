// RM-conditioned base-location belief (#539 roadmap item: RM-destination
// belief model). beliefWeights (SWR_MCTS_BELIEF=1) now conditions on whether
// the base has PUBLICLY relocated:
//  - pre-RM: peaked setup-fitted feature weights (unchanged);
//  - post-RM: draw-pick posterior — P ∝ C(worse-ranked, 3) + 25% uniform
//    floor — because the destination was the best of 4 uniform probe draws.
// Corpus grounding: initial placements are feature-biased (loyal 37% vs 13%
// pool); relocations sit at pool average (dist 1.5 vs 1.4).
// Run: SWR_MCTS_BELIEF=1 node scripts/test-belief-rm-conditioned.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The belief model is deliberately OFF by default under node so benches can A/B
// it explicitly (see BELIEF_ENABLED in mctsAI). This test used to hard-exit(1)
// when the flag was missing, which made a plain `node scripts/test-*.mjs` sweep
// report a FAILURE for a test that passes perfectly well — so it was never
// actually run. Turn the flag on for THIS process instead. It must happen
// before mctsAI is imported, because BELIEF_ENABLED is evaluated once at module
// load. An explicit SWR_MCTS_BELIEF=0 is still honoured, so the A/B direction
// remains available; that case skips cleanly below rather than failing.
process.env.SWR_MCTS_BELIEF ??= '1';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const mcts = await import('../src/play/mctsAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

if (process.env.SWR_MCTS_BELIEF !== '1') {
  // Only reachable when the caller explicitly passed SWR_MCTS_BELIEF=0 to A/B
  // the belief model off. There is nothing to assert about a disabled model, so
  // skip — exit 0, not a failure.
  console.log('SKIP: SWR_MCTS_BELIEF=0 — belief model disabled for A/B, nothing to assert.');
  process.exit(0);
}

const G = createGame(data, { seed: 12, autoSetupUnits: true });
// Empire ground presence so distances differentiate.
M.deployUnit(G, 'Empire', 'stormtrooper', 'coruscant');
const candidates = mcts.baseCandidates(G).slice(0, 12);
const N = candidates.length;
check('enough candidates to test', N >= 8, `N=${N}`);

const spread = (w) => {
  const vals = candidates.map((s) => w.get(s));
  const total = vals.reduce((a, b) => a + b, 0);
  const ps = vals.map((v) => v / total).sort((a, b) => b - a);
  return { top: ps[0], bottom: ps[ps.length - 1], ratio: ps[0] / ps[ps.length - 1] };
};

console.log('[ pre-RM: peaked setup posterior ]');
const pre = spread(mcts.beliefWeights(G, candidates));
check('pre-RM weights are non-uniform', pre.ratio > 1.5, `ratio=${pre.ratio.toFixed(2)}`);

console.log('\n[ post-RM: uniform (corpus: relocations sit at pool average) ]');
G.turnLog.push({ seq: G.turnLog.length, turn: G.timeMarker, phase: G.phase, side: 'Rebel', kind: 'rapid-mobilization-base-established', payload: {} });
const post = spread(mcts.beliefWeights(G, candidates));
check('post-RM posterior is uniform', Math.abs(post.ratio - 1) < 1e-9, `ratio=${post.ratio.toFixed(4)}`);
check('post-RM is FLATTER than pre-RM (the parked A/B lesson)', post.ratio < pre.ratio, `pre=${pre.ratio.toFixed(2)} post=${post.ratio.toFixed(2)}`);

console.log('\n[ posterior masses are sane ]');
{
  const w = mcts.beliefWeights(G, candidates);
  const total = candidates.reduce((a, s) => a + w.get(s), 0);
  check('all weights positive and finite', candidates.every((s) => Number.isFinite(w.get(s)) && w.get(s) > 0), '');
  check('total mass positive', total > 0, '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
