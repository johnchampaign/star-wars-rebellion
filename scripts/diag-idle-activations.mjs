// Why does the AI pass while it still has pool leaders and movable units?
// (task #8, activation half — reports #629 "passed with a leader left in the
// pool and fleets that can still be moved", #639, #580/#630, #574 "only uses 2
// leaders per turn", #599 "activating all leaders to one system".)
//
// At every pass decision we ask, in bestCommandAction's own terms:
//   no-tactic-leader   pool has no leader with tactic values (RAW: can't activate)
//   empty-pool         no leaders at all — passing is correct
//   no-positive-system every system scored <= 0, so the generator emitted NO
//                      activate action for ANY leader even though one could move
//   generated-lost     an activate WAS generated and pass still outscored it
//
// Also measures candidate DIVERSITY, because bestCommandAction picks each
// leader's target as the argmax of a LEADER-INDEPENDENT system score: every
// pool leader ends up proposing the SAME system, so N leaders produce N
// duplicate candidates. That matters twice over — it is #599 verbatim, and
// MCTS searches only bestCommandAction(...).slice(0, topK), so duplicates
// crowd genuine alternative targets out of the search.
//
// Run: node scripts/diag-idle-activations.mjs [games]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json') };

const GAMES = Number(process.argv[2] ?? 15);
const reason = new Map();
const bump = (side, k) => { const key = side + '|' + k; reason.set(key, (reason.get(key) ?? 0) + 1); };
// Diversity accounting over ALL command decisions (not just passes).
const div = { Empire: { decisions: 0, acts: 0, distinct: 0, leaders: 0 }, Rebel: { decisions: 0, acts: 0, distinct: 0, leaders: 0 } };
// How much of the MCTS candidate window is spent on duplicate activate targets.
const topKWaste = { Empire: [], Rebel: [] };
const TOPK = 12;

/** Units this side could actually pull into `sysId` from a neighbour — the
 *  same notion the generator's no-op guard uses. */
function movableInto(G, side, sysId) {
  let n = 0;
  for (const nb of (G.catalog.adjacency[sysId] ?? [])) {
    for (const u of (G.map.systems[nb]?.units ?? [])) {
      if (u.side !== side) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t || t.transport?.immobile || t.class === 'structure') continue;
      n++;
    }
  }
  return n;
}

for (let seed = 1; seed <= GAMES; seed++) {
  AI.seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: true,
    expansion: { enabled: true, roteUnits: true, roteMissionsRebel: true, roteMissionsEmpire: true } });
  let guard = 0;
  while (!G.isGameOver && guard++ < 6000) {
    const side = G.currentPlayer;
    if (G.phase === 'Command' && !G.pendingChoice && !G.pendingMission && !G.pendingCombat) {
      let acts = null;
      try { acts = AI.bestCommandAction(G, side); } catch { /* ignore */ }
      if (acts && acts.length) {
        const f = side === 'Rebel' ? G.rebel : G.empire;
        const activates = acts.filter((a) => a.kind === 'activate');
        const tacticLeaders = f.leaderPool.filter((lid) => {
          const l = G.catalog.leaders[lid];
          return l && (l.tacticValues.space + l.tacticValues.ground) > 0;
        });
        // Diversity over every decision where activation was even possible.
        if (tacticLeaders.length > 0) {
          const d = div[side];
          d.decisions++;
          d.acts += activates.length;
          d.distinct += new Set(activates.map((a) => a.targetSystemId)).size;
          d.leaders += tacticLeaders.length;
          const window = acts.slice(0, TOPK).filter((a) => a.kind === 'activate');
          const dupes = window.length - new Set(window.map((a) => a.targetSystemId)).size;
          topKWaste[side].push(dupes);
        }
        if (acts[0].kind === 'pass') {
          if (f.leaderPool.length === 0) bump(side, 'empty-pool');
          else if (tacticLeaders.length === 0) bump(side, 'no-tactic-leader');
          else if (activates.length === 0) {
            // Generator produced nothing. Did it actually have something to move?
            const couldMove = Object.keys(G.map.systems).some((s) => movableInto(G, side, s) > 0);
            bump(side, couldMove ? 'no-positive-system (units WERE movable)' : 'no-positive-system (nothing movable)');
          } else bump(side, 'generated-lost');
        }
      }
    }
    if (!AI.stepOnce(G, side)) {
      const o = side === 'Rebel' ? 'Empire' : 'Rebel';
      if (!AI.stepOnce(G, o)) break;
    }
  }
}

console.log(`self-play games: ${GAMES}\n`);
for (const side of ['Empire', 'Rebel']) {
  const rows = [...reason.entries()].filter(([k]) => k.startsWith(side + '|'))
    .map(([k, n]) => [k.split('|')[1], n]).sort((a, b) => b[1] - a[1]);
  const tot = rows.reduce((s, r) => s + r[1], 0) || 1;
  console.log(`== ${side} — ${tot} pass decisions ==`);
  for (const [k, n] of rows) console.log(`   ${String(n).padStart(5)}  ${(100 * n / tot).toFixed(1).padStart(5)}%  ${k}`);
  const d = div[side];
  const w = topKWaste[side];
  const meanW = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
  console.log(`   candidate diversity over ${d.decisions} activatable decisions:` +
    ` ${(d.acts / Math.max(1, d.decisions)).toFixed(2)} activate actions from` +
    ` ${(d.leaders / Math.max(1, d.decisions)).toFixed(2)} eligible leaders,` +
    ` but only ${(d.distinct / Math.max(1, d.decisions)).toFixed(2)} DISTINCT targets`);
  console.log(`   duplicate activate candidates inside the MCTS top-${TOPK} window: ${meanW.toFixed(2)} per decision\n`);
}
