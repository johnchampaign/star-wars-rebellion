// jocke01 (#696): "The empire just moved a big fleet of ships to corellia. The
// problem is that it has 0 ground units ... This move does nothing for the
// empire except make their situation worse."
//
// The activation scorer pays a "go take that planet" bonus for any neutral or
// Rebel-loyal system it doesn't already hold, scaled by the system's resources.
// But planting a subjugation marker requires a GROUND unit standing there —
// ships cannot do it. The bonus was paid whether or not the Empire could
// actually deliver ground, so a fleet with no troops would sail off to
// "subjugate" a planet it had no way of taking. Measured at 30 of 595 spread
// activations (5.0%) arriving with units but no ground.
//
// The guard withholds only the take-the-planet bonus, not the whole target:
// moving ships somewhere can still be right for a fight or for staging, and
// those are scored on their own merits elsewhere. It also deliberately leaves
// the Rebel-loyalty bonus alone, since occupying a Rebel-loyal system also
// clears a base candidate — something ships can do by themselves.
//
// Run: node scripts/test-subjugation-needs-ground-696.mjs
//   Counterfactual: SWR_SUBJ_GROUND=0 node scripts/test-subjugation-needs-ground-696.mjs
//   must FAIL — that flag pays the bonus regardless of ground.
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

/** A neutral target with resources, and one staging neighbour holding the given
 *  Imperial force. Everything else is swept off so the target's score comes only
 *  from the take-the-planet bonus under test. */
function board(seed, staged) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.empire.leadersOnBoard = {};
  G.rebel.leadersOnBoard = {};
  // A neutral, resource-bearing, non-remote target with a neighbour to stage in.
  const target = Object.keys(G.map.systems).find((sid) =>
    sid !== G.rebelBaseSystemId
    && !G.catalog.systems[sid]?.isRemote
    && (G.catalog.systems[sid]?.resources?.length ?? 0) > 0
    && (G.catalog.adjacency[sid] ?? []).some((a) => G.map.systems[a] && a !== G.rebelBaseSystemId));
  // Make the target the UNIQUELY best conquest target by handing every other
  // system to the Empire. Without this the board is left full of equally
  // attractive neutral planets, `target` is merely the alphabetically-first of
  // them, and the test only passed because the AI's tiebreak ALSO resolved
  // alphabetically — so it silently depended on the bias fixed in
  // test-alphabetical-tiebreak-bias. The fixture's own comment already claimed
  // "everything else is swept off"; it swept units but not loyalty.
  for (const [sid, ss] of Object.entries(G.map.systems)) {
    if (sid === target || sid === G.rebelBaseSystemId) continue;
    ss.loyalty = 'imperial';
    ss.subjugated = false;
  }
  G.map.systems[target].loyalty = 'neutral';
  G.map.systems[target].subjugated = false;
  const staging = (G.catalog.adjacency[target] ?? [])
    .find((a) => G.map.systems[a] && a !== G.rebelBaseSystemId);
  for (const typeId of staged) M.deployUnit(G, 'Empire', typeId, staging);
  return { G, target, staging };
}

const activateScore = (G, target) => {
  const acts = ai.bestCommandAction(G, 'Empire');
  return acts.find((a) => a.kind === 'activate' && a.targetSystemId === target)?.score;
};

console.log('\n[ a fleet that can carry troops still goes to take the planet ]');
{
  // Carrier + troopers: ground is deliverable, so the bonus is earned.
  const { G, target } = board(696, ['assault-carrier', 'stormtrooper', 'stormtrooper']);
  const s = activateScore(G, target);
  check('the target is offered', s != null, 'no activate candidate at all');
  check('and scores positively', (s ?? -1) > 0, `score=${s}`);
}

console.log('\n[ #696 a fleet with no ground does NOT get the take-the-planet bonus ]');
{
  // Ships only. Nothing here can plant a subjugation marker.
  const { G, target, staging } = board(697, ['star-destroyer', 'tie-fighter', 'tie-fighter']);
  const ground = G.map.systems[staging].units.filter((u) => {
    const t = G.catalog.unitTypes[u.typeId];
    return u.side === 'Empire' && t?.theater === 'ground' && t.class !== 'structure';
  });
  check('the staging system really has no ground units', ground.length === 0,
    JSON.stringify(ground.map((u) => u.typeId)));
  const withShips = activateScore(G, target);

  // Same board, but give the fleet something to carry. TWO troopers, not one:
  // the move executor keeps 1 ground back as a garrison at a subjugated or
  // producing Imperial-loyal system, so a lone trooper is not actually
  // deliverable and the guard would still (correctly) withhold the bonus.
  const withTroops = (() => {
    const b = board(697, ['star-destroyer', 'tie-fighter', 'tie-fighter']);
    M.deployUnit(b.G, 'Empire', 'stormtrooper', b.staging);
    M.deployUnit(b.G, 'Empire', 'stormtrooper', b.staging);
    return activateScore(b.G, b.target);
  })();

  check('adding a trooper raises the target score', (withTroops ?? 0) > (withShips ?? 0),
    `ships-only=${withShips} with-troops=${withTroops}`);
}

console.log('\n[ the guard withholds a bonus, it does not blanket-ban ship moves ]');
{
  // Ships alone against an enemy-held system must still be considered — that
  // target is scored as a fight, not as a land grab.
  const { G, target, staging } = board(698, ['star-destroyer', 'star-destroyer']);
  M.deployUnit(G, 'Rebel', 'corellian-corvette', target);
  const s = activateScore(G, target);
  check('an enemy-held system is still a candidate for a ship-only fleet',
    s != null && s > 0, `score=${s}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
