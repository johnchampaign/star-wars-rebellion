// @timeout 120000
// SWR_EMPIRE_CALIB — Empire Assignment calibration toward the recorded humans
// (2026-09-04). Measured on 1150 exact human-Empire Assignment positions from the
// archive (mine-human-decisions --stage assignment + calibrate-assignment-values):
//   1. the flat reserve of 3 assigned pool-3 leaders (4.9 from a pool of 8) where
//      the humans assigned 3.5 and kept ~56% back for the Command phase;
//   2. Construct Death Star was gated on OWNING A FACTORY, which RAW never asks
//      for (the DS goes straight onto the build queue) — the humans assign it in
//      39% of rounds held, the AI in 0%;
//   3. base values fitted to the humans' per-mission rates (holdout mission-set
//      agreement 0.26 -> 0.33+).
// This test pins 1 and 2 on synthetic boards with the legacy child as the
// non-vacuous control, and 3 by source.
// Run: node scripts/test-empire-calib.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** Empire Assignment with a pool of `poolSize` leaders (all Empire leaders in the catalog) and a hand of `hand`. */
function board(poolSize, hand) {
  const G = createGame(data, { seed: 5, autoSetupUnits: true });
  const all = Object.values(G.catalog.leaders).filter((l) => l.side === 'Empire').map((l) => l.id);
  G.empire.leaderPool = all.slice(0, poolSize);
  G.empire.missionHand = hand;
  G.phase = 'Assignment'; G.currentPlayer = 'Empire';
  return G;
}
const plan = (G) => { AI.seedAI(1); return AI.__testPlanAssignment(G, 'Empire'); };
const leadersUsed = (P) => P.reduce((s, p) => s + p.leaderIds.length, 0);
const BIG_HAND = ['gather-intel', 'research-and-development', 'capture-rebel-operative', 'rule-by-fear', 'trade-negotiations', 'display-of-power', 'message-from-high-command', 'construct-factory', 'imperial-propaganda', 'deployment'];
function dsBoard() {
  const G = board(4, ['construct-death-star', 'gather-intel', 'rule-by-fear']);
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => !(u.side === 'Empire' && u.typeId === 'construction-yard'));
  return G;
}

if (process.env.CALIB_CHILD === '1') {
  const P8 = plan(board(8, BIG_HAND));
  const Pds = plan(dsBoard());
  console.log(JSON.stringify({ used8: leadersUsed(P8), ds: Pds.some((p) => p.missionId === 'construct-death-star') })); process.exit(0);
}
const legacy = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, CALIB_CHILD: '1', SWR_EMPIRE_CALIB: '0' }, encoding: 'utf8' }).trim().split('\n').pop());

console.log('[ the leader reserve scales with the pool, like the recorded humans ]');
{
  const G = board(8, BIG_HAND); const P = plan(G); const used = leadersUsed(P);
  check(`pool of 8: the planner assigns at most 4 leaders (assigned ${used}, kept ${8 - used})`, used <= 4 && used >= 3, `plan ${JSON.stringify(P.map((p) => p.missionId))}`);
  check(`legacy flat reserve assigned ${legacy.used8} from the same pool (the over-commitment this fixes)`, legacy.used8 === 5);
  const G4 = board(4, BIG_HAND); const u4 = leadersUsed(plan(G4));
  check(`pool of 4 still keeps 3 back (assigned ${u4})`, u4 === 1);
}
console.log('[ Construct Death Star needs a Death Star Under Construction in supply, not a factory ]');
{
  const G = dsBoard();
  const hasYard = Object.values(G.map.systems).some((ss) => ss.units.some((u) => u.side === 'Empire' && u.typeId === 'construction-yard'));
  check('board has no Imperial factory', !hasYard);
  const P = plan(G);
  check('construct-death-star IS assigned with a DSUC in supply', P.some((p) => p.missionId === 'construct-death-star'), JSON.stringify(P.map((p) => p.missionId)));
  check('the legacy factory gate skipped it on the same board', legacy.ds === false);
}
console.log('[ the fitted values are on by default ]');
{
  const src = readFileSync(join(ROOT, 'src/play/randomAI.ts'), 'utf8');
  check('empireValues = EMPIRE_CALIB ? EMPIRE_VALUES_CALIBRATED : legacy', /EMPIRE_CALIB \? EMPIRE_VALUES_CALIBRATED : \{/.test(src));
  check('the reserve helper reads the lever', /Math\.max\(EMPIRE_RESERVE_LEADERS, Math\.round\(pool \* 0\.56\)\)/.test(src));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
