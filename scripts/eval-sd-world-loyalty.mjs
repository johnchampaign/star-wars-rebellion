// Position instrument for #763 (Star Destroyer worlds): on the exact human-
// Empire Assignment positions, how often do the recorded humans put a leader on
// a loyalty mission when one success would make a Star Destroyer world (a world
// with a space-square icon: Corellia, Mon Calamari, Utapau) Imperial-loyal, vs
// the heuristic under the current lever settings? And when the heuristic does
// assign one, does its target pick aim it at that world?
//
// Why loyalty and not control: a SUBJUGATED world builds from its left-most
// icon only (RR "Subjugation"), and all three worlds carry the square on the
// right, so only Imperial loyalty builds Star Destroyers there.
//
//   node scripts/eval-sd-world-loyalty.mjs [reports/human-assignments.jsonl]
//   SWR_LOYALTY_YIELD=0 node scripts/eval-sd-world-loyalty.mjs   (baseline)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts'); const codec = await import('../src/engine/codec.ts');
const AI = await import('../src/play/randomAI.ts'); const MT = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });
const rows = readFileSync(process.argv[2] ?? join(ROOT, 'reports', 'human-assignments.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.stage === 'assignment' && r.quality === 'exact' && r.humanSide === 'Empire');

// Loyalty gained on the target by one success.
const GAIN = { 'rule-by-fear': 1, 'trade-negotiations': 1, 'message-from-high-command': 1, 'display-of-power': 2 };
const LOYALTY = Object.keys(GAIN);
const sdWorld = (G, sid) => !!G.catalog.systems[sid]?.buildSlot
  && (G.catalog.systems[sid].resources ?? []).some((r) => r.type === 'space' && r.shape === 'square');
/** SD worlds mission `m` could make Imperial-loyal with one success. */
function convertible(G, m) {
  const out = [];
  for (const sid of MT.missionTargets(G, 'Empire', m).systemIds) {
    const ss = G.map.systems[sid]; if (!ss || !sdWorld(G, sid) || ss.loyalty === 'imperial') continue;
    const need = ss.loyalty === 'rebel' ? 2 : 1;
    if (GAIN[m] >= need) out.push(sid);
  }
  return out;
}
const B = { sd: { n: 0, h: 0, a: 0, per: {}, aimed: 0, aimedOf: 0 }, none: { n: 0, h: 0, a: 0, per: {}, aimed: 0, aimedOf: 0 } };
for (const r of rows) {
  let G; try { G = codec.decode(r.state, catalog); } catch { continue; }
  const hand = G.empire.missionHand.filter((m) => LOYALTY.includes(m));
  if (hand.length === 0) continue;
  const conv = new Map(hand.map((m) => [m, convertible(G, m)]));
  const b = B[[...conv.values()].some((x) => x.length) ? 'sd' : 'none']; b.n++;
  AI.seedAI(1); const plan = AI.__testPlanAssignment(G, 'Empire').map((x) => x.missionId);
  const human = new Set(r.humanAssignments.map((x) => x.missionId));
  if (hand.some((m) => human.has(m))) b.h++;
  if (hand.some((m) => plan.includes(m))) b.a++;
  for (const m of hand) {
    const e = (b.per[m] ??= { held: 0, h: 0, a: 0 }); e.held++;
    if (human.has(m)) e.h++; if (plan.includes(m)) e.a++;
    // Would the heuristic's target pick aim this mission at the SD world?
    if (b === B.sd && conv.get(m).length) {
      const legal = MT.missionTargets(G, 'Empire', m).systemIds;
      let best = null, bs = -Infinity;
      for (const sid of legal) { const s = AI.empireMissionTargetScore(G, m, sid); if (s > bs) { bs = s; best = sid; } }
      b.aimedOf++; if (conv.get(m).includes(best)) b.aimed++;
    }
  }
}
const pc = (x, n) => n ? `${(100 * x / n).toFixed(0)}%` : '-';
const tag = `SWR_LOYALTY_YIELD=${process.env.SWR_LOYALTY_YIELD ?? 'default'} W=${process.env.SWR_LOYALTY_YIELD_W ?? 'default'}`;
for (const [k, b] of Object.entries(B)) {
  console.log(`[${tag}] ${k === 'sd' ? 'an SD world is one success from loyalty' : 'no SD world convertible'}  n=${b.n}: any loyalty mission assigned — human ${pc(b.h, b.n)} / heur ${pc(b.a, b.n)}`
    + (k === 'sd' ? `;  target pick aims at the SD world ${pc(b.aimed, b.aimedOf)} (n=${b.aimedOf})` : ''));
  console.log('    ' + Object.entries(b.per).map(([m, e]) => `${m} human ${pc(e.h, e.held)} / heur ${pc(e.a, e.held)} (n=${e.held})`).join('  |  '));
}
