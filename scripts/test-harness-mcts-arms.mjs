// The MCTS arms of the tournament harness (Rebel AND Empire).
//
// Every "re-test against a stronger opponent" note in docs/ab-levers.md needs
// this arm to be REAL — and the harness has silently measured nothing before:
// it ran the base game by default until 2026-08-06, and `SWR_MCTS=1` alone
// changed nothing (byte-identical results). This test makes those failure
// modes impossible for the Rebel arm specifically:
//
//   1. --rebel-policy mcts actually installs a Command policy for the Rebel
//   2. that policy actually SEARCHES: on the same seed the MCTS Rebel and the
//      heuristic Rebel must diverge (if they don't, the override isn't wired)
//   3. every game log names its policies, so a run can't be mistaken for
//      heuristic self-play after the fact
//   4. --fast-search is honoured and RECORDED as fast, never silently equated
//      with the shipped strength
//
// This drives real (short) games, so it takes ~1–2 min. Kept deliberately
// small: it is a wiring test, not a strength measurement.
//
// @timeout 480000
// (Runner budget override — see run-all-tests.mjs. This file drives five real
// short MCTS games to prove the arms are wired, ~4 min; the default 180 s
// budget is for pure-engine tests. It is the ONE test allowed to be slow.)
//
// Run: node scripts/test-harness-mcts-arms.mjs
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const OUT_H = join(ROOT, 'tournament-logs', '_test-arm-heuristic');
const OUT_M = join(ROOT, 'tournament-logs', '_test-arm-mcts');
for (const d of [OUT_H, OUT_M]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });

// One short game per arm, same seed. --max-rounds 3 keeps this cheap; we only
// need the two arms to make DIFFERENT decisions, not to finish a game.
const run = (out, extra) => spawnSync(process.execPath, [
  join(ROOT, 'scripts', 'tournament.mjs'), '--games', '1', '--seed', '9001', '--expansion',
  '--max-rounds', '3', '--out', out, ...extra,
], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });

console.log('\n[ 1+2. the flag installs a Rebel policy that really searches ]');
const h = run(OUT_H, []);
const m = run(OUT_M, ['--rebel-policy', 'mcts', '--fast-search']);
check('heuristic arm ran', h.status === 0, (h.stderr || h.stdout).slice(-300));
check('mcts arm ran', m.status === 0, (m.stderr || m.stdout).slice(-300));
check('the harness reports the Rebel policy as mcts', /policies: Rebel=mcts/.test(m.stdout), m.stdout.slice(0, 200));
check('and labels the fast-search profile as NOT the shipped strength', /fast-search.*NOT the shipped strength/.test(m.stdout));
check('the heuristic arm is labelled heuristic', !/policies:/.test(h.stdout) || /Rebel=heuristic/.test(h.stdout));

const gh = JSON.parse(readFileSync(join(OUT_H, 'game-0001.json'), 'utf8'));
const gm = JSON.parse(readFileSync(join(OUT_M, 'game-0001.json'), 'utf8'));
// Divergence: the Rebel's Command-phase decisions must differ somewhere. Compare
// the sequence of Rebel command actions (activate/reveal/pass) in order.
const rebelCmds = (g) => (g.log ?? [])
  .filter((e) => e.side === 'Rebel' && ['activate-system', 'reveal-mission', 'pass'].includes(e.kind))
  .map((e) => `${e.kind}:${e.payload?.targetSystemId ?? e.payload?.missionId ?? ''}`);
const a = rebelCmds(gh), b = rebelCmds(gm);
check('the MCTS Rebel makes at least one different Command decision from the heuristic on the same seed',
  JSON.stringify(a) !== JSON.stringify(b),
  `identical sequences (${a.length} actions) — the override is not wired`);
check('the MCTS arm actually logged ai-decision traces from the search',
  (gm.log ?? []).some((e) => e.kind === 'ai-decision' && e.side === 'Rebel' && e.payload?.policy === 'mcts'),
  'no Rebel ai-decision with policy=mcts');

console.log('\n[ 3+4. every game log names its policies and search profile ]');
check('heuristic game log records policies', gh.policies?.Rebel === 'heuristic' && gh.policies?.Empire === 'heuristic',
  JSON.stringify(gh.policies));
check('mcts game log records Rebel=mcts', gm.policies?.Rebel === 'mcts', JSON.stringify(gm.policies));
check('and records the search profile as fast with the reduced budget',
  gm.policies?.search?.fast === true && gm.policies?.search?.budget === 24 && gm.policies?.search?.horizon === 2,
  JSON.stringify(gm.policies?.search));
