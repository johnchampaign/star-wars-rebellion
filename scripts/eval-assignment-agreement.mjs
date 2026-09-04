import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts'); const codec = await import('../src/engine/codec.ts'); const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT,'assets',p),'utf8'));
const catalog = setup.buildCatalog({systems:j('systems.json'),adjacency:j('adjacency.json'),leaders:j('leaders.json'),actions:j('actions.json'),missions:j('missions.json'),objectives:j('objectives.json'),tactics:j('tactics.json'),probes:j('probes.json')});
const rows = readFileSync(process.argv[2],'utf8').split('\n').filter(Boolean).map((l)=>JSON.parse(l)).filter((r)=>r.stage==='assignment' && r.quality==='exact');
const stat = { Rebel:{n:0,rmH:0,rmA:0,jacc:0,hidden:0,rmA_hidden:0,revealed:0,sabH:0,sabA:0,hfH:0,hfA:0}, Empire:{n:0,rmH:0,rmA:0,jacc:0,hidden:0,rmA_hidden:0,revealed:0,sabH:0,sabA:0,hfH:0,hfA:0} };
for (const r of rows) {
  let G; try { G = codec.decode(r.state, catalog); } catch { continue; }
  AI.seedAI(1);
  const plan = AI.__testPlanAssignment(G, r.humanSide);
  const A = new Set(plan.map((x)=>x.missionId)), H = new Set(r.humanAssignments.map((x)=>x.missionId));
  const s = stat[r.humanSide]; s.n++;
  const inter=[...A].filter((m)=>H.has(m)).length, uni=new Set([...A,...H]).size; s.jacc += uni? inter/uni : 1;
  if (H.has('rapid-mobilization')) s.rmH++; if (A.has('rapid-mobilization')) s.rmA++;
  if (H.has('sabotage')) s.sabH++; if (A.has('sabotage')) s.sabA++;
  if (H.has('hidden-fleet')) s.hfH++; if (A.has('hidden-fleet')) s.hfA++;
  if (!G.rebelBaseRevealed) { s.hidden++; if (A.has('rapid-mobilization')) s.rmA_hidden++; } else s.revealed++;
}
for (const side of ['Rebel','Empire']) { const s=stat[side]; if(!s.n) continue;
  console.log(`${side} (n=${s.n} exact human positions): mission-set agreement (Jaccard) ${(s.jacc/s.n).toFixed(2)}`);
  if (side==='Rebel') console.log(`   Rapid Mobilization: human ${100*s.rmH/s.n|0}%  heuristic-on-same-positions ${100*s.rmA/s.n|0}%  (heuristic with base HIDDEN: ${100*s.rmA_hidden/Math.max(1,s.hidden)|0}% of ${s.hidden})\n   Sabotage: human ${100*s.sabH/s.n|0}%  heuristic ${100*s.sabA/s.n|0}%   Hidden Fleet: human ${100*s.hfH/s.n|0}%  heuristic ${100*s.hfA/s.n|0}%`);
}
