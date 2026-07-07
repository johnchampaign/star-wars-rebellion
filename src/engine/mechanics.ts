// Mechanics façade — every state mutation routes through these functions.
// Direct mutation of GameState outside this module is a bug. See docs/engine.md §10.
//
// After every public Mechanics.* call we run three post-mutation invariants:
//   1. recomputeSubjugation(affectedSystems)
//   2. recomputeRebelBaseReveal()
//   3. recomputeGameEnd()
// These are idempotent — calling twice in a row is a no-op on the second call.

import type {
  GameState, Side, SystemId, UnitInstance, UnitInstanceId, UnitTypeId,
  LeaderId, SystemState,
} from './types';
import { log } from './log';
import { shuffle } from './rng';

// ============================================================================
// Helpers
// ============================================================================

function otherSide(s: Side): Side { return s === 'Rebel' ? 'Empire' : 'Rebel'; }
function faction(G: GameState, s: Side) { return s === 'Rebel' ? G.rebel : G.empire; }

/** All systems that any leader of `side` is currently placed in. */
function sideSystems(G: GameState, side: Side): SystemId[] {
  // Conservative: anywhere with at least one unit of `side`.
  const out: SystemId[] = [];
  for (const [id, ss] of Object.entries(G.map.systems)) {
    if (ss.units.some((u) => u.side === side)) out.push(id);
  }
  return out;
}

function unitsAt(G: GameState, sysId: SystemId): UnitInstance[] {
  return sysId === 'rebel-base-space' ? G.map.rebelBaseSpace.units : G.map.systems[sysId].units;
}

function stateAt(G: GameState, sysId: SystemId): SystemState {
  return sysId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[sysId];
}

function hasGroundOf(G: GameState, side: Side, sysId: SystemId): boolean {
  return unitsAt(G, sysId).some((u) => {
    if (u.side !== side) return false;
    const t = G.catalog.unitTypes[u.typeId];
    return t?.theater === 'ground';
  });
}

function hasAnyOf(G: GameState, side: Side, sysId: SystemId): boolean {
  return unitsAt(G, sysId).some((u) => u.side === side);
}

// ============================================================================
// Invariants
// ============================================================================

/** Subjugation: marker on iff Empire has ground unit AND system loyalty != imperial.
 *  Marker off iff Empire has no ground units. Coruscant is excluded (always Imperial). */
export function recomputeSubjugation(G: GameState, affected?: SystemId[]): void {
  const ids = affected ?? Object.keys(G.map.systems);
  for (const id of ids) {
    if (id === 'rebel-base-space') continue;
    const ss = G.map.systems[id];
    if (!ss) continue;
    if (G.catalog.systems[id]?.isCoruscant) continue;
    if (G.catalog.systems[id]?.isRemote) continue; // remote systems can't be subjugated (rr p.12)
    // Destroyed systems have no loyalty and cannot be subjugated (rr p.7). A
    // ground unit sitting in a Superlaser'd planet must NOT plant a subjugation
    // marker (player report: AT-ST subjugated a destroyed Sullust).
    if (ss.destroyed) {
      if (ss.subjugated) {
        ss.subjugated = false;
        log(G, { kind: 'subjugation-cleared', payload: { systemId: id, reason: 'destroyed' } });
      }
      continue;
    }
    const empireGround = hasGroundOf(G, 'Empire', id);
    // Per rr p.8 (and forum clarifications): subjugation ONLY ever sits on
    // neutral or Rebel-loyalty systems. Imperial-loyalty systems are already
    // under full Imperial control and never carry a subjugation marker.
    if (ss.loyalty === 'imperial') {
      if (ss.subjugated) {
        ss.subjugated = false;
        log(G, { kind: 'subjugation-cleared', payload: { systemId: id, reason: 'imperial-loyalty' } });
      }
      continue;
    }
    if (empireGround) {
      if (!ss.subjugated) {
        ss.subjugated = true;
        log(G, { kind: 'subjugated', payload: { systemId: id } });
      }
    } else if (ss.subjugated) {
      ss.subjugated = false;
      log(G, { kind: 'liberated', payload: { systemId: id } });
    }
  }
}

/** Rebel base reveal: if Empire has loyalty OR ground units in the secret system,
 *  reveal the base (rr p.11). One-way: once revealed, stays revealed. */
export function recomputeRebelBaseReveal(G: GameState, reason: string = 'auto'): void {
  if (G.rebelBaseRevealed) return;
  const base = G.map.systems[G.rebelBaseSystemId];
  if (!base) return;
  const empireLoyalty = base.loyalty === 'imperial';
  const empireGround = hasGroundOf(G, 'Empire', G.rebelBaseSystemId);
  if (empireLoyalty || empireGround) {
    revealRebelBase(G, reason);
  }
}

/** Game-end checks per rr p.14. */
export function recomputeGameEnd(G: GameState): void {
  if (G.isGameOver) return;

  // Empire wins: base revealed AND Imperial units in base system AND no Rebel units there.
  if (G.rebelBaseRevealed) {
    const base = G.map.systems[G.rebelBaseSystemId];
    if (base) {
      const empireThere = hasAnyOf(G, 'Empire', G.rebelBaseSystemId);
      const rebelThere = hasAnyOf(G, 'Rebel', G.rebelBaseSystemId);
      if (empireThere && !rebelThere) {
        G.isGameOver = true;
        G.winner = 'Empire';
        G.winReason = 'base-captured';
        G.phase = 'GameOver';
        log(G, { kind: 'game-over', payload: { winner: 'Empire', reason: 'base-captured' } });
        return;
      }
    }
  }

  // Empire wins: base system destroyed.
  if (G.rebelBaseSystemId && G.map.systems[G.rebelBaseSystemId]?.destroyed) {
    G.isGameOver = true;
    G.winner = 'Empire';
    G.winReason = 'base-destroyed';
    G.phase = 'GameOver';
    log(G, { kind: 'game-over', payload: { winner: 'Empire', reason: 'base-destroyed' } });
    return;
  }

  // Rebel wins: reputation marker meets time marker.
  if (G.reputationMarker <= G.timeMarker) {
    G.isGameOver = true;
    G.winner = 'Rebel';
    G.winReason = 'reputation-time';
    G.phase = 'GameOver';
    log(G, { kind: 'game-over', payload: { winner: 'Rebel', reason: 'reputation-time' } });
    return;
  }
}

/** Record which systems the Empire has "searched" — i.e. satisfied the base-
 *  reveal condition (subjugated/Empire-ground OR Imperial loyalty) while the
 *  base was NOT there. Those systems are ruled out as the base location until
 *  the base relocates. Safe to add ANY qualifying non-base system while the
 *  base is unrevealed: if a system met the condition AND were the base, the
 *  base would already be revealed (so we wouldn't be here). */
export function recordEmpireSearched(G: GameState, affected?: SystemId[]): void {
  if (G.rebelBaseRevealed) return; // moot once revealed
  if (!G.empireSearchedRuledOut) G.empireSearchedRuledOut = [];
  const set = new Set(G.empireSearchedRuledOut);
  const ids = affected ?? Object.keys(G.map.systems);
  for (const id of ids) {
    if (id === 'rebel-base-space' || id === G.rebelBaseSystemId) continue;
    const ss = G.map.systems[id];
    if (!ss) continue;
    if (ss.subjugated || ss.loyalty === 'imperial') set.add(id);
  }
  G.empireSearchedRuledOut = [...set];
}

/** Re-seed the searched-ruled-out set when the base relocates: prior searches
 *  no longer rule out a freshly-hidden base, EXCEPT systems that still qualify
 *  right now (still subjugated / Imperial-loyal — the base can't be hiding
 *  under Empire ground or Imperial control). */
export function resetEmpireSearchedForBaseMove(G: GameState): void {
  G.empireSearchedRuledOut = [];
  recordEmpireSearched(G);
}

