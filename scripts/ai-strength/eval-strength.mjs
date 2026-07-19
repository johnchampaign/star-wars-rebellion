// AI strength regression harness (Feature 2).
//
// Pits the current AI against a random-legal-move baseline, per side (this
// game is two ASYMMETRIC seats, so strength is measured as BOTH "our Rebel
// beats a random Empire" AND "our Empire beats a random Rebel"), reports
// Wilson 95% CIs, appends to a dated history file, prints the trend, and
// exits non-zero if either side's CI LOWER BOUND falls under the threshold —
// so it can gate CI or the daily routine with a single command.
//
// Usage:
//   node scripts/ai-strength/eval-strength.mjs [--games 200] [--seed 1]
//        [--min-winrate 0.85] [--shards 4]
//        [--rebel heuristic|depth2|mcts] [--empire heuristic|depth2|mcts]
//        [--history benchmarks/ai-strength-history.jsonl] [--dry]
//
// DEFAULT POLICIES ARE THE FAST ONES (heuristic both sides): a gate must be
// runnable in minutes. The production search policies (depth2/mcts) cost
// 1-2s per DECISION — use --games 20 with those, and expect ~30+ min.
// '--frozen <commit>' is reserved for a future git-worktree arm; it errors
// clearly today rather than pretending.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { gate, fmtCI, wilsonInterval } from './lib/winrate.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..', '..');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
if (argv.includes('--frozen') || flag('--frozen', null)) {
  console.error('--frozen <commit> is not implemented yet (needs a git-worktree arm). Run without it.');
  process.exit(2);
}
const GAMES = parseInt(flag('--games', '200'), 10);
const SEED = parseInt(flag('--seed', '1'), 10);
// Per-side thresholds. The two seats have DIFFERENT natural levels vs random:
// the Rebel wins on the reputation clock unless actively beaten (~80-90%), but
// the Empire must FIND the hidden base inside 16 rounds — vs random that is
// bottlenecked by its own hunt, ~35% for the fast heuristic. So the gate
// defaults are regression tripwires set just under the CALIBRATED current
// levels (see benchmarks/ai-strength-history.jsonl), not absolute standards.
// --min-winrate sets both; --min-rebel/--min-empire override individually.
const MIN_BOTH = flag('--min-winrate', null);
const MIN_REBEL = parseFloat(flag('--min-rebel', MIN_BOTH ?? '0.70'));
const MIN_EMPIRE = parseFloat(flag('--min-empire', MIN_BOTH ?? '0.22'));
const SHARDS = Math.max(1, parseInt(flag('--shards', '4'), 10));
const REBEL_POLICY = flag('--rebel', 'heuristic');
const EMPIRE_POLICY = flag('--empire', 'heuristic');
const HISTORY = flag('--history', join(ROOT, 'benchmarks', 'ai-strength-history.jsonl'));
const DRY = argv.includes('--dry'); // skip history append (for tests/smoke)

// ---- child mode: play a seed range for one matchup, print one JSON line ----
const CHILD = flag('--child', null); // 'rebel' | 'empire' = which seat OUR AI plays
if (CHILD) {
  const from = parseInt(flag('--from', '0'), 10);
  const n = parseInt(flag('--n', '0'), 10);
  const { playGame } = await import('../selfplay/lib/playGame.mjs');
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const seed = SEED + from + i;
    const cfg = CHILD === 'rebel'
      ? { seed, rebel: REBEL_POLICY, empire: 'random', collect: false }
      : { seed, rebel: 'random', empire: EMPIRE_POLICY, collect: false };
    const g = await playGame(cfg);
    const ourSide = CHILD === 'rebel' ? 'Rebel' : 'Empire';
    if (g.winner === ourSide) wins++;
  }
  console.log(JSON.stringify({ child: CHILD, from, n, wins }));
  process.exit(0);
}

// ---- parent mode ----
const perSide = Math.floor(GAMES / 2);
console.log(`AI strength eval: ${GAMES} games (${perSide}/side) vs random baseline, seed ${SEED}`);
console.log(`  our Rebel:  ${REBEL_POLICY}   our Empire: ${EMPIRE_POLICY}   gate: CI lower bound >= ${MIN_REBEL} (rebel) / ${MIN_EMPIRE} (empire)`);

