// Per-seat state redaction for online play (Phase 2). SECURITY-CRITICAL: the
// view returned here is sent over the internet to a player's browser, so it
// must contain NOTHING the viewer isn't entitled to see. A leak here hands the
// opponent the Rebel base location, the contents of hands, or the RNG state.
//
// Strategy: clone, then explicitly strip every secret. We keep counts (masked
// piles preserve length) so the UI can still show "N cards" without identities.
//
// What's secret:
//   - Rebel base system id (until revealed) and the Setup base candidates.
//   - Every deck's contents/order (face-down to EVERYONE, incl. its owner).
//   - The opponent's hands (action / mission / objective / probe).
//   - The mission id on the opponent's assigned (face-down) missions — the
//     committed leaders are public, the chosen mission is not.
//   - The RNG state + controller seeds (a client that has these could predict
//     future dice rolls).
//   - The turn log (it records the base pick and assigned mission ids). For now
//     it is emptied wholesale — safe but lossy. TODO(#log-redaction): replace
//     with per-entry filtering that keeps public events for the event banner.
//
// What's public (kept): leader pools, leaders/units on the board, the Rebel
// Base space contents, eliminated/captured leaders, attachment rings, the build
// queue, all discard piles, reputation/time, loyalty, and empireSearchedRuledOut
// (systems ruled OUT, explicitly not secret).

import type { GameState, FactionState } from '../engine/types';
import type { Side, SystemId } from '../types';

/** Sentinel that replaces a hidden card/system id. Distinct enough that the UI
 *  and tests can detect "this was redacted". */
export const HIDDEN = '__hidden__';

/** Replace every entry with the HIDDEN sentinel, preserving the count. */
function hide(pile: string[]): string[] {
  return pile.map(() => HIDDEN);
}
function hideOpt(pile: string[] | undefined): string[] | undefined {
  return pile ? pile.map(() => HIDDEN) : pile;
}

function redactFaction(f: FactionState, own: boolean): FactionState {
  return {
    ...f,
    // Decks are face-down to everyone — even the owner cannot see deck order.
    actionDeck: hide(f.actionDeck),
    missionDeck: hide(f.missionDeck),
    objectiveDeck: hideOpt(f.objectiveDeck),
    projectDeck: hideOpt(f.projectDeck),
    // Hands are visible only to their owner.
    actionHand: own ? f.actionHand : hide(f.actionHand),
    missionHand: own ? f.missionHand : hide(f.missionHand),
    objectiveHand: own ? f.objectiveHand : hideOpt(f.objectiveHand),
    probeHand: own ? f.probeHand : hideOpt(f.probeHand),
    // Assigned missions: committed leaders are public; the mission is hidden
    // from the opponent until it is revealed/resolved.
    leadersOnMissions: own
      ? f.leadersOnMissions
      : f.leadersOnMissions.map((m) => ({ missionId: HIDDEN, leaderIds: m.leaderIds })),
  };
}

/** Produce the redacted GameState a given seat (or a null spectator) is allowed
 *  to see. Pure — never mutates the input. */
/** Probe-derived ruled-out systems for the Empire, computed from the FULL deck
 *  (the deck is hidden in the view, so the UI can't derive this itself). A system
 *  is ruled out once its probe is no longer in the deck (the Empire drew it),
 *  EXCLUDING the actual base — so this never leaks the base. Mirrors the UI's
 *  empireRuledOutSystems(); keep them in sync. */
function computeEmpireProbeRuledOut(state: GameState): SystemId[] {
  const cat = state.catalog;
  if (!cat?.probes || !cat.systems) return [];
  const inDeck = new Set(
    (state.probeDeck ?? []).map((pid) => cat.probes[pid]?.systemId).filter(Boolean) as string[],
  );
  const out = new Set<string>();
  for (const p of Object.values(cat.probes)) {
    if (!p.systemId || inDeck.has(p.systemId) || p.systemId === state.rebelBaseSystemId) continue;
    out.add(p.systemId);
  }
  for (const s of Object.values(cat.systems)) {
    if (s.isCoruscant && s.id !== state.rebelBaseSystemId) out.add(s.id);
  }
  return [...out] as SystemId[];
}

export function redactStateForViewer(state: GameState, viewer: Side | null): GameState {
  const G = structuredClone(state);
  const baseHiddenToViewer = viewer !== 'Rebel' && !G.rebelBaseRevealed;
  // The Empire's probe rule-outs must be computed from the real (pre-hide) deck.
  const empireProbeRuledOut = viewer === 'Empire' ? computeEmpireProbeRuledOut(state) : undefined;
  return {
    ...G,
    // RNG / seeds: zero them so a client cannot predict rolls.
    rng: { state: 0 },
    controllerSeeds: { rebel: 0, empire: 0 },
    // Probe deck is face-down. The Empire's deck-derived rule-outs are computed
    // from the real deck above (the hidden deck can't yield them client-side).
    probeDeck: hide(G.probeDeck),
    empireProbeRuledOut,
    // The base location, until it is revealed to all.
    rebelBaseSystemId: baseHiddenToViewer ? (HIDDEN as SystemId) : G.rebelBaseSystemId,
    // The 5 Setup base candidates are shown to the Rebel only.
    pendingRebelBasePick: viewer === 'Rebel' ? G.pendingRebelBasePick : undefined,
    // Log records the base pick + assigned mission ids — empty it for now.
    turnLog: [],
    rebel: redactFaction(G.rebel, viewer === 'Rebel'),
    empire: redactFaction(G.empire, viewer === 'Empire'),
  };
}
