// Is the Empire's force ASSEMBLED at the moment the base is revealed? (#539)
//
// The #539 cluster (#538/#690/#722/#708) is filed as "the base is revealed and
// the Empire walks its heavy force the wrong way" — a CHOICE failure. This
// script tests the competing explanation: that the AI Empire never reaches a
// position from which converging is possible, so the post-reveal choice
// function is being blamed for a staging failure that happened rounds earlier.
//
// It compares the reveal-moment POSITION (no search, no forward play) between:
//   AI-BUILT    reveal snapshots from human-Rebel game logs (the Empire is the AI)
//   HUMAN-BUILT post-reveal positions from reports/human-decisions.jsonl
//               (humanSide=Empire — the Empire is a winning human)
// Metric: Empire mobile GROUND by hop-distance from the base, plus how much of
// it sits within one hop of the base — the staging the strike-fleet planner is
// meant to produce.
//
// NOT measured here: how much force is pinned under its own leader (#695's
// finding that the no-leave rule immobilises ~3/4 of the army). These are
// Command-START boards, where the round's leaders are not placed yet (2 of 200
// sampled have any Empire leader on the map), so a pin count taken here would
// be near-zero by construction and would say nothing. It needs a mid-round
// sampler instead.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGameLog, snapshotToCodec } from './lib/log-reader.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });

const bfs = (adj, s) => { const d = { [s]: 0 }; const q = [s]; while (q.length) { const c = q.shift(); for (const n of adj[c] ?? []) if (d[n] == null) { d[n] = d[c] + 1; q.push(n); } } return d; };
const isMobileGround = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile; };

/** Reveal-moment force profile for one board. */
function profile(G) {
  const base = G.rebelBaseSystemId;
  if (!base) return null;
  const d = bfs(G.catalog.adjacency, base);
  const p = { at0: 0, at1: 0, at2: 0, far: 0, total: 0, within1: 0 };
  for (const [sid, ss] of Object.entries(G.map.systems)) {
    for (const u of ss.units) {
      if (u.side !== 'Empire' || !isMobileGround(G, u)) continue;
      p.total++;
      const h = d[sid];
      if (h === 0) p.at0++; else if (h === 1) p.at1++; else if (h === 2) p.at2++; else p.far++;
      if (h != null && h <= 1) p.within1++;
    }
  }
  p.round = G.timeMarker;
  return p;
}

const aiBuilt = [], humanBuilt = [];

// --- AI-built: reveal snapshots from human-Rebel logs (Empire = the AI) ---
const dir = join(ROOT, 'logs');
let scanned = 0, used = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let L; try { L = readGameLog(join(dir, f)); } catch { continue; }
  if (L.humanSide !== 'Rebel' || !L.snapshots?.length) continue;
  scanned++;
  const snap = L.snapshots.find((s) => s.at === 'base-reveal') ?? L.snapshots[0];
  let G; try { G = codec.decode(snapshotToCodec(snap.state), catalog); } catch { continue; }
  if (!G.rebelBaseRevealed) continue;
  const p = profile(G); if (p) { aiBuilt.push(p); used++; }
}

// --- Human-built: post-reveal human-Empire positions ---
for (const line of readFileSync(join(ROOT, 'reports', 'human-decisions.jsonl'), 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(line);
  if (r.quality !== 'exact' || r.humanSide !== 'Empire') continue;
  let G; try { G = codec.decode(r.state, catalog); } catch { continue; }
  if (!G.rebelBaseRevealed) continue;
  const p = profile(G); if (p) humanBuilt.push(p);
}

const mean = (xs, k) => xs.length ? (xs.reduce((s, x) => s + x[k], 0) / xs.length).toFixed(2) : '-';
const med = (xs, k) => { if (!xs.length) return '-'; const v = xs.map((x) => x[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
const row = (name, xs) => `${name.padEnd(24)} n=${String(xs.length).padStart(4)}  round=${mean(xs, 'round')}  ground:total=${mean(xs, 'total')}  @base=${mean(xs, 'at0')}  1hop=${mean(xs, 'at1')}  2hop=${mean(xs, 'at2')}  3+=${mean(xs, 'far')}  within1=${mean(xs, 'within1')} (med ${med(xs, 'within1')})`;

console.log(`\nEMPIRE MOBILE GROUND AT / AFTER THE BASE REVEAL — position only, no search.\n`);
console.log(row('AI-built (AI Empire)', aiBuilt));
console.log(row('human-built (won games)', humanBuilt));
const share = (xs) => { const t = xs.reduce((s, x) => s + x.total, 0); return t ? `${(100 * xs.reduce((s, x) => s + x.within1, 0) / t).toFixed(0)}%` : '-'; };
console.log(`\nshare of the Empire's mobile ground that is within 1 hop of the base:`);
console.log(`  AI-built:    ${share(aiBuilt)}`);
console.log(`  human-built: ${share(humanBuilt)}`);
console.log(`\nlogs scanned (human-Rebel with snapshots): ${scanned}, usable reveal boards: ${used}`);
