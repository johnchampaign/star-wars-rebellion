// Ground posture at the moment the base is revealed: Rebel ground strength at the
// base vs Empire MOBILE ground strength within 1 hop / 2 hops / anywhere, plus the
// carrier capacity co-located with the 1-hop ground. Two populations:
//   --human   exact post-reveal human-Empire Command positions (reports/human-decisions.jsonl)
//   --archive the reveal snapshots of human-Rebel games (what the AI Empire had built up)
// node scripts/measure-reveal-posture.mjs --human | --archive
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGameLog, snapshotToCodec } from './lib/log-reader.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv.includes('--archive') ? 'archive' : 'human';
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts'); const codec = await import('../src/engine/codec.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });
const isMobileGround = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile; };
const strOf = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return t ? (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0) : 0; };
function bfs(adj, s) { const d = { [s]: 0 }; const q = [s]; while (q.length) { const c = q.shift(); for (const n of adj[c] ?? []) if (d[n] == null) { d[n] = d[c] + 1; q.push(n); } } return d; }
function posture(G) {
  const base = G.rebelBaseSystemId; const dist = bfs(G.catalog.adjacency, base);
  const gstr = (pred) => { let n = 0, c = 0; for (const [sid, ss] of Object.entries(G.map.systems)) for (const u of ss.units ?? []) if (u.side === 'Empire' && isMobileGround(G, u) && pred(dist[sid] ?? 99)) { n += strOf(G, u); c++; } return [n, c]; };
  let lift1 = 0; for (const [sid, ss] of Object.entries(G.map.systems)) { if ((dist[sid] ?? 99) > 1) continue; const units = ss.units ?? []; if (!units.some((u) => u.side === 'Empire' && isMobileGround(G, u))) continue; for (const u of units) if (u.side === 'Empire') lift1 += G.catalog.unitTypes[u.typeId]?.transport?.capacity ?? 0; }
  const rebel = (G.map.systems[base]?.units ?? []).filter((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground').reduce((a, u) => a + strOf(G, u), 0);
  const [s1, c1] = gstr((d) => d <= 1), [s2, c2] = gstr((d) => d <= 2), [sA, cA] = gstr(() => true);
  return { t: G.timeMarker, rebel, s1, c1, s2, c2, sA, cA, lift1 };
}
const P = [];
if (MODE === 'human') {
  const rows = readFileSync(join(ROOT, 'reports', 'human-decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const seen = new Set();
  for (const r of rows) {
    if (r.humanSide !== 'Empire' || r.quality !== 'exact') continue;
    let G; try { G = codec.decode(r.state, catalog); } catch { continue; }
    if (!G.rebelBaseRevealed || !G.rebelBaseSystemId) continue;
    const key = r.gameId + ':' + G.timeMarker; if (seen.has(key)) continue; seen.add(key); // one per game-turn
    P.push({ id: r.gameId, ...posture(G) });
  }
} else {
  const dir = join(ROOT, 'logs'); const seen = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let L; try { L = readGameLog(join(dir, f)); } catch { continue; }
    if (L.humanSide !== 'Rebel' || seen.has(L.gameId)) continue;
    for (const s of [...L.snapshots.filter((x) => x.at === 'base-reveal'), ...L.snapshots.filter((x) => x.at !== 'base-reveal')]) {
      let G; try { G = codec.decode(snapshotToCodec(s.state), catalog); } catch { continue; }
      if (G.rebelBaseRevealed) { seen.add(L.gameId); P.push({ id: L.gameId, ...posture(G) }); break; }
    }
  }
}
const n = P.length; const mean = (k) => (P.reduce((a, p) => a + p[k], 0) / n).toFixed(1);
const ratio = (k) => (P.reduce((a, p) => a + p[k] / Math.max(1, p.rebel), 0) / n).toFixed(2);
const ge = (k) => P.filter((p) => p[k] >= p.rebel).length;
console.log(`${MODE === 'human' ? 'WINNING HUMAN EMPIRES (post-reveal Command positions)' : 'AI EMPIRE (reveal snapshots of human-Rebel games)'}: n=${n}, mean turn ${mean('t')}`);
console.log(`  Rebel ground at base: mean strength ${mean('rebel')}`);
console.log(`  Empire mobile ground within 1 hop: mean strength ${mean('s1')} (${mean('c1')} units)  ratio to Rebel ${ratio('s1')}  boards with >= Rebel: ${ge('s1')}/${n}`);
console.log(`  within 2 hops: strength ${mean('s2')} (${mean('c2')} units)  ratio ${ratio('s2')}  >= Rebel: ${ge('s2')}/${n}`);
console.log(`  whole map:     strength ${mean('sA')} (${mean('cA')} units)  ratio ${ratio('sA')}  >= Rebel: ${ge('sA')}/${n}`);
console.log(`  share of the Empire's mobile ground within 1 hop of the base: ${(100 * P.reduce((a, p) => a + p.c1 / Math.max(1, p.cA), 0) / n).toFixed(0)}%; within 2 hops: ${(100 * P.reduce((a, p) => a + p.c2 / Math.max(1, p.cA), 0) / n).toFixed(0)}%`);
console.log(`  carrier capacity co-located with 1-hop ground: mean ${mean('lift1')}`);
