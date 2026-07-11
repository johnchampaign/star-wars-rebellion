// Empire strike-fleet plan layer (#539) — the delivery executor.
//
// WHY THIS EXISTS
// The AI Empire finds the Rebel base on schedule but cannot finish: at reveal
// ~9.6 mobile ground is staged within 2 hops of the base, yet only ~5.1 is
// DELIVERED to the assault (consolidation-bench). Capturing the base is a
// multi-turn logistics sequence — co-locate a carrier with each stranded ground
// stack, ferry it inward, mass the ground theater, then dash — and the greedy
// per-action Command scorer has no memory, so consecutive activations never
// compose into one maneuver. Ten scoring nudges were tried and came back inert
// or negative because they lacked a STABLE, DOMINANT aim point that persists
// across turns.
//
// SCOPE: POST-REVEAL ONLY. Firing a dominant aim point BEFORE the base is
// revealed collapses the Empire (measured 60g A/B: win 55%→25%, base-found
// 30→19) because it pulls every leader toward one suspect region and starves the
// hunt — the net-negative "blanket pre-reveal ferry" the diagnosis warned about.
// The delivery failure this fixes (#538: base revealed 3 turns, force never
// composed) is post-reveal, so the planner leaves the hunt scoring untouched and
// only engages once the base is exposed.
//
// WHAT THIS IS
// `derivePlan(G)` is a PURE function recomputed deterministically from public
// state each turn (no serialized plan state → codec/online schema untouched,
// seeded A/Bs stay reproducible). It reports the force requirement and a mode
// (STAGE → READY → STRIKE). `planSystemBonus` turns the plan into a dominant,
// stable bonus the Command scorer adds when activating a system: carrier↔ground
// co-location and an inward gradient toward the base every turn (so ground
// actually reaches the assault), plus a force-gated dash in STRIKE.
//
// HARD CONSTRAINTS (violating these has measurably hurt Empire win rate before):
//   - Never strip the last garrison unit from a subjugated system — the executor
//     (tryCommandAction groundReserve) enforces this; the planner's accounting
//     excludes that reserved ground so it never counts on it.
//   - Never suppress lone-leader scouting moves (#446) — the planner only ADDS
//     positive bonuses; it never zeroes or penalizes a hunting activation.
//   - No under-strength rush: the base-dash bonus fires ONLY in STRIKE (force
//     already sufficient); in STAGE/READY the plan adds nothing on the base
//     itself, leaving the scorer's own readiness gate to decide when to assault.
//
// Env-gated (SWR_EMPIRE_PLANNER=1) for A/B. Off by default → byte-identical to
// the pre-planner scorer.

import type { GameState, SystemId } from '../engine/types';

export type PlanMode = 'STAGE' | 'READY' | 'STRIKE';

export interface StrikeFleetPlan {
  /** Reporting-only labels (STAGE/READY/STRIKE) — the modes NO LONGER gate the
   *  attack. Doctrine correction from John (playtest #1 review): "stage first"
   *  is the wrong attitude — the force grows WHILE moving (build/deploy en
   *  route, merge converging groups), and attacking with an inferior force is
   *  usually worthwhile (Imperial production wins the attrition trade, and a
   *  space-only win denies the Rebel future deploys at the base). The base
   *  bonus below therefore scales with the deliverable WAVE, from the first
   *  real wave up — STRIKE just adds a kicker when the wave is decisive. */
  mode: PlanMode;
  /** The revealed Rebel base — the sink all delivery flows toward. */
  targetSystemId: SystemId;
  /** Ground defenders to clear + margin, in the ground theater. */
  neededGround: number;
  /** Empire free ground deliverable to the base in ONE activation (already at
   *  the base + liftable from base-adjacent co-located carriers). */
  massedGround: number;
  /** Empire mobile SPACE units deliverable in one activation (at the base +
   *  base-adjacent, leader-free). A ships-only wave has real value: winning the
   *  base's space theater blocks Rebel deployment there (doctrine). */
  massedShips: number;
  /** Empire free mobile ground within 2 hops of the base (the staging pool). */
  stagedGround: number;
  /** Hop distance from the base for every reachable system — computed once per
   *  plan so the per-system bonus never re-runs a BFS. Runtime-only (the plan
   *  is derived, never serialized). */
  distFromBase: Map<string, number>;
}

