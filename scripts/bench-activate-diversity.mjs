// A/B the distinct-target activation candidates (#599) UNDER MCTS, on real
// recorded human-Rebel positions.
//
// Why a dedicated bench: the change is invisible to the pure heuristic, which
// just takes the top-scoring action — and the top TARGET is the same either
// way, so scripts/bench-assign-gate.mjs came back byte-identical across arms.
// The change only matters to the search: searchMctsCommand searches
// bestCommandAction(...).slice(0, topK), and pre-fix every pool leader named
// the SAME system, so alternative destinations never entered the search.
//
// Shape follows scripts/mcts-bench.mjs (same replay discovery, same
// hold-the-base defender), but BOUNDED: --max-replays caps the corpus scan so
// a run finishes in minutes rather than an hour, and the driver runs BOTH arms
// itself so the only difference between them is SWR_ACTIVATE_DIVERSITY.
//
// Both arms get the same replays, the same AI seed, and the same MCTS config.
// Vary --ai-seed across runs: a single replay run is ONE deterministic sample
// and the find-count is known to swing hard between seeds, so do not read a
// one-seed difference as a result.
//
// Run:  node scripts/bench-activate-diversity.mjs [--max-replays 12] [--rounds 6] [--ai-seed 424242]
// Internal: --arm runs one arm under the current env.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const argv = process.argv.slice(2);
const IS_ARM = argv.includes('--arm');
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const MAX_REPLAYS = parseInt(flag('--max-replays', '12'), 10);
const N_ROUNDS = parseInt(flag('--rounds', '6'), 10);
const AI_SEED = parseInt(flag('--ai-seed', '424242'), 10);
// Which env flag to A/B. Defaults to the distinct-target change this bench was
// written for, but any 1/0 search flag works — e.g.
//   --flag SWR_MCTS_KEEP_PLAYING   (the #630 lost-position fallback)
const FLAG = flag('--flag', 'SWR_ACTIVATE_DIVERSITY');

// ---------------------------------------------------------------------------
// Driver: run both arms, compare.
// ---------------------------------------------------------------------------
if (!IS_ARM) {
  const run = (diversity) => {
    const env = { ...process.env, SWR_MCTS: '1', [FLAG]: diversity };
    const pass = ['--arm', '--max-replays', String(MAX_REPLAYS), '--rounds', String(N_ROUNDS), '--ai-seed', String(AI_SEED)];
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [SELF, ...pass], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) { console.error(r.stderr?.slice(-3000)); throw new Error(`arm diversity=${diversity} failed`); }
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) { console.error(r.stdout.slice(-3000)); throw new Error(`arm diversity=${diversity}: no RESULT line`); }
    const out = JSON.parse(line.slice(7));
    out.minutes = (Date.now() - t0) / 60000;
    return out;
  };
  console.log(`${FLAG} A/B — <=${MAX_REPLAYS} replays, ${N_ROUNDS} rounds, ai-seed ${AI_SEED}, MCTS ON`);
  console.log(`running OFF arm (${FLAG}=0)...`);
  const off = run('0');
  console.log(`  ${off.minutes.toFixed(1)} min`);
  console.log(`running ON arm (${FLAG}=1)...`);
  const on = run('1');
  console.log(`  ${on.minutes.toFixed(1)} min`);

  const hunts = (r) => r.replays.filter((x) => x.kind === 'hunt');
  const pct = (n, d) => d ? `${n}/${d} (${(100 * n / d).toFixed(0)}%)` : '0/0';
  console.log('\n=============== PER-REPLAY ===============');
  for (const b of on.replays) {
    const a = off.replays.find((x) => x.log === b.log && x.kind === b.kind);
    const mark = a && (a.captured !== b.captured || a.revealed !== b.revealed) ? '  <-- DIFFERS' : '';
    console.log(`  ${b.log} [${b.kind}] base=${b.base} def=${b.defenders}${mark}`);
    if (a) console.log(`     OFF revealed=${a.revealed} captured=${a.captured} assaults=${a.assaults} maxDelivered=${a.maxDelivered}`);
    console.log(`     ON  revealed=${b.revealed} captured=${b.captured} assaults=${b.assaults} maxDelivered=${b.maxDelivered}`);
  }
  const sum = (r, f) => r.replays.reduce((s, x) => s + (f(x) ? 1 : 0), 0);
  const tot = (r, f) => r.replays.reduce((s, x) => s + f(x), 0);
  console.log('\n=============== TOTALS ===============');
  console.log(`  hunt replays where the base was FOUND:  OFF ${pct(hunts(off).filter((x) => x.revealed).length, hunts(off).length)}   ON ${pct(hunts(on).filter((x) => x.revealed).length, hunts(on).length)}`);
  console.log(`  replays CAPTURED:                       OFF ${pct(sum(off, (x) => x.captured), off.replays.length)}   ON ${pct(sum(on, (x) => x.captured), on.replays.length)}`);
  console.log(`  total base assaults:                    OFF ${tot(off, (x) => x.assaults)}   ON ${tot(on, (x) => x.assaults)}`);
  console.log(`  total peak ground delivered:            OFF ${tot(off, (x) => x.maxDelivered)}   ON ${tot(on, (x) => x.maxDelivered)}`);
  for (const [k, r] of [['OFF', off], ['ON', on]]) {
    if (r.mcts) {
      const d = Math.max(1, r.mcts.decisions);
      console.log(`  ${k} search: ${r.mcts.decisions} decisions, ` +
        `${(r.mcts.pulls / d).toFixed(1)} rollouts/decision, ` +
        `disagreed ${(100 * r.mcts.disagreements / d).toFixed(0)}%, ` +
        `pass-margin fired ${(100 * (r.mcts.passRescues ?? 0) / d).toFixed(1)}%, ` +
        `keep-playing fired ${(100 * (r.mcts.keepPlaying ?? 0) / d).toFixed(1)}%`);
    }
  }
  console.log('\n  NOTE: one seed = one deterministic sample. Re-run with --ai-seed to put');
  console.log('  error bars on these before treating any gap as real.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Arm.
// ---------------------------------------------------------------------------
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const codec = await import('../src/engine/codec.ts');
const { stepOnce: aiStep, seedAI, setCommandPolicyOverride } = await import('../src/play/randomAI.ts');
const { readGameLog, snapshotToCodec } = await import('./lib/log-reader.mjs');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const mctsMod = await import('../src/play/mctsAI.ts');
setCommandPolicyOverride('Empire', (g, s) => mctsMod.mctsCommandStep(g, s));

const isMobileGround = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile; };
const groundAt = (G, sid) => (G.map.systems[sid]?.units ?? []).filter((u) => u.side === 'Empire' && isMobileGround(G, u)).length;
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

