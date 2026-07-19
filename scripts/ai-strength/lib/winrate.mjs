// Win-rate statistics for the AI strength harness. Kept as a tiny pure module
// so the math is unit-testable (scripts/test-winrate-math.mjs).

/** Wilson score interval for a binomial proportion. Returns { p, lo, hi }.
 *  Preferred over the normal approximation because it behaves sanely at
 *  p-hat near 0/1 and small n — exactly the regimes a strength gate sees. */
export function wilsonInterval(wins, games, z = 1.96) {
  if (games <= 0) return { p: 0, lo: 0, hi: 0 };
  const p = wins / games;
  const z2 = z * z;
  const denom = 1 + z2 / games;
  const center = (p + z2 / (2 * games)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / games + z2 / (4 * games * games))) / denom;
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** Gate decision: pass iff the CI LOWER BOUND clears the threshold — a point
 *  estimate above threshold with a straddling interval is a coin-flip, not
 *  evidence. */
export function gate(wins, games, minWinrate, z = 1.96) {
  const ci = wilsonInterval(wins, games, z);
  return { ...ci, minWinrate, pass: ci.lo >= minWinrate };
}

/** Format a CI for humans: "94.0% [89.9, 96.6]". */
export function fmtCI(ci) {
  const pct = (x) => (100 * x).toFixed(1);
  return `${pct(ci.p)}% [${pct(ci.lo)}, ${pct(ci.hi)}]`;
}