/** RR p.7: ground units in a system require transport from ships present; if
 *  there's more ground than the side's in-system ship transport capacity, the
 *  excess is destroyed. This bites in DESTROYED systems (the planet is gone, so
 *  ground can only be there if a ship is carrying it) — e.g. a lone AT-ST moved
 *  into a Superlaser'd planet with no carrier must be destroyed (player report).
 *  RAW lets the owner pick which excess to lose; we auto-cull the LOWEST-tier
 *  ground first, which is the owner-optimal pick in every case (ground units
 *  carry no other state, so you'd always sacrifice the cheapest). Deliberately
 *  not a player prompt: this runs inside `recompute` after every unit move, which
 *  is not a pausable context, and the auto-result already matches what the owner
 *  would choose. Splices directly to avoid re-entering invariants. */
const GROUND_TIER_RANK: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
function cullOverTransportInDestroyed(G: GameState, affected?: SystemId[]): void {
  const ids = affected ?? Object.keys(G.map.systems);
  for (const id of ids) {
    const ss = G.map.systems[id];
    if (!ss || !ss.destroyed) continue;
    for (const side of ['Rebel', 'Empire'] as const) {
      const ground = ss.units.filter((u) => u.side === side && G.catalog.unitTypes[u.typeId]?.theater === 'ground');
      const capacity = ss.units
        .filter((u) => u.side === side && G.catalog.unitTypes[u.typeId]?.theater === 'space')
        .reduce((s, u) => s + (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0), 0);
      const excess = ground.length - capacity;
      if (excess <= 0) continue;
      const order = [...ground].sort((a, b) =>
        (GROUND_TIER_RANK[G.catalog.unitTypes[a.typeId]?.tier ?? 'triangle'] ?? 0)
        - (GROUND_TIER_RANK[G.catalog.unitTypes[b.typeId]?.tier ?? 'triangle'] ?? 0));
      for (let k = 0; k < excess; k++) {
        const u = order[k];
        const i = ss.units.indexOf(u);
        if (i < 0) continue;
        ss.units.splice(i, 1);
        log(G, { kind: 'destroyed-system-overflow', side, payload: { systemId: id, typeId: u.typeId, unit: u.instanceId } });
      }
    }
  }
}

/** RoE p.7 "Removing Target Markers": when a player has a GROUND unit in a
 *  system that holds the opponent's target marker AND the opponent (the marker's
 *  owner) has no ground units there, the marker is removed (and any removal
 *  effect resolves). Removing the opponent's marker is always to the remover's
 *  benefit — re-enables Death Star Plans (Secure the Plans), scores reputation
 *  (Raid Outposts), or ends the opponent's immediate objective (Rebel Cell /
 *  Show No Fear) — so we resolve it automatically (#321). Skipped while a combat
 *  is mid-resolution so transient ground counts don't strip a marker early. */
function processTargetMarkerRemovals(G: GameState, affected?: SystemId[]): void {
  if (G.pendingCombat) return;
  const ids = affected ?? Object.keys(G.map.systems);
  for (const id of ids) {
    const ss = G.map.systems[id];
    if (!ss?.targetMarkers?.length) continue;
    const hasGround = (side: Side) => ss.units.some(
      (u) => u.side === side && G.catalog.unitTypes[u.typeId]?.theater === 'ground');
    for (const m of [...ss.targetMarkers]) {
      const remover: Side = m.placedBy === 'Rebel' ? 'Empire' : 'Rebel';
      if (!hasGround(remover) || hasGround(m.placedBy)) continue;
      if (m.source === 'raid-outposts-2') removeRaidOutpostMarker(G, id);
      else removeTargetMarker(G, id, m.source, remover);
    }
  }
}

/** Full-board target-marker removal sweep. `processTargetMarkerRemovals` bails
 *  entirely while ANY combat is pending (so transient mid-combat ground counts
 *  can't strip a marker early), and post-combat only re-checks the combat system
 *  — so a DIFFERENT system whose occupation changed during that window (e.g. a
 *  Rapid Mobilization / multi-system move that also triggered a combat elsewhere)
 *  can keep a stale marker the opponent has already cleared on the ground (#475).
 *  Run this at the start of each Refresh, before any target-marker objective
 *  scores, to catch such misses. RAW-consistent: it only removes markers the
 *  removal condition already applies to. */
export function sweepTargetMarkerRemovals(G: GameState): void {
  processTargetMarkerRemovals(G);
}

function applyInvariants(G: GameState, affected?: SystemId[]): void {
  recomputeSubjugation(G, affected);
  cullOverTransportInDestroyed(G, affected);
  processTargetMarkerRemovals(G, affected);
  recomputeRebelBaseReveal(G);
  recordEmpireSearched(G, affected);
  // If a captured leader's system no longer has Imperial units, auto-rescue
  // (rr Capturing leaders). Scan affected systems only, since this is called
  // after every unit movement / destruction.
  if (G.empire.capturedLeaders && G.empire.capturedLeaders.length > 0) {
    const ids = affected ?? Object.keys(G.map.systems);
    for (const id of ids) maybeAutoRescue(G, id);
  }
  recomputeGameEnd(G);
}

/** Re-run invariants for `sysId` once a combat has fully resolved.
 *  processTargetMarkerRemovals is intentionally skipped while G.pendingCombat
 *  is set (transient mid-battle ground counts must not strip a marker early),
 *  and finishCombatTail clears pendingCombat without otherwise re-touching the
 *  system. Without this, a side that conquers a system on the ground wouldn't
 *  strip the loser's target marker — and bank its reputation (Raid Outposts) /
 *  end the opponent's immediate objective — until some later, unrelated
 *  applyInvariants happened to include the system (issue #363, root cause of
 *  the #358 "wait for Refresh" misdiagnosis). Must be called AFTER pendingCombat
 *  is cleared. */
export function postCombatInvariants(G: GameState, sysId: SystemId): void {
  applyInvariants(G, [sysId]);
}

// ============================================================================
// Reveal base
// ============================================================================

/** Reveal the Rebel base. Moves units & leaders from the Rebel Base space
 *  into the actual base system. One-way; idempotent. (rr p.11) */
export function revealRebelBase(G: GameState, reason: string = 'auto'): void {
  if (G.rebelBaseRevealed) return;
  G.rebelBaseRevealed = true;

  const dest = G.map.systems[G.rebelBaseSystemId];
  if (!dest) return;

  // Move units
  for (const u of G.map.rebelBaseSpace.units) dest.units.push(u);
  G.map.rebelBaseSpace.units = [];

  // Move leaders from Rebel Base "system key" to the actual system
  const fromKey = 'rebel-base-space';
  for (const side of ['Rebel', 'Empire'] as const) {
    const f = faction(G, side);
    const leaders = f.leadersOnBoard[fromKey] ?? [];
    if (leaders.length > 0) {
      f.leadersOnBoard[G.rebelBaseSystemId] = [
        ...(f.leadersOnBoard[G.rebelBaseSystemId] ?? []),
        ...leaders,
      ];
      delete f.leadersOnBoard[fromKey];
    }
  }

  log(G, { kind: 'reveal-base', payload: { reason, systemId: G.rebelBaseSystemId } });
}

// ============================================================================
// Loyalty
// ============================================================================

/** Gain N loyalty for `side` in `systemId`. Handles the "1 = remove opponent's,
 *  2 = remove + place own" semantics (rr p.8). */
