// #538/#539 follow-through instrument (John's option a, 2026-09-04): from real
// base-reveal snapshots, play the Empire forward for several rounds and watch
// the massed force ROUND BY ROUND — does it arrive at the base and assault, or
// get peeled apart? Two arms on the same boards:
//   heuristic — the plain randomAI Empire (what verify-reveal-forward drove)
//   shipped   — MCTS Empire + the default (ranker) Rebel, what players face
// Per round after the reveal: Empire mobile ground at the base / within 1 hop /
// total, whether an Empire assault on the base happened, capture by round.
//
// Usage: node scripts/measure-reveal-followthrough.mjs [--logs 40] [--rounds 4] [--arm heuristic|shipped|both]
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGameLog, snapshotToCodec } from './lib/log-reader.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const NLOGS = Number(arg('--logs', 40)), CAP = Number(arg('--rounds', 4)), ARM = arg('--arm', 'both');
const ONLY = arg('--only', null); // a single log file name, for debugging one board
const OUT = arg('--out', 'reports/reveal-followthrough.json'), LABEL = arg('--label', null); // --label renames the arm in the output (e.g. a lever arm)
process.env.SWR_MCTS_MS ??= '600000'; // pull-bounded, not clock-bounded: the [verdict] tier
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const isMobileGround = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile; };
function bfs(adj, s) { const d = { [s]: 0 }; const q = [s]; while (q.length) { const c = q.shift(); for (const n of adj[c] ?? []) if (d[n] == null) { d[n] = d[c] + 1; q.push(n); } } return d; }

