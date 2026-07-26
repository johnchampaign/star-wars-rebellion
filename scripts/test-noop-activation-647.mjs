// #647 — "Imperial AI activates a system with a leader and does nothing. In this
// case sents Darth Vader to Kessel. There is no fight, not a single character
// from my side... nothing." Replayed from the reporter's own board
// (scripts/fixtures/noop-activation-647.json). Same complaint as #606, #538,
// #555, #516.
//
// THE BUG. bestCommandAction sinks an activation to -50 when it can bring no
// units, but the old condition exempted every enemy-occupied target:
//     if (movable === 0 && !enemyHere) ts = -50;
// on the assumption that an enemy means a fight. It doesn't. phases.
// activateSystem computes `willFight = oppHere && myHere`, so a fight needs
// units of OURS already there — a leader arriving alone never triggers combat
// however many enemies are present.
//
// On this board Kessel held ONE Rebel trooper, ZERO Imperial units, and nothing
// movable in range (the neighbouring ground unit at Saleucami had no carrier).
// The exemption applied, so the no-op scored 32 and was the AI's TOP pick —
// logged as orders:0, unitsMoved:0.
//
// The guard now requires own units present for the enemy exemption, which keeps
// the genuinely useful case (bring the leader into a fight already available)
// and the #517 idle-stack case, while closing this one.
//
// Run: node scripts/test-noop-activation-647.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const catalog = setup.buildCatalog(data);
const raw = readFileSync(join(ROOT, 'scripts/fixtures/noop-activation-647.json'), 'utf8');
/** The snapshot is captured AFTER the reported activation; put Vader back in the
 *  pool to recover the decision the AI actually faced. */
function board() {
  const G = codec.decode(raw, catalog);
  G.empire.leadersOnBoard = {};
  if (!G.empire.leaderPool.includes('darth-vader')) G.empire.leaderPool.push('darth-vader');
  G.currentPlayer = 'Empire';
  G.passedThisCommand = [];
  return G;
}

console.log('[ #647 — do not send a leader somewhere it can neither move nor fight ]');
{
  const G = board();
  const kessel = G.map.systems['kessel'];
  const ownHere = kessel.units.filter((u) => u.side === 'Empire').length;
  const enemyHere = kessel.units.some((u) => u.side !== 'Empire');
  check('the fixture still reproduces the shape (enemy present, no Imperial units)',
    enemyHere && ownHere === 0, `own=${ownHere} enemy=${enemyHere}`);

  AI.seedAI(1);
  const acts = AI.bestCommandAction(G, 'Empire');
  const noop = acts.find((a) => a.kind === 'activate' && a.targetSystemId === 'kessel');
  check('the no-op Kessel activation is not offered at all', !noop,
    `still proposed at score ${noop?.score}`);
  const top = acts[0];
  check('and the AI has something real to do instead', top && top.kind !== 'pass',
    `top=${top?.kind}`);
}

console.log('[ the useful cases must survive ]');
// These need an ISOLATED board. On the full fixture the candidate list is
// capped at one target per tactic-capable leader, so a legitimate target can be
// absent simply by ranking 6th — which would make this assert ranking rather
// than the guard. Strip the Empire down so the system under test is the only
// thing it could possibly activate (same technique as
// test-idle-stack-activation-517.mjs).
function isolated(mutate) {
  const G = board();
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.side !== 'Empire');
  G.empire.leadersOnBoard = {};
  G.empire.leadersOnMissions = [];
  G.empire.leaderPool = ['darth-vader'];
  mutate(G);
  AI.seedAI(1);
  return AI.bestCommandAction(G, 'Empire');
}
const TARGET = 'kessel';
const mk = (t, side, n) => ({ instanceId: `${side}-${t}-${n}`, typeId: t, side, damage: 0 });
{
  // Own units AND enemy units at the target, nothing movable in. willFight is
  // `oppHere && myHere` = true, so activating genuinely STARTS a combat and the
  // leader's tactic values matter — this must stay on the table.
  const acts = isolated((G) => {
    G.map.systems[TARGET].units = [mk('rebel-trooper', 'Rebel', 1), mk('stormtrooper', 'Empire', 1)];
  });
  const join = acts.find((a) => a.kind === 'activate' && a.targetSystemId === TARGET);
  check('activating INTO an available fight is still offered (own units + enemy)',
    !!join, 'the guard over-reached and blocked a real combat');
}
{
  // The #647 shape on the same isolated board: enemy present, NO units of ours,
  // nothing movable. No fight is possible, so it must be sunk.
  const acts = isolated((G) => {
    G.map.systems[TARGET].units = [mk('rebel-trooper', 'Rebel', 1)];
  });
  const noop = acts.find((a) => a.kind === 'activate' && a.targetSystemId === TARGET);
  check('but a lone leader into an enemy system with nothing to bring is not',
    !noop, `proposed at score ${noop?.score}`);
}
{
  // #517: a resident stack with no enemy and nothing pullable is still a no-op
  // (RAW: you cannot move units INTO their own system).
  const acts = isolated((G) => {
    G.map.systems[TARGET].units = [mk('stormtrooper', 'Empire', 1)];
  });
  const idle = acts.find((a) => a.kind === 'activate' && a.targetSystemId === TARGET);
  check('a resident stack with no enemy is still not activated (#517)', !idle,
    `proposed at score ${idle?.score}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
