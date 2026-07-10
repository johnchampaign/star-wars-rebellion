// Diagnostic: what does the strike-fleet plan actually DO post-reveal in self-play?
// Runs planner-ON self-play and, at every Empire Command decision where the base
// is revealed, records the plan mode, whether co-location has a valid target,
// and whether the plan bonus CHANGES the Empire's chosen activation vs baseline.
// Usage: SWR_EMPIRE_PLANNER=1 node scripts/diag-planner.mjs [games]
import { readFileSync } from 'node:fs';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const ai = await import('../src/play/randomAI.ts');
const planner = await import('../src/play/empirePlanner.ts');
const j = (p) => JSON.parse(readFileSync(new URL('../assets/' + p, import.meta.url), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const N = parseInt(process.argv[2] ?? '60', 10);

console.log('planner enabled:', planner.PLANNER_ENABLED);
const modeCount = { STAGE: 0, READY: 0, STRIKE: 0 };
let decisions = 0, planNonNull = 0, coLocateAvail = 0, topChanged = 0, nonzeroBonusSystems = 0;
let canImprove = 0, deferApplied = 0, wouldAssaultBase = 0, planChangedTop = 0;
const sum = { needed: 0, massed: 0, staged: 0 };

for (let i = 0; i < N; i++) {
  const seed = 1000 + i; ai.seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: false });
  let s = 0; while (G.phase === 'Setup' && s++ < 100) { if (!ai.stepOnce(G, G.currentPlayer)) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!ai.stepOnce(G, o)) { phases.setupAutoFill(G, 'Rebel'); phases.setupAutoFill(G, 'Empire'); } } }
  let st = 0;
  while (!G.isGameOver && st < 200000) {
    const sd = G.currentPlayer;
    // Inspect Empire Command decisions with the base revealed.
    if (sd === 'Empire' && G.phase === 'Command' && G.rebelBaseRevealed && !G.pendingChoice && !G.pendingCombat) {
      const plan = planner.derivePlan(G);
      if (plan) {
        decisions++; planNonNull++; modeCount[plan.mode]++;
        sum.needed += plan.neededGround; sum.massed += plan.massedGround; sum.staged += plan.stagedGround;
        // Carrier economy near the base: total Empire carriers and how many sit
        // within 2 hops of the base (the delivery bottleneck if ~0).
        { const db = {}; { const q=[plan.targetSystemId]; db[plan.targetSystemId]=0; while(q.length){const c=q.shift(); if(db[c]>=2) continue; for(const n of (G.catalog.adjacency[c]??[])) if(db[n]==null){db[n]=db[c]+1;q.push(n);}} }
          let totCar=0, nearCar=0, nearGround=0;
          for (const [sid,ss] of Object.entries(G.map.systems)) for (const u of ss.units) { if(u.side!=='Empire')continue; const t=G.catalog.unitTypes[u.typeId]; const cap=(t&&!t.transport.immobile)?(t.transport.capacity??0):0; if(cap>0){totCar++; if(db[sid]!=null)nearCar++;} if(t&&t.theater==='ground'&&t.class!=='structure'&&!t.transport.immobile&&db[sid]!=null)nearGround++; }
          sum.totCar=(sum.totCar??0)+totCar; sum.nearCar=(sum.nearCar??0)+nearCar; sum.nearGround=(sum.nearGround??0)+nearGround; }
        if (plan.canImproveDelivery) canImprove++;
        const baseBonus = planner.planSystemBonus(G, plan, plan.targetSystemId);
        if (baseBonus < 0) deferApplied++;
        // What would the Empire pick WITHOUT the planner? Temporarily disable by
        // comparing the top action's target: recompute top action and see if the
        // base is the winner and whether the defer flips it.
        const top = ai.bestCommandAction(G, 'Empire')[0];
        if (top && top.kind === 'activate' && top.targetSystemId === plan.targetSystemId) wouldAssaultBase++;
        // co-location availability: any system ≤2 hops from base with stranded free ground + adjacent carrier
        let coloc = false, nonzero = 0;
        for (const sid of Object.keys(G.map.systems)) {
          const b = planner.planSystemBonus(G, plan, sid);
          if (b > 0) nonzero++;
        }
        nonzeroBonusSystems += nonzero;
        // Does the plan change the top action? Compare with vs without the bonus.
        const withPlan = ai.bestCommandAction(G, 'Empire')[0];
        // recompute baseline by temporarily... we can't easily disable; approximate:
        // find the top activate target's plan bonus — if the winning action is an
        // activate whose target has a nonzero plan bonus, count as plausibly-changed.
        if (withPlan && withPlan.kind === 'activate' && planner.planSystemBonus(G, plan, withPlan.targetSystemId) > 0) topChanged++;
        for (const sid of Object.keys(G.map.systems)) {
          const ss = G.map.systems[sid];
          const d = // quick 2-hop check
            (G.catalog.adjacency[plan.targetSystemId] ?? []).includes(sid) ||
            (G.catalog.adjacency[plan.targetSystemId] ?? []).some((n) => (G.catalog.adjacency[n] ?? []).includes(sid));
          if (!d || sid === plan.targetSystemId) continue;
          let stranded = 0; for (const u of ss.units) { const t = G.catalog.unitTypes[u.typeId]; if (u.side === 'Empire' && t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile) stranded++; }
          const hasCarrier = ss.units.some((u) => (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) > 0 && u.side === 'Empire');
          const carrierAdj = (G.catalog.adjacency[sid] ?? []).some((a) => (G.map.systems[a]?.units ?? []).some((u) => u.side === 'Empire' && (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) > 0));
          if (stranded > 0 && !hasCarrier && carrierAdj) { coloc = true; break; }
        }
        if (coloc) coLocateAvail++;
      }
    }
    if (ai.stepOnce(G, sd)) { st++; continue; }
    const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (ai.stepOnce(G, o)) { st++; continue; } break;
  }
  if (!G.isGameOver && G.timeMarker > 16) G.isGameOver = true;
}
console.log(`Empire post-reveal Command decisions with a plan: ${decisions}`);
console.log(`  modes:`, modeCount);
console.log(`  decisions where co-location was AVAILABLE:  ${coLocateAvail}`);
console.log(`  avg systems with nonzero plan bonus/decision: ${decisions ? (nonzeroBonusSystems / decisions).toFixed(1) : 0}`);
console.log(`  decisions where chosen activate had a plan bonus (plausibly plan-driven): ${topChanged}`);
console.log(`  canImproveDelivery TRUE: ${canImprove}   base-defer bonus applied (<0): ${deferApplied}`);
console.log(`  top action = activate the base (with planner ON): ${wouldAssaultBase}`);
console.log(`  avg needed=${(sum.needed/Math.max(1,decisions)).toFixed(1)} massed=${(sum.massed/Math.max(1,decisions)).toFixed(1)} staged=${(sum.staged/Math.max(1,decisions)).toFixed(1)}`);
const d = Math.max(1, decisions);
console.log(`  carrier economy: total Empire carriers=${((sum.totCar??0)/d).toFixed(1)}  carriers within 2 hops of base=${((sum.nearCar??0)/d).toFixed(1)}  ground within 2 hops=${((sum.nearGround??0)/d).toFixed(1)}`);