// newest human-Rebel logs with a reveal snapshot
const dir = join(ROOT, 'logs');
const seedGame = createGame(data, { seed: 1, autoSetupUnits: true });
const logs = []; const seen = new Set();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)) {
  if (ONLY && f.f !== ONLY) continue;
  try {
    const L = readGameLog(join(dir, f.f));
    if (L.humanSide !== 'Rebel' || !L.snapshots.length || seen.has(L.gameId)) continue;
    if (!revealState(L, seedGame.catalog)) continue;
    seen.add(L.gameId); logs.push({ path: join(dir, f.f), L });
  } catch { /* skip */ }
  if (logs.length >= NLOGS) break;
}
function revealState(L, catalog) {
  for (const s of [...L.snapshots.filter((x) => x.at === 'base-reveal'), ...L.snapshots.filter((x) => x.at !== 'base-reveal')]) {
    try { const G = codec.decode(snapshotToCodec(s.state), catalog); if (G.rebelBaseRevealed) return G; } catch { /* skip */ }
  }
  return null;
}
function install(arm) {
  if (arm === 'shipped') { AI.setCommandPolicyOverride('Empire', (g, s) => mcts.mctsCommandStep(g, s)); AI.setCommandPolicyOverride('Rebel', (g, s) => mcts.mctsCommandStep(g, s)); }
  else { AI.setCommandPolicyOverride('Empire', null); AI.setCommandPolicyOverride('Rebel', null); }
}
function playForward(G, arm, seed) {
  install(arm); AI.seedAI(seed); mcts.seedMCTS?.(seed * 29 + 3);
  const base = G.rebelBaseSystemId; const dist = bfs(G.catalog.adjacency, base);
  const count = (pred) => { let n = 0; for (const [sid, ss] of Object.entries(G.map.systems)) for (const u of ss.units ?? []) if (u.side === 'Empire' && isMobileGround(G, u) && pred(dist[sid] ?? 99)) n++; return n; };
  const strOf = (u) => { const t = G.catalog.unitTypes[u.typeId]; return t ? (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0) : 0; };
  const gstr = (pred) => { let n = 0; for (const [sid, ss] of Object.entries(G.map.systems)) for (const u of ss.units ?? []) if (u.side === 'Empire' && isMobileGround(G, u) && pred(dist[sid] ?? 99)) n += strOf(u); return n; };
  // carrier capacity that shares a system with Empire ground within 1 hop (ground that can actually be lifted)
  const liftWithin1 = () => { let cap = 0; for (const [sid, ss] of Object.entries(G.map.systems)) { if ((dist[sid] ?? 99) > 1) continue; const units = ss.units ?? []; if (!units.some((u) => u.side === 'Empire' && isMobileGround(G, u))) continue; for (const u of units) if (u.side === 'Empire') cap += G.catalog.unitTypes[u.typeId]?.transport?.capacity ?? 0; } return cap; };
  const rebelGroundStr = () => (G.map.systems[base]?.units ?? []).filter((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground').reduce((a, u) => a + strOf(u), 0);
  const snap = () => ({ t: G.timeMarker, atBase: count((d) => d === 0), within1: count((d) => d <= 1), within2: count((d) => d <= 2), total: count(() => true), str1: gstr((d) => d <= 1), str2: gstr((d) => d <= 2), strAll: gstr(() => true), lift1: liftWithin1(), rebelGround: rebelGroundStr() });
  const rounds = [snap()]; let assaults = 0, captured = false, inCombat = false, steps = 0; const assaultDetails = [];
  const startT = G.timeMarker; let lastT = G.timeMarker; let stuck = null;
  while (!G.isGameOver && G.timeMarker < startT + CAP && steps < 20000) {
    const pc = G.pendingCombat;
    if (pc && !inCombat && pc.attackerSide === 'Empire' && pc.systemId === base) {
      assaults++;
      // Strength on the ground at the moment the assault starts (attack dice + health per unit).
      const str = (u) => { const t = G.catalog.unitTypes[u.typeId]; return t ? (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0) : 0; };
      const isG = (u) => G.catalog.unitTypes[u.typeId]?.theater === 'ground';
      const units = G.map.systems[base]?.units ?? [];
      const sum = (side, pred) => units.filter((u) => u.side === side && pred(u)).reduce((a, u) => a + str(u), 0);
      const cnt = (side, pred) => units.filter((u) => u.side === side && pred(u)).length;
      assaultDetails.push({ t: G.timeMarker, empGround: sum('Empire', isG), rebGround: sum('Rebel', isG), empGroundN: cnt('Empire', isG), rebGroundN: cnt('Rebel', isG), empSpace: sum('Empire', (u) => !isG(u)), rebSpace: sum('Rebel', (u) => !isG(u)) });
    }
    inCombat = !!pc;
    if (G.timeMarker !== lastT) { rounds.push(snap()); lastT = G.timeMarker; }
    const sd = G.currentPlayer; const o = sd === 'Rebel' ? 'Empire' : 'Rebel';
    if (AI.stepOnce(G, sd)) { steps++; } else if (AI.stepOnce(G, o)) { steps++; } else { stuck = `${G.phase}/${G.combat ? 'combat' : ''}${G.pendingDecision?.kind ?? G.pendingDecision?.type ?? ''}`; break; }
    if (G.winner === 'Empire') { captured = true; break; }
  }
  rounds.push(snap());
  if (process.env.SWR_RIG_DEBUG === '1') {
    process.stderr.write(`    base=${base} units@base=${JSON.stringify((G.map.systems[base]?.units ?? []).map((u) => u.side[0] + ':' + u.typeId))}\n`);
    for (const e of G.turnLog.slice(-300)) {
      const js = JSON.stringify(e.payload ?? {});
      if (js.includes(base) || /game-over|combat-end|combat-start|retreat/.test(e.kind))
        process.stderr.write(`    ${e.side ?? ''} ${e.kind} ${js.slice(0, 240)}\n`);
    }
  }
  const baseMoved = G.rebelBaseSystemId !== base; // the AI Rebel relocated with Rapid Mobilization after the reveal
  return { rounds, assaults, assaultDetails, captured, capturedAtOriginalBase: captured && !baseMoved, baseMoved, endT: G.timeMarker, winner: G.winner ?? null, stuck, steps };
}
const results = [];
const arms = ARM === 'both' ? ['heuristic', 'shipped'] : [ARM];
let i = 0;
for (const { path, L } of logs) {
  i++;
  for (const arm of arms) {
    const G = revealState(L, seedGame.catalog); if (!G) continue;
    const t0 = Date.now();
    const r = playForward(G, arm, 20260904 + i);
    results.push({ log: path.split('/').pop(), arm: LABEL ?? arm, revealT: r.rounds[0].t, ...r, ms: Date.now() - t0 });
    process.stderr.write(`[${i}/${logs.length}] ${arm.padEnd(9)} reveal t${r.rounds[0].t} -> capture=${r.captured} assaults=${r.assaults} within1: ${r.rounds.map((x) => x.within1).join('>')}  (${((Date.now() - t0) / 1000).toFixed(0)}s)${r.stuck ? ' STUCK ' + r.stuck : ''} winner=${r.winner}\n`);
    writeFileSync(OUT.startsWith('/') ? OUT : join(ROOT, OUT), JSON.stringify(results));
  }
}
// summary
for (const arm of arms.map((a) => LABEL ?? a)) {
  const R = results.filter((x) => x.arm === arm); if (!R.length) continue;
  const n = R.length; const cap = R.filter((x) => x.captured).length; const ass = R.filter((x) => x.assaults > 0).length; const moved = R.filter((x) => x.baseMoved).length; const capOrig = R.filter((x) => x.capturedAtOriginalBase).length;
  const peeled = R.filter((x) => { const w = x.rounds.map((y) => y.within1); return w.length > 2 && Math.max(...w.slice(1)) < w[0]; }).length;
  const byRound = [0, 1, 2, 3, 4].map((k) => { const v = R.filter((x) => x.rounds[k]).map((x) => x.rounds[k].within1); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '-'; });
  console.log(`${arm.padEnd(9)} n=${n}  captured within ${CAP} rounds: ${cap} (${(100 * cap / n).toFixed(0)}%) [at the ORIGINAL base ${capOrig}; Rebel relocated in ${moved}]  assaulted the base: ${ass} (${(100 * ass / n).toFixed(0)}%)  force PEELED (within-1 never exceeds reveal-moment): ${peeled} (${(100 * peeled / n).toFixed(0)}%)  mean within-1 by round: ${byRound.join(' > ')}`);
}
