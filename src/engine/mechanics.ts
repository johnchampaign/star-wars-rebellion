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

function applyInvariants(G: GameState, affected?: SystemId[]): void {
  recomputeSubjugation(G, affected);
  recomputeRebelBaseReveal(G);
  // If a captured leader's system no longer has Imperial units, auto-rescue
  // (rr Capturing leaders). Scan affected systems only, since this is called
  // after every unit movement / destruction.
  if (G.empire.capturedLeaders && G.empire.capturedLeaders.length > 0) {
    const ids = affected ?? Object.keys(G.map.systems);
    for (const id of ids) maybeAutoRescue(G, id);
  }
  recomputeGameEnd(G);
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
  const inst = mkInstance(typeId, side);
  ss.units.push(inst);
  log(G, { kind: 'deploy', side, payload: { typeId, systemId, unit: inst.instanceId } });
  applyInvariants(G, [systemId]);
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

/** Capture a Rebel leader. Only one 'captured' ring exists at a time (rr p.3);
 *  if a second leader is captured, the first is rescued. */
export function captureLeader(G: GameState, leaderId: LeaderId, ring: 'captured' | 'carbonite' = 'captured'): void {
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
  // releases the first (rr Capturing leaders).
  if (ring === 'captured') {
    const existing = e.capturedLeaders.findIndex((c) => c.ring === 'captured');
    if (existing >= 0) {
      const old = e.capturedLeaders.splice(existing, 1)[0];
      rescueLeader(G, old.leaderId, 'replaced-by-new-capture');
    }
  }
  e.capturedLeaders.push({ leaderId, ring, systemId: capturedSystemId });
  log(G, { kind: 'capture-leader', payload: { leaderId, ring, systemId: capturedSystemId } });

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
  } else {
    // If no Imperial units are at the captured leader's system, the leader is
    // immediately rescued (rr p.3).
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

export type AttachmentKind = 'yoda' | 'dark-side';

export function attachRing(G: GameState, leaderId: LeaderId, ring: AttachmentKind): void {
  if (!G.leaderAttachments) G.leaderAttachments = {};
  const existing = G.leaderAttachments[leaderId] ?? [];
  if (existing.length > 0 && !existing.includes(ring)) {
    // Replace any pre-existing ring.
    log(G, { kind: 'ring-remove', payload: { leaderId, ring: existing[0], replacedBy: ring } });
  }
  G.leaderAttachments[leaderId] = [ring];
  log(G, { kind: 'ring-attach', payload: { leaderId, ring } });
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
  log(G, { kind: 'eliminate-leader', side, payload: { leaderId } });
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
