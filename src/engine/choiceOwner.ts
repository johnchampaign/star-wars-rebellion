// Single source of truth for "which Side owns the current pendingChoice".
//
// Extracted from PlayTab's aiOwesChoice() so the online GameAdapter
// (src/adapter/rebellionAdapter.ts) and the single-player UI agree exactly on
// turn/choice ownership — if these ever diverged, an online game would hand the
// wrong player the turn.
//
// TODO(unify): PlayTab still has its own aiOwesChoice() copy of this switch.
// Refactor it to `return pendingChoiceOwner(G, side)` so there is exactly one
// source of truth (tracked as a follow-up task).

import type { GameState, Side } from './types';

/** True if `side` owns the choice the engine is currently waiting on.
 *  Returns false when there is no pending choice. */
export function pendingChoiceOwner(G: GameState, side: Side): boolean {
  const pc = G.pendingChoice;
  if (!pc) return false;
  switch (pc.kind) {
    case 'OpposeMission':            return pc.opposerSide === side;
    // Always-Rebel choices (no `side` tag on the request).
    case 'InfiltrationPick':         return side === 'Rebel';
    case 'StolenPlansReorder':       return side === 'Rebel';
    case 'PlanTheAssaultShips':      return side === 'Rebel';
    case 'LeadStrikeTeamUnits':      return side === 'Rebel';
    case 'CovertOperationPick':      return side === 'Rebel';
    // Everything else is tagged with the owning side. The robust default below
    // covers any side-tagged kind not explicitly listed (see issue #74).
    default: {
      const sided = pc as { side?: Side };
      return typeof sided.side === 'string' && sided.side === side;
    }
  }
}
