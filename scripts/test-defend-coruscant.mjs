// "The empire is very slow to react to rebel fleets adjacent to coruscant ...
// If the rebels ever gathers a threatening fleet next to coruscant they have
// heart of the empire in hand or on top of the objective deck 8-9 out of 10
// times ... While the ai is pretty good at deploying some units on the
// coruscant space at setup it reacts really slow to it being attacked."
//   — jocke01, BGG
//
// He was right, and the numbers were worse than "slow". Measured on the
// fixtures below BEFORE the fix: with SIX Rebel units parked one jump from an
// EMPTY Coruscant, activating to the capital scored 2 and ranked last of four
// candidate systems. Defending an undefended capital against a visible armada
// was the least attractive move on the board.
//
// TWO objectives key off this square, and the old scorer saw neither coming:
//   Threaten the Core    "5 or more Rebel units are in AND/OR ADJACENT TO
//                         Coruscant" — pays out while the fleet is still next
//                         door, so arriving-only awareness is already too late.
//   Heart of the Empire  "If the Coruscant system contains a Rebel unit and NO
//                         Imperial units", and it RETURNS TO HAND instead of
//                         being spent — 2 reputation every Refresh until the
//                         Empire puts a unit back. That repeatability is why a
//                         human scores it "2+ times in a few games".
// The old code only reacted on `hasEnemyUnits && !hasOwnUnits` — i.e. once the
// Rebels were standing on the capital AND the garrison was already dead, which
// is the exact instant Heart of the Empire becomes scoreable. It also docked
// Coruscant 3 points for being "quiet" right up until that moment.
//
// WHY A FIXTURE AND NOT AN A/B. Self-play cannot see this. Across 300 RoE
// games the AI Rebel played Heart of the Empire 8 times total (0.027/game) and
// Threaten the Core 11; a human plays the first one twice in a single game. The
// harness opponent never mounts the attack, so a win-rate arm would measure the
// absence of the threat, not the quality of the defence. See docs/ab-levers.md.
//
// Run: node scripts/test-defend-coruscant.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const NB = data.adjacency.neighbors['coruscant'];
const REBEL_ARMADA = ['rebel-trooper', 'rebel-trooper', 'rebel-trooper',
  'corellian-corvette', 'corellian-corvette', 'x-wing'];

/** Swept board: an Imperial garrison on Coruscant, an Imperial relief force one
 *  jump away on a DIFFERENT neighbour (so activating to the capital is actually
 *  possible), and a Rebel force on the first neighbour. */
function board(seed, garrison, rebelAdj, rebelOn = []) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  for (const t of garrison) M.deployUnit(G, 'Empire', t, 'coruscant');
  for (const t of ['star-destroyer', 'star-destroyer', 'stormtrooper', 'stormtrooper']) {
    M.deployUnit(G, 'Empire', t, NB[1]);
  }
  for (const t of rebelAdj) M.deployUnit(G, 'Rebel', t, NB[0]);
  for (const t of rebelOn) M.deployUnit(G, 'Rebel', t, 'coruscant');
  return G;
}

/** The Empire's activate-to-Coruscant option: its score and its rank among all
 *  real (non-pass) actions. Rank is what actually decides play — a bonus that
 *  leaves the capital ranked last changes nothing. */
function coruscantOption(G) {
  const acts = ai.bestCommandAction(G, 'Empire').filter((a) => a.kind !== 'pass');
  const cor = acts.find((a) => a.kind === 'activate' && a.targetSystemId === 'coruscant');
  return { score: cor?.score, rank: cor ? acts.indexOf(cor) + 1 : null, n: acts.length };
}

console.log('\n[ an armada NEXT DOOR is now an emergency, not an afterthought ]');
{
  // The reported situation: fleet massing one jump out, token garrison.
  const o = coruscantOption(board(1, ['stormtrooper'], REBEL_ARMADA));
  check('the capital is offered as a target', o.score != null, 'not offered at all');
  check('and it is now the TOP-ranked activation (it was last of four)',
    o.rank === 1, `rank ${o.rank}/${o.n} score=${o.score}`);
}
{
  // The most urgent case of all: nothing on the capital, armada next door. One
  // move and Heart of the Empire starts paying every Refresh.
  const o = coruscantOption(board(2, [], REBEL_ARMADA));
  check('an EMPTY capital under threat is heavily weighted (was score 2, last)',
    (o.score ?? 0) >= 25, `score=${o.score} rank=${o.rank}/${o.n}`);
}

