// Unit tests for the strength harness win-rate math (Wilson interval + gate).
// Run: node scripts/test-winrate-math.mjs
import { wilsonInterval, gate } from './ai-strength/lib/winrate.mjs';
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

console.log('[ Wilson interval — hand-checked values (z=1.96) ]');
{
  // 50/100: symmetric case. center=0.5, half=0.0962 → (0.4038, 0.5962).
  const ci = wilsonInterval(50, 100);
  check('50/100 p', near(ci.p, 0.5), String(ci.p));
  check('50/100 lo ≈ 0.4038', near(ci.lo, 0.4038), String(ci.lo));
  check('50/100 hi ≈ 0.5962', near(ci.hi, 0.5962), String(ci.hi));
}
{
  // 8/10: small-n asymmetric case, textbook Wilson ≈ (0.4902, 0.9433).
  const ci = wilsonInterval(8, 10);
  check('8/10 lo ≈ 0.4902', near(ci.lo, 0.4902), String(ci.lo));
  check('8/10 hi ≈ 0.9433', near(ci.hi, 0.9433), String(ci.hi));
}
{
  // Extremes stay in [0,1] and don't NaN.
  const c0 = wilsonInterval(0, 50), c1 = wilsonInterval(50, 50);
  check('0/50 lo = 0', c0.lo === 0, String(c0.lo));
  check('0/50 hi > 0 (never claims certainty)', c0.hi > 0 && c0.hi < 0.15, String(c0.hi));
  check('50/50 hi = 1', c1.hi === 1, String(c1.hi));
  check('50/50 lo < 1 (never claims certainty)', c1.lo < 1 && c1.lo > 0.9, String(c1.lo));
  check('0 games → all zeros', JSON.stringify(wilsonInterval(3, 0)) === JSON.stringify({ p: 0, lo: 0, hi: 0 }));
}

console.log('\n[ interval behaviour ]');
{
  const small = wilsonInterval(90, 100), big = wilsonInterval(900, 1000);
  check('same p-hat, larger n → narrower interval', (big.hi - big.lo) < (small.hi - small.lo));
  check('interval contains p-hat', small.lo <= small.p && small.p <= small.hi);
}

console.log('\n[ gate: decides on the LOWER bound, not the point estimate ]');
{
  // 90% observed over 30 games: point estimate clears 0.85 but the interval
  // does not — the gate must FAIL (that is its whole reason to exist).
  const g1 = gate(27, 30, 0.85);
  check('27/30 vs 0.85: point above, lower bound below → FAIL', g1.p >= 0.85 && !g1.pass, JSON.stringify(g1));
  // Same rate over 300 games: now the evidence is real → PASS.
  const g2 = gate(270, 300, 0.85);
  check('270/300 vs 0.85 → PASS', g2.pass, JSON.stringify(g2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
