// Position instrument for SWR_SABOTAGE_CLEAR (#748): on the exact human-Empire
// Assignment positions, how often do the recorded humans assign R&D / Construct
// Factory when an Imperial build world is choked by sabotage, vs the heuristic
// under the given lever settings. Run several settings via env:
//   SWR_SABOTAGE_CLEAR=1 SWR_SABOTAGE_CLEAR_CAP=10 SWR_SABOTAGE_CLEAR_MULT=1.5 node scripts/eval-sabotage-clear.mjs reports/human-assignments.jsonl
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts'); const codec = await import('../src/engine/codec.ts'); const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });
const rows = readFileSync(process.argv[2] ?? join(ROOT, 'reports', 'human-assignments.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.stage === 'assignment' && r.quality === 'exact' && r.humanSide === 'Empire');
const S = { square: { n: 0, h: {}, a: {} }, other: { n: 0, h: {}, a: {} }, none: { n: 0, h: {}, a: {} } };
const M = ['research-and-development', 'construct-factory', 'lure-of-the-dark-side', 'construct-death-star', 'rule-by-fear'];
for (const r of rows) {
  let G; try { G = codec.decode(r.state, catalog); } catch { continue; }
  let choked = 0, sq = 0;
  for (const [sid, ss] of Object.entries(G.map.systems)) { const d = G.catalog.systems[sid]; if (!d || d.isRemote || ss.loyalty !== 'imperial' || !ss.sabotage) continue; choked++; if ((d.resources ?? []).some((x) => x.shape === 'square')) sq++; }
  const s = S[sq > 0 ? 'square' : choked > 0 ? 'other' : 'none']; s.n++;
  AI.seedAI(1); const plan = AI.__testPlanAssignment(G, 'Empire').map((x) => x.missionId);
  const hand = new Set(G.empire.missionHand);
  for (const m of M) { if (!hand.has(m)) continue; (s.h[m] ??= { held: 0, y: 0 }).held++; (s.a[m] ??= { held: 0, y: 0 }).held++; if (r.humanAssignments.some((x) => x.missionId === m)) s.h[m].y++; if (plan.includes(m)) s.a[m].y++; }
}
const pct = (e) => e && e.held ? `${(100 * e.y / e.held).toFixed(0)}%` : '-';
const tag = `lever=${process.env.SWR_SABOTAGE_CLEAR === '0' ? 'off' : 'ON (default)'} cap=${process.env.SWR_SABOTAGE_CLEAR_CAP ?? 10} mult=${process.env.SWR_SABOTAGE_CLEAR_MULT ?? 0.6}`;
for (const b of ['square', 'other', 'none']) { const s = S[b]; console.log(`[${tag}] ${b === 'square' ? 'SQUARE world choked' : b === 'other' ? 'non-square choked' : 'no choke'} n=${s.n}: ` + M.map((m) => `${m.split('-')[0]} human ${pct(s.h[m])} / heur ${pct(s.a[m])} (n=${s.h[m]?.held ?? 0})`).join('  |  ')); }