export function gainLoyalty(G: GameState, side: Side, systemId: SystemId, amount: number = 1): void {
  if (amount <= 0) return;
  const ss = G.map.systems[systemId];
  if (!ss) return;
  if (G.catalog.systems[systemId]?.isCoruscant) {
    log(G, { kind: 'loyalty-blocked', payload: { systemId, reason: 'coruscant-locked' } });
    return;
  }
  if (G.catalog.systems[systemId]?.isRemote) {
    log(G, { kind: 'loyalty-blocked', payload: { systemId, reason: 'remote' } });
    return;
  }
  if (ss.destroyed) return;

  const target = side === 'Rebel' ? 'rebel' : 'imperial';
  for (let i = 0; i < amount; i++) {
    // Subjugation is Imperial military occupation (rr p.8). It overlays
    // the underneath loyalty (neutral or Rebel) but never coexists with
    // Imperial loyalty. So Empire gaining loyalty here STILL works on
    // the underneath value: subjugated+neutral → imperial (and
    // recomputeSubjugation clears the marker); subjugated+rebel → still
    // subjugated+neutral after one gain. Don't short-circuit.
    if (ss.loyalty === target) {
      // Already loyal — no further effect. Log explicitly so a player can see
      // *why* a successful mission produced no visible change.
      log(G, { kind: 'loyalty-already', side, payload: { systemId, loyalty: target } });
      continue;
    }
    if (ss.loyalty === 'neutral') {
      ss.loyalty = target;
      log(G, { kind: 'gain-loyalty', side, payload: {
        systemId, newLoyalty: target,
        // Rebel side only: underneath loyalty under a subjugation marker
        // matters when the marker later comes off.
        ...(ss.subjugated ? { hiddenUnderSubjugation: true } : {}),
      }});
    } else {
      // Opponent's loyalty present — remove (one step toward neutral).
      ss.loyalty = 'neutral';
      log(G, { kind: 'remove-loyalty', side, payload: {
        systemId,
        ...(ss.subjugated ? { hiddenUnderSubjugation: true } : {}),
      }});
    }
  }
  applyInvariants(G, [systemId]);
}

/** Lose loyalty for `side` in `systemId`. */
export function loseLoyalty(G: GameState, side: Side, systemId: SystemId): void {
  const ss = G.map.systems[systemId];
  if (!ss) return;
  const target = side === 'Rebel' ? 'rebel' : 'imperial';
  if (ss.loyalty !== target) return;
  ss.loyalty = 'neutral';
  log(G, { kind: 'lose-loyalty', side, payload: { systemId } });
  applyInvariants(G, [systemId]);
}

// ============================================================================
// Units: move, build queue, deploy, gain, destroy, damage
// ============================================================================

let instanceCounter = 1_000_000; // for run-time unit instances
function mkInstance(typeId: UnitTypeId, side: Side): UnitInstance {
  return { instanceId: `u${(++instanceCounter).toString().padStart(7, '0')}`, typeId, side, damage: 0 };
}

/** Reseed the module-level instance counter so the next mkInstance() call
 *  produces an ID strictly greater than any ID already in G. Required after
 *  loading a saved game — without this, the counter resets to 1_000_000 on
 *  every page reload while saved units retain their old IDs, leading to
 *  collisions where two unit instances share the same instanceId. (Issue #29
 *  symptom: order-builder pushed instanceId u1000003 for two distinct units
 *  at the same system; validateMoveOrderTransport's find() returned only the
 *  first match, so the AC's capacity went uncounted.) */
/** Repair probe-card conservation in a loaded state (#451). A Rapid
 *  Mobilization bug leaked the Rebel's private RM probe draw into the EMPIRE'S
 *  probe hand AND duplicated those cards back into the deck, so existing saves
 *  can hold: (a) cards present in both hand and deck, (b) duplicate copies in
 *  the hand, and (c) the current HIDDEN base's own card in the Empire hand
 *  (falsely ruling out the actual base system). The deck copy is authoritative
 *  — a card can never legitimately be in the hand and the deck at once. */
export function repairProbeState(G: GameState): void {
  const hand = G.empire?.probeHand;
  if (!hand || hand.length === 0) return;
  const inDeck = new Set(G.probeDeck ?? []);
  const baseProbeId = !G.rebelBaseRevealed && G.rebelBaseSystemId
    ? Object.values(G.catalog.probes).find((p) => p.systemId === G.rebelBaseSystemId)?.id
    : undefined;
  const seen = new Set<string>();
  const repaired = hand.filter((pid) => {
    if (inDeck.has(pid)) return false;      // duplicated into the deck — deck wins
    if (pid === baseProbeId) return false;  // the hidden base's card belongs under the base
    if (seen.has(pid)) return false;        // in-hand duplicate
    seen.add(pid);
    return true;
  });
  if (repaired.length !== hand.length) {
    G.empire.probeHand = repaired;
    log(G, { kind: 'probe-state-repaired', side: 'Empire', payload: {
      removed: hand.length - repaired.length,
    }});
  }
}

export function reseedInstanceCounters(G: GameState): void {
  let maxU = 1_000_000;
  const visit = (units: UnitInstance[]): void => {
    for (const u of units) {
      const m = /^u(\d+)$/.exec(u.instanceId);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxU) maxU = n;
      }
    }
  };
  for (const ss of Object.values(G.map.systems)) visit(ss.units);
  visit(G.map.rebelBaseSpace.units);
  instanceCounter = maxU;
  // Second pass: detect any duplicate instanceIds that may already be in the
  // saved state (the bug existed before this fix shipped), and renumber the
  // duplicates to fresh IDs. Without this heal, a player whose state was
  // poisoned by the pre-fix counter collision would stay stuck — their next
  // activation involving a duplicated unit would still rejection-loop.
  const seen = new Set<string>();
  const renumber = (units: UnitInstance[]): void => {
    for (const u of units) {
      if (seen.has(u.instanceId)) {
        const oldId = u.instanceId;
        u.instanceId = `u${(++instanceCounter).toString().padStart(7, '0')}`;
        log(G, { kind: 'instance-id-heal', side: u.side, payload: {
          oldId, newId: u.instanceId, typeId: u.typeId,
          reason: 'duplicate-instanceid-from-counter-collision',
        }});
      }
      seen.add(u.instanceId);
    }
  };
  for (const ss of Object.values(G.map.systems)) renumber(ss.units);
  renumber(G.map.rebelBaseSpace.units);
}

/** Move a specific unit instance from one system to another. No legality
 *  checks beyond existence — the caller is responsible (e.g. ActivateSystem
 *  validates transport capacity, immobile, etc.). */
export function moveUnit(G: GameState, unitInstanceId: UnitInstanceId, from: SystemId, to: SystemId): void {
  if (from === to) return;
  const src = stateAt(G, from);
  const dst = stateAt(G, to);
  const i = src.units.findIndex((u) => u.instanceId === unitInstanceId);
  if (i < 0) return;
  const [u] = src.units.splice(i, 1);
  dst.units.push(u);
  log(G, { kind: 'move-unit', side: u.side, payload: { unit: u.instanceId, from, to } });
  applyInvariants(G, [from, to]);
}

/** Unit-conservation invariant. This is a board game: a physical token is moved
 *  between locations, never copied. So at all times:
 *   - every unit instanceId appears in exactly ONE location (a copy = bug, and a
 *     phantom copy at the Rebel base system can even FALSE-reveal the base), and
 *   - the in-play + queued count of a unit type never exceeds its physical supply.
 *  (Totals do change legitimately — builds/spawns add, combat removes — but those
 *  always use fresh ids and respect supply, so these two hold continuously.)
 *  Returns a list of human-readable violations; empty = healthy. */
export function findUnitInvariantViolations(G: GameState): string[] {
  const errs: string[] = [];
  const seen = new Map<string, string>(); // instanceId -> location
  const typeCount = new Map<string, number>();
  const visit = (loc: string, units: UnitInstance[] | undefined): void => {
    for (const u of units ?? []) {
      const prev = seen.get(u.instanceId);
      if (prev) errs.push(`duplicate unit ${u.instanceId} (${u.typeId}) in ${prev} AND ${loc}`);
      else seen.set(u.instanceId, loc);
      typeCount.set(u.typeId, (typeCount.get(u.typeId) ?? 0) + 1);
    }
  };
  for (const [sid, ss] of Object.entries(G.map.systems)) visit(sid, ss.units);
  visit('rebel-base-space', G.map.rebelBaseSpace?.units);
  // Queued units are still "from the supply", so count them toward the cap.
  for (const side of ['rebel', 'empire'] as const) {
    const q = G[side]?.buildQueue;
    if (!q) continue;
    for (const slot of [1, 2, 3] as const) for (const t of q[slot] ?? []) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
  }
  for (const [typeId, n] of typeCount) {
    const cap = G.catalog?.unitTypes?.[typeId]?.supplyCount;
    if (typeof cap === 'number' && n > cap) errs.push(`unit type ${typeId} exceeds supply: ${n} in play/queued > ${cap}`);
  }
  return errs;
}

