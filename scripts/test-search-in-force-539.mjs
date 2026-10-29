// #539 (the Empire finds the base and does not take it). In AI self-play the
// reveal is usually the Empire's own landing, and most of those landings are
// weak: 2 stormtroopers against 9 Rebel ground is typical, with ~9 more Imperial
// ground within two jumps. A weak reveal loses the battle and the Rebel moves
// the base. SWR_SEARCH_IN_FORCE: once the base is down to a few live worlds, a
// landing there is the assault, so a weak one loses its search bonus, troops
// load before fighters, and moving ground next door is rewarded instead.
//
// Board: scripts/fixtures/search-in-force-539.json, a self-play round start
// (base-game rules) where Ilum is the last world the base could be on (it is
// there), the Rebel garrison is strength 11, and the best move with the flag
// off is Vader landing ONE stormtrooper on it. Four more sit on Alderaan, two
// jumps out, and activating Ord Mantell (next to Ilum) brings them in.
// Pins: flag on, the one-trooper landing is sunk and the Ord Mantell staging
// move leads; control: flag off reproduces the tap; with no reserve to wait for
// (the Alderaan troops gone) the landing stands (#809's lesson); a broad
// search is untouched.
// Run: node scripts/test-search-in-force-539.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const raw = readFileSync(join(ROOT, 'scripts/fixtures/search-in-force-539.json'), 'utf8');
const board = () => codec.decode(raw, catalog);

/** What the Empire would do on this board, under whatever flags this process has. */
function measure() {
  const scores = (G) => {
    const acts = ai.bestCommandAction(G, 'Empire');
    const best = (sid) => Math.max(-999, ...acts.filter((a) => a.kind === 'activate' && a.targetSystemId === sid).map((a) => a.score));
    return { top: acts[0]?.targetSystemId, ilum: best('ilum'), ordMantell: best('ord-mantell') };
  };
  const groundTo = (G2, sid) => ai.plannedMoveOrders(G2, 'Empire', sid).reduce((n, o) => n + o.unitInstanceIds.filter((id) => {
    const u = G2.map.systems[o.fromSystemId].units.find((x) => x.instanceId === id);
    return G2.catalog.unitTypes[u.typeId].theater === 'ground';
  }).length, 0);
  const noReserve = board();
  noReserve.map.systems.alderaan.units = noReserve.map.systems.alderaan.units.filter((u) => !(u.side === 'Empire' && u.typeId === 'stormtrooper'));
  const wide = board(); wide.empireSearchedRuledOut = []; wide.empire.probeHand = [];
  return { ...scores(board()), ilumGround: groundTo(board(), 'ilum'), stageGround: groundTo(board(), 'ord-mantell'),
    weak: [...(ai.empireWeakSearchTargets(board()) ?? [])], noReserveTop: scores(noReserve).top,
    wideLikely: ai.searchInForceTarget(wide, 'ilum'), wideLive: ai.empireLiveBaseCandidates(wide).length };
}
if (process.argv[2] === '--measure') { console.log(`RESULT ${JSON.stringify(measure())}`); process.exit(0); }
const arm = (v) => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--measure'], { encoding: 'utf8',
    env: { ...process.env, SWR_SEARCH_IN_FORCE: v, SWR_EMPIRE_PLANNER: '1', SWR_HUNT_OCCUPY: '1', SWR_MCTS_BELIEF: '1' } });
  const m = r.stdout.match(/RESULT (.*)/);
  if (!m) throw new Error(r.stdout + r.stderr.slice(-400));
  return JSON.parse(m[1]);
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ the board ]');
{
  const G = board();
  check('the base is hidden at Ilum', G.rebelBaseSystemId === 'ilum' && !G.rebelBaseRevealed);
  check('Ilum is the only world the Empire has not ruled out', ai.empireLiveBaseCandidates(G).join(',') === 'ilum', ai.empireLiveBaseCandidates(G).join(','));
  check('the public garrison it would face is strength 11', ai.rebelGarrisonIfBase(G, 'ilum') === 11, String(ai.rebelGarrisonIfBase(G, 'ilum')));
}

const off = arm('0'), on = arm('1');
console.log('[ control: flag off is the one-trooper tap ]');
check('the best move is to land on Ilum', off.top === 'ilum', JSON.stringify(off));
check('…with 1 ground unit', off.ilumGround === 1, JSON.stringify(off));
check('the gate is silent', off.weak.length === 0, JSON.stringify(off));

console.log('[ flag on: stage, then land in force ]');
check('Ilum is a weak landing with an army to wait for', on.weak.join(',') === 'ilum', JSON.stringify(on));
check('the best move is the staging move at Ord Mantell', on.top === 'ord-mantell', JSON.stringify(on));
check('…which brings 5 ground next to Ilum', on.stageGround === 5, JSON.stringify(on));
check('the tap loses at least its search bonus', off.ilum - on.ilum >= 16, `${off.ilum} -> ${on.ilum}`);
check('the staging move scores higher than before', on.ordMantell > off.ordMantell, `${off.ordMantell} -> ${on.ordMantell}`);

console.log('[ it only waits when waiting pays ]');
check('with no reserve to bring up, the landing stands', on.noReserveTop === 'ilum', JSON.stringify(on));
check('with many worlds still possible, Ilum is not treated as the likely base', !on.wideLikely && on.wideLive > 5, JSON.stringify(on));

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
