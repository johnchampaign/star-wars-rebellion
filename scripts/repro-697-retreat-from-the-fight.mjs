// #697 — "The empire activated cato nemodia and moved it's fleet from corellia
// back there. Again this does nothing for the empire player. I just revealed
// and scored 'heart of the empire' the only way to stop it is to attack and
// hopefully destroy all my ships."
//
// Replays the reporter's EXACT board. The attached state is captured just AFTER
// the activation, so we rewind the two things it changed — the nine ships that
// moved corellia -> cato-neimoidia, and Ozzel leaving the pool — to recover the
// position the AI actually faced, then dump the per-system activation scores.
//
// The board at that moment:
//   coruscant   imperial-loyal, 9 REBEL units (2 mon-cala cruisers + transport
//               in space, 3 troopers + 2 vanguards + airspeeder on the ground),
//               ZERO Empire units. This is the Heart of the Empire score.
//   corellia    neutral, the Empire's entire 9-ship fleet. ADJACENT to coruscant.
//   cato-neimoidia  neutral, EMPTY, no Rebels, also adjacent to corellia.
// The Empire chose cato-neimoidia.
//
// Run: node scripts/repro-697-retreat-from-the-fight.mjs [path-to-state.json]
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

const STATE = process.argv[2] ?? join(ROOT, 'reports', '697-state.json');
const G = codec.decode(readFileSync(STATE, 'utf8'), setup.buildCatalog(data));

// ---- rewind the activation ------------------------------------------------
const MOVED = ['s100014', 's100015', 's100018', 's100020', 's100026', 's100021', 's100027', 's100024', 'u1000010'];
const cato = G.map.systems['cato-neimoidia'];
const corellia = G.map.systems['corellia'];
const back = cato.units.filter((u) => MOVED.includes(u.instanceId));
cato.units = cato.units.filter((u) => !MOVED.includes(u.instanceId));
corellia.units = [...corellia.units, ...back];
delete G.empire.leadersOnBoard['cato-neimoidia'];
if (!G.empire.leaderPool.includes('admiral-ozzel')) G.empire.leaderPool.push('admiral-ozzel');
G.currentPlayer = 'Empire';
G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Empire');

const count = (sid, side) => G.map.systems[sid].units.filter((u) => u.side === side).length;
console.log(`turn ${G.timeMarker}  reputation ${G.reputationMarker}/${G.trackLength}  base ${G.rebelBaseSystemId} revealed=${G.rebelBaseRevealed}`);
console.log(`rewound: corellia Empire=${count('corellia', 'Empire')}  cato-neimoidia Empire=${count('cato-neimoidia', 'Empire')}`);
console.log(`coruscant: Rebel=${count('coruscant', 'Rebel')} Empire=${count('coruscant', 'Empire')} loyalty=${G.map.systems['coruscant'].loyalty}`);
console.log(`Empire pool: ${JSON.stringify(G.empire.leaderPool)}`);
console.log(`Rebel objective hand: ${JSON.stringify(G.rebel.objectiveHand ?? [])}`);

// ---- what the generator offers, ranked ------------------------------------
AI.seedAI(1);
const acts = AI.bestCommandAction(G, 'Empire');
const desc = (a) => a.kind === 'reveal' ? `reveal ${a.missionId} -> ${a.targetSystemId}`
  : a.kind === 'activate' ? `activate ${a.targetSystemId} with ${a.leaderId}` : 'pass';
console.log(`\n${acts.length} candidates:`);
for (const a of [...acts].sort((x, y) => (y.score ?? 0) - (x.score ?? 0))) {
  const mark = a.kind === 'activate' && a.targetSystemId === 'coruscant' ? '  <== the fight'
    : a.kind === 'activate' && a.targetSystemId === 'cato-neimoidia' ? '  <== what it chose'
    : '';
  console.log(`   ${String(a.score ?? 0).padStart(7)}   ${desc(a)}${mark}`);
}

const best = [...acts].sort((x, y) => (y.score ?? 0) - (x.score ?? 0))[0];
const cor = acts.find((a) => a.kind === 'activate' && a.targetSystemId === 'coruscant');
const cn = acts.find((a) => a.kind === 'activate' && a.targetSystemId === 'cato-neimoidia');
console.log(`\ntop candidate:     ${desc(best)}  (${best.score})`);
console.log(`coruscant:         ${cor ? cor.score : 'NOT GENERATED'}`);
console.log(`cato-neimoidia:    ${cn ? cn.score : 'NOT GENERATED'}`);
if (cor && cn) {
  console.log(cor.score > cn.score
    ? '\n=> attacking the scoring fleet now OUTSCORES the empty-system shuffle.'
    : `\n=> the empty-system shuffle still outscores attacking by ${cn.score - cor.score}.`);
}

// ---- and what the PRODUCTION policy (MCTS) actually does with them ---------
// The heuristic score above is only a prior; searchMctsCommand does the picking,
// over the top-K candidates. One search is a single deterministic sample, so
// run many and report the distribution.
const mcts = await import('../src/play/mctsAI.ts');
const rewind = (g) => {
  const c = g.map.systems['cato-neimoidia'], co = g.map.systems['corellia'];
  const mv = c.units.filter((u) => MOVED.includes(u.instanceId));
  c.units = c.units.filter((u) => !MOVED.includes(u.instanceId));
  co.units = [...co.units, ...mv];
  delete g.empire.leadersOnBoard['cato-neimoidia'];
  if (!g.empire.leaderPool.includes('admiral-ozzel')) g.empire.leaderPool.push('admiral-ozzel');
  g.currentPlayer = 'Empire';
  g.passedThisCommand = (g.passedThisCommand ?? []).filter((s) => s !== 'Empire');
  return g;
};
const SEEDS = Number(process.env.SEEDS ?? 30);
const tally = new Map();
for (let s = 1; s <= SEEDS; s++) {
  const g = rewind(codec.decode(readFileSync(STATE, 'utf8'), setup.buildCatalog(data)));
  AI.seedAI(s); mcts.seedMCTS?.(s);
  const r = mcts.searchMctsCommand(g, 'Empire');
  if (!r) continue;
  const k = desc(r.chosen);
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
console.log(`\n=== ${SEEDS} independent MCTS searches on this position ===`);
for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(3)} (${String(Math.round(100 * n / SEEDS)).padStart(3)}%)  ${k}`);
}