/** Units of `typeId` currently committed (NOT in the holding pool): on the
 *  board, in the Rebel base space, or sitting in either side's build queue.
 *  Unit type ids are unique per side (e.g. 'x-wing' is Rebel-only), so no
 *  side filter is needed — counting by typeId is exact. */
export function unitsCommitted(G: GameState, typeId: UnitTypeId): number {
  let n = 0;
  for (const ss of Object.values(G.map.systems)) for (const u of ss.units) if (u.typeId === typeId) n++;
  for (const u of G.map.rebelBaseSpace?.units ?? []) if (u.typeId === typeId) n++;
  for (const side of ['rebel', 'empire'] as const) {
    const q = G[side]?.buildQueue;
    if (!q) continue;
    for (const slot of [1, 2, 3] as const) for (const t of q[slot] ?? []) if (t === typeId) n++;
  }
  return n;
}

/** How many units of `typeId` remain in the holding pool (the physical
 *  supply minus everything committed). RAW: the supply IS the limit — you
 *  cannot build/deploy a unit you don't have a token for (the resource is
 *  simply wasted). Returns Infinity for types with no printed supplyCount. */
export function unitsAvailableInSupply(G: GameState, typeId: UnitTypeId): number {
  const cap = G.catalog?.unitTypes?.[typeId]?.supplyCount;
  if (typeof cap !== 'number') return Infinity;
  return Math.max(0, cap - unitsCommitted(G, typeId));
}

/** Place a unit on a side's build queue (rr p.3). Optional `sourceSystemId`
 *  ('rebel-base' for the Rebel Base card's own resource icons) is recorded
 *  in the log so the refresh-report can show "built X from Y." */
export function buildToQueue(G: GameState, side: Side, typeId: UnitTypeId, slot: 1 | 2 | 3, sourceSystemId?: string): void {
  const f = faction(G, side);
  f.buildQueue[slot].push(typeId);
  log(G, { kind: 'build-queue', side, payload: { typeId, slot, sourceSystemId } });
}

/** Deploy a unit from supply directly to a system. Honors no checks here —
 *  caller is responsible for the 2-per-system cap, sabotage, etc. */
export function deployUnit(G: GameState, side: Side, typeId: UnitTypeId, systemId: SystemId): void {
  const ss = stateAt(G, systemId);
  if (!ss) return;
  // The completed Death Star and the Death Star Under Construction are the
  // same Death Star (one token). Deploying the DS removes any DSUC still on
  // the board so the two never coexist — e.g. Imperial Might pulling the
  // finished Death Star off build space 1 (player report #188). The normal
  // completion path removes the DSUC first, so this is a no-op there.
  if (typeId === 'death-star') removeDeathStarUnderConstruction(G);
  const inst = mkInstance(typeId, side);
  ss.units.push(inst);
  log(G, { kind: 'deploy', side, payload: { typeId, systemId, unit: inst.instanceId } });
  applyInvariants(G, [systemId]);
}

/** RAW (RR p.6 "Building a Death Star"): "If a Death Star Under Construction is
 *  destroyed, the Death Star on the build queue is also destroyed." The DSUC
 *  model on the map and the completed Death Star advancing through the build
 *  queue are the same Death Star — so killing the under-construction model must
 *  cancel the queued build, otherwise the Death Star the Rebels just destroyed
 *  re-deploys a few turns later (player report: DSUC destroyed but Death Star
 *  stayed in the build queue). Removes the first queued 'death-star' (slots
 *  1→3); no-op if none is queued. */
function removeDeathStarFromQueue(G: GameState): void {
  for (const slot of [1, 2, 3] as const) {
    const q = G.empire.buildQueue[slot];
    const i = q.indexOf('death-star' as UnitTypeId);
    if (i >= 0) {
      q.splice(i, 1);
      log(G, { kind: 'dsuc-destroyed-cancels-build', side: 'Empire', payload: { slot } });
      return;
    }
  }
}

/** Remove the Death Star Under Construction from wherever it sits (it's the
 *  same Death Star that just deployed in completed form). No-op if none. */
function removeDeathStarUnderConstruction(G: GameState): void {
  for (const sid of Object.keys(G.map.systems)) {
    const arr = G.map.systems[sid].units;
    const i = arr.findIndex((u) => u.typeId === 'death-star-under-construction');
    if (i >= 0) {
      const removed = arr.splice(i, 1)[0];
      log(G, { kind: 'dsuc-replaced-by-death-star', side: 'Empire', payload: {
        systemId: sid, removed: removed.instanceId,
      }});
      return;
    }
  }
}

/** Gain a unit (mission text "gain X") — bypasses sabotage / 2-per-system /
 *  build-queue (rr p.13). Same effect as deployUnit at the engine level. */
export function gainUnit(G: GameState, side: Side, typeId: UnitTypeId, systemId: SystemId): void {
  deployUnit(G, side, typeId, systemId);
}

/** Destroy a unit (removes from board, returns to supply). */
// Causes that are LEGAL for destroying an indestructible-except-by-special-means
// unit (health.color === null — currently only the Death Star). Any other
// cause is a programming error: per RAW, the Death Star can only be destroyed
// by the Death Star Plans objectives. New paths that legitimately need to
// remove such a unit must add their cause here AND have a RAW citation.
const INDESTRUCTIBLE_DESTROY_ALLOWLIST = new Set<string>([
  'death-star-plans',     // RR p.10 — Lvl2/Lvl3 Death Star Plans objectives.
]);

export function destroyUnit(G: GameState, unitInstanceId: UnitInstanceId, cause: string = 'unknown'): void {
  const tryDestroy = (units: { instanceId: string; side: Side; typeId: string }[], sysId: string): boolean => {
    const i = units.findIndex((u) => u.instanceId === unitInstanceId);
    if (i < 0) return false;
    const u = units[i];
    const t = G.catalog.unitTypes[u.typeId];
    // RAW invariant: units with health.color === null cannot be destroyed
    // by ordinary combat / mission effects. If a non-allowlisted cause
    // reaches here, refuse the destroy + log loudly so a future bug like
    // the Hit And Run free-Death-Star kill (issue #28) gets caught at
    // the destroyUnit boundary rather than slipping through a candidate
    // filter we forgot to add elsewhere.
    if (t?.health.color === null && !INDESTRUCTIBLE_DESTROY_ALLOWLIST.has(cause)) {
      const msg = `INVARIANT: refused to destroy indestructible unit ${u.typeId} (${u.instanceId}) at ${sysId} via cause='${cause}'. Allowed causes: ${[...INDESTRUCTIBLE_DESTROY_ALLOWLIST].join(', ')}. This is a bug — fix the caller or add the cause to the allowlist with a RAW citation.`;
      log(G, { kind: 'invariant-violation', side: u.side, payload: { rule: 'destroy-indestructible', typeId: u.typeId, unit: u.instanceId, systemId: sysId, cause } });
      // Throw in dev so the bug is loud; in production the log entry above
      // gives us the audit trail and we keep the unit alive (graceful degrade).
      // Access `process` via globalThis so engine code typechecks without
      // @types/node (which CLAUDE.md forbids in the main tsconfig) and still
      // runs under both node (tsx scripts) and the browser.
      const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
      if (proc && proc.env?.NODE_ENV !== 'production') {
        throw new Error(msg);
      }
      console.error(msg);
      return true; // matched the unit but refused — caller stops searching.
    }
    units.splice(i, 1);
    log(G, { kind: 'destroy-unit', side: u.side, payload: { unit: u.instanceId, typeId: u.typeId, systemId: sysId, cause } });
    // Destroying the under-construction Death Star also destroys the completed
    // Death Star advancing through the build queue — they're one Death Star
    // (RR p.6). Without this the queued copy re-deploys later (player report).
    if (u.typeId === 'death-star-under-construction') removeDeathStarFromQueue(G);
    // While a battle is in progress, record the loss for the combat screen's
    // "units removed" panel (Foggy Leggy request). Combat is atomic, so any
    // destroy during a pending combat is a combat loss.
    if (G.pendingCombat) (G.pendingCombat.removed ??= []).push({ typeId: u.typeId, side: u.side });
    return true;
  };
  for (const [sysId, ss] of Object.entries(G.map.systems)) {
    if (tryDestroy(ss.units, sysId)) {
      applyInvariants(G, [sysId]);
      return;
    }
  }
  if (tryDestroy(G.map.rebelBaseSpace.units, 'rebel-base-space')) {
    applyInvariants(G);
  }
}

