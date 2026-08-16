// "also, the rebel base is almost every time at ryloth - a bit more
// variability could be useful"  — rokhm1, #718 (played Empire vs the AI Rebel)
//
// He was right, and understated it: measured across 600 tournament games the
// base was at RYLOTH 53% OF THE TIME (mon-calamari a distant second at 11%).
// Cause: chooseRebelBaseSystem ended in `sort(...)[0]` — the deterministic
// maximum of a score that is almost a pure function of the map's fixed
// geography (distance-from-Empire capped at 4, +2 loyalty tiebreak). Same
// stable-sort-first-pick family as the alphabetical tie-break bug, but worse
// here, because THIS pick is the game's hidden information. An Empire player
// who knows the AI favours Ryloth probes it first and wins the entire
// hide-and-seek game before it starts, every game.
//
// The fix samples uniformly among candidates within 4 points of the best score
// (one distance step) — trading a sliver of placement quality for entropy,
// which is exactly the trade a human makes by not always picking the "obvious"
// base. This test pins the distribution, not any particular choice.
//
// Run: node scripts/test-base-placement-variability.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Drive the REAL setup path so the candidate list is the game's own, not a
// hand-rolled approximation.
const N = 240;
const picks = new Map();
for (let seed = 1; seed <= N; seed++) {
  const G = createGame(data, { seed, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true } });
  ai.seedAI(seed);
  const cands = G.pendingRebelBasePick ?? [];
  if (cands.length === 0) { continue; }
  const pick = ai.chooseRebelBaseSystem(G, cands);
  picks.set(pick, (picks.get(pick) ?? 0) + 1);
  ai.unseedAI();
}
const total = [...picks.values()].reduce((a, b) => a + b, 0);
const sorted = [...picks.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n[ distribution over ${total} seeded setups ]`);
for (const [s, c] of sorted.slice(0, 8)) console.log(`   ${s.padEnd(16)}${c}  ${(100 * c / total).toFixed(0)}%`);

check('the sampler ran on real setup candidate lists', total >= N * 0.9, `only ${total}`);
check('no single system exceeds a third of all games (Ryloth was 53%)',
  sorted[0][1] / total < 0.34, `${sorted[0][0]} at ${(100 * sorted[0][1] / total).toFixed(0)}%`);
check('at least 5 distinct systems get used', picks.size >= 5, `only ${picks.size}`);

console.log('\n[ but quality is not sacrificed — every pick is near-optimal ]');
{
  // Recompute each pick's score standing vs the best available. The sampler
  // may only ever give up MARGIN (4) points.
  let worstGap = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const G = createGame(data, { seed, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true } });
    ai.seedAI(seed);
    const cands = G.pendingRebelBasePick ?? [];
    if (!cands.length) continue;
    const pick = ai.chooseRebelBaseSystem(G, cands);
    // Score shape mirrored from chooseRebelBaseSystem (safe doctrine).
    const imperial = Object.keys(G.map.systems).filter((sid) =>
      G.map.systems[sid]?.loyalty === 'imperial' || G.map.systems[sid]?.units.some((u) => u.side === 'Empire'));
    const dist = new Map(); let frontier = imperial.slice(); let d = 0;
    for (const s of frontier) dist.set(s, 0);
    while (frontier.length && d < 8) {
      d++; const next = [];
      for (const s of frontier) for (const a of (G.catalog.adjacency[s] ?? [])) {
        if (!dist.has(a)) { dist.set(a, d); next.push(a); }
      }
      frontier = next;
    }
    const far = (sid) => Math.min(dist.get(sid) ?? 8, 4);
    const bestFar = Math.max(...cands.map(far));
    const gap = bestFar - far(pick);
    // One hop may be conceded, and only while the base stays 2+ hops out.
    if (gap > 1 || (gap === 1 && far(pick) < 2)) worstGap = Math.max(worstGap, gap + (far(pick) < 2 ? 10 : 0));
    ai.unseedAI();
  }
  check('distance concedes at most one hop and never drops below 2', worstGap === 0, `violation ${worstGap}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
