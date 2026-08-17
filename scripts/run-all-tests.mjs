#!/usr/bin/env node
// run-all-tests.mjs — run every scripts/test-*.mjs and report a tally.
//
// 189 of these exist, each written to pin a specific fixed bug, and until now
// only two were reachable from package.json with no CI behind them. A pinned bug
// nobody re-runs is not pinned: #506 sat "probably already fixed" for three weeks
// while its own dedicated test passed 24/24 on every build in between.
//
// Skips test-ai-worker-admin.mjs (the only one that talks to the network).
//
// Run: npm test            (all)
//      npm test -- --list  (just show what would run)
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['test-ai-worker-admin.mjs']); // hits the live admin API
const TIMEOUT_MS = 180_000;

const files = readdirSync(join(ROOT, 'scripts'))
  .filter((f) => /^test-.*\.mjs$/.test(f) && !SKIP.has(f))
  .sort();

if (process.argv.includes('--list')) {
  for (const f of files) console.log(f);
  console.log(`\n${files.length} test scripts (${SKIP.size} skipped)`);
  process.exit(0);
}

const pass = [], fail = [], timeout = [];
const t0 = Date.now();

// A test that legitimately drives real MCTS games (the harness-arm tripwire)
// can't fit the default budget and shouldn't force it up for everyone. It
// declares its own in a header line: `// @timeout 480000`. Kept next to the
// reason in the file, not in an allowlist here that would drift.
const budgetFor = (f) => {
  const m = readFileSync(join(ROOT, 'scripts', f), 'utf-8').slice(0, 4000).match(/^\/\/\s*@timeout\s+(\d+)/m);
  return m ? Number(m[1]) : TIMEOUT_MS;
};

for (const [i, f] of files.entries()) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', f)], {
    cwd: ROOT, timeout: budgetFor(f), encoding: 'utf-8',
  });
  const label = `[${String(i + 1).padStart(3)}/${files.length}] ${f}`;
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') {
    timeout.push(f); console.log(`${label}  TIMEOUT`);
  } else if (r.status === 0) {
    pass.push(f); console.log(`${label}  ok`);
  } else {
    // Keep the last few lines — enough to tell a real assertion failure from a
    // script that needs an argument or a fixture that no longer exists.
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-3).join(' | ');
    fail.push({ f, status: r.status, out });
    console.log(`${label}  FAIL (exit ${r.status})  ${out.slice(0, 160)}`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n=== ${pass.length} passed, ${fail.length} failed, ${timeout.length} timed out, in ${secs}s ===`);
if (fail.length) {
  console.log('\nfailures:');
  for (const { f, status, out } of fail) console.log(`  ${f} (exit ${status})\n      ${out.slice(0, 220)}`);
}
if (timeout.length) console.log(`\ntimeouts:\n${timeout.map((f) => '  ' + f).join('\n')}`);
process.exit(fail.length || timeout.length ? 1 : 0);
