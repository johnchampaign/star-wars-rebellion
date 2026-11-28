// Would this deploy-step action be the player's LAST one this Refresh?
//
// #858 — "Game would not permit me to undo previous placement during the
// Deployment Step." Undo lives inside the deploy picker and works between
// placements, but the final unit ended the step on the spot: the picker
// closed, the game moved on to Assignment, and that last click (a placement
// or a "leave on build queue") could never be taken back.
//
// The play screen uses this to hold the final action behind a confirmation
// while Undo is still on screen. It is answered by a dry run on a copy rather
// than by counting the queue, because the queue alone can't tell: units behind
// this one are sent back to the build queue without a prompt when the 2-per-
// system limit leaves them nowhere legal to go.
import type { GameState } from '../engine/types';
import { declineDeployUnit, resolveDeployUnitPick } from '../engine/phases';

/** True when resolving the pending DeployUnitPick this way (a system id, or
 *  null for "leave on build queue") leaves this side no further deploy pick.
 *  Never touches `G`. */
export function endsDeployStep(G: GameState, systemId: string | null): boolean {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'DeployUnitPick') return false;
  const side = pc.side;
  const { catalog, ...rest } = G;
  const trial = { ...structuredClone(rest), catalog } as GameState;
  const r = systemId === null ? declineDeployUnit(trial) : resolveDeployUnitPick(trial, systemId);
  if (!r.ok) return false; // let the real call report the reason
  const next = trial.pendingChoice;
  return !(next && next.kind === 'DeployUnitPick' && next.side === side);
}