// Same discovery as mcts-bench, sorted for determinism. The cap takes an
// EVENLY SPACED subset of the qualifying logs rather than the first N — the
// first N by filename is an arbitrary and possibly unrepresentative slice of
// the corpus (the first three are all zero-defender hunts that neither arm
// resolves), which would hide any real difference. Both arms and every seed
// see the identical set.
function findReplayLogs() {
  const all = [];
  for (const f of readdirSync(join(ROOT, 'logs')).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const L = readGameLog(join(ROOT, 'logs', f));
      if (L.humanSide !== 'Rebel') continue;
      if (L.snapshots.some((s) => s.at === 'base-reveal')) { all.push({ file: f, L, kind: 'reveal' }); continue; }
      const ts = L.snapshots.filter((s) => s.at === 'turn-start').map((s) => s.turn);
      if (ts.length >= 4) all.push({ file: f, L, kind: 'hunt', fromTurn: Math.max(2, Math.max(...ts) - 3) });
    } catch { /* skip unreadable */ }
  }
  if (all.length <= MAX_REPLAYS) return all;
  // Prefer 'reveal' replays: they start with the base already exposed, so they
  // actually exercise the assault the diversity change is meant to help, while
  // a 'hunt' replay can end with nothing found and tell us nothing either way.
  const reveals = all.filter((x) => x.kind === 'reveal');
  const huntsAll = all.filter((x) => x.kind === 'hunt');
  const pick = [];
  const spread = (arr, n) => {
    if (n <= 0 || arr.length === 0) return [];
    const step = arr.length / n;
    return Array.from({ length: Math.min(n, arr.length) }, (_, i) => arr[Math.floor(i * step)]);
  };
  const wantReveal = Math.min(reveals.length, Math.ceil(MAX_REPLAYS / 2));
  pick.push(...spread(reveals, wantReveal));
  pick.push(...spread(huntsAll, MAX_REPLAYS - pick.length));
  return pick;
}

const catalogSeed = createGame(data, { seed: 1, autoSetupUnits: true });
const replays = [];
for (const { file, L, kind, fromTurn } of findReplayLogs()) {
  const snap = kind === 'reveal'
    ? L.snapshots.find((s) => s.at === 'base-reveal')
    : L.snapshots.find((s) => s.at === 'turn-start' && s.turn === fromTurn);
  if (!snap) continue;
  const G = codec.decode(snapshotToCodec(snap.state), catalogSeed.catalog);
  stripRM(G);
  seedAI(AI_SEED);
  mctsMod.seedMCTS(AI_SEED);
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
    // turn-start snapshots decode parked mid-Refresh — kick the remainder.
    if (phases.resumeRefreshTurnStart(G)) { st++; continue; }
    break;
  }
  replays.push({ log: file.slice(0, 12), kind, base, defenders, assaults, maxDelivered, captured, revealed, revealTurn, startT });
  console.error(`  replay ${file.slice(0, 12)} [${kind}] revealed=${revealed} captured=${captured} steps=${st}`);
}

console.log('RESULT ' + JSON.stringify({ replays, mcts: mctsMod.mctsStats ?? null }));