console.log('\n[ the existing recapture case still works (#697) ]');
{
  const o = coruscantOption(board(3, [], [], ['rebel-trooper', 'rebel-trooper', 'x-wing']));
  check('Rebels standing on the capital ranks first', o.rank === 1,
    `rank ${o.rank}/${o.n} score=${o.score}`);
}

console.log('\n[ narrowness — a quiet capital must NOT hoover up activations ]');
{
  // The failure mode to avoid is an Empire that garrisons Coruscant forever
  // while the Rebels win somewhere else entirely.
  const quiet = coruscantOption(board(4, ['stormtrooper'], []));
  check('with no Rebels in or next to Coruscant it stays bottom-ranked',
    quiet.rank === quiet.n, `rank ${quiet.rank}/${quiet.n} score=${quiet.score}`);

  // And the score must be identical to the lever-off behaviour: no threat means
  // this rule contributed nothing at all.
  process.env.SWR_DEFEND_CORUSCANT = '0';
  const mod = await import(`../src/play/randomAI.ts?nocache=${Date.now()}`);
  const off = (() => {
    const G = board(4, ['stormtrooper'], []);
    const acts = mod.bestCommandAction(G, 'Empire').filter((a) => a.kind !== 'pass');
    const cor = acts.find((a) => a.kind === 'activate' && a.targetSystemId === 'coruscant');
    return cor?.score;
  })();
  delete process.env.SWR_DEFEND_CORUSCANT;
  check('a quiet capital scores exactly the same with the rule off', quiet.score === off,
    `on=${quiet.score} off=${off}`);
}

console.log('\n[ the capital is not used as a SOURCE while threatened (#489) ]');
{
  // The other half of the reported failure: the Empire had a fleet AT/NEXT TO
  // Coruscant and marched it away to subjugate Corellia, gifting Heart of the
  // Empire. Pulling units OUT of a threatened capital must be refused the same
  // way the revealed Rebel base and prison systems refuse to be drained.
  const G = createGame(data, { seed: 8, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  const nb = data.adjacency.neighbors['coruscant'];
  for (const t of ['star-destroyer', 'stormtrooper', 'stormtrooper']) M.deployUnit(G, 'Empire', t, 'coruscant');
  for (const t of ['rebel-trooper', 'x-wing']) M.deployUnit(G, 'Rebel', t, nb[0]);
  // A tempting activation target next door to Coruscant on the OTHER side.
  G.map.systems[nb[1]].loyalty = 'neutral';
  const pulled = ai.__testPlannedMoveOrders(G, 'Empire', nb[1])
    .filter((o) => o.fromSystemId === 'coruscant');
  check('no move order sources from the threatened capital', pulled.length === 0,
    JSON.stringify(pulled));
  // And with the Rebels gone, Coruscant is an ordinary staging system again.
  for (const sid of [nb[0]]) G.map.systems[sid].units = G.map.systems[sid].units.filter((u) => u.side !== 'Rebel');
  const pulledQuiet = ai.__testPlannedMoveOrders(G, 'Empire', nb[1])
    .filter((o) => o.fromSystemId === 'coruscant');
  check('a QUIET capital may still supply moves', pulledQuiet.length > 0,
    'coruscant refused to source even with no threat');
}

console.log('\n[ the response scales with the size of the threat ]');
{
  const small = coruscantOption(board(6, ['stormtrooper', 'stormtrooper'], ['x-wing', 'rebel-trooper']));
  const big = coruscantOption(board(6, ['stormtrooper', 'stormtrooper'], REBEL_ARMADA));
  check('a bigger force next door pulls harder than a small one',
    (big.score ?? 0) > (small.score ?? 0), `small=${small.score} big=${big.score}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
