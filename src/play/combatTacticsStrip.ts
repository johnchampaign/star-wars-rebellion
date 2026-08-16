// The "Tactics played" strip on the live combat board (#645).
//
// Derived from the turnLog rather than recorded separately: every tactic play
// already logs, so this stays correct for old saves and for every future card
// without a second bookkeeping path. Pulled out of CombatBoardLive into a pure
// function so it can be TESTED — it silently drifted once already: the strip
// listened for the events a cinematic card fires when it is cancelled or has
// no effect, but not the one it fires when it actually PLAYS
// (`cinematic-tactic-play`, which carries `cardId` rather than `card`). A card
// that got cancelled showed on the board while a card that resolved was
// invisible, and a playtester in a cinematic game had to leave the battle and
// read the log to learn what had just hit them.

import type { GameState, LogEntry } from '../engine/types';
import type { Side } from '../types';

export interface PlayedTactic {
  side: Side;
  card: string;
  /** Short human tag: which ability fired and what it did, or 'cancelled' /
   *  'no effect'. Undefined for base-game plays (their detail is in the
   *  per-attack tacticsPlayed list already shown on the board). */
  note?: string;
}

/** Every tactic played in the CURRENT combat at `systemId`, in play order. */
export function playedTacticsFor(turnLog: readonly LogEntry[], systemId: string): PlayedTactic[] {
  let beginIdx = -1;
  for (let i = turnLog.length - 1; i >= 0; i--) {
    const e = turnLog[i];
    if (e.kind === 'combat-begin' && (e.payload as { systemId?: string })?.systemId === systemId) { beginIdx = i; break; }
  }
  if (beginIdx < 0) return [];
  const out: PlayedTactic[] = [];
  for (let i = beginIdx + 1; i < turnLog.length; i++) {
    const e = turnLog[i];
    if (e.kind === 'combat-end') break;
    // combat-tactic fires when a base tactic ACTS (reroll/damage). A cinematic
    // tactic that's revealed and then CANCELLED by the opponent, or that has NO
    // applicable ability, logs a different event and would otherwise never show
    // — so the enemy's defensive/cancel card was invisible unless you dug
    // through the log. All are post-reveal, so surfacing them leaks nothing
    // face-down.
    if ((e.kind === 'combat-tactic' || e.kind === 'cinematic-tactic-cancelled'
      || e.kind === 'cinematic-tactic-no-ability') && e.side) {
      const card = (e.payload as { card?: string })?.card;
      if (card) {
        out.push({ side: e.side as Side, card,
          note: e.kind === 'cinematic-tactic-cancelled' ? 'cancelled'
            : e.kind === 'cinematic-tactic-no-ability' ? 'no effect' : undefined });
      }
      continue;
    }
    if (e.kind === 'cinematic-tactic-play' && e.side) {
      const p = e.payload as {
        cardId?: string; ability?: 'primary' | 'secondary';
        dealt?: number; targetDealt?: number; condDealt?: number; destroyed?: string;
        prevent?: { red?: number; black?: number; directHit?: number }; extra?: boolean; gained?: string;
      };
      if (!p.cardId) continue; // the 'gained a unit' variant names no card
      const bits: string[] = [];
      if (p.ability) bits.push(p.ability === 'primary' ? 'top' : 'bottom');
      const dmg = (p.dealt ?? 0) + (p.targetDealt ?? 0) + (p.condDealt ?? 0);
      if (dmg > 0) bits.push(`${dmg} dmg`);
      if (p.destroyed) bits.push('destroyed a unit');
      if (p.prevent) {
        const pv = [p.prevent.red ? `${p.prevent.red}R` : '', p.prevent.black ? `${p.prevent.black}B` : '',
          p.prevent.directHit ? `${p.prevent.directHit}✶` : ''].filter(Boolean).join('/');
        if (pv) bits.push(`prevent ${pv}`);
      }
      if (p.extra) bits.push('+card');
      out.push({ side: e.side as Side, card: p.cardId, note: bits.join(' · ') || undefined });
    }
  }
  return out;
}

/** Convenience for the board. */
export function playedTacticsForCombat(G: GameState): PlayedTactic[] {
  const sys = G.pendingCombat?.systemId;
  return sys ? playedTacticsFor(G.turnLog, sys) : [];
}