async function runSide(which) {
  const per = Math.ceil(perSide / SHARDS);
  const children = [];
  let from = 0;
  for (let s = 0; s < SHARDS && from < perSide; s++) {
    const n = Math.min(per, perSide - from);
    children.push({
      n,
      promise: new Promise((resolve, reject) => {
        // PRODUCTION FEATURE ENVS: the planner and occupy-to-clear hunt are
        // default-ON in the browser but default-OFF in node — without these
        // the gate measures a configuration nobody ships (first smoke run:
        // Empire 35% vs random, purely from the missing features). They're
        // process-wide, so the random seat's non-Command machinery (deploys)
        // sees them too — acceptable: random overrides all Command decisions.
        const child = spawn(process.execPath, [
          SELF, '--child', which, '--from', String(from), '--n', String(n),
          '--seed', String(SEED), '--rebel', REBEL_POLICY, '--empire', EMPIRE_POLICY,
        ], { cwd: ROOT, env: { SWR_EMPIRE_PLANNER: '1', SWR_HUNT_OCCUPY: '1', ...process.env } });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.pipe(process.stderr);
        child.on('exit', (code) => {
          if (code !== 0) return reject(new Error(`${which} shard exited ${code}`));
          const line = out.trim().split('\n').pop();
          try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
        });
      }),
    });
    from += n;
  }
  const results = await Promise.all(children.map((c) => c.promise));
  return results.reduce((a, r) => a + r.wins, 0);
}

const t0 = Date.now();
const [rebelWins, empireWins] = await Promise.all([runSide('rebel'), runSide('empire')]);
const rebelGate = gate(rebelWins, perSide, MIN_REBEL);
const empireGate = gate(empireWins, perSide, MIN_EMPIRE);
const elapsed = Math.round((Date.now() - t0) / 1000);

console.log('');
console.log(`  Rebel  vs random Empire: ${rebelWins}/${perSide} = ${fmtCI(rebelGate)}  ${rebelGate.pass ? 'PASS' : 'FAIL'}`);
console.log(`  Empire vs random Rebel:  ${empireWins}/${perSide} = ${fmtCI(empireGate)}  ${empireGate.pass ? 'PASS' : 'FAIL'}`);
console.log(`  (${elapsed}s)`);

// ---- history + trend ----
const entry = {
  at: new Date().toISOString(),
  seed: SEED, games: GAMES,
  policies: { rebel: REBEL_POLICY, empire: EMPIRE_POLICY },
  rebel: { wins: rebelWins, n: perSide, ...wilsonInterval(rebelWins, perSide) },
  empire: { wins: empireWins, n: perSide, ...wilsonInterval(empireWins, perSide) },
  minWinrate: { rebel: MIN_REBEL, empire: MIN_EMPIRE },
  pass: rebelGate.pass && empireGate.pass,
};
if (!DRY) {
  mkdirSync(dirname(HISTORY), { recursive: true });
  appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
  const lines = readFileSync(HISTORY, 'utf8').split('\n').filter((l) => l.trim());
  const last = lines.slice(-5).map((l) => JSON.parse(l));
  console.log('\ntrend (last ' + last.length + ' runs):');
  for (const h of last) {
    const d = h.at.slice(0, 10);
    console.log(`  ${d}  rebel ${(100 * h.rebel.p).toFixed(1)}%  empire ${(100 * h.empire.p).toFixed(1)}%  ` +
      `(${h.policies.rebel}/${h.policies.empire}, n=${h.games}) ${h.pass ? '' : ' FAIL'}`);
  }
  if (last.length >= 2) {
    const prev = last[last.length - 2], cur = last[last.length - 1];
    const dr = (100 * (cur.rebel.p - prev.rebel.p)).toFixed(1);
    const de = (100 * (cur.empire.p - prev.empire.p)).toFixed(1);
    console.log(`  delta vs previous run: rebel ${dr >= 0 ? '+' : ''}${dr}pt, empire ${de >= 0 ? '+' : ''}${de}pt`);
  }
}

process.exit(entry.pass ? 0 : 1);