// ---- enable gate ----
// Two independent switches, OR'd (each guarded so the other runtime is safe):
//   - node harnesses (tournament/bench/fixtures): SWR_EMPIRE_PLANNER=1 env var,
//     exactly as before.
//   - browser (live playtest): visit any URL with ?planner=1 once — it persists
//     to localStorage['swr-empire-planner'] so the flag survives reloads and new
//     games; ?planner=0 clears it. Evaluated once at module load, so mid-game
//     toggles don't half-apply: set the flag, THEN start/reload the game.
// Default (no env, no flag): OFF — production behavior is byte-identical.
// PlayTab shows a visible "EMPIRE PLANNER ON" badge and stamps the flag into
// the archived game record, so playtest logs are attributable when mining.
export const PLANNER_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_EMPIRE_PLANNER === '1') return true;
  } catch { /* browser: no process */ }
  try {
    const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } };
    const q = g.location?.search ? new URLSearchParams(g.location.search).get('planner') : null;
    if (q === '1') g.localStorage?.setItem('swr-empire-planner', '1');
    else if (q === '0') g.localStorage?.removeItem('swr-empire-planner');
    return g.localStorage?.getItem('swr-empire-planner') === '1';
  } catch { /* node without env flag, or storage blocked */ }
  return false;
})();

// ---------------------------------------------------------------------------
// Unit helpers (mirror the scorer's classification exactly).
// ---------------------------------------------------------------------------
function isMobileGround(G: GameState, typeId: string): boolean {
  const t = G.catalog.unitTypes[typeId];
  return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile;
}
function carrierCapacity(G: GameState, typeId: string): number {
  const t = G.catalog.unitTypes[typeId];
  return t && !t.transport.immobile ? (t.transport.capacity ?? 0) : 0;
}

function bfs(G: GameState, origin: SystemId, maxHops: number): Map<string, number> {
  const dist = new Map<string, number>([[origin, 0]]);
  let frontier = [origin];
  for (let d = 1; d <= maxHops; d++) {
    const next: string[] = [];
    for (const s of frontier) {
      for (const a of (G.catalog.adjacency[s] ?? [])) {
        if (!dist.has(a)) { dist.set(a, d); next.push(a); }
      }
    }
    frontier = next;
  }
  return dist;
}

/** Empire free mobile ground at a system — total mobile ground minus the one
 *  garrison unit the executor reserves at a still-subjugated system (never
 *  counted on, per the hard constraint). Post-reveal the executor commits every
 *  ground unit, so nothing is reserved. */
function freeGroundAt(G: GameState, sysId: SystemId): number {
  const ss = G.map.systems[sysId];
  if (!ss) return 0;
  let g = 0;
  for (const u of ss.units) if (u.side === 'Empire' && isMobileGround(G, u.typeId)) g++;
  if (!G.rebelBaseRevealed && ss.subjugated && g > 0) g -= 1; // reserved garrison
  return g;
}
function carrierCapacityAt(G: GameState, sysId: SystemId): number {
  const ss = G.map.systems[sysId];
  if (!ss) return 0;
  let c = 0;
  for (const u of ss.units) if (u.side === 'Empire') c += carrierCapacity(G, u.typeId);
  return c;
}
function hasEmpireCarrierAt(G: GameState, sysId: SystemId): boolean {
  return carrierCapacityAt(G, sysId) > 0;
}

// ---------------------------------------------------------------------------
// derivePlan — the pure planner. Empire perspective. null = no plan this turn
// (base not revealed, or no base id).
// ---------------------------------------------------------------------------
export function derivePlan(G: GameState): StrikeFleetPlan | null {
  if (!G.rebelBaseRevealed || !G.rebelBaseSystemId) return null;
  const target = G.rebelBaseSystemId as SystemId;

  // Force requirement: real Rebel ground + structures at the base + a margin so
  // we win the ground fight (matches the scorer's own assault gate). Structures
  // must be destroyed to take the system even though they don't attack.
  let rebelGround = 0;
  for (const u of G.map.systems[target]?.units ?? []) {
    const t = G.catalog.unitTypes[u.typeId];
    if (u.side === 'Rebel' && t?.theater === 'ground') rebelGround++;
  }
  const neededGround = rebelGround + 2;

  // Ground already at the base, plus what a co-located carrier on a base-adjacent
  // system can lift in one activation → the one-activation deliverable force.
  // Ships counted separately: space units self-move, and a ships-only wave that
  // wins the base's space theater blocks Rebel deployment there (doctrine).
  const groundAtBase = freeGroundAt(G, target);
  const shipsAt = (sid: SystemId): number => {
    let s = 0;
    for (const u of G.map.systems[sid]?.units ?? []) {
      if (u.side !== 'Empire') continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (t && t.theater === 'space' && !t.transport.immobile) s++;
    }
    return s;
  };
  let liftableAdjacent = 0;
  let massedShips = shipsAt(target);
  for (const n of (G.catalog.adjacency[target] ?? [])) {
    // A leader on the neighbor blocks pulling its units into the base.
    if ((G.empire.leadersOnBoard[n] ?? []).length > 0) continue;
    liftableAdjacent += Math.min(freeGroundAt(G, n), carrierCapacityAt(G, n));
    massedShips += shipsAt(n);
  }
  const massedGround = groundAtBase + liftableAdjacent;

  // Map-wide distance from the base (one BFS per plan; the march gradient needs
  // it for every system, not just the 2-hop ring).
  const distFromBase = bfs(G, target, 12);

  // Staging pool: free ground within 2 hops of the base.
  let stagedGround = 0;
  for (const sid of Object.keys(G.map.systems)) {
    if (sid === target) continue;
    if ((distFromBase.get(sid) ?? 99) <= 2) stagedGround += freeGroundAt(G, sid);
  }
  stagedGround += groundAtBase;

  let mode: PlanMode;
  if (massedGround >= neededGround) mode = 'STRIKE';      // dash: deliverable force wins the ground fight
  else if (stagedGround >= neededGround) mode = 'READY';  // force is near — co-locate + mass it inward
  else mode = 'STAGE';                                    // consolidate more force toward the base

  return { mode, targetSystemId: target, neededGround, massedGround, massedShips, stagedGround, distFromBase };
}

