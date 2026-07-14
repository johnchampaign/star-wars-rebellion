// MCTS-policy bench — validates the determinized Monte-Carlo Empire policy
// (src/play/mctsAI.ts, SWR_MCTS=1) against the HUMAN-LIKE defender, the same
// regime as smoke-empire-planner.mjs. The headline metric is the hunt-replay
// find count: recorded human-Rebel positions where the real game's Empire
// never located the base (docs/ai-health.md baseline: heuristic finds 0/17).
//
//   PART 1 — REPLAY: every recorded human-Rebel position (reveal + hunt kinds,
//   same corpus discovery as the smoke suite), defender holds (RM stripped).
//   PART 2 — HOLD-DEFENDER SELF-PLAY: seeded games, Rebel never relocates,
//   base fortified at reveal. MCTS Empire vs heuristic Rebel.
//
// Run (driver, both arms):  node scripts/mcts-bench.mjs [--games 12] [--rounds 6]
//   --on-only          skip the OFF arm (heuristic baseline is well known)
//   --replays-only     PART 1 only (fastest signal on the hunt)
//   --budget/--dets/--horizon/--topk  forwarded to the ON arm's search config
// Internal: --arm runs one arm under the current SWR_MCTS env.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

const argv = process.argv.slice(2);
const IS_ARM = argv.includes('--arm');
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const N_GAMES = parseInt(flag('--games', '12'), 10);
const N_ROUNDS = parseInt(flag('--rounds', '6'), 10);
// Replay AI seed. Each replay is ONE deterministic sample given this seed —
// vary it across runs to put error bars on the replay metrics (a single run's
// find-count swung 3/22 -> 13/22 on a pure RNG-consumption refactor).
const AI_SEED = parseInt(flag('--ai-seed', '424242'), 10);
const REPLAYS_ONLY = argv.includes('--replays-only');
const SKIP_REPLAYS = argv.includes('--skip-replays');
const ON_ONLY = argv.includes('--on-only');