/** Apply damage to a unit. If accumulated damage ≥ unit's health, the unit
 *  is staged for destruction at end of theater step (caller manages staging).
 *  Returns true if the unit's damage now equals or exceeds health. */
export function damageUnit(G: GameState, unitInstanceId: UnitInstanceId, amount: number): boolean {
  for (const ss of [...Object.values(G.map.systems), G.map.rebelBaseSpace]) {
    const u = ss.units.find((u) => u.instanceId === unitInstanceId);
    if (!u) continue;
    u.damage += amount;
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.health.color === null) return false; // invulnerable
    return u.damage >= t.health.value;
  }
  return false;
}

/** Destroy an entire system (Superlaser Online — rr p.7). */
export function destroySystem(G: GameState, systemId: SystemId): void {
  const ss = G.map.systems[systemId];
  if (!ss) return;
  // Idempotent: a system can only be destroyed once. Re-firing the superlaser
  // on rubble is a no-op (player report #165: the Empire "double-tapped" an
  // already-destroyed Cato Nemoidia). Without this, a second hit re-logged the
  // destruction and re-ran the loyalty side effects.
  if (ss.destroyed) return;
  ss.destroyed = true;
  // Destroy all Rebel ground units; Imperial ground units survive only if transport allows (rr p.7).
  // For simplicity here we just destroy all rebel ground; transport-capacity culling is a higher-level concern.
  const toDestroy = ss.units.filter((u) => {
    const t = G.catalog.unitTypes[u.typeId];
    return u.side === 'Rebel' && t?.theater === 'ground';
  });
  for (const u of toDestroy) {
    const idx = ss.units.indexOf(u);
    if (idx >= 0) ss.units.splice(idx, 1);
  }
  // Loyalty/subjugation are removed on destroyed systems.
  ss.loyalty = 'neutral';
  ss.subjugated = false;
  // RoE p.8: when a system is destroyed, all target markers in it are removed
  // and each marker's removal effect is resolved (e.g. Raid Outposts scores the
  // Rebel 1 reputation). Iterate a copy since removal mutates the list.
  for (const m of [...(ss.targetMarkers ?? [])]) {
    if (m.source === 'raid-outposts-2') removeRaidOutpostMarker(G, systemId);
    else removeTargetMarker(G, systemId, m.source, m.placedBy);
  }
  log(G, { kind: 'destroy-system', payload: { systemId } });
  applyInvariants(G, [systemId]);
}

// ============================================================================
// Leaders
// ============================================================================

export function placeLeader(G: GameState, side: Side, leaderId: LeaderId, systemId: SystemId): void {
  const f = faction(G, side);
  const i = f.leaderPool.indexOf(leaderId);
  if (i >= 0) f.leaderPool.splice(i, 1);
  // Enforce the single-location invariant: a leader occupies exactly one place.
  // Strip any existing board position before placing, otherwise a caller that
  // places an already-on-board leader leaves a stale duplicate. This bit Homing
  // Beacon (player report #192): rescueLeader dropped the leader at the base
  // space, then placeLeader added the chosen system, leaving Mon Mothma in BOTH
  // the rebel-base-space and Felucia at once.
  for (const [sysId, list] of Object.entries(f.leadersOnBoard)) {
    const j = list.indexOf(leaderId);
    if (j >= 0) {
      list.splice(j, 1);
      if (list.length === 0) delete f.leadersOnBoard[sysId];
      break;
    }
  }
  if (!f.leadersOnBoard[systemId]) f.leadersOnBoard[systemId] = [];
  f.leadersOnBoard[systemId].push(leaderId);
  log(G, { kind: 'place-leader', side, payload: { leaderId, systemId } });
}

/** Return a leader from anywhere on the board back to the leader pool. */
export function returnLeader(G: GameState, side: Side, leaderId: LeaderId): void {
  const f = faction(G, side);
  for (const [sysId, list] of Object.entries(f.leadersOnBoard)) {
    const i = list.indexOf(leaderId);
    if (i >= 0) {
      list.splice(i, 1);
      if (list.length === 0) delete f.leadersOnBoard[sysId];
      break;
    }
  }
  if (!f.leaderPool.includes(leaderId)) f.leaderPool.push(leaderId);
  log(G, { kind: 'return-leader', side, payload: { leaderId } });
}

// ---------- RoE Target markers ----------
//
// RoE rules p.8: several mission and objective cards resolve via a target
// marker placed on a specific system. The marker persists until removed
// (usually by a Rebel ground unit in the system per the generic rule, but
// many cards have their own removal trigger written into rulesText).
// Markers are stored on SystemState.targetMarkers, tagged with the card id
// that placed them so multiple cards' markers can coexist.

/** Place a target marker on a system from a specific card. Idempotent — if
 *  that card already has a marker on that system, no-op (a single card
 *  produces at most one marker on a given system at a time). */
export function placeTargetMarker(
  G: GameState, sysId: SystemId, source: string, placedBy: Side,
): void {
  const ss = G.map.systems[sysId];
  if (!ss) return;
  if (!ss.targetMarkers) ss.targetMarkers = [];
  if (ss.targetMarkers.some((m) => m.source === source && m.placedBy === placedBy)) return;
  ss.targetMarkers.push({ source, placedBy, placedAt: G.timeMarker });
  log(G, { kind: 'target-marker-place', side: placedBy, payload: { systemId: sysId, source } });
}

/** Remove a target marker by source. Returns true if removed. */
export function removeTargetMarker(
  G: GameState, sysId: SystemId, source: string, by?: Side,
): boolean {
  const ss = G.map.systems[sysId];
  if (!ss?.targetMarkers?.length) return false;
  const i = ss.targetMarkers.findIndex((m) => m.source === source);
  if (i < 0) return false;
  const removed = ss.targetMarkers.splice(i, 1)[0];
  if (ss.targetMarkers.length === 0) delete ss.targetMarkers;
  log(G, { kind: 'target-marker-remove', side: by ?? removed.placedBy, payload: { systemId: sysId, source } });
  maybeDiscardDepletedImmediateObjective(G, source);
  return true;
}

/** The RoE "Immediate" objectives that place target markers and stay in play
 *  while at least one marker is on the board. */
const IMMEDIATE_MARKER_OBJECTIVE_IDS: ReadonlySet<string> = new Set([
  'raid-outposts-2', 'rebel-cell-2', 'show-no-fear-3',
]);

/** RoE FAQ (sw03 FAQ v2.1, p.6): "An immediate objective stays in play while at
 *  least one of its corresponding target markers is on the board. When all of
 *  its target markers are removed, discard the objective card." Centralized so
 *  it fires from every marker-removal site. Without it a fully-raided Raid
 *  Outposts lingered in the Rebel's hand, where Exploit Weakness could grab it
 *  as if it were unused (player report #354). Idempotent — the in-hand check
 *  guards against double-discard. */
export function maybeDiscardDepletedImmediateObjective(G: GameState, source: string): void {
  if (!IMMEDIATE_MARKER_OBJECTIVE_IDS.has(source)) return;
  if (systemsWithTargetMarker(G, source).length > 0) return; // still in play
  const hand = G.rebel.objectiveHand;
  if (!hand) return;
  const i = hand.indexOf(source);
  if (i < 0) return; // not in hand (already discarded / scored / never drawn)
  hand.splice(i, 1);
  (G.rebel.objectiveDiscard ??= []).push(source);
  log(G, { kind: 'immediate-objective-discarded', side: 'Rebel', payload: { objectiveId: source } });
}

