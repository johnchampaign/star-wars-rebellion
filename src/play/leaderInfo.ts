// Per-leader display facts shared by the leader roster, the map tokens and the
// assignment pickers: attached rings and minor skill icons (#827, #828).
import type { GameState } from '../engine/types';
import { totalSkill } from '../engine/phases';

// Attachment rings, and what each one does in play (card text in
// assets/actions.json + assets/missions.json).
export const RING_LABELS: Record<string, string> = {
  r2d2: 'R2-D2', c3po: 'C-3PO', k2so: 'K-2SO',
  yoda: 'Yoda', bounty: 'Bounty', 'dark-side': 'Dark Side',
  // #626: the Falcon ring decides WHO can trigger the rescue and
  // WHERE, so the player has to be able to see where it landed.
  falcon: 'Millennium Falcon',
};
const RING_EFFECTS: Record<string, string> = {
  r2d2: "discard to turn 1 opponent's die to the blank side",
  c3po: 'discard to automatically succeed at a diplomacy mission after failure',
  k2so: 'gains minor Spec-Ops and minor Intel icons',
  yoda: 'once per round, may reroll 1 of your dice when in the same system as a mission or combat',
  bounty: 'when this leader is captured, the Rebels lose 1 reputation',
  'dark-side': 'this leader is an Imperial leader for the rest of the game',
  falcon: 'automatically rescue 1 captured leader in a system after a successful mission there',
};
/** The rings on one leader, as names (#828). */
export function leaderRingLabels(G: GameState, leaderId: string): string[] {
  return (G.leaderAttachments?.[leaderId] ?? []).map((r) => RING_LABELS[r] ?? r);
}
/** One line per ring, name + effect, for a hover tooltip. */
export function leaderRingTooltip(G: GameState, leaderId: string): string {
  return (G.leaderAttachments?.[leaderId] ?? [])
    .map((r) => `Ring: ${RING_LABELS[r] ?? r} — ${RING_EFFECTS[r] ?? ''}`).join('\n');
}
/** Minor skill icons per skill (#827), through the engine's own count so the
 *  display can't disagree with the mission roll: expansion-gated, and K-2SO's
 *  ring-granted icons included. Skills with no minor icons are left out. */
export function leaderMinorSkills(G: GameState, leaderId: string): { key: string; name: string; value: number }[] {
  return ([['D', 'Diplomacy', 'diplomacy'], ['I', 'Intel', 'intel'], ['O', 'Spec-Ops', 'specOps'], ['L', 'Logistics', 'logistics']] as const)
    .map(([key, name, skill]) => ({ key, name, value: totalSkill(G, [leaderId], skill).minor }))
    .filter((m) => m.value > 0);
}