// ---------------------------------------------------------------------------
// planSystemBonus — the dominant, stable bonus the Command scorer ADDS for
// activating `sysId`. Only positive (never suppresses a hunting move). Returns 0
// when the planner is disabled or plan is null (caller also guards).
// ---------------------------------------------------------------------------

// Dominant over the pre-planner staging/converge bonuses (+18 stage, +10/+5
// gradient) so the SAME sink wins the activation turn after turn — that
// stability is the point (a fixed aim composes into multi-turn logistics where a
// thrashing per-turn nudge can't). Deliberately NOT larger than the scorer's own
// base-converge readiness gate on the base system, which still governs the
// assault trigger.
const B_COLOCATE = 30;      // co-locate a carrier with a stranded free-ground stack near the base
// Attack-wave floor: the minimum deliverable ground that counts as a real wave.
// Below this (and without a fleet) the planner adds nothing on the base — a
// near-empty activation is the measured leader-gift failure (68% of leader-only
// base invasions in lost games), not doctrine aggression.
const WAVE_FLOOR_GROUND = 3;
const RAID_FLOOR_SHIPS = 4;
// March-pull gradient weight by the pull-target's distance from the base. The
// bonus is weight × liftable force pulled inward (capped), so marching a real
// strike stack dominates subjugation/mission scores (~12-29 post-reveal) while
// a token 1-unit shuffle doesn't. Map-wide on purpose: John's live playtest
// (mon-calamari, t3 reveal) had 16 ground + 6 carriers co-located THREE hops
// out and the old ≤3-hop, holds-units-only gradient never out-scored a
// subjugation — the army sat still for the whole 2-turn reveal window.
const MARCH_W: Record<number, number> = { 1: 3.5, 2: 3.0, 3: 2.5, 4: 2.0, 5: 1.5 };
const MARCH_W_FAR = 1.0;    // 6+ hops — still marches, just softer
const MARCH_PULL_CAP = 8;   // force units of pull that count toward the bonus