/** Does this system carry a target marker from the given card source? */
export function hasTargetMarker(G: GameState, sysId: SystemId, source: string): boolean {
  const ss = G.map.systems[sysId];
  return !!ss?.targetMarkers?.some((m) => m.source === source);
}

/** All systems that currently carry a target marker from the given card
 *  source. Handy for "for each marker, at start of refresh" objective
 *  scoring (Show No Fear, Rebel Cell, Raid Outposts). */
export function systemsWithTargetMarker(G: GameState, source: string): SystemId[] {
  const out: SystemId[] = [];
  for (const [sysId, ss] of Object.entries(G.map.systems)) {
    if (ss.targetMarkers?.some((m) => m.source === source)) out.push(sysId);
  }
  return out;
}

/** RoE Raid Outposts: remove one of the card's target markers from `sysId` and
 *  award the Rebel +1 reputation. Used both by the Refresh raid check (Rebel
 *  ground unit present) and by Heist (which can grab a marker without units).
 *  Returns true if a marker was removed. */
export function removeRaidOutpostMarker(G: GameState, sysId: SystemId): boolean {
  if (!hasTargetMarker(G, sysId, 'raid-outposts-2')) return false;
  removeTargetMarker(G, sysId, 'raid-outposts-2', 'Rebel');
  recordObjectiveScored(G, 'raid-outposts-2', 1, 'refresh');
  log(G, { kind: 'raid-outposts-score', side: 'Rebel', payload: { systemId: sysId, reputation: 1 } });
  gainReputation(G, 1);
  return true;
}

/** RoE rules p.8 "LEADER POOL LIMIT": a player can have at most 8 leaders
 *  in their leader pool. Excess leaders are eliminated.
 *
 *  RAW lets the player CHOOSE which to keep — we don't have a UI prompt for
 *  that yet, so this MVP eliminates from the tail of the pool (most-recent
 *  additions go first). It still surfaces every elimination via a clear
 *  `leader-pool-cap-eliminate` log entry so playtesters can flag misses.
 *  When a "pick which to keep" UI exists, swap the tail-eliminate for a
 *  pendingChoice. Phase 6 MVP — see docs/rise-of-the-empire.md.
 *
 *  No-op when expansion.enabled is false (base game has no cap). */
export function enforceLeaderPoolCap(G: GameState, side: Side): boolean {
  if (!G.expansion?.enabled) return false;
  const f = faction(G, side);
  const cap = 8 + (f.leaderPoolCapBonus ?? 0);

  // RoE "Ambitions of Power" — Empire-only Special. If the pool is over
  // the current cap AND Empire has the card in hand AND Motti or Jabba is
  // accessible (in pool or on the board), offer to play it. Posting the
  // offer pauses elimination; the resolver bumps leaderPoolCapBonus and
  // re-runs enforceLeaderPoolCap when it lands.
  if (side === 'Empire'
      && f.leaderPool.length > cap
      && G.empire.actionHand.includes('ambitions-of-power')
      && !G.pendingChoice) {
    const ambitionLeaders: LeaderId[] = ['motti', 'jabba'];
    const accessible = ambitionLeaders.some((lid) => {
      if (G.empire.leaderPool.includes(lid)) return true;
      if (G.empire.leadersOnMissions.some((m) => m.leaderIds.includes(lid))) return true;
      for (const board of Object.values(G.empire.leadersOnBoard)) {
        if (board.includes(lid)) return true;
      }
      return false;
    });
    if (accessible) {
      G.pendingChoice = {
        kind: 'AmbitionsOfPowerOffer',
        side: 'Empire',
        currentPoolSize: f.leaderPool.length,
        currentCap: cap,
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'AmbitionsOfPowerOffer', poolSize: f.leaderPool.length, cap,
      }});
      return true; // resolver re-runs the cap after answering
    }
  }

  // RoE p.8: the player CHOOSES which leader(s) to eliminate. Post a
  // LeaderPoolEliminate choice (one leader per choice, re-posted until at cap),
  // unless another choice is already pending (e.g. the other side's cap, or an
  // Ambitions offer) — guarded so we never clobber a pending choice. Returns
  // true if a choice was posted (the caller leaves it for the controller to
  // resolve; the resolver re-runs the cap to continue / finish).
  if (f.leaderPool.length > cap && !G.pendingChoice) {
    G.pendingChoice = {
      kind: 'LeaderPoolEliminate',
      side,
      candidates: [...f.leaderPool],
      overBy: f.leaderPool.length - cap,
    };
    log(G, { kind: 'choice-request', side, payload: {
      kind: 'LeaderPoolEliminate', overBy: f.leaderPool.length - cap, poolSize: f.leaderPool.length,
    }});
    return true;
  }
  return false;
}

/** Move a leader that is already on the board from one system to another,
 *  without touching the leader pool. Used when a leader leads a combat
 *  retreat (rr p.5: "take one of his leaders from the system and place it in
 *  an adjacent system"). */
export function relocateLeader(
  G: GameState, side: Side, leaderId: LeaderId, fromSystemId: SystemId, toSystemId: SystemId
): void {
  const f = faction(G, side);
  const from = f.leadersOnBoard[fromSystemId];
  if (from) {
    const i = from.indexOf(leaderId);
    if (i >= 0) {
      from.splice(i, 1);
      if (from.length === 0) delete f.leadersOnBoard[fromSystemId];
    }
  }
  (f.leadersOnBoard[toSystemId] ??= []).push(leaderId);
  log(G, { kind: 'leader-retreat', side, payload: { leaderId, from: fromSystemId, to: toSystemId } });
}

/** Capture a Rebel leader. Only one 'captured' ring exists at a time (rr p.3);
 *  if a second leader is captured, the first is rescued. */
export function captureLeader(G: GameState, leaderId: LeaderId, ring: 'captured' | 'carbonite' = 'captured', opts?: { deferAutoRescue?: boolean }): void {
  const r = G.rebel;
  const e = G.empire;
  if (!e.capturedLeaders) e.capturedLeaders = [];

  // Find where the leader currently is — that's where they stay (captured at
  // that system, per Rules Reference). If they're in the pool, default to
  // Coruscant (a leader in the pool isn't on a board; the only way to be
  // captured-from-pool would be via a mission that's already targeting a
  // system, but use a fallback in case).
  let capturedSystemId: SystemId | null = null;
  for (const [sysId, list] of Object.entries(r.leadersOnBoard)) {
    if (list.includes(leaderId)) { capturedSystemId = sysId; break; }
  }
  if (!capturedSystemId) {
    // Not on board — probably in pool. Use a safe default (Coruscant).
    capturedSystemId = 'coruscant';
  }

  // Take the leader off Rebel's pool/board.
  const poolIdx = r.leaderPool.indexOf(leaderId);
  if (poolIdx >= 0) r.leaderPool.splice(poolIdx, 1);
  for (const list of Object.values(r.leadersOnBoard)) {
    const i = list.indexOf(leaderId);
    if (i >= 0) list.splice(i, 1);
  }

  // Empire only has 1 'captured' ring. Capturing another with 'captured'
  // releases the first (rr p.3: "if a second leader is captured, the first is
  // rescued"). Let rescueLeader do the removal+placement — do NOT pre-splice the
  // entry, or rescueLeader can't find it and bails early, leaving the freed
  // leader placed nowhere (player report #384: the first captured leader
  // vanished instead of returning to the Rebel supply).
  if (ring === 'captured') {
    const existing = e.capturedLeaders.find((c) => c.ring === 'captured');
    if (existing) {
      rescueLeader(G, existing.leaderId, 'replaced-by-new-capture');
    }
  }
  e.capturedLeaders.push({ leaderId, ring, systemId: capturedSystemId });
  log(G, { kind: 'capture-leader', payload: { leaderId, ring, systemId: capturedSystemId } });

  // RoE "Post Bounty" (Jabba) — if the captured leader bears a bounty ring,
  // Rebels lose 1 reputation and the ring is consumed. Stacks if there
  // happen to be multiple bounty rings on the same leader (RAW says one
  // ring per leader; the dedup in attachRing keeps it to a single entry).
  if (G.expansion?.enabled && G.leaderAttachments?.[leaderId]?.includes('bounty')) {
    removeAttachment(G, leaderId, 'bounty');
    loseReputation(G, 1);
    log(G, { kind: 'post-bounty-rep-loss', side: 'Empire', payload: {
      leaderId, systemId: capturedSystemId,
    }});
  }

  // Noble Sacrifice (Rebel/Obi-Wan) Special-timing trigger. The card reads
  // "use when this leader becomes captured" — so the use-window opens at the
  // moment of capture, BEFORE the automatic "no Imperial units → rescued"
  // check resolves. If the offer is posted we DEFER the auto-rescue until the
  // offer is answered (resolveNobleSacrificeOffer runs it on decline); posting
  // the offer and then auto-rescuing Obi-Wan out from under it would strand a
  // pendingChoice for a leader who's no longer captured (deadlock).
  //   In practice the rescue never fires at capture time: the only two capture
  // missions (Capture Rebel Operative, Collect Bounty) both guarantee an
  // Imperial unit at the leader's system. But the offer must fire regardless,
  // and the ordering is correct for any future capture source too.
  const postNobleSacrifice = leaderId === 'obi-wan-kenobi'
    && G.pendingMission
    && G.rebel.actionHand.includes('noble-sacrifice')
    && !G.pendingChoice;
  if (postNobleSacrifice) {
    G.pendingChoice = { kind: 'NobleSacrificeOffer', side: 'Rebel' };
    log(G, { kind: 'choice-request', side: 'Rebel', payload: { kind: 'NobleSacrificeOffer' } });
  } else if (!opts?.deferAutoRescue) {
    // If no Imperial units are at the captured leader's system, the leader is
    // immediately rescued (rr p.3). Collect Bounty defers this: it captures at
    // the (Rebel) mission system, THEN relocates the leader to the nearest
    // Imperial system — so the rescue must run AFTER that move, not now
    // (player #259: the leader was auto-freed at capture before relocation).
    maybeAutoRescue(G, capturedSystemId);
  }
}

