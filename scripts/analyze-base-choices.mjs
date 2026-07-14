// Where do HUMANS put the Rebel base? — empirical grounding for the MCTS
// determinizer's belief weighting (the post-RM re-hunt lever).
//
// Scans v2 logs (per-turn snapshots) for human-Rebel games and collects every
// base LOCATION EVENT: the initial placement (setup-complete snapshot) and
// each relocation (rebelBaseSystemId change between consecutive snapshots).
// For each, records features of the chosen system AND of every alternative
// candidate at that moment (population-relative stats are what a sampler
// needs): remoteness, distance to the nearest Empire ground presence,
// distance to the nearest Empire unit of any kind, distance from the previous
// base, loyalty, resource count.
//
// Run: node scripts/analyze-base-choices.mjs [--json]

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const { readGameLog, snapshotToCodec } = await import('./lib/log-reader.mjs');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const cat = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const JSON_OUT = process.argv.includes('--json');

function bfs(G, starts) {
  const d = {}; let frontier = [];
  for (const s of starts) { d[s] = 0; frontier.push(s); }
  let dist = 0;
  while (frontier.length) {
    dist++; const next = [];
    for (const s of frontier) for (const a of (cat.adjacency[s] ?? [])) if (d[a] === undefined) { d[a] = dist; next.push(a); }
    frontier = next;
  }
  return d;
}

function features(G, sid, prevBase) {
  const sys = cat.systems[sid];
  const ss = G.map.systems[sid];
  const empireGroundAt = [];
  const empireAnyAt = [];
  for (const [id, s2] of Object.entries(G.map.systems)) {
    let ground = false, any = false;
    for (const u of s2.units) {
      if (u.side !== 'Empire') continue;
      any = true;
      if (cat.unitTypes[u.typeId]?.theater === 'ground') ground = true;
    }
    if (ground) empireGroundAt.push(id);
    if (any) empireAnyAt.push(id);
  }
  const dGround = empireGroundAt.length ? bfs(G, empireGroundAt) : {};
  const dAny = empireAnyAt.length ? bfs(G, empireAnyAt) : {};
  const dPrev = prevBase ? bfs(G, [prevBase]) : {};
  return {
    remote: !!sys?.isRemote,
    resources: sys?.resources?.length ?? 0,
    loyalty: ss?.loyalty ?? 'none',
    subjugated: !!ss?.subjugated,
    dEmpireGround: dGround[sid] ?? 99,
    dEmpireAny: dAny[sid] ?? 99,
    dPrevBase: prevBase ? (dPrev[sid] ?? 99) : null,
  };
}

/** Candidate pool at the moment of choice: systems the base could plausibly
 *  go to (not destroyed, not Empire-ground, not imperial-loyal — mirrors the
 *  reveal condition), used as the comparison population. */
function candidatePool(G) {
  const out = [];
  for (const [sid, ss] of Object.entries(G.map.systems)) {
    if (ss.destroyed) continue;
    if (ss.loyalty === 'imperial' && !ss.subjugated) continue;
    if (ss.units.some((u) => u.side === 'Empire' && cat.unitTypes[u.typeId]?.theater === 'ground')) continue;
    out.push(sid);
  }
  return out;
}

const events = []; // { kind: 'initial'|'relocate', file, turn, chosen: feats, pool: feats[] }
let games = 0, v2 = 0;
for (const f of readdirSync(join(ROOT, 'logs')).filter((x) => x.endsWith('.json'))) {
  let L;
  try { L = readGameLog(join(ROOT, 'logs', f)); } catch { continue; }
  if (L.humanSide !== 'Rebel') continue;
  games++;
  const snaps = L.snapshots ?? [];
  if (!snaps.length) continue;
  v2++;
  let prevBase = null;
  const ordered = [...snaps].sort((a, b) => (a.turn - b.turn) || (a.at === 'setup-complete' ? -1 : 1));
  for (const s of ordered) {
    let G;
    try { G = codec.decode(snapshotToCodec(s.state), cat); } catch { continue; }
    const base = G.rebelBaseSystemId;
    if (!base) continue;
    if (prevBase === null) {
      events.push({ kind: 'initial', file: f.slice(0, 8), turn: s.turn, base, chosen: features(G, base, null), pool: candidatePool(G).map((sid) => ({ sid, ...features(G, sid, null) })) });
    } else if (base !== prevBase) {
      events.push({ kind: 'relocate', file: f.slice(0, 8), turn: s.turn, base, from: prevBase, chosen: features(G, base, prevBase), pool: candidatePool(G).map((sid) => ({ sid, ...features(G, sid, prevBase) })) });
    }
    prevBase = base;
  }
}

if (JSON_OUT) { console.log(JSON.stringify(events, null, 1)); process.exit(0); }

console.log(`human-Rebel games: ${games}, with snapshots: ${v2}`);
for (const kind of ['initial', 'relocate']) {
  const evs = events.filter((e) => e.kind === kind);
  console.log(`\n=== ${kind} (${evs.length} events) ===`);
  if (!evs.length) continue;
  const chosenSystems = {};
  for (const e of evs) chosenSystems[e.base] = (chosenSystems[e.base] ?? 0) + 1;
  console.log('systems chosen:', Object.entries(chosenSystems).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(' '));
  const frac = (get) => {
    const c = evs.filter((e) => get(e.chosen)).length / evs.length;
    const p = evs.reduce((sum, e) => sum + e.pool.filter((x) => get(x)).length / Math.max(1, e.pool.length), 0) / evs.length;
    return `${(100 * c).toFixed(0)}% vs pool ${(100 * p).toFixed(0)}%`;
  };
  const avg = (get) => {
    const c = evs.reduce((s, e) => s + get(e.chosen), 0) / evs.length;
    const p = evs.reduce((sum, e) => sum + e.pool.reduce((s2, x) => s2 + get(x), 0) / Math.max(1, e.pool.length), 0) / evs.length;
    return `${c.toFixed(1)} vs pool ${p.toFixed(1)}`;
  };
  console.log(`  remote:          ${frac((x) => x.remote)}`);
  console.log(`  rebel-loyal:     ${frac((x) => x.loyalty === 'rebel')}`);
  console.log(`  resources:       ${avg((x) => x.resources)}`);
  console.log(`  dist Empire GND: ${avg((x) => Math.min(x.dEmpireGround, 8))}`);
  console.log(`  dist Empire any: ${avg((x) => Math.min(x.dEmpireAny, 8))}`);
  if (kind === 'relocate') console.log(`  dist from old:   ${avg((x) => Math.min(x.dPrevBase ?? 8, 8))}`);
}
