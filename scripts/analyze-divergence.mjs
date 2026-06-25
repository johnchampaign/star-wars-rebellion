// Divergence miner: where does the AI play differently from the human?
//
// For each side, it builds a strategic "fingerprint" of per-game behaviour and
// contrasts the HUMAN distribution (from the uploaded play logs, for the side the
// human controlled) against the AI distribution (from fresh self-play), using the
// SAME extractor so the comparison is apples-to-apples. It then ranks metrics by
// how far apart the two are — that ranked list is the decision-useful output.
//
// This reads turnLogs directly (no replay), so it's robust to engine drift across
// the log corpus's history. Deeper per-decision divergence is a separate v2.
//
// Usage: node scripts/analyze-divergence.mjs [aiGames]
import { readFileSync, readdirSync } from 'node:fs';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { decode } = await import('../src/engine/codec.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(new URL('../assets/' + p, import.meta.url), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1 }).catalog;

const AI_GAMES = parseInt(process.argv[2] ?? '120', 10);
const CAPTURE_MISSIONS = new Set(['detained', 'collect-bounty']);

// ---- The strategic fingerprint for one side, from a finished game's turnLog ----
// Returns per-game metric values (the side is the one we're profiling).
function fingerprint(turnLog, side, won) {
  const other = side === 'Empire' ? 'Rebel' : 'Empire';
  let activations = 0, leaderOnlyActs = 0, missionsRevealed = 0, passes = 0, assigns = 0, skips = 0;
  let subjugations = 0, captures = 0, captureMissionReveals = 0, probesDrawn = 0;
  let repGains = 0, relocations = 0, baseRevealed = false, baseFoundTurn = null;
  let combatsStarted = 0, baseAssaults = 0, recruits = 0;
  let rebelBaseSys = null, rounds = 1;
  for (const e of turnLog) {
    if (typeof e.turn === 'number') rounds = Math.max(rounds, e.turn);
    if (e.kind === 'setup' && e.payload?.baseSystem) rebelBaseSys = e.payload.baseSystem;
    else if (e.kind === 'reveal-base') { baseRevealed = true; if (baseFoundTurn == null) baseFoundTurn = e.turn; }
  }
  for (const e of turnLog) {
    switch (e.kind) {
      case 'activate-system': if (e.side === side) { activations++; if ((e.payload?.orders ?? 0) === 0) leaderOnlyActs++; } break;
      case 'reveal-mission':
        if (e.side === side) { missionsRevealed++; if (CAPTURE_MISSIONS.has(e.payload?.missionId)) captureMissionReveals++; }
        break;
      case 'pass': if (e.side === side) passes++; break;
      case 'assign-leader': if (e.side === side) assigns++; break;
      case 'skip-assignment': if (e.side === side) skips++; break;
      case 'subjugated': if (side === 'Empire') subjugations++; break;
      case 'capture-leader': if (side === 'Empire') captures++; break;
      case 'draw-probe': if (side === 'Empire') probesDrawn++; break;
      case 'gain-reputation': if (side === 'Rebel') repGains++; break;
      case 'recruit-leader': if (e.side === side) recruits++; break;
      case 'establish-base': case 'relocate-base': case 'rapid-mobilization-base-applied':
        if (side === 'Rebel') relocations++; break;
      case 'combat-begin':
        if (e.payload?.attackerSide === side) {
          combatsStarted++;
          if (rebelBaseSys && e.payload?.systemId === rebelBaseSys && side === 'Empire') baseAssaults++;
        }
        break;
    }
  }
  const r = Math.max(1, rounds);
  // Per-round rates strip out the game-length confound (the human wins faster as
  // Empire, so per-game totals understate their activity).
  const m = { rounds, won: won ? 1 : 0,
    'activations/rd': activations / r, 'missions/rd': missionsRevealed / r,
    'assigns/rd': assigns / r, 'passes/rd': passes / r, 'skips/rd': skips / r,
    recruits, combatsStarted };
  if (side === 'Empire') Object.assign(m, {
    subjugations, captures, captureMissionReveals, 'probes/rd': probesDrawn / r,
    baseAssaults, baseFound: baseRevealed ? 1 : 0,
    // The headline efficiency metric: probes spent per base actually found.
    probesPerFind: baseRevealed ? probesDrawn / 1 : null,
  });
  else Object.assign(m, { 'repGains/rd': repGains / r, repGains, relocations });
  return m;
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const std = (xs) => { const mu = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - mu) ** 2))); };

