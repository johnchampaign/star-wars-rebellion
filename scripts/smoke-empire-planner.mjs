// Empire-planner smoke suite (#539) — validates the planner against a
// HUMAN-LIKE defender so John doesn't have to playtest every iteration.
//
// Why standard self-play can't do this: the AI Rebel relocates its base the
// moment anyone marches (3.9x/game) and defends it thin, so every post-reveal
// lever reads as a no-op. A human (John) holds, garrisons ~9 ground, and
// relocates once under real pressure. This suite simulates that regime:
//
//   PART 1 — REPLAY: every recorded human-Rebel reveal position (base-reveal
//   snapshots in logs/, accumulating with each real playtest) is replayed
//   forward with Rapid Mobilization stripped from the Rebel ("the defender
//   holds") — does the Empire march, wave, and capture the REAL position?
//
//   PART 2 — HOLD-DEFENDER SELF-PLAY: seeded games where the Rebel never
//   relocates (RM stripped post-setup) and the base is fortified to a
//   human-plausible garrison at reveal. Planner off vs on, same seeds.
//
// Run: node scripts/smoke-empire-planner.mjs [games=120] [rounds=6]
// (Driver mode: spawns itself twice with SWR_EMPIRE_PLANNER=0/1 and prints a
//  PASS/FAIL verdict per gate. --arm is the internal single-arm mode.)

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
// Driver: argv[2]=games argv[3]=rounds. Arm: argv[2]='--arm' argv[3]=games argv[4]=rounds.
const IS_ARM = process.argv[2] === '--arm';
const N_GAMES = parseInt(IS_ARM ? process.argv[3] : process.argv[2], 10) || 120;
const N_ROUNDS = parseInt(IS_ARM ? process.argv[4] : process.argv[3], 10) || 6;

