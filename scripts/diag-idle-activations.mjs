// Why does the AI pass while it still has pool leaders and movable units?
// (task #8, activation half — reports #629 "passed with a leader left in the
// pool and fleets that can still be moved", #639, #580/#630, #574 "only uses 2
// leaders per turn", #599 "activating all leaders to one system".)
//
// At every pass decision we ask, in bestCommandAction's own terms:
//   no-tactic-leader   pool has no leader with tactic values (RAW: can't activate)
//   empty-pool         no leaders at all — passing is correct
//   no-positive-system every system scored <= 0, so the generator emitted NO
//                      activate action for ANY leader. Split by whether a LEGAL
//                      move actually existed (see movableInto below).
//   generated-lost     an activate WAS generated and pass still outscored it
//
// FINDING (2026-08-08): the no-positive-system bucket is NOT the smoking gun it
// looks like. This script used to call it "units WERE movable" on a count that
// ignored both the own-leader pin (RR p.2) and transport capacity (RR p.9), so
// it reported ~17% of Empire passes as a generation bug. Applying both rules,
// 86 of 89 such decisions had NO legal move at all — the units were pinned
// under the faction's own leaders or were ground troops with no carrier. The
// remaining 3 scored exactly 0 and are the `ts > 0` filter boundary in
// bestCommandAction, not a veto. The activation half of the passivity reports
// is largely correct play; the live gaps are on the MISSION half
// (scripts/diag-facedown-missions.mjs).
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
 *  same notion the generator's no-op guard uses.
 *
 *  This MUST mirror bestCommandAction's `movable` count, because the whole
 *  point of the 'units WERE movable' bucket is "the generator vetoed a move
 *  that was really available". An earlier version counted any non-immobile
 *  friendly unit in any neighbour, which ignored two hard rules and so
 *  reported a generation bug that does not exist:
 *
 *    • RR p.2 "Units cannot move out of a system that already contains a
 *      leader from its faction." Enforced by the engine at phases.ts
 *      (`friendly-leader-blocks-source`). Measured over 12 self-play games,
 *      1602 of the 2191 friendly mobile units sitting at these "idle" passes
 *      were pinned this way — they legally could not move at all.
 *    • Transport capacity (RR p.9): ground units and restricted fighters move
 *      only if a capital ship at the SAME source has spare capacity. Of the
 *      589 unpinned units, 586 were stranded ground troops with no carrier.
 *
 *  With both rules applied, only 3 of 89 all-vetoed decisions had a genuinely
 *  movable unit — and those scored exactly 0, i.e. they are the `ts > 0`
 *  boundary, not a veto. The activation half of the passivity reports is
 *  overwhelmingly RAW-correct behaviour; do not go hunting a veto bug here.
 *  See docs/ai-health.md, "Passivity: activation half is mostly RAW". */
function movableInto(G, side, sysId) {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  let n = 0;
  for (const nb of (G.catalog.adjacency[sysId] ?? [])) {
    // RR p.2: our own leader standing here pins every unit in the system.
    if ((f.leadersOnBoard[nb] ?? []).length > 0) continue;
    let selfMoving = 0, capacity = 0, needCarry = 0;
    for (const u of (G.map.systems[nb]?.units ?? [])) {
      if (u.side !== side) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t || t.transport?.immobile || t.class === 'structure') continue;
      if (t.transport?.capacity > 0) { selfMoving++; capacity += t.transport.capacity; }
      else if (AI.isSelfMovingUnit(t)) selfMoving++;
      else needCarry++;
    }
    n += selfMoving + Math.min(capacity, needCarry);
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
            // Generator produced nothing. Did it actually have a LEGAL move?
            // movableInto now applies the own-leader pin and transport capacity,
            // so 'units WERE movable' means a real move existed and was vetoed
            // anyway — that bucket, and only that one, is a bug.
            const couldMove = Object.keys(G.map.systems).some((s) => movableInto(G, side, s) > 0);
            bump(side, couldMove
              ? 'no-positive-system (a LEGAL move existed — real gap)'
              : 'no-positive-system (no legal move — RAW-correct pass)');
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
