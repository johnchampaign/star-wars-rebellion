// Self-play batch runner (Feature 1.1) — plays N complete AI-vs-AI games and
// writes ONE JSONL record per game (schema selfplay-v1, see lib/schema.mjs).
//
// Usage:
//   node scripts/selfplay/run-batch.mjs [--games 1000] [--seed 1] [--shards 4]
//        [--rebel heuristic|depth2|mcts|random] [--empire heuristic|depth2|mcts|random]
//        [--out analytics-out/<run-id>/games.jsonl]
//
// Parallelism: the parent spawns --shards child processes of THIS script with
// disjoint seed ranges (child mode: --shard-out <file>), then concatenates.
// Seeds are absolute (seed + game index), so the same --seed/--games always
// reproduces the same set of games regardless of shard count.
//
// NOTE ON POLICIES: heuristic-vs-heuristic runs ~0.1-0.2s/game. 'mcts' and
// 'depth2' cost 1-2s PER DECISION — N=1000 with those is HOURS; the runner
// warns and expects a much smaller --games.
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildRecord } from './lib/schema.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..', '..');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const GAMES = parseInt(flag('--games', '1000'), 10);
const SEED = parseInt(flag('--seed', '1'), 10);
const SHARDS = Math.max(1, parseInt(flag('--shards', '4'), 10));
const REBEL = flag('--rebel', 'heuristic');
const EMPIRE = flag('--empire', 'heuristic');
const SHARD_OUT = flag('--shard-out', null);
const SHARD_FROM = parseInt(flag('--shard-from', '0'), 10);
const SHARD_N = parseInt(flag('--shard-n', '0'), 10);

async function runGames(from, n, outFile) {
  const { playGame } = await import('./lib/playGame.mjs');
  const { computeDims } = await import('./lib/dims-rebellion.mjs');
  writeFileSync(outFile, '');
  for (let i = 0; i < n; i++) {
    const seed = SEED + from + i;
    const g = await playGame({ seed, rebel: REBEL, empire: EMPIRE });
    const rec = buildRecord({
      game: 'rebellion',
      seed,
      policies: { Rebel: REBEL, Empire: EMPIRE },
      winner: g.winner,
      winReason: g.winReason,
      rounds: g.rounds,
      durationMs: g.durationMs,
      actions: g.actions,
      snapshots: g.snapshots,
      dims: computeDims(g),
    });
    appendFileSync(outFile, JSON.stringify(rec) + '\n');
    if ((i + 1) % 25 === 0) console.log(`  [shard @${from}] ${i + 1}/${n}`);
  }
}

if (SHARD_OUT) {
  // ---- child mode ----
  await runGames(SHARD_FROM, SHARD_N, SHARD_OUT);
  process.exit(0);
}

// ---- parent mode ----
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = flag('--out', join(ROOT, 'analytics-out', `run-${ts}`, 'games.jsonl'));
mkdirSync(dirname(outFile), { recursive: true });

if ((REBEL === 'mcts' || REBEL === 'depth2' || EMPIRE === 'mcts' || EMPIRE === 'depth2') && GAMES > 50) {
  console.warn(`WARNING: search policies cost 1-2s/decision; ${GAMES} games will take hours. Consider --games 20.`);
}

const per = Math.ceil(GAMES / SHARDS);
const children = [];
let from = 0;
for (let s = 0; s < SHARDS && from < GAMES; s++) {
  const n = Math.min(per, GAMES - from);
  const shardFile = outFile + `.shard${s}`;
  // Run shards with the browser-default feature set (planner + hunt are
  // default-ON in production but default-OFF in node) so the analytics mine
  // the AI players actually face. Override per-run via the environment.
  const child = spawn(process.execPath, [
    SELF, '--shard-out', shardFile, '--shard-from', String(from), '--shard-n', String(n),
    '--seed', String(SEED), '--rebel', REBEL, '--empire', EMPIRE,
  ], { stdio: 'inherit', cwd: ROOT, env: { SWR_EMPIRE_PLANNER: '1', SWR_HUNT_OCCUPY: '1', ...process.env } });
  children.push({ child, shardFile, n });
  from += n;
}
console.log(`self-play batch: ${GAMES} games (${REBEL} vs ${EMPIRE}), seed ${SEED}, ${children.length} shards -> ${outFile}`);

const codes = await Promise.all(children.map(({ child }) =>
  new Promise((resolve) => child.on('exit', resolve))));
if (codes.some((c) => c !== 0)) {
  console.error('one or more shards failed:', codes);
  process.exit(1);
}
let total = 0;
writeFileSync(outFile, '');
for (const { shardFile } of children) {
  const text = readFileSync(shardFile, 'utf8');
  appendFileSync(outFile, text);
  total += text.split('\n').filter((l) => l.trim()).length;
}
console.log(`done: ${total} records in ${outFile}`);