// ---- Collect HUMAN fingerprints from the logs, split by controlled side ----
const humanByside = { Empire: [], Rebel: [] };
let decoded = 0, skippedUnknown = 0;
for (const f of readdirSync(new URL('../logs', import.meta.url)).filter((x) => x.endsWith('.json'))) {
  let g;
  try { g = JSON.parse(readFileSync(new URL('../logs/' + f, import.meta.url), 'utf8')).game; } catch { continue; }
  const side = g.humanSide;
  if (side !== 'Empire' && side !== 'Rebel') { skippedUnknown++; continue; }
  let G;
  try { G = decode(g.codec, catalog); } catch { continue; }
  if (!Array.isArray(G.turnLog)) continue;
  decoded++;
  humanByside[side].push(fingerprint(G.turnLog, side, g.winner === side));
}

// ---- Collect AI fingerprints from fresh self-play (both sides are AI) ----
const aiByside = { Empire: [], Rebel: [] };
for (let i = 0; i < AI_GAMES; i++) {
  const seed = 5000 + i; seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: false });
  let s = 0;
  while (G.phase === 'Setup' && s++ < 100) { if (!aiStep(G, G.currentPlayer)) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!aiStep(G, o)) { phases.setupAutoFill(G, 'Rebel'); phases.setupAutoFill(G, 'Empire'); } } }
  let st = 0;
  while (!G.isGameOver && st < 200000) { const sd = G.currentPlayer; if (aiStep(G, sd)) { st++; continue; } const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (aiStep(G, o)) { st++; continue; } break; }
  if (!G.isGameOver && G.timeMarker > 16) { G.isGameOver = true; }
  aiByside.Empire.push(fingerprint(G.turnLog, 'Empire', G.winner === 'Empire'));
  aiByside.Rebel.push(fingerprint(G.turnLog, 'Rebel', G.winner === 'Rebel'));
}

// ---- Report: ranked divergence per side ----
function report(side) {
  const H = humanByside[side], A = aiByside[side];
  if (H.length === 0) { console.log(`\n(no human ${side} logs)`); return; }
  const keys = Object.keys(H[0]);
  const rows = keys.map((k) => {
    // Drop nulls (e.g. probesPerFind only exists when the base was found).
    const hv = H.map((m) => m[k]).filter((x) => x != null);
    const av = A.map((m) => m[k]).filter((x) => x != null);
    const hm = mean(hv), am = mean(av);
    const pooledSd = Math.max(1e-6, (std(hv) + std(av)) / 2);
    const z = Math.abs(hm - am) / pooledSd; // standardized gap
    return { k, hm, am, diff: hm - am, z };
  }).sort((a, b) => b.z - a.z);
  console.log(`\n========== ${side}  (human n=${H.length}, AI self-play n=${A.length}) ==========`);
  console.log(`  human win-rate as ${side}: ${(100 * mean(H.map((m) => m.won))).toFixed(0)}%   |   AI: ${(100 * mean(A.map((m) => m.won))).toFixed(0)}%`);
  console.log(`  ${'metric'.padEnd(22)} ${'HUMAN'.padStart(8)} ${'AI'.padStart(8)} ${'gap'.padStart(8)}   divergence`);
  for (const r of rows) {
    if (r.k === 'won') continue;
    const bar = '#'.repeat(Math.min(30, Math.round(r.z * 6)));
    console.log(`  ${r.k.padEnd(22)} ${r.hm.toFixed(1).padStart(8)} ${r.am.toFixed(1).padStart(8)} ${(r.diff >= 0 ? '+' : '') + r.diff.toFixed(1)}`.padEnd(52) + `  ${r.z.toFixed(2)}σ ${bar}`);
  }
}

console.log(`Divergence analysis — decoded ${decoded} human logs (${skippedUnknown} skipped: humanSide unknown), ${AI_GAMES} AI self-play games.`);
report('Empire');
report('Rebel');
console.log(`\nBiggest σ = where the AI's play diverges most from yours. Positive gap = you do MORE of it than the AI.`);
