// Position instrument for #840/#841 (SWR_REBEL_LOYALTY_YIELD): on the exact
// positions where a recorded HUMAN Rebel revealed a loyalty-gain mission
// (Build Alliance and friends), which target does the Rebel target scorer pick,
// and how often does it match the human? Also reports how often the pick is a
// space-square world (Mon Calamari, Corellia, Utapau: a Mon Cal for the Rebel,
// a Star Destroyer denied to the Empire) for the scorer and for the humans.
//
//   node scripts/eval-rebel-loyalty-target.mjs [reports/human-decisions.jsonl]
//   SWR_REBEL_LOYALTY_YIELD=0 node scripts/eval-rebel-loyalty-target.mjs   (baseline)
//   SWR_REBEL_LOYALTY_YIELD_W=2 node scripts/eval-rebel-loyalty-target.mjs
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
const LOYALTY = new Set(['build-alliance', 'establish-trade-relations', 'wookie-uprising', 'support-of-mon-calamari', 'regional-aid']);
const rows = readFileSync(process.argv[2] ?? join(ROOT, 'reports', 'human-decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.humanSide === 'Rebel' && r.quality === 'exact' && r.humanAction?.kind === 'reveal-mission' && LOYALTY.has(r.humanAction.missionId));

function bfs(G, origin, maxHops) {
  const d = new Map([[origin, 0]]); let frontier = [origin];
  for (let h = 1; h <= maxHops; h++) {
    const next = [];
    for (const s of frontier) for (const a of G.catalog.adjacency[s] ?? []) if (!d.has(a)) { d.set(a, h); next.push(a); }
    frontier = next;
  }
  return d;
}
const sqWorld = (G, sid) => (G.catalog.systems[sid]?.resources ?? []).some((r) => r.type === 'space' && r.shape === 'square');

let n = 0, agree = 0, rrSum = 0, aiSq = 0, humSq = 0, humSqAvail = 0;
const byMission = {};
for (const r of rows) {
  let G;
  try { G = codec.decode(r.state, catalog); } catch { continue; }
  const m = r.humanAction.missionId, human = r.humanAction.targetSystemId;
  const t = MT.missionTargets(G, 'Rebel', m);
  const cands = (t.permissive ? Object.keys(G.map.systems) : t.systemIds).filter((sid) => !MT.missionRevealIsPointless(G, 'Rebel', m, sid));
  if (!cands.includes(human) || cands.length < 2) continue;
  const baseDist = (G.rebelBaseSystemId && !G.rebelBaseRevealed && !AI.rebelBaseExposed(G)) ? bfs(G, G.rebelBaseSystemId, 3) : null;
  const scored = cands.map((sid) => ({ sid, s: AI.rebelMissionTargetScore(G, m, sid, baseDist) })).sort((a, b) => b.s - a.s);
  n++;
  const top = scored[0].sid;
  if (top === human) agree++;
  const rank = scored.findIndex((x) => x.sid === human) + 1;
  rrSum += 1 / rank;
  if (sqWorld(G, top)) aiSq++;
  if (sqWorld(G, human)) humSq++;
  if (cands.some((sid) => sqWorld(G, sid) && G.map.systems[sid]?.loyalty === 'neutral')) humSqAvail++;
  (byMission[m] ??= { n: 0, agree: 0 }); byMission[m].n++; if (top === human) byMission[m].agree++;
}
const pct = (a) => (100 * a / Math.max(1, n)).toFixed(1) + '%';
console.log(`positions ${n}  exact-agree ${agree} (${pct(agree)})  MRR ${(rrSum / Math.max(1, n)).toFixed(3)}  scorer-square ${aiSq} (${pct(aiSq)})  human-square ${humSq} (${pct(humSq)})  neutral-square-available ${humSqAvail}`);
console.log('by mission:', Object.entries(byMission).map(([k, v]) => `${k} ${v.agree}/${v.n}`).join('  '));