/** Auto-rescue any captured leader at `systemId` if no Imperial units remain.
 *  Called after captures, after unit movements, and after combat. */
export function maybeAutoRescue(G: GameState, systemId: SystemId): void {
  const e = G.empire;
  if (!e.capturedLeaders || e.capturedLeaders.length === 0) return;
  const ss = G.map.systems[systemId];
  if (!ss) return;
  const hasEmpire = ss.units.some((u) => u.side === 'Empire');
  if (hasEmpire) return;
  // Rescue every captured leader at this system.
  const toRescue = e.capturedLeaders.filter((c) => c.systemId === systemId).map((c) => c.leaderId);
  for (const lid of toRescue) {
    log(G, { kind: 'auto-rescue', payload: { leaderId: lid, systemId, reason: 'no-imperial-units' } });
    rescueLeader(G, lid, 'no-imperial-units');
  }
}

/** Rescue a captured Rebel leader. Places them in the Rebel Base space if
 *  hidden, or in the base's system if revealed (rr p.12). */
export function rescueLeader(G: GameState, leaderId: LeaderId, reason: string = 'auto'): void {
  const e = G.empire;
  if (!e.capturedLeaders) return;
  const i = e.capturedLeaders.findIndex((c) => c.leaderId === leaderId);
  if (i < 0) return;

  // Per RR p.3 "Captured Leaders": a leader with the carbonite ring is still
  // a captured leader and *can* be rescued (the ring is just bookkeeping for
  // which leader is the "second" capture). The Rebel just doesn't get back
  // the reputation lost to Carbon Freezing — that's handled at mission time.
  const rescuedSystemId = e.capturedLeaders[i].systemId;
  e.capturedLeaders.splice(i, 1);
  const destKey = G.rebelBaseRevealed ? G.rebelBaseSystemId : 'rebel-base-space';
  if (!G.rebel.leadersOnBoard[destKey]) G.rebel.leadersOnBoard[destKey] = [];
  G.rebel.leadersOnBoard[destKey].push(leaderId);
  log(G, { kind: 'rescue-leader', payload: { leaderId, dest: destKey, reason } });

  // It Is Your Destiny (Empire/Vader) Special trigger: if Vader is at the
  // rescue system, Empire may discard the card to capture one of the
  // rescuing leaders. Only fires inside a mission rescue context.
  if (G.pendingMission
    && G.pendingMission.resolverSide === 'Rebel'
    && G.pendingMission.targetSystemId === rescuedSystemId
    && (G.empire.leadersOnBoard[rescuedSystemId] ?? []).includes('darth-vader')
    && G.empire.actionHand.includes('it-is-your-destiny')
    && !G.pendingChoice) {
    const candidates = (G.pendingMission.leaderIds as LeaderId[])
      .filter((lid) => lid !== leaderId); // can't capture the rescuee themselves
    if (candidates.length > 0) {
      G.pendingChoice = {
        kind: 'ItIsYourDestinyOffer',
        side: 'Empire',
        candidates,
      };
      log(G, { kind: 'choice-request', side: 'Empire', payload: {
        kind: 'ItIsYourDestinyOffer', candidates: candidates.length,
      }});
    }
  }
}

// ----- Leader attachments ("rings") --------------------------------------
//
// Per RR p.3 "Attachment Rings": a leader can have only one attachment ring
// at a time. A new ring replaces the previous one. These are the non-capture
// rings (Yoda, dark-side, R2D2, etc.). The 'captured' and 'carbonite' rings
// are tracked separately in G.empire.capturedLeaders[].ring (a leader can
// have both an attachment ring AND a captured/carbonite status).

export type AttachmentKind = 'yoda' | 'dark-side' | 'r2d2' | 'c3po' | 'bounty' | 'k2so';

export function attachRing(G: GameState, leaderId: LeaderId, ring: AttachmentKind): void {
  if (!G.leaderAttachments) G.leaderAttachments = {};
  const existing = G.leaderAttachments[leaderId] ?? [];
  // Append (dedup) rather than replace: a leader can bear more than one ring
  // (e.g. the R2-D2 and C-3PO droid rings are distinct tokens). Every trigger
  // site keys off `includes(ring)`, so co-existence is safe.
  if (!existing.includes(ring)) existing.push(ring);
  G.leaderAttachments[leaderId] = existing;
  log(G, { kind: 'ring-attach', payload: { leaderId, ring } });
}

/** Find which leader (if any) currently bears the given ring. */
export function findRingHolder(G: GameState, ring: AttachmentKind): LeaderId | null {
  const map = G.leaderAttachments ?? {};
  for (const lid of Object.keys(map)) {
    if (map[lid]?.includes(ring)) return lid as LeaderId;
  }
  return null;
}

export function removeAttachment(G: GameState, leaderId: LeaderId, ring: AttachmentKind): void {
  const list = G.leaderAttachments?.[leaderId];
  if (!list) return;
  const i = list.indexOf(ring);
  if (i < 0) return;
  list.splice(i, 1);
  if (list.length === 0) delete G.leaderAttachments![leaderId];
  log(G, { kind: 'ring-remove', payload: { leaderId, ring } });
}

export function hasAttachment(G: GameState, leaderId: LeaderId, ring: AttachmentKind): boolean {
  return G.leaderAttachments?.[leaderId]?.includes(ring) ?? false;
}

/** Convert a Rebel leader to an Imperial leader for the rest of the game
 *  (Lure of the Dark Side). Removes them from all Rebel state, places them in
 *  the Empire pool, and attaches the 'dark-side' ring as a record. The leader
 *  must currently be captured by Empire (per the card). */