export function planSystemBonus(G: GameState, plan: StrikeFleetPlan, sysId: SystemId): number {
  const { mode, targetSystemId, distFromBase } = plan;
  const ss = G.map.systems[sysId];
  if (!ss) return 0;

  // A leader already here can't pull units out (activating moves nothing), so
  // never reward parking a second leader on a feeder/co-location system.
  const leaderHere = (G.empire.leadersOnBoard[sysId] ?? []).length > 0;

  // 1) The base itself — attack-wave bonus, scaled by what's DELIVERABLE now.
  //    Doctrine (John, playtest #1 review): don't wait to be "ready". The
  //    Empire out-produces the Rebels, so throwing a real-but-inferior wave at
  //    the base is usually worthwhile (attrition trade + every wave the march
  //    keeps feeding), and a ships-only wave that wins the space theater blocks
  //    Rebel deployment at the base. So:
  //      - deliverable ground ≥ WAVE_FLOOR: assault wave — bonus grows with the
  //        wave's ground + ships; STRIKE (decisive force) adds a kicker.
  //      - else deliverable ships ≥ RAID_FLOOR: space-denial raid — smaller
  //        bonus; the scorer's own no-ground penalty (−12) stays as the
  //        counterweight, so raids fire only with a real fleet.
  //      - else 0: never reward a near-empty activation (the leader-gift trap).
  if (sysId === targetSystemId) {
    const g = plan.massedGround, s = plan.massedShips;
    if (g >= WAVE_FLOOR_GROUND) {
      return 8 + 2 * Math.min(g, 8) + Math.min(s, 6) + (mode === 'STRIKE' ? 8 : 0);
    }
    if (s >= RAID_FLOOR_SHIPS) return 4 + 1.5 * Math.min(s, 8);
    return 0;
  }

  const dBase = distFromBase.get(sysId) ?? 99;
  if (leaderHere || dBase < 1 || dBase > 90) return 0;

  // 2) Carrier↔ground co-location: a base-adjacent-ish system holding stranded
  //    free ground with NO local carrier but a carrier one hop away — activating
  //    it pulls the carrier in so next turn the ground ferries to the base.
  //    ≤2 hops only, so we never ferry lift away from the hunt elsewhere.
  if (dBase <= 2) {
    const stranded = freeGroundAt(G, sysId);
    if (stranded > 0 && !hasEmpireCarrierAt(G, sysId)) {
      const carrierAdjacent = (G.catalog.adjacency[sysId] ?? []).some((a) => hasEmpireCarrierAt(G, a));
      if (carrierAdjacent) return B_COLOCATE + Math.min(stranded, 4);
    }
  }

  // 3) March-pull gradient — reward activating the PULL-TARGET: the (usually
  //    empty) system one hop closer to the base than a strike stack. RAW moves
  //    units INTO the activated system from its neighbors, so this — not
  //    "activate where the units are" (the old, wrong formulation, which can't
  //    move a stack at all) — is the actual marching move. Pull counts only
  //    force that would move INWARD (neighbor strictly farther from the base),
  //    only from leader-free neighbors (RAW: leaders pin their system's units),
  //    and only ground a co-located carrier can actually lift (RAW: ground
  //    crosses space inside a carrier from its own system).
  let pull = 0;
  for (const n of (G.catalog.adjacency[sysId] ?? [])) {
    if ((G.empire.leadersOnBoard[n] ?? []).length > 0) continue;
    if ((distFromBase.get(n) ?? 99) <= dBase) continue; // lateral/inner — not an inward march
    pull += Math.min(freeGroundAt(G, n), carrierCapacityAt(G, n));
  }
  if (pull > 0) {
    const w = MARCH_W[dBase] ?? MARCH_W_FAR;
    return Math.min(pull, MARCH_PULL_CAP) * w;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// deployProximityScore — the BUILD-phase lever. Once the base is revealed, the
// doctrine deploys the strongest GROUND (ATAT) and CAPITAL ships (SD/SSD — they
// win the space fight AND carry ground) ADJACENT to the base so they join the
// assault this round, and only where there's transport to carry ground in. The
// AI's default deploy placement is transport-aware but base-blind; this adds the
// base pull. Returns a bonus the DeployUnitPick handler adds to its per-system
// score. 0 when disabled, base hidden, or the system isn't near the base.
// ---------------------------------------------------------------------------
function spareCapacityAt(G: GameState, sysId: SystemId): number {
  const ss = sysId === 'rebel-base-space' ? undefined : G.map.systems[sysId];
  if (!ss) return 0;
  let capacity = 0, needs = 0;
  for (const u of ss.units) {
    if (u.side !== 'Empire') continue;
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    if (t.transport.capacity > 0) capacity += t.transport.capacity;
    else if ((t.theater === 'ground' && t.class !== 'structure') || t.transport.restriction) needs++;
  }
  return capacity - needs;
}

export function deployProximityScore(G: GameState, sysId: SystemId, typeId: string): number {
  if (!PLANNER_ENABLED) return 0;
  if (!G.rebelBaseRevealed || !G.rebelBaseSystemId) return 0;
  const t = G.catalog.unitTypes[typeId];
  if (!t) return 0;
  const dBase = bfs(G, G.rebelBaseSystemId as SystemId, 3).get(sysId);
  if (dBase == null || dBase < 1 || dBase > 3) return 0; // base ring out to 3 hops
  // Build-en-route (doctrine): the attack force GROWS as it marches — new units
  // deploy into the column's path, not just the final ring. d3 is one build
  // cycle out: a unit deployed there joins the second wave.
  const prox = dBase === 1 ? 1 : dBase === 2 ? 0.4 : 0.2;
  const strength = (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0);

  // Capital / transport-provider (SD, SSD, Death Star, carrier): always wants to
  // be adjacent — it wins space (denying Rebel deploys) and ferries ground in.
  if (!t.transport.immobile && t.transport.capacity > 0) {
    return prox * (12 + strength);
  }
  // Ground (ATAT strongest): adjacent to the base is ideal, BUT only if there's
  // transport capacity here to actually carry it into the assault — deploying a
  // strong ground unit where nothing can lift it just strands it (doctrine).
  if (t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile) {
    if (spareCapacityAt(G, sysId) <= 0) return 0;
    return prox * (8 + strength);
  }
  return 0; // fighters etc. — no special base pull (they can't take the ground)
}