// ---------------------------------------------------------------------------
// Driver mode.
// ---------------------------------------------------------------------------
if (!IS_ARM) {
  const run = (mcts) => {
    const env = { ...process.env, SWR_MCTS: mcts };
    for (const [f, v] of [['--budget', 'SWR_MCTS_BUDGET'], ['--dets', 'SWR_MCTS_DETS'], ['--horizon', 'SWR_MCTS_HORIZON'], ['--topk', 'SWR_MCTS_TOPK']]) {
      const x = flag(f, null); if (x != null) env[v] = x;
    }
    const pass = ['--arm', '--games', String(N_GAMES), '--rounds', String(N_ROUNDS), '--ai-seed', String(AI_SEED)];
    if (REPLAYS_ONLY) pass.push('--replays-only');
    if (SKIP_REPLAYS) pass.push('--skip-replays');
    const r = spawnSync(process.execPath, [SELF, ...pass], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) { console.error(r.stderr?.slice(-3000)); throw new Error(`arm SWR_MCTS=${mcts} failed`); }
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) { console.error(r.stdout.slice(-3000)); throw new Error(`arm SWR_MCTS=${mcts}: no RESULT line`); }
    return JSON.parse(line.slice(7));
  };
  console.log(`MCTS bench — ${REPLAYS_ONLY ? 'replays only' : N_GAMES + ' hold-defender games/arm'}, ${N_ROUNDS} replay rounds`);
  let off = null;
  if (!ON_ONLY) { console.log('running heuristic (OFF) arm...'); off = run('0'); }
  console.log('running MCTS (ON) arm...');
  const t0 = Date.now();
  const on = run('1');
  console.log(`ON arm wall time: ${((Date.now() - t0) / 60000).toFixed(1)} min`);

  const f = (x, d = 1) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  console.log('\n================= REPLAYS (real human positions, defender holds) =================');
  for (const b of on.replays) {
    const a = off?.replays.find((x) => x.log === b.log && x.kind === b.kind);
    const rv = (r) => r.kind === 'hunt' ? ` revealed=${r.revealed}${r.revealed ? '@t' + r.revealTurn : ''}` : '';
    console.log(`  ${b.log} [${b.kind}${b.kind === 'hunt' ? ' from t' + b.startT : ''}]  base=${b.base} defenders=${b.defenders}`);
    if (a) console.log(`    OFF:${rv(a)} assaults=${a.assaults} maxDelivered=${a.maxDelivered} captured=${a.captured}`);
    console.log(`    ON :${rv(b)} assaults=${b.assaults} maxDelivered=${b.maxDelivered} captured=${b.captured}`);
  }
  const hunts = on.replays.filter((b) => b.kind === 'hunt');
  const found = hunts.filter((b) => b.revealed).length;
  const foundOff = off ? off.replays.filter((b) => b.kind === 'hunt' && b.revealed).length : '?';
  const caps = on.replays.filter((b) => b.captured).length;
  const capsOff = off ? off.replays.filter((b) => b.captured).length : '?';
  console.log(`\n  HUNT REPLAYS FOUND: OFF ${foundOff}/${hunts.length}  ON ${found}/${hunts.length}   (ai-health baseline: 0/17)`);
  console.log(`  REPLAY CAPTURES:    OFF ${capsOff}/${on.replays.length}  ON ${caps}/${on.replays.length}`);

  if (!REPLAYS_ONLY) {
    console.log('\n================= HOLD-DEFENDER SELF-PLAY =================');
    const row = (k, get, d = 1) => console.log(`  ${k.padEnd(34)} OFF ${off ? f(get(off), d).padStart(6) : '     ?'}   ON ${f(get(on), d).padStart(6)}`);
    row('Empire win-rate %', (r) => 100 * r.sp.empWins / r.sp.games);
    row('base revealed', (r) => r.sp.revealed, 0);
    row('avg find-turn', (r) => r.sp.sumRevealTurn / Math.max(1, r.sp.revealed));
    row('conversion % (revealed→win)', (r) => 100 * r.sp.converted / Math.max(1, r.sp.revealed));
    row('PEAK delivered ground / revealed', (r) => r.sp.sumPeak / Math.max(1, r.sp.revealed));
  }
  if (on.mcts) {
    console.log(`\n  MCTS: ${on.mcts.decisions} decisions, ${(on.mcts.pulls / Math.max(1, on.mcts.decisions)).toFixed(1)} rollouts/decision, `
      + `${(on.mcts.ms / Math.max(1, on.mcts.decisions)).toFixed(0)}ms/decision, `
      + `disagreed with heuristic on ${(100 * on.mcts.disagreements / Math.max(1, on.mcts.decisions)).toFixed(0)}%`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Arm mode.
// ---------------------------------------------------------------------------
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const codec = await import('../src/engine/codec.ts');
const { stepOnce: aiStep, seedAI, setCommandPolicyOverride } = await import('../src/play/randomAI.ts');
const { readGameLog, snapshotToCodec } = await import('./lib/log-reader.mjs');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const MCTS_ON = process.env.SWR_MCTS === '1';
let mctsMod = null;
if (MCTS_ON) {
  mctsMod = await import('../src/play/mctsAI.ts');
  setCommandPolicyOverride('Empire', (g, s) => mctsMod.mctsCommandStep(g, s));
}

const isMobileGround = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile; };
const groundAt = (G, sid, side = 'Empire') => (G.map.systems[sid]?.units ?? []).filter((u) => u.side === side && isMobileGround(G, u)).length;
const rebelGroundAt = (G, sid) => (G.map.systems[sid]?.units ?? []).filter((u) => { const t = G.catalog.unitTypes[u.typeId]; return u.side === 'Rebel' && t?.theater === 'ground'; }).length;

/** The human-like defender: strip Rapid Mobilization so the base HOLDS. */
function stripRM(G) {
  const f = G.rebel;
  f.missionDeck = (f.missionDeck ?? []).filter((id) => id !== 'rapid-mobilization');
  f.missionHand = (f.missionHand ?? []).filter((id) => id !== 'rapid-mobilization');
  const kept = [];
  for (const am of (f.leadersOnMissions ?? [])) {
    if (am.missionId === 'rapid-mobilization') { f.leaderPool.push(...am.leaderIds); continue; }
    kept.push(am);
  }
  f.leadersOnMissions = kept;
}

/** Fortify the base to a human-plausible garrison (mirrors the smoke suite). */
function fortify(G, base, tough, tag) {
  const ss = G.map.systems[base]; if (!ss) return;
  let n = rebelGroundAt(G, base), k = 0;
  while (n < tough) { ss.units.push({ instanceId: `fort-${tag}-g${k++}`, typeId: 'rebel-trooper', side: 'Rebel', damage: 0 }); n++; }
  if (G.catalog.unitTypes['shield-generator'] && !ss.units.some((u) => u.side === 'Rebel' && u.typeId === 'shield-generator')) {
    ss.units.push({ instanceId: `fort-${tag}-s`, typeId: 'shield-generator', side: 'Rebel', damage: 0 });
  }
}

// ---- PART 1: replays of real human positions (same discovery as smoke) ----
function findReplayLogs() {
  const out = [];
  for (const f of readdirSync(join(ROOT, 'logs')).filter((x) => x.endsWith('.json'))) {
    try {
      const L = readGameLog(join(ROOT, 'logs', f));
      if (L.humanSide !== 'Rebel') continue;
      if (L.snapshots.some((s) => s.at === 'base-reveal')) { out.push({ file: f, L, kind: 'reveal' }); continue; }
      const ts = L.snapshots.filter((s) => s.at === 'turn-start').map((s) => s.turn);
      if (ts.length >= 4) out.push({ file: f, L, kind: 'hunt', fromTurn: Math.max(2, Math.max(...ts) - 3) });
    } catch { /* skip */ }
  }
  return out;
}

const catalogSeed = createGame(data, { seed: 1, autoSetupUnits: true });
const replays = [];
for (const { file, L, kind, fromTurn } of SKIP_REPLAYS ? [] : findReplayLogs()) {
  const snap = kind === 'reveal'
    ? L.snapshots.find((s) => s.at === 'base-reveal')
    : L.snapshots.find((s) => s.at === 'turn-start' && s.turn === fromTurn);
  if (!snap) continue;
  const G = codec.decode(snapshotToCodec(snap.state), catalogSeed.catalog);
  stripRM(G); // the defender holds
  seedAI(AI_SEED);
  if (mctsMod) mctsMod.seedMCTS(AI_SEED);
  const base = G.rebelBaseSystemId;
  const defenders = rebelGroundAt(G, base);
  const startT = G.timeMarker;
  let assaults = 0, maxDelivered = 0, captured = false, inCombat = false, st = 0;
  let revealed = kind === 'reveal', revealTurn = revealed ? startT : null;
  while (!G.isGameOver && G.timeMarker < startT + N_ROUNDS && st < 100000) {
    if (!revealed && G.rebelBaseRevealed) { revealed = true; revealTurn = G.timeMarker; }
    const pc = G.pendingCombat;
    if (pc && !inCombat && pc.attackerSide === 'Empire' && pc.systemId === base) {
      assaults++; maxDelivered = Math.max(maxDelivered, groundAt(G, base));
    }
    inCombat = !!pc;
    const sd = G.currentPlayer;
    if (aiStep(G, sd)) { st++; if (G.winner === 'Empire') { captured = true; break; } continue; }
    const o = sd === 'Rebel' ? 'Empire' : 'Rebel';
    if (aiStep(G, o)) { st++; if (G.winner === 'Empire') { captured = true; break; } continue; }
    // turn-start snapshots decode parked mid-Refresh (advanceTime fires the
    // snapshot inside the refresh chain) — kick the unexecuted remainder.
    if (phases.resumeRefreshTurnStart(G)) { st++; continue; }
    break;
  }
  replays.push({ log: file.slice(0, 12), kind, base, defenders, assaults, maxDelivered, captured, revealed, revealTurn, startT });
  console.error(`replay ${file.slice(0, 12)} [${kind}] done: revealed=${revealed} captured=${captured} steps=${st} endTM=${G.timeMarker} over=${G.isGameOver} winner=${G.winner ?? 'none'}`);
}

// ---- PART 2: hold-defender self-play ----
const TOUGH = 8;
const sp = { games: 0, empWins: 0, revealed: 0, converted: 0, sumPeak: 0, sumRevealTurn: 0 };
if (!REPLAYS_ONLY) {
  for (let i = 0; i < N_GAMES; i++) {
    const seed = 5000 + i; seedAI(seed);
    if (mctsMod) mctsMod.seedMCTS(seed);
    const G = createGame(data, { seed, autoSetupUnits: false });
    let s = 0; while (G.phase === 'Setup' && s++ < 100) { if (!aiStep(G, G.currentPlayer)) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!aiStep(G, o)) { phases.setupAutoFill(G, 'Rebel'); phases.setupAutoFill(G, 'Empire'); } } }
    stripRM(G);
    let revealedAt = null, fortified = false, inCombat = false, peak = 0, st = 0;
    while (!G.isGameOver && st < 200000 && G.timeMarker <= 16) {
      const base = G.rebelBaseSystemId;
      if (G.rebelBaseRevealed && !fortified) { fortify(G, base, TOUGH, i); fortified = true; revealedAt = G.timeMarker; }
      if (G.rebelBaseRevealed) peak = Math.max(peak, groundAt(G, base));
      inCombat = !!G.pendingCombat;
      void inCombat;
      const sd = G.currentPlayer; if (aiStep(G, sd)) { st++; continue; }
      const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (aiStep(G, o)) { st++; continue; } break;
    }
    sp.games++;
    const win = G.winner === 'Empire'; if (win) sp.empWins++;
    if (revealedAt != null) {
      sp.revealed++; sp.sumPeak += peak; sp.sumRevealTurn += revealedAt;
      if (win) sp.converted++;
    }
    console.error(`game ${i + 1}/${N_GAMES}: winner=${G.winner ?? 'none'} revealed=${revealedAt != null}`);
  }
}

const mcts = mctsMod ? mctsMod.mctsStats : null;
console.log('RESULT ' + JSON.stringify({ replays, sp, mcts }));
