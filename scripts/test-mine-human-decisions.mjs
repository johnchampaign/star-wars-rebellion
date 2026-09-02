// @timeout 300000
// Tripwire for the step-1 imitation pipeline: the exact-state replayer
// (scripts/mine-human-decisions.mjs) must keep reaching the Command phase from
// archived turn-start snapshots, and the coverage instrument
// (scripts/eval-candidate-coverage.mjs) must keep reading its output.
//
// The replayer answers every Refresh/Assignment choice the engine posts with
// the recorded resolution (deploy, build, recruit, ring, hand-trim, pool cap,
// assignment incl. the #76 undo and action-card plays). Any engine change that
// renames one of those events, reorders the Refresh steps, or alters a
// resolver's contract silently breaks the dataset — this catches it.
//
// Needs logs/ (gitignored, present on the dev machine). Skips cleanly if absent.
// Run: node scripts/test-mine-human-decisions.mjs
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const logsDir = join(ROOT, 'logs');
const haveLogs = existsSync(logsDir) && readdirSync(logsDir).some((f) => f.endsWith('.json'));
if (!haveLogs) { console.log('  (skip) no logs/ on this machine'); process.exit(0); }

const tmp = mkdtempSync(join(tmpdir(), 'mine-'));
const out = join(tmp, 'hd.jsonl');
console.log('[ the replayer reaches the Command phase on real archived rounds ]');
const r = spawnSync(process.execPath, [join(ROOT, 'scripts/mine-human-decisions.mjs'), '--limit', '12', '--out', out], { cwd: ROOT, encoding: 'utf8' });
check('miner ran', r.status === 0, (r.stderr || r.stdout).slice(-400));
const m = /replayed to Command: exact (\d+) approx (\d+) failed (\d+)/.exec(r.stdout) || [];
const exact = Number(m[1] || 0), approx = Number(m[2] || 0), failed = Number(m[3] || 0);
console.log(`    exact ${exact} approx ${approx} failed ${failed}`);
check('most rounds replay EXACTLY (>= 70% of attempted)', exact / Math.max(1, exact + approx + failed) >= 0.7);
check('at least one sample was written', existsSync(out) && readFileSync(out, 'utf8').trim().length > 0);
const rows = existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
check('samples carry state + human action + candidates + matchIndex',
  rows.length > 0 && rows.every((x) => typeof x.state === 'string' && x.humanAction?.kind && Array.isArray(x.candidates) && typeof x.matchIndex === 'number'));

console.log('[ the coverage instrument reads it ]');
const e = spawnSync(process.execPath, [join(ROOT, 'scripts/eval-candidate-coverage.mjs'), out], { cwd: ROOT, encoding: 'utf8' });
check('instrument ran', e.status === 0, (e.stderr || e.stdout).slice(-300));
check('and reports an ALL row with a coverage percentage', /^ALL\s+\d+\s+\d+%/m.test(e.stdout), e.stdout.slice(0, 200));
rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
