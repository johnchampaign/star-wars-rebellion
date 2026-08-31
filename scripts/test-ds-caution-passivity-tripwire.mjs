// @timeout 300000
// The regression guard that let SWR_DS_CAUTION ship (#701, John's option b).
//
// Death Star caution (hold the station back instead of sweeping it into Rebel
// reach) sat WORKS, BLOCKED from 2026-08-09 to 2026-08-31 for exactly one
// measured cost: with it enabled, the Empire forfeited the #639 board 8% of
// the time (0% without) — and pass-with-plays is the single most reported
// Empire complaint. On 2026-08-31 that cost re-measured at 0/60 forfeits
// (P ≈ 0.007 against 8%), and the cause of the cure is UNATTRIBUTED — it was
// not the pass floor (SWR_MCTS_PASS_Z=0 still 0/24) and not the subjugation
// re-pricing (SWR_CONVERT_SUBJUGATED=0 still 0/24); it lies somewhere in three
// weeks of engine work. A cost that vanished for unknown reasons can return
// for unknown reasons, so the ship decision was "mechanism numbers + this
// tripwire": if the old passivity interaction ever sneaks back, THIS file goes
// red instead of players re-reporting passing.
//
// It re-runs the #639 forfeit check with the lever pinned ON — independent of
// the shipped default, so it keeps guarding even if the default is later
// flipped. test-passivity-639 continues to cover the default configuration;
// test-death-star-caution-701 pins the caution mechanism itself.
//
// Run: node scripts/test-ds-caution-passivity-tripwire.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Pin ON before any module loads (the lever is read at import time).
process.env.SWR_DS_CAUTION = '1';
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const mcts = await import('../src/play/mctsAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = setup.buildCatalog(data);
const raw = readFileSync(join(ROOT, 'scripts/fixtures/passivity-639.json'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const board = () => {
  const G = codec.decode(raw, catalog);
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Empire');
  G.currentPlayer = 'Empire';
  return G;
};

console.log('[ with Death Star caution ON, the #639 board must still act ]');
{
  const G = board();
  check('the fixture still poses the choice (leaders idle in pool)',
    G.empire.leaderPool.length >= 2, JSON.stringify(G.empire.leaderPool));
  AI.seedAI(1);
  const real = AI.bestCommandAction(G, 'Empire').filter((a) => a.kind !== 'pass');
  check('real actions are available (a pass would be a CHOICE, not forced)', real.length > 0);

  // The historical cost was 8% (2/25). 25 seeds at 0 tolerated forfeits gives
  // P(miss | p=0.08) ≈ 0.12 per run — but this runs on every suite invocation,
  // so a returned regression is caught within a few runs at worst, and the
  // 2026-08-31 measurement at 60 seeds anchors the baseline.
  const SEEDS = 25;
  let forfeits = 0;
  for (let s = 1; s <= SEEDS; s++) {
    const g = board();
    AI.seedAI(s); mcts.seedMCTS?.(s);
    const r = mcts.searchMctsCommand(g, 'Empire');
    if (r && r.chosen.kind === 'pass') forfeits++;
  }
  console.log(`    forfeits with caution ON: ${forfeits}/${SEEDS}`);
  check('zero forfeits — the cost that blocked this lever has not returned',
    forfeits === 0,
    `the 2026-08-09 passivity interaction is BACK (${forfeits}/${SEEDS}); do not paper over this — `
    + 'either fix the interaction or flip SWR_DS_CAUTION back off and reopen #701');
}

console.log('[ and the lever is actually shipped ON by default ]');
{
  const src = readFileSync(join(ROOT, 'src/play/randomAI.ts'), 'utf8');
  check("SWR_DS_CAUTION defaults ON (opt-out via '0')",
    /SWR_DS_CAUTION === '0'\) return false/.test(src) && !/SWR_DS_CAUTION === '1';/.test(src));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
