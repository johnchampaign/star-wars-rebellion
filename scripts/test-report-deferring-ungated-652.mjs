// #651/#652 — "Every time I win a ground battle in a sabotaged system the game
// freezes." A MUTUAL-BLOCK deadlock between two guards that were each correct
// on their own.
//
// PlayTab has two independent mechanisms:
//   1. REPORT_DEFERRING_CHOICES — a queued combat/mission report steps aside
//      while one of these choices is pending, so the report can't render on top
//      of a required prompt (#473/#472/#410/#412/#477).
//   2. Per-modal report gates — several pickers only render when no report is
//      queued, so they don't appear underneath one.
//
// Applying BOTH to the same choice kind deadlocks: the report waits for the
// choice, the choice waits for the report, and NOTHING renders. That is exactly
// what happened when 'Choice' was added to REPORT_DEFERRING_CHOICES while the
// generic modal kept its own report gate. Seize Control raises its
// marker choice from finishCombatTail — the precise moment a combat report is
// queued — so winning a battle in a sabotaged system froze the game outright.
//
// Every OTHER entry in the list has always rendered unconditionally, which is
// why none of them ever showed this. This tripwire enforces that invariant on
// the source: a kind may be report-deferring, or report-gated, never both.
//
// Run: node scripts/test-report-deferring-ungated-652.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
const lines = src.split('\n');
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ #652 — a report-deferring choice must not ALSO be report-gated ]');

// Pull the live list out of the source so the test can never drift from it.
const listBlock = /const REPORT_DEFERRING_CHOICES = \[([\s\S]*?)\];/.exec(src);
check('found REPORT_DEFERRING_CHOICES in PlayTab', !!listBlock);
if (!listBlock) { console.log('\n0 passed, 1 failed'); process.exit(1); }
const kinds = [...listBlock[1].matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]);
check(`it lists ${kinds.length} choice kinds`, kinds.length > 0);

const GATE = /(missionReports|combatReports)[\s\S]{0,40}?length === 0/;
const offenders = [];
for (const kind of kinds) {
  // Find RENDER sites (a JSX condition), not the ownership switch (`case '…':`).
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(`G.pendingChoice?.kind === '${kind}'`)) continue;
    // Walk back to the start of this JSX expression — the line opening with `{`
    // at the same indent — collecting the condition text.
    let start = i;
    for (let k = i; k >= 0 && i - k < 8; k--) {
      if (/^\s*\{/.test(lines[k])) { start = k; break; }
    }
    const condition = lines.slice(start, i + 1).join('\n');
    if (GATE.test(condition)) offenders.push(`${kind} (PlayTab.tsx:${start + 1})`);
  }
}
check('no report-deferring choice carries a report gate on its own modal',
  offenders.length === 0,
  `these would deadlock — the report waits for the choice and the choice waits for the report: ${offenders.join(', ')}`);

// And specifically the one that bit: the generic Choice modal.
const genericRender = lines.findIndex((l) => l.includes("G.pendingChoice?.kind === 'Choice'")
  && !l.includes('case'));
check('the generic Choice modal render site exists', genericRender >= 0);
if (genericRender >= 0) {
  const before = lines.slice(Math.max(0, genericRender - 6), genericRender + 1).join('\n');
  check('and it renders without waiting on a queued report', !GATE.test(before),
    'the generic modal is report-gated again — #652 will come straight back');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
