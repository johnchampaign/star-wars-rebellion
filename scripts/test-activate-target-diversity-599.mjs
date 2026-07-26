// #599 — "Why are the imperials activating all their leaders to one system and
// not moving units?" (also feeds #605's low-skill-leader-sent-to-a-system.)
//
// bestCommandAction used to loop over pool leaders and hand EVERY one the argmax
// of a LEADER-INDEPENDENT system score. So N eligible leaders produced N
// candidates that all named the SAME system, and the AI never compared two
// destinations within a single decision. Measured at 2.33 activate candidates
// from 2.34 eligible leaders but only 1.00 distinct target
// (scripts/diag-idle-activations.mjs).
//
// It also starved the search: searchMctsCommand takes
// bestCommandAction(...).slice(0, topK), so duplicate targets consumed top-K
// slots that genuine alternatives never got.
//
// Now distinct positive-scoring systems are walked best-first and each is paired
// with the best-suited free leader (tactic values weighted by the theatre the
// fight would happen in).
// Run: node scripts/test-activate-target-diversity-599.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ #599 — activation candidates must offer distinct destinations ]');
{
  // Walk self-play and record, over every decision where more than one leader
  // could activate, how many DISTINCT target systems the generator offered.
  let multiLeaderDecisions = 0, duplicateTargetDecisions = 0, acts = 0, distinct = 0;
  for (let seed = 1; seed <= 8; seed++) {
    ai.seedAI(seed);
    const G = createGame(data, { seed, autoSetupUnits: true,
      expansion: { enabled: true, roteUnits: true, roteMissionsRebel: true, roteMissionsEmpire: true } });
    let guard = 0;
    while (!G.isGameOver && guard++ < 6000) {
      const side = G.currentPlayer;
      if (G.phase === 'Command' && !G.pendingChoice && !G.pendingMission && !G.pendingCombat) {
        let list = null;
        try { list = ai.bestCommandAction(G, side); } catch { /* ignore */ }
        if (list) {
          const a = list.filter((x) => x.kind === 'activate');
          if (a.length > 1) {
            multiLeaderDecisions++;
            const d = new Set(a.map((x) => x.targetSystemId)).size;
            acts += a.length; distinct += d;
            if (d < a.length) duplicateTargetDecisions++;
          }
        }
      }
      if (!ai.stepOnce(G, side)) {
        const o = side === 'Rebel' ? 'Empire' : 'Rebel';
        if (!ai.stepOnce(G, o)) break;
      }
    }
  }
  console.log(`    ${multiLeaderDecisions} multi-leader decisions, ${acts} activate candidates, ${distinct} distinct targets`);
  check('every leader does not get sent to the same system',
    duplicateTargetDecisions === 0,
    `${duplicateTargetDecisions}/${multiLeaderDecisions} decisions still offered duplicate targets`);
  // Pre-fix this ratio was exactly 1 distinct target per decision no matter how
  // many leaders were free; it should now track the candidate count.
  check('distinct targets scale with the number of candidates',
    multiLeaderDecisions === 0 || distinct === acts,
    `${distinct} distinct across ${acts} candidates`);
}

console.log('[ #605 — the better-suited leader should lead the fight ]');
{
  // A ground fight at the target: the leader with the higher GROUND tactic
  // value should be the one proposed, not whoever sits first in pool order.
  ai.seedAI(3);
  const G = createGame(data, { seed: 11, autoSetupUnits: true, expansion: { enabled: true, roteUnits: true } });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.side !== 'Empire');
  G.empire.leadersOnBoard = {}; G.empire.leadersOnMissions = [];
  const TARGET = Object.keys(G.map.systems).find((s) => (G.catalog.adjacency[s] ?? []).length > 0);
  const nbr = (G.catalog.adjacency[TARGET] ?? [])[0];
  const mk = (t, side) => ({ instanceId: t + Math.random(), typeId: t, side, damage: 0 });
  // Rebel GROUND defenders at the target; Empire ground next door to march in.
  G.map.systems[TARGET].units = [mk('rebel-trooper', 'Rebel'), mk('rebel-trooper', 'Rebel')];
  G.map.systems[nbr].units = [mk('stormtrooper', 'Empire'), mk('stormtrooper', 'Empire'), mk('assault-tank', 'Empire')];

  // Pick two pool leaders with clearly different ground tactic values.
  const withGround = Object.values(G.catalog.leaders)
    .filter((l) => l.side === 'Empire' && (l.tacticValues.space + l.tacticValues.ground) > 0)
    .sort((a, b) => b.tacticValues.ground - a.tacticValues.ground);
  const strong = withGround[0], weak = withGround[withGround.length - 1];
  if (!strong || !weak || strong.tacticValues.ground === weak.tacticValues.ground) {
    check('catalog has leaders with differing ground tactics (skipped)', true);
  } else {
    // Weak one FIRST in pool order — pre-fix that alone decided the pick.
    G.empire.leaderPool = [weak.id, strong.id];
    const acts = ai.bestCommandAction(G, 'Empire');
    const atTarget = acts.find((a) => a.kind === 'activate' && a.targetSystemId === TARGET);
    check(`the higher-ground-tactic leader leads a ground fight (${strong.id} g=${strong.tacticValues.ground} over ${weak.id} g=${weak.tacticValues.ground})`,
      !atTarget || atTarget.leaderId === strong.id,
      `picked ${atTarget?.leaderId}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
