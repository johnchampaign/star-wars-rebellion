// Replay the AI Empire FORWARD from a real reveal-moment board snapshot (#539).
//
// Now that logState is on, every game log embeds a full board snapshot at the
// moment the base is revealed. This harness decodes that snapshot and plays the
// AI Empire forward from it, measuring how much ground it delivers to the base
// and whether it captures — the delivery test the saturated self-play benches
// can't provide, because the STARTING position here is a real, human-defended
// (and possibly relocated) reveal position rather than a thin AI-Rebel base.
//
// Run BOTH arms to A/B the planner from the identical real position:
//   node scripts/verify-reveal-forward.mjs [logfile]                    # planner OFF
//   SWR_EMPIRE_PLANNER=1 node scripts/verify-reveal-forward.mjs [logfile]   # planner ON
// With no logfile arg it auto-picks the newest human-Rebel log that carries a
// reveal snapshot (i.e. your just-played game).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGameLog, snapshotToCodec } from './lib/log-reader.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const CAP = Number(process.env.SWR_REVEAL_ROUNDS ?? 4);

const isMobileGround = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile; };
const isMobile = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return !!t && !t.transport.immobile; };
function bfs(adj, start) { const d = { [start]: 0 }; const q = [start]; while (q.length) { const c = q.shift(); for (const n of adj[c] ?? []) if (d[n] == null) { d[n] = d[c] + 1; q.push(n); } } return d; }

// Pick the log: explicit arg, else newest human-Rebel log with a reveal snapshot.
// Reads BOTH log formats via the shared reader (scripts/lib/log-reader.mjs).
function resolveLog() {
  const arg = process.argv[2];
  if (arg) return resolve(arg); // use the given path as-is (absolute or cwd-relative)
  const dir = join(ROOT, 'logs');
  const cands = readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of cands) {
    try {
      const L = readGameLog(join(dir, f));
      if (L.humanSide !== 'Rebel') continue;
      if (L.snapshots.length > 0) return join(dir, f);
    } catch { /* skip */ }
  }
  return null;
}

// Extract the reveal-moment snapshot: prefer the labeled base-reveal keyframe,
// else the first snapshot whose board has the base revealed.
function revealSnapshot(L, catalog) {
  const ordered = [
    ...L.snapshots.filter((s) => s.at === 'base-reveal'),
    ...L.snapshots.filter((s) => s.at !== 'base-reveal'),
  ];
  for (const s of ordered) {
    try {
      const G = codec.decode(snapshotToCodec(s.state), catalog);
      if (G.rebelBaseRevealed) return G;
    } catch { /* skip */ }
  }
  return null;
}

const logPath = resolveLog();
if (!logPath) { console.log('No usable log found (need a human-Rebel game with a reveal snapshot).'); process.exit(1); }
const L = readGameLog(logPath);
const seedGame = createGame(data, { seed: 1, autoSetupUnits: true, expansion: L.final.expansion });
const G = revealSnapshot(L, seedGame.catalog);
if (!G) { console.log(`Log ${logPath} has no reveal snapshot (played before logState shipped?).`); process.exit(1); }

const base = G.rebelBaseSystemId;
const dist = bfs(G.catalog.adjacency, base);
const bucket = (sid) => { const d = dist[sid]; return d == null ? '4+' : (d >= 3 ? (d === 3 ? '3' : '4+') : String(d)); };
const groundAtBase = () => (G.map.systems[base]?.units ?? []).filter((u) => u.side === 'Empire' && isMobileGround(G, u)).length;
const rebelGroundAtBase = () => (G.map.systems[base]?.units ?? []).filter((u) => { const t = G.catalog.unitTypes[u.typeId]; return u.side === 'Rebel' && t?.theater === 'ground'; }).length;

// Snapshot the STARTING distribution of Empire mobile ground by hop-from-base.
const startDist = { 0: 0, 1: 0, 2: 0, 3: 0, '4+': 0 };
for (const [sid, ss] of Object.entries(G.map.systems)) for (const u of ss.units) if (u.side === 'Empire' && isMobileGround(G, u)) startDist[bucket(sid)]++;

const planner = process.env.SWR_EMPIRE_PLANNER === '1' ? 'ON ' : 'off';
console.log(`\n=== reveal-forward replay [planner=${planner}]  log=${logPath} ===`);
console.log(`base=${base}  t=${G.timeMarker}  reputation=${G.reputationMarker}  winner(final in log)=${L.winner}`);
console.log(`Rebel ground defending base: ${rebelGroundAtBase()}   Empire ground @base=${startDist[0]} 1hop=${startDist[1]} 2hop=${startDist[2]} 3hop=${startDist[3]} 4+=${startDist['4+']}`);

seedAI(20260710);
const startT = G.timeMarker;
let peak = groundAtBase(), firstAssault = null, inCombat = false, captured = false, steps = 0;
while (!G.isGameOver && G.timeMarker < startT + CAP && steps < 100000) {
  const pc = G.pendingCombat;
  if (pc && !inCombat && pc.attackerSide === 'Empire' && pc.systemId === base && firstAssault == null) firstAssault = groundAtBase();
  inCombat = !!pc;
  peak = Math.max(peak, groundAtBase());
  const sd = G.currentPlayer;
  if (aiStep(G, sd)) { steps++; if (G.winner === 'Empire') { captured = true; break; } continue; }
  const o = sd === 'Rebel' ? 'Empire' : 'Rebel';
  if (aiStep(G, o)) { steps++; if (G.winner === 'Empire') { captured = true; break; } continue; }
  break;
}
peak = Math.max(peak, groundAtBase());
console.log(`--- after up to ${CAP} rounds of AI forward-play ---`);
console.log(`PEAK Empire ground delivered to base: ${peak}   ground at first assault: ${firstAssault ?? '-'}`);
console.log(`base captured by Empire: ${captured}   winner=${G.winner ?? '(unfinished)'}   ranTo t=${G.timeMarker}`);
