// Minimal random AI for development. Makes valid, mostly-random choices in
// every phase so a solo human can play through end-to-end. Intentionally dumb:
// no heuristics, no lookahead. Replace with a real controller later.
//
// Contract: stepOnce(G, side) performs exactly one engine call when it's `side`'s
// turn. The caller is expected to call it in a loop (with refresh in between)
// until G.currentPlayer flips back to the human, the game ends, or we're in a
// state with no valid AI action.

import type { GameState, Side, LeaderId } from '../engine/types';
import * as phases from '../engine/phases';
import * as combat from '../engine/combat';

function pick<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Run one AI action for `side`. Returns true if something happened (caller
 *  should re-render and may call again), false if nothing left to do. */
export function stepOnce(G: GameState, side: Side): boolean {
  if (G.isGameOver) return false;

  // Pending-choice handlers run REGARDLESS of whose turn it is: an opponent
  // can owe a choice (e.g. OpposeMission during the other side's turn,
  // CombatAttackerTactics/CombatDefenderTactics mid-combat).
  if (G.pendingChoice && G.pendingChoice.kind === 'OpposeMission' && G.pendingChoice.opposerSide === side) {
    console.log('[ai] handleOpposeMission', { side, choice: G.pendingChoice });
    const ok = handleOpposeMission(G, side);
    console.log('[ai] handleOpposeMission done', { ok, newChoice: G.pendingChoice?.kind });
    return ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatAttackerTactics' && G.pendingChoice.side === side) {
    return handleCombatAttackerTactics(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatDefenderTactics' && G.pendingChoice.side === side) {
    return handleCombatDefenderTactics(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'BuildPick' && G.pendingChoice.side === side) {
    return handleBuildPick(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatAssignDamage' && G.pendingChoice.side === side) {
    return handleCombatAssignDamage(G);
  }

  // From here on, only act on our own turn.
  if (G.currentPlayer !== side) return false;

  // If a player choice is pending and this side owns it, resolve it first.
  if (G.pendingChoice && G.pendingChoice.kind === 'StolenPlansReorder' && side === 'Rebel') {
    const c = G.pendingChoice;
    // Pick the highest-rep remaining card to place next on top.
    let best = c.remaining[0];
    let bestRep = G.catalog.objectives[best]?.reputation ?? 0;
    for (const cid of c.remaining.slice(1)) {
      const rep = G.catalog.objectives[cid]?.reputation ?? 0;
      if (rep > bestRep) { best = cid; bestRep = rep; }
    }
    const r = phases.resolveStolenPlansPick(G, best);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'InfiltrationPick' && side === 'Rebel') {
    const c = G.pendingChoice;
    const repTop = G.catalog.objectives[c.topId]?.reputation ?? 0;
    const repBottom = G.catalog.objectives[c.bottomId]?.reputation ?? 0;
    const keep = repTop >= repBottom ? c.topId : c.bottomId;
    const r = phases.resolveInfiltrationPick(G, keep);
    return r.ok;
  }
  switch (G.phase) {
    case 'Setup': {
      // If we're the Rebel and a base pick is pending, pick first.
      if (side === 'Rebel' && G.pendingRebelBasePick && G.pendingRebelBasePick.length > 0) {
        const picked = pick(G.pendingRebelBasePick)!;
        const r = phases.pickRebelBase(G, picked);
        if (r.ok) return true;
      }
      // Auto-fill all remaining units for this side.
      const r = phases.setupAutoFill(G, side);
      return r.ok;
    }
    case 'Assignment': {
      // 50/50: try assigning one random leader to one random mission, else skip.
      const f = side === 'Rebel' ? G.rebel : G.empire;
      if (Math.random() < 0.5 && f.missionHand.length > 0 && f.leaderPool.length > 0) {
        const missionId = pick(f.missionHand)!;
        const leaderId = pick(f.leaderPool)! as LeaderId;
        const r = phases.assignLeader(G, side, missionId, [leaderId]);
        if (r.ok) return true;
        // fall through to skip if invalid
      }
      const r = phases.skipAssignment(G, side);
      return r.ok;
    }
    case 'Command': {
      // Priority 1: if any assigned mission has enough skill, reveal it
      // (random target system). This keeps assigned missions from sitting
      // unresolved forever.
      const f = side === 'Rebel' ? G.rebel : G.empire;
      const revealable = f.leadersOnMissions.filter((am) => {
        const card = G.catalog.missions[am.missionId];
        if (!card || !card.skill) return false;
        let total = 0;
        for (const lid of am.leaderIds) {
          const ld = G.catalog.leaders[lid];
          if (ld) total += ld.skills[card.skill as keyof typeof ld.skills] ?? 0;
        }
        return total >= card.skillCost;
      });
      if (revealable.length > 0 && Math.random() < 0.6) {
        const am = pick(revealable)!;
        const sysIds = Object.keys(G.map.systems);
        for (let attempt = 0; attempt < 5; attempt++) {
          const targetSystemId = pick(sysIds)!;
          const r = phases.revealMission(G, side, am.missionId, targetSystemId);
          if (r.ok) return true;
        }
      }
      // 70%: try to activate a system with a random eligible leader + random
      // target. 30%: pass. If activation fails (no eligible leader / engine
      // rejection), fall through to pass so we don't get stuck.
      const eligible = f.leaderPool.filter((lid) => {
        const l = G.catalog.leaders[lid];
        return l && (l.tacticValues.space + l.tacticValues.ground) > 0;
      });
      if (eligible.length > 0 && Math.random() < 0.70) {
        const leaderId = pick(eligible)!;
        const sysIds = Object.keys(G.map.systems);
        // Try up to 5 random targets in case the first hits a friendly-leader
        // block or other engine reject.
        for (let attempt = 0; attempt < 5; attempt++) {
          const targetSystemId = pick(sysIds)!;
          // Maybe pull some units from one random adjacent friendly system.
          const orders: phases.MoveOrder[] = [];
          if (Math.random() < 0.5) {
            const adj = G.catalog.adjacency[targetSystemId] ?? [];
            const candidates = adj.filter((sysId) => {
              if ((f.leadersOnBoard[sysId] ?? []).length > 0) return false;
              const ss = G.map.systems[sysId];
              return ss && ss.units.some((u) => u.side === side);
            });
            const fromId = pick(candidates);
            if (fromId) {
              const ss = G.map.systems[fromId];
              const mine = ss.units.filter((u) => u.side === side);
              // Move 1-3 random units.
              const n = Math.min(mine.length, 1 + Math.floor(Math.random() * 3));
              const shuffled = [...mine].sort(() => Math.random() - 0.5).slice(0, n);
              orders.push({ fromSystemId: fromId, unitInstanceIds: shuffled.map((u) => u.instanceId) });
            }
          }
          const r = phases.activateSystem(G, side, leaderId, targetSystemId, orders);
          if (r.ok) return true;
        }
      }
      const r = phases.pass(G, side);
      return r.ok;
    }
    default:
      return false;
  }
}

function handleOpposeMission(G: GameState, side: Side): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'OpposeMission' }>;
  const skill = c.skill;
  // Pick the best pool leader: max matching-skill icons; ties broken by lowest
  // total leader value (don't burn a strong leader as a 0-skill blocker).
  let best: { lid: LeaderId; m: number; v: number } | null = null;
  for (const lid of c.poolLeaders) {
    const ld = G.catalog.leaders[lid];
    if (!ld) continue;
    const m = (ld.skills as Record<string, number>)[skill] ?? 0;
    const v = ld.skills.diplomacy + ld.skills.intel + ld.skills.specOps + ld.skills.logistics
           + ld.tacticValues.space + ld.tacticValues.ground;
    if (!best || m > best.m || (m === best.m && v < best.v)) best = { lid, m, v };
  }
  let sentLeader: LeaderId | null = null;
  if (best) {
    const haveExisting = c.existingAtTarget.length > 0;
    if (best.m >= 1) sentLeader = best.lid;
    else if (!haveExisting && c.attackerDice <= 1) sentLeader = best.lid;
  }
  const r = phases.resolveOpposition(G, sentLeader);
  return r.ok;
}

// ---------- Combat tactic-card heuristics --------------------------------
// Mirrors the prior auto-play behaviour now that those helpers are gone.

function handleCombatAttackerTactics(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAttackerTactics' }>;
  const hits = c.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
  const blanks = c.dice.filter((d) => d.face === 'blank').length;
  let concentrateFire: string | null = null;
  // Concentrate Fire if hit rate < 50% AND we have blanks to reroll.
  if (c.dice.length > 0 && blanks > 0 && hits < Math.ceil(c.dice.length / 2)) {
    concentrateFire = c.hand.find((cid) => cid.includes('concentrate-fire')) ?? null;
  }
  const damageBoosts: string[] = [];
  for (const sub of ['take-it-down', 'critical-hit', 'onslaught']) {
    const cid = c.hand.find((x) => x.includes(sub));
    if (cid) damageBoosts.push(cid);
  }
  const r = combat.resolveCombatAttackerTactics(G, {
    concentrateFireCardId: concentrateFire,
    damageBoostCardIds: damageBoosts,
  });
  return r.ok;
}

function handleCombatDefenderTactics(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatDefenderTactics' }>;
  const blockCards: string[] = [];
  const sacrifices: string[] = [];
  if (c.incomingHits > 0) {
    // Free block first.
    const free = c.hand.find((cid) => cid.includes('defensive-formation'));
    if (free) blockCards.push(free);
    // Then dig-in / outmaneuver if we have a sacrificial spare.
    const paid = c.hand.find((cid) =>
      (cid.includes('dig-in') && c.theater === 'ground') ||
      (cid.includes('outmaneuver') && c.theater === 'space')
    );
    if (paid && c.hand.length >= 2) {
      const sacrifice = c.hand.find((cid) =>
        cid !== paid && cid !== free && !cid.includes('concentrate-fire') // keep concentrate-fire if we have it for next time
      );
      if (sacrifice) { blockCards.push(paid); sacrifices.push(sacrifice); }
    }
  }
  const r = combat.resolveCombatDefenderTactics(G, { blockCardIds: blockCards, sacrificeCardIds: sacrifices });
  return r.ok;
}

// ---------- Build-pick heuristic --------------------------------
// Picks the first legal unit type for each entry (matches the prior
// auto-behavior). Real game would diversify, but this keeps AI-vs-AI
// games running without a UI prompt.
function handleBuildPick(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'BuildPick' }>;
  const choices = c.picks.map((p) => p.legalUnitTypes[0]);
  const r = phases.resolveBuildPicks(G, choices);
  return r.ok;
}