check('the heuristic log has no search profile', gh.policies?.search === null, JSON.stringify(gh.policies?.search));

console.log('\n[ the EMPIRE arm gets the same guarantees ]');
{
  // The shipped Empire IS the MCTS Empire (browser default ON), so this arm is
  // the one that measures what players actually face. It also DETERMINIZES the
  // hidden base (samples worlds), which the Rebel arm does not, so its wiring
  // is asserted separately rather than assumed from the Rebel's.
  const OUT_E = join(ROOT, 'tournament-logs', '_test-arm-empire');
  if (existsSync(OUT_E)) rmSync(OUT_E, { recursive: true, force: true });
  const e = run(OUT_E, ['--empire-policy', 'mcts', '--fast-search']);
  check('empire mcts arm ran', e.status === 0, (e.stderr || e.stdout).slice(-300));
  check('the harness reports the Empire policy as mcts', /policies: Rebel=heuristic Empire=mcts/.test(e.stdout), e.stdout.slice(0, 200));
  const ge = JSON.parse(readFileSync(join(OUT_E, 'game-0001.json'), 'utf8'));
  const empCmds = (g) => (g.log ?? [])
    .filter((x) => x.side === 'Empire' && ['activate-system', 'reveal-mission', 'pass'].includes(x.kind))
    .map((x) => `${x.kind}:${x.payload?.targetSystemId ?? x.payload?.missionId ?? ''}`);
  check('the MCTS Empire diverges from the heuristic Empire on the same seed',
    JSON.stringify(empCmds(gh)) !== JSON.stringify(empCmds(ge)), 'identical Empire sequences — override not wired');
  const dec = (ge.log ?? []).filter((x) => x.kind === 'ai-decision' && x.side === 'Empire' && x.payload?.policy === 'mcts');
  check('the Empire search logs policy=mcts decision traces', dec.length > 0);
  check('and those traces show DETERMINIZATION (worlds > 1) — the Empire samples the hidden base',
    dec.some((x) => (x.payload?.search?.worlds ?? 0) > 1), JSON.stringify(dec[0]?.payload?.search));
  check('the game log records Empire=mcts with the fast profile',
    ge.policies?.Empire === 'mcts' && ge.policies?.Rebel === 'heuristic' && ge.policies?.search?.fast === true,
    JSON.stringify(ge.policies));
  rmSync(OUT_E, { recursive: true, force: true });
}

console.log('\n[ --realistic: one word for the pairing players actually face ]');
{
  const OUT_R = join(ROOT, 'tournament-logs', '_test-arm-realistic');
  const OUT_R1 = join(ROOT, 'tournament-logs', '_test-arm-realistic-override');
  for (const d of [OUT_R, OUT_R1]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  // NOTE: no --expansion passed — the preset must turn it on itself.
  const r = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'tournament.mjs'), '--games', '1', '--seed', '9001',
    '--max-rounds', '3', '--out', OUT_R, '--realistic',
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
  check('realistic run completed', r.status === 0, (r.stderr || r.stdout).slice(-300));
  check('summary shows BOTH sides mcts, fast-search, and the preset name',
    /policies: Rebel=mcts Empire=mcts .*fast-search.*\[--realistic preset\]/.test(r.stdout), r.stdout.slice(0, 260));
  check('the preset turned Rise of the Empire on by itself', /mode: Rise of the Empire/.test(r.stdout));
  const gr = JSON.parse(readFileSync(join(OUT_R, 'game-0001.json'), 'utf8'));
  check('the game log records both policies, fast, AND realistic=true',
    gr.policies?.Rebel === 'mcts' && gr.policies?.Empire === 'mcts' && gr.policies?.search?.fast === true && gr.policies?.realistic === true,
    JSON.stringify(gr.policies));
  // Explicit flags must win, so a one-sided arm is still one word away.
  const r1 = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'tournament.mjs'), '--games', '1', '--seed', '9001',
    '--max-rounds', '3', '--out', OUT_R1, '--realistic', '--empire-policy', 'eval',
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
  check('an explicit --empire-policy overrides the preset\'s Empire choice',
    r1.status === 0 && /policies: Rebel=mcts Empire=eval/.test(r1.stdout), r1.stdout.slice(0, 200));
  for (const d of [OUT_R, OUT_R1]) rmSync(d, { recursive: true, force: true });
}

for (const d of [OUT_H, OUT_M]) rmSync(d, { recursive: true, force: true });
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
