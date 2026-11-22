// #765 / #766 / #768 — rokhm1, playing Empire against the AI Rebel, on its
// mission targeting. Both boards are the reporter's own
// (scripts/fixtures/loyalty-target-765.json, hidden-fleet-768.json).
//
// #765/#766: "why would the rebels build an alliance at Saleucami when both Mon
// Calamari and Utapau are free and unreachable for my forces?" The loyalty-
// target term counted resource icons and ignored their SHAPE, so the two
// square-icon worlds (the only ones that build the big ships) led a one-circle
// Saleucami by just 2 points — inside the search's noise. SWR_LOYALTY_SHAPE
// weights squares 6, triangles 3, circles 2. Across the 166 archived human
// Rebel loyalty reveals the scorer's top pick is now a square world 79 times
// (humans: 80), up from 45.
//
// #768: Hidden Fleet had NO target scoring — every system tied — and the Rebel
// dropped its fleet and seven ground units on neutral Sullust, one jump from
// an Imperial fleet as strong as its own, as its second mission while the
// Empire still had a leader to strike with. SWR_HIDDEN_FLEET_GUARD scores that
// counter-strike down (and lifts once the Empire has no leader left, which is
// the timing the reporter asked for), but not on a Rebel-loyal system, where
// reinforcing is the play the recorded humans make.
//
// Non-vacuous: a child re-runs the same boards with both levers off.
// Run: node scripts/test-rebel-targets-765-768.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = process.argv.includes('--child');
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });
const board = (f) => codec.decode(readFileSync(join(ROOT, 'scripts/fixtures', f), 'utf8'), catalog);

function measure() {
  // #765: snapshot is after the flip — put Saleucami back to neutral.
  const G = board('loyalty-target-765.json');
  G.map.systems.saleucami.loyalty = 'neutral';
  const ba = (s) => AI.rebelMissionTargetScore(G, 'build-alliance', s, null);
  // #768: snapshot is after the move — put the 13 units back in the base space.
  const H = board('hidden-fleet-768.json');
  const sul = H.map.systems.sullust;
  const back = sul.units.filter((u) => u.side === 'Rebel');
  H.map.rebelBaseSpace.units.push(...back);
  sul.units = sul.units.filter((u) => u.side !== 'Rebel');
  const hf = (G2, s) => AI.rebelMissionTargetScore(G2, 'hidden-fleet', s, null);
  const out = {
    moved: back.length,
    monCalMargin: ba('mon-calamari') - ba('saleucami'),
    utapauMargin: ba('utapau') - ba('saleucami'),
    sullust: hf(H, 'sullust'),
    quiet: hf(H, 'bespin'),
  };
  // Same board, Empire out of leaders → the drop is safe again.
  const pool = H.empire.leaderPool; H.empire.leaderPool = [];
  out.sullustNoLeaders = hf(H, 'sullust');
  H.empire.leaderPool = pool;
  // Same board, Sullust Rebel-loyal → reinforcing, not a gift.
  sul.loyalty = 'rebel';
  out.sullustDefending = hf(H, 'sullust');
  return out;
}

if (CHILD) { console.log(JSON.stringify(measure())); process.exit(0); }

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const on = measure();
// The control reproduces the pre-#765 scorer, so it also turns off the #840
// loyalty-yield term, which prices the same Mon Calamari / Utapau square icons.
const off = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
  env: { ...process.env, SWR_LOYALTY_SHAPE: '0', SWR_HIDDEN_FLEET_GUARD: '0', SWR_REBEL_LOYALTY_YIELD: '0' }, encoding: 'utf8',
}).trim().split('\n').pop());

console.log('#765 loyalty target shape');
check('fixture restores the Hidden Fleet move (13 units)', on.moved === 13, `moved ${on.moved}`);
check('Mon Calamari clearly beats Saleucami', on.monCalMargin >= 5, JSON.stringify(on));
check('Utapau clearly beats Saleucami', on.utapauMargin >= 5, JSON.stringify(on));
check('control: flat icon count left it within 2', off.monCalMargin <= 2, JSON.stringify(off));
console.log('#768 Hidden Fleet counter-strike');
check('Sullust (strikeable, Empire holds a leader) scores below a quiet system', on.sullust < on.quiet, JSON.stringify(on));
check('penalty lifts when the Empire has no leader left', on.sullustNoLeaders === on.quiet, JSON.stringify(on));
check('no penalty when reinforcing a Rebel-loyal system', on.sullustDefending === on.quiet, JSON.stringify(on));
check('control: unscored, Sullust tied the quiet system', off.sullust === off.quiet, JSON.stringify(off));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