export function flipLeaderToImperial(G: GameState, leaderId: LeaderId): boolean {
  const ld = G.catalog.leaders[leaderId];
  if (!ld) return false;
  if (ld.side !== 'Rebel') return false;
  // Must be in capturedLeaders.
  const cap = G.empire.capturedLeaders ?? [];
  const i = cap.findIndex((c) => c.leaderId === leaderId);
  if (i < 0) return false;
  cap.splice(i, 1);
  // Belt-and-suspenders: also strip from any Rebel state if somehow present.
  const r = G.rebel;
  const poolIdx = r.leaderPool.indexOf(leaderId);
  if (poolIdx >= 0) r.leaderPool.splice(poolIdx, 1);
  for (const list of Object.values(r.leadersOnBoard)) {
    const j = list.indexOf(leaderId);
    if (j >= 0) list.splice(j, 1);
  }
  for (const am of r.leadersOnMissions) {
    const j = am.leaderIds.indexOf(leaderId);
    if (j >= 0) am.leaderIds.splice(j, 1);
  }
  // Add to Empire pool.
  if (!G.empire.leaderPool.includes(leaderId)) G.empire.leaderPool.push(leaderId);
  attachRing(G, leaderId, 'dark-side');
  log(G, { kind: 'leader-flipped', payload: { leaderId, newSide: 'Empire' } });
  return true;
}

/** Eliminate a leader (returned to the box, cannot re-enter the game). */
export function eliminateLeader(G: GameState, side: Side, leaderId: LeaderId): void {
  const f = faction(G, side);
  const poolIdx = f.leaderPool.indexOf(leaderId);
  if (poolIdx >= 0) f.leaderPool.splice(poolIdx, 1);
  for (const list of Object.values(f.leadersOnBoard)) {
    const i = list.indexOf(leaderId);
    if (i >= 0) list.splice(i, 1);
  }
  // Also clear from captured-leader pool if relevant
  if (G.empire.capturedLeaders) {
    const i = G.empire.capturedLeaders.findIndex((c) => c.leaderId === leaderId);
    if (i >= 0) G.empire.capturedLeaders.splice(i, 1);
  }
  if (!f.eliminatedLeaders.includes(leaderId)) f.eliminatedLeaders.push(leaderId);
  // A ring-bearer who's eliminated loses their rings (the droid action card
  // is gone with them — push it to discard so it leaves the deck cleanly).
  const rings = G.leaderAttachments?.[leaderId];
  if (rings && rings.length) {
    if (rings.includes('r2d2')) G.rebel.actionDiscard.push('resourceful-astromech');
    if (rings.includes('c3po')) G.rebel.actionDiscard.push('human-cyborg-relations');
    delete G.leaderAttachments![leaderId];
  }
  log(G, { kind: 'eliminate-leader', side, payload: { leaderId } });
}

/** Remove a system's probe card from play (the deck AND the Empire's hand if it
 *  was already drawn) and mark the system ruled out. RoE setup: the system that
 *  holds the Death Star Under Construction has its probe card removed like the
 *  Imperial-loyalty systems' — it can't be the Rebel base and the Empire knows
 *  it, so it must not reappear via Intercepted Transmissions etc. (player report
 *  #372). No-op if the system has no probe card or it's already gone. */
export function removeProbeForSystem(G: GameState, sysId: SystemId): void {
  if (!sysId) return;
  const probe = Object.values(G.catalog.probes).find((p) => p.systemId === sysId);
  if (!probe) return;
  let removed = false;
  const di = G.probeDeck?.indexOf(probe.id) ?? -1;
  if (di >= 0) { G.probeDeck.splice(di, 1); removed = true; }
  const hi = G.empire.probeHand?.indexOf(probe.id) ?? -1;
  if (hi >= 0) { G.empire.probeHand!.splice(hi, 1); removed = true; }
  // NOTE: deliberately do NOT touch G.empireProbeRuledOut here. That field is a
  // precomputed mirror used ONLY by the online view, where the probe deck is
  // hidden and redactStateForViewer recomputes it from scratch (from the real
  // deck) for the Empire viewer every redaction. Writing to it on the live
  // (non-redacted) state created a truthy-but-partial array in hotseat /
  // single-player: the "Base search" panel's `if (G.empireProbeRuledOut)`
  // short-circuit then trusted this partial list (only setup removals) and
  // never marked probes the Empire DREW during play as ruled out (player report
  // #381 — drawn probes stayed "still possible" green). Leaving the field
  // undefined in hotseat lets the panel derive rule-outs from the visible deck,
  // which is correct.
  if (removed) log(G, { kind: 'probe-removed-for-system', payload: { systemId: sysId, probeId: probe.id } });
}

// ============================================================================
// Decks (basic draw/discard)
// ============================================================================

export function drawAction(G: GameState, side: Side, n: number = 1): string[] {
  const f = faction(G, side);
  const drawn: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = f.actionDeck.shift();
    if (!c) break;
    f.actionHand.push(c);
    drawn.push(c);
  }
  if (drawn.length > 0) log(G, { kind: 'draw-action', side, payload: { count: drawn.length } });
  return drawn;
}

export function drawMission(G: GameState, side: Side, n: number = 1): string[] {
  const f = faction(G, side);
  const drawn: string[] = [];
  for (let i = 0; i < n; i++) {
    if (f.missionDeck.length === 0 && f.missionDiscard.length > 0) {
      // Reshuffle discard into deck (rr p.6 component limitations)
      f.missionDeck = shuffle(G.rng, [...f.missionDiscard]);
      f.missionDiscard = [];
    }
    const c = f.missionDeck.shift();
    if (!c) break;
    f.missionHand.push(c);
    drawn.push(c);
  }
  if (drawn.length > 0) log(G, { kind: 'draw-mission', side, payload: { count: drawn.length, missionIds: drawn } });
  return drawn;
}

export function drawObjective(G: GameState, n: number = 1): string[] {
  if (!G.rebel.objectiveDeck || !G.rebel.objectiveHand) return [];
  const drawn: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = G.rebel.objectiveDeck.shift();
    if (!c) break;
    G.rebel.objectiveHand.push(c);
    drawn.push(c);
  }
  if (drawn.length > 0) log(G, { kind: 'draw-objective', side: 'Rebel', payload: { count: drawn.length, objectiveIds: drawn } });
  return drawn;
}

export function drawProbe(G: GameState, n: number = 1): string[] {
  if (!G.empire.probeHand) G.empire.probeHand = [];
  const drawn: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = G.probeDeck.shift();
    if (!c) break;
    G.empire.probeHand.push(c);
    drawn.push(c);
  }
  if (drawn.length > 0) log(G, { kind: 'draw-probe', side: 'Empire', payload: { count: drawn.length, probeIds: drawn } });
  return drawn;
}

// ============================================================================
// Time / reputation
// ============================================================================

export function gainReputation(G: GameState, n: number = 1): void {
  for (let i = 0; i < n; i++) {
    G.reputationMarker -= 1;
    log(G, { kind: 'gain-reputation', side: 'Rebel', payload: { newValue: G.reputationMarker } });
    recomputeGameEnd(G);
    if (G.isGameOver) return;
  }
}

/** Record a Rebel objective scoring: queue the report-modal entry AND append to
 *  the persistent scored-objectives list the UI shows (Foggy Leggy request).
 *  Single chokepoint for every objective-scoring site. Does NOT grant the
 *  reputation itself — callers still call gainReputation. */
export function recordObjectiveScored(
  G: GameState, objectiveId: string, reputation: number, via: string, seq?: number,
): void {
  const report: { objectiveId: string; reputation: number; via: string; seq?: number } = { objectiveId, reputation, via };
  if (seq !== undefined) report.seq = seq;
  (G.objectiveReports ??= []).push(report);
  (G.rebel.scoredObjectives ??= []).push({ objectiveId, reputation, turn: G.timeMarker });
}

export function loseReputation(G: GameState, n: number = 1): void {
  for (let i = 0; i < n; i++) {
    G.reputationMarker += 1;
    log(G, { kind: 'lose-reputation', side: 'Rebel', payload: { newValue: G.reputationMarker } });
  }
}

export function advanceTime(G: GameState, n: number = 1): void {
  for (let i = 0; i < n; i++) {
    G.timeMarker += 1;
    log(G, { kind: 'advance-time', payload: { newValue: G.timeMarker } });
    recomputeGameEnd(G);
    if (G.isGameOver) return;
  }
}

// ============================================================================
// Suppress unused-imports warnings
// ============================================================================

// `sideSystems` and `otherSide` are exported for use by phase logic in later turns.
export { sideSystems, otherSide };