// ---------------------------------------------------------------------------
// Driver mode: run both arms, compare, verdict.
// ---------------------------------------------------------------------------
if (!IS_ARM) {
  const run = (flag) => {
    const r = spawnSync(process.execPath, [SELF, '--arm', String(N_GAMES), String(N_ROUNDS)], {
      env: { ...process.env, SWR_EMPIRE_PLANNER: flag },
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) { console.error(r.stderr?.slice(-2000)); throw new Error(`arm ${flag} failed`); }
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) { console.error(r.stdout.slice(-2000)); throw new Error(`arm ${flag}: no RESULT line`); }
    return JSON.parse(line.slice(7));
  };
  console.log(`Empire-planner smoke suite — ${N_GAMES} hold-defender games/arm, ${N_ROUNDS} replay rounds`);
  console.log('running planner OFF arm...');
  const off = run('0');
  console.log('running planner ON  arm...');
  const on = run('1');

  const f = (x, d = 1) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  console.log('\n================= REPLAYS (real human positions, defender holds) =================');
  for (let i = 0; i < off.replays.length; i++) {
    const a = off.replays[i], b = on.replays[i];
    const rv = (r) => r.kind === 'hunt' ? ` revealed=${r.revealed}${r.revealed ? '@t' + r.revealTurn : ''}` : '';
    console.log(`  ${a.log} [${a.kind}${a.kind === 'hunt' ? ' from t' + a.startT : ''}]  base=${a.base} defenders=${a.defenders}`);
    console.log(`    OFF:${rv(a)} assaults=${a.assaults} maxDelivered=${a.maxDelivered} captured=${a.captured} minStackDist=${a.minStackDist}`);
    console.log(`    ON :${rv(b)} assaults=${b.assaults} maxDelivered=${b.maxDelivered} captured=${b.captured} minStackDist=${b.minStackDist}`);
  }
  console.log('\n================= HOLD-DEFENDER SELF-PLAY =================');
  const row = (k, get, d = 1) => console.log(`  ${k.padEnd(34)} OFF ${f(get(off), d).padStart(6)}   ON ${f(get(on), d).padStart(6)}`);
  row('Empire win-rate %', (r) => 100 * r.sp.empWins / r.sp.games);
  row('base revealed', (r) => r.sp.revealed, 0);
  row('avg find-turn', (r) => r.sp.sumRevealTurn / Math.max(1, r.sp.revealed));
  row('conversion % (revealed→win)', (r) => 100 * r.sp.converted / Math.max(1, r.sp.revealed));
  row('assault waves / revealed game', (r) => r.sp.assaults / Math.max(1, r.sp.revealed));
  row('delivered ground @ first assault', (r) => r.sp.sumFirst / Math.max(1, r.sp.firsts));
  row('PEAK delivered ground / revealed', (r) => r.sp.sumPeak / Math.max(1, r.sp.revealed));
  row('rounds reveal→capture', (r) => r.sp.sumCapTurns / Math.max(1, r.sp.captures));

  console.log('\n================= GATES =================');
  let pass = true;
  const gate = (name, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) pass = false; };
  // The hunt-march lever runs PRE-reveal, so reveals may legitimately rise;
  // what must never happen is finding FEWER bases or finding them later.
  gate('base-finding not down (same seeds)', on.sp.revealed >= off.sp.revealed, `${off.sp.revealed} vs ${on.sp.revealed}`);
  const rtOff = off.sp.sumRevealTurn / Math.max(1, off.sp.revealed), rtOn = on.sp.sumRevealTurn / Math.max(1, on.sp.revealed);
  gate('avg find-turn not slower (+0.3 slack)', rtOn <= rtOff + 0.3, `${f(rtOff)} → ${f(rtOn)}`);
  // NOTE: first-assault size is deliberately NOT a gate. Doctrine (John): the
  // first wave goes in early with whatever is deliverable — attrition pays and
  // the force grows en route. The delivery target from #539 (≥8 ground at the
  // assault) is therefore measured on the PEAK wave, not the first.
  const pOff = off.sp.sumPeak / Math.max(1, off.sp.revealed), pOn = on.sp.sumPeak / Math.max(1, on.sp.revealed);
  gate('PEAK delivered ≥ 8 (the #539 target) and not down', pOn >= 8 && pOn >= pOff - 0.2, `${f(pOff)} → ${f(pOn)}`);
  const wOff = off.sp.assaults / Math.max(1, off.sp.revealed), wOn = on.sp.assaults / Math.max(1, on.sp.revealed);
  gate('waves per revealed game not down', wOn >= wOff - 0.1, `${f(wOff)} → ${f(wOn)}`);
  const cOff = 100 * off.sp.converted / Math.max(1, off.sp.revealed), cOn = 100 * on.sp.converted / Math.max(1, on.sp.revealed);
  gate('conversion not down vs holding defender', cOn >= cOff - 2, `${f(cOff)}% → ${f(cOn)}%`);
  const tOff = off.sp.sumCapTurns / Math.max(1, off.sp.captures), tOn = on.sp.sumCapTurns / Math.max(1, on.sp.captures);
  gate('reveal→capture not slower', tOn <= tOff + 0.2, `${f(tOff)} → ${f(tOn)} rounds`);
  const wrOff = 100 * off.sp.empWins / off.sp.games, wrOn = 100 * on.sp.empWins / on.sp.games;
  gate('Empire win-rate not down > 2pt', wrOn >= wrOff - 2, `${f(wrOff)}% → ${f(wrOn)}%`);
  // Outcome-first replay gates: capturing the real held position is the point;
  // delivered ground is a means (a leaner, earlier wave that captures beats a
  // bigger, later one that doesn't — doctrine).
  const revealCases = on.replays.filter((b) => b.kind === 'reveal');
  const repOk = revealCases.every((b) => {
    const a = off.replays.find((x) => x.log === b.log && x.kind === 'reveal');
    return b.assaults >= 1 && (b.captured || (a && !a.captured && b.maxDelivered >= a.maxDelivered));
  });
  gate('every reveal-replay: ON assaults and captures (or ≥ OFF when neither captures)', repOk);
  // Hunt replays: positions where the real game's Empire NEVER found the base.
  // OPEN PROBLEM, not a regression gate — no shipped lever addresses the hunt
  // yet (the hunt-march attempt was killed by the gates above; post-mortem in
  // empirePlanner.ts deriveHuntTarget). Reported for tracking; graduates to a
  // hard gate when a hunt lever ships.
  const huntCases = on.replays.filter((b) => b.kind === 'hunt');
  if (huntCases.length) {
    const found = huntCases.filter((b) => b.revealed).length;
    console.log(`  OPEN  hunt-replays: ON finds the base in ${found}/${huntCases.length} `
      + `(${huntCases.map((b) => `${b.log.slice(0, 8)}:${b.revealed ? 'found@t' + b.revealTurn : 'no'}`).join(', ')})`);
  }
  console.log(pass ? '\nSMOKE: GREEN — ready for a live playtest.' : '\nSMOKE: RED — planner not validated; keep iterating.');
  process.exit(pass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Arm mode: run replays + hold-defender self-play under the current env flag.
// ---------------------------------------------------------------------------
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const codec = await import('../src/engine/codec.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const { readGameLog, snapshotToCodec } = await import('./lib/log-reader.mjs');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const isMobileGround = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile; };
const groundAt = (G, sid, side = 'Empire') => (G.map.systems[sid]?.units ?? []).filter((u) => u.side === side && isMobileGround(G, u)).length;
const rebelGroundAt = (G, sid) => (G.map.systems[sid]?.units ?? []).filter((u) => { const t = G.catalog.unitTypes[u.typeId]; return u.side === 'Rebel' && t?.theater === 'ground'; }).length;
function bfsDist(G, start) { const d = { [start]: 0 }, q = [start]; while (q.length) { const c = q.shift(); for (const n of (G.catalog.adjacency[c] ?? [])) if (d[n] == null) { d[n] = d[c] + 1; q.push(n); } } return d; }

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

/** Fortify the base to a human-plausible garrison (mirrors bench-hard). */
function fortify(G, base, tough, tag) {
  const ss = G.map.systems[base]; if (!ss) return;
  let n = rebelGroundAt(G, base), k = 0;
  while (n < tough) { ss.units.push({ instanceId: `fort-${tag}-g${k++}`, typeId: 'rebel-trooper', side: 'Rebel', damage: 0 }); n++; }
  if (G.catalog.unitTypes['shield-generator'] && !ss.units.some((u) => u.side === 'Rebel' && u.typeId === 'shield-generator')) {
    ss.units.push({ instanceId: `fort-${tag}-s`, typeId: 'shield-generator', side: 'Rebel', damage: 0 });
  }
}

// ---- PART 1: replays of real human positions ----
// Two case kinds:
//   'reveal' — the base WAS revealed; replay from the reveal moment (does the
//              Empire march, wave, and capture the real position?).
//   'hunt'   — the base was NEVER found (e.g. f1eb6cec: 7 candidates left, a
//              44-unit army 2 hops from ryloth, zero visits); replay from a
//              mid-game turn-start (does the Empire now FIND it — and then
//              convert the reveal it earns?).
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
for (const { file, L, kind, fromTurn } of findReplayLogs()) {
  const snap = kind === 'reveal'
    ? L.snapshots.find((s) => s.at === 'base-reveal')
    : L.snapshots.find((s) => s.at === 'turn-start' && s.turn === fromTurn);
  if (!snap) continue;
  const G = codec.decode(snapshotToCodec(snap.state), catalogSeed.catalog);
  stripRM(G); // the defender holds
  seedAI(424242);
  const base = G.rebelBaseSystemId;
  const defenders = rebelGroundAt(G, base);
  const startT = G.timeMarker;
  let assaults = 0, maxDelivered = 0, captured = false, inCombat = false, st = 0, minStackDist = 99;
  let revealed = kind === 'reveal', revealTurn = revealed ? startT : null;
  while (!G.isGameOver && G.timeMarker < startT + N_ROUNDS && st < 100000) {
    if (!revealed && G.rebelBaseRevealed) { revealed = true; revealTurn = G.timeMarker; }
    const pc = G.pendingCombat;
    if (pc && !inCombat && pc.attackerSide === 'Empire' && pc.systemId === base) {
      assaults++; maxDelivered = Math.max(maxDelivered, groundAt(G, base));
    }
    inCombat = !!pc;
    // biggest Empire stack's distance to the base (march telemetry)
    const dist = bfsDist(G, base);
    for (const [sid, ss] of Object.entries(G.map.systems)) {
      const g = ss.units.filter((u) => u.side === 'Empire' && isMobileGround(G, u)).length;
      if (g >= 4) minStackDist = Math.min(minStackDist, dist[sid] ?? 99);
    }
    const sd = G.currentPlayer;
    if (aiStep(G, sd)) { st++; if (G.winner === 'Empire') { captured = true; break; } continue; }
    const o = sd === 'Rebel' ? 'Empire' : 'Rebel';
    if (aiStep(G, o)) { st++; if (G.winner === 'Empire') { captured = true; break; } continue; }
    // turn-start snapshots decode parked mid-Refresh (advanceTime fires the
    // snapshot inside the refresh chain), so without this kick every hunt-kind
    // replay deadlocked at step 0 — the historical "0/17 hunt-replays" line
    // was measuring a stuck harness, not the hunt. resumeRefreshTurnStart runs
    // the unexecuted remainder of the refresh and play proceeds normally.
    if (phases.resumeRefreshTurnStart(G)) { st++; continue; }
    break;
  }
  replays.push({ log: file.slice(0, 12), kind, base, defenders, assaults, maxDelivered, captured, minStackDist, revealed, revealTurn, startT });
}

// ---- PART 2: hold-defender self-play ----
const TOUGH = 8;
const sp = { games: 0, empWins: 0, revealed: 0, converted: 0, assaults: 0, sumFirst: 0, firsts: 0, sumPeak: 0, sumCapTurns: 0, captures: 0, sumRevealTurn: 0 };
for (let i = 0; i < N_GAMES; i++) {
  const seed = 5000 + i; seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: false });
  let s = 0; while (G.phase === 'Setup' && s++ < 100) { if (!aiStep(G, G.currentPlayer)) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!aiStep(G, o)) { phases.setupAutoFill(G, 'Rebel'); phases.setupAutoFill(G, 'Empire'); } } }
  stripRM(G); // never relocates — the base holds like a human's
  let revealedAt = null, fortified = false, firstDone = false, inCombat = false, peak = 0, st = 0;
  while (!G.isGameOver && st < 200000) {
    const base = G.rebelBaseSystemId;
    if (G.rebelBaseRevealed && !fortified) { fortify(G, base, TOUGH, i); fortified = true; revealedAt = G.timeMarker; }
    if (G.rebelBaseRevealed) peak = Math.max(peak, groundAt(G, base));
    const pc = G.pendingCombat;
    if (pc && !inCombat && pc.attackerSide === 'Empire' && pc.systemId === base && G.rebelBaseRevealed) {
      sp.assaults++;
      if (!firstDone) { firstDone = true; sp.sumFirst += groundAt(G, base); sp.firsts++; }
    }
    inCombat = !!pc;
    const sd = G.currentPlayer; if (aiStep(G, sd)) { st++; continue; }
    const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (aiStep(G, o)) { st++; continue; } break;
  }
  if (!G.isGameOver && G.timeMarker > 16) G.isGameOver = true;
  sp.games++;
  const win = G.winner === 'Empire'; if (win) sp.empWins++;
  if (revealedAt != null) {
    sp.revealed++; sp.sumPeak += peak; sp.sumRevealTurn += revealedAt;
    if (win) { sp.converted++; sp.captures++; sp.sumCapTurns += Math.max(0, G.timeMarker - revealedAt); }
  }
}

console.log('RESULT ' + JSON.stringify({ replays, sp }));