/** AI damage-assignment heuristic — for each incoming hit, pick the
 *  weakest legal target (lowest current effective HP, ties broken by
 *  smaller tier first). Tracks already-staged targets across hits so we
 *  don't waste damage on the same instance. */
function handleCombatAssignDamage(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAssignDamage' }>;
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  const assigned = new Map<string, number>(); // instanceId → damage already queued
  const assignments: (string | null)[] = [];

  // Find the live unit instance from catalog data + current map state.
  const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
  for (let i = 0; i < c.hits.length; i++) {
    const targets = c.targetsByHit[i];
    if (targets.length === 0) { assignments.push(null); continue; }
    let best: { id: string; remaining: number; tier: number } | null = null;
    for (const tid of targets) {
      const u = ss?.units.find((x) => x.instanceId === tid);
      if (!u) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      const queued = assigned.get(tid) ?? 0;
      const remaining = (t.health.value ?? 1) - (u.damage ?? 0) - queued;
      if (remaining <= 0) continue; // already dead under queued damage
      const tier = tierRank[t.tier ?? 'square'] ?? 9;
      if (!best || remaining < best.remaining || (remaining === best.remaining && tier < best.tier)) {
        best = { id: tid, remaining, tier };
      }
    }
    if (best) {
      assignments.push(best.id);
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1);
    } else {
      assignments.push(null);
    }
  }
  const r = combat.resolveCombatAssignDamage(G, assignments);
  return r.ok;
}
