// jocke01 (#697): "The empire activated cato nemodia and moved it's fleet from
// corellia back there. Again this does nothing for the empire player. I just
// revealed and scored 'heart of the empire' the only way to stop it is to
// attack and hopefully destroy all my ships. The empire outnumbers me so it
// should be able too."
//
// Heart Of The Empire (stage 2): "If the Coruscant system contains a Rebel unit
// and no Imperial units. Then return this card to your hand." It pays the Rebel
// 2 reputation at EVERY Refresh and is never spent — so a Rebel force parked on
// an empty Coruscant is a permanent reputation leak, and the Empire only has to
// BE there to plug it. It does not have to clear the ground.
//
// Replaying the reporter's board, Coruscant scored −11 and was dropped by the
// `ts > 0` candidate filter, so the Empire could not consider it at all. Three
// separate things sank it:
//   −3   "already Imperial-controlled and no enemy here: moving units in gains
//         nothing" — whose condition never actually tested for the enemy, so it
//         fired on the one Imperial-loyal system the Rebel had taken.
//   −3   a flat "don't waste activations on Coruscant" tourism penalty.
//   −30  "can't win the ground fight" — the Empire's fleet had no troops, so
//         empGround(0) < rebGround. But combat.ts gates each theatre on
//         bothSidesHaveTheater(), so with no Imperial ground there is no ground
//         battle to lose: the fight is purely in space, where nine Imperial
//         ships faced three Rebel ones.
//
// Run: node scripts/test-contest-occupied-capital-697.mjs
//   Counterfactual: SWR_THEATER_ODDS=0 node scripts/test-contest-occupied-capital-697.mjs
//   must FAIL — that flag restores the theatre-blind comparison.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

/** The reporter's shape, reduced to its moving parts: a Rebel force holding
 *  Coruscant with no Imperial unit on it, and the Empire's whole fleet one jump
 *  away at Corellia. `rebelShips` toggles whether the Rebel garrison includes
 *  anything the Imperial fleet can actually shoot at. */
function board(seed, { rebelShips }) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.empire.leadersOnBoard = {};
  G.rebel.leadersOnBoard = {};
  G.timeMarker = 5;

  // Rebels hold the capital. Ground units are what make the objective stick and
  // what the old code read as an unwinnable ground fight.
  for (const t of ['rebel-trooper', 'rebel-trooper', 'rebel-trooper', 'rebel-vanguard', 'rebel-vanguard']) {
    M.deployUnit(G, 'Rebel', t, 'coruscant');
  }
  if (rebelShips) for (const t of ['mon-cala-cruiser', 'rebel-transport']) M.deployUnit(G, 'Rebel', t, 'coruscant');

  // The Imperial fleet next door: ships only, no troops — as reported.
  for (const t of ['star-destroyer', 'star-destroyer', 'assault-carrier',
    'tie-fighter', 'tie-fighter', 'tie-fighter', 'tie-fighter', 'tie-striker']) {
    M.deployUnit(G, 'Empire', t, 'corellia');
  }
  return G;
}

const scoreOf = (G, target) => ai.bestCommandAction(G, 'Empire')
  .find((a) => a.kind === 'activate' && a.targetSystemId === target)?.score;

console.log('\n[ corellia really is one jump from coruscant ]');
{
  const G = board(697, { rebelShips: true });
  check('adjacency holds', (G.catalog.adjacency['corellia'] ?? []).includes('coruscant'),
    JSON.stringify(G.catalog.adjacency['corellia']));
  check('coruscant has no Imperial unit', !G.map.systems['coruscant'].units.some((u) => u.side === 'Empire'));
  check('coruscant is Imperial-loyal', G.map.systems['coruscant'].loyalty === 'imperial',
    G.map.systems['coruscant'].loyalty);
}

console.log('\n[ #697 a Rebel-held capital is a candidate the Empire can pick ]');
{
  const G = board(697, { rebelShips: true });
  const s = scoreOf(G, 'coruscant');
  // The bug was total: not "ranked too low" but absent from the list, because
  // the `ts > 0` filter drops anything non-positive before leaders are paired.
  check('activating coruscant is offered at all', s != null,
    'no activate candidate — the Empire cannot consider retaking its own capital');
  check('and scores positively', (s ?? -1) > 0, `score=${s}`);
}

console.log('\n[ it beats shuffling the same fleet to an empty neutral ]');
{
  // Cato Neimoidia is the move the reporter actually saw: also adjacent to
  // Corellia, empty, neutral, no Rebels, nothing to contest.
  const G = board(697, { rebelShips: true });
  const cor = scoreOf(G, 'coruscant');
  const cato = scoreOf(G, 'cato-neimoidia');
  check('the empty-neutral shuffle no longer outranks the fight',
    cor != null && (cato == null || cor > cato), `coruscant=${cor} cato-neimoidia=${cato}`);
}

console.log('\n[ the ground stack alone does not veto a space operation ]');
{
  // Same board minus the Rebel ships. Now no theatre is shared: the Imperial
  // fleet would arrive, beginCombat would no-op, and the ships would sit next
  // to a Rebel army they cannot touch. That is worth less than the real fight,
  // and the scorer has to tell the two apart rather than treating both as a
  // ground rout.
  const withShips = scoreOf(board(697, { rebelShips: true }), 'coruscant');
  const groundOnly = scoreOf(board(697, { rebelShips: false }), 'coruscant');
  check('a defender with ships scores above a defender with none',
    (withShips ?? 0) > (groundOnly ?? 0), `withShips=${withShips} groundOnly=${groundOnly}`);
}

console.log('\n[ a quiet Coruscant is still not worth visiting ]');
{
  // The tourism penalty must survive. Note the baseline here is +4, not a
  // negative — the flat `timeMarker * 2` urgency term outweighs both −3s on its
  // own, and always did. So the assertion is comparative: an unoccupied capital
  // must stay far below an occupied one, and must not be what the Empire picks.
  const G = board(697, { rebelShips: true });
  G.map.systems['coruscant'].units = [];
  const empty = scoreOf(G, 'coruscant');
  const held = scoreOf(board(697, { rebelShips: true }), 'coruscant');
  check('an empty coruscant scores far below a Rebel-held one',
    (empty ?? 0) < (held ?? 0) - 20, `empty=${empty} held=${held}`);
  const top = ai.bestCommandAction(G, 'Empire').filter((a) => a.kind === 'activate')[0];
  check('and is not the Empire\'s pick', top?.targetSystemId !== 'coruscant',
    `top activate = ${top?.targetSystemId} (${top?.score})`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
