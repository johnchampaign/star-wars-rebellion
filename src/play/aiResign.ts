// AI resignation offer (#677). "I'm convinced I'm going to lose this game —
// will you accept my resignation, or do you want to play it out?"
//
// Design (John, 2026-08-30): the AI OFFERS, the human DECIDES. Accepting ends
// the game as a human win with winReason 'resignation'; declining dismisses the
// offer for the rest of the game. The printed rules have no surrender, so this
// is a convenience layer over RAW, not a rules change — declining plays the
// game out exactly as before.
//
// THE ONE HARD REQUIREMENT is that the AI must never offer resignation from a
// position it could still win. Everything here is therefore structural and
// conservative: a handful of interpretable conditions that must ALL hold, and
// the UI additionally requires the verdict at TWO consecutive round starts.
// Validated against the uploaded game archive: in every recorded game the AI
// went on to WIN, this detector must never fire for the AI's side on any turn
// snapshot (scripts/test-ai-resignation-677.mjs pins fixtures; the full-log
// sweep ran at review time — see #677).
import type { GameState, Side, SystemId } from '../engine/types';
import { baseCandidates } from './mctsAI';

const other = (s: Side): Side => (s === 'Rebel' ? 'Empire' : 'Rebel');

/** Sum of max-health of a side's units, split by theater. Health is the best
 *  single-number proxy for force size the engine has (dice scale with units,
 *  health with survivability); we only ever compare ratios of it. */
function forceHealth(G: GameState, side: Side): { space: number; ground: number } {
  let space = 0, ground = 0;
  const add = (units: { side: Side; typeId: string }[] | undefined) => {
    for (const u of units ?? []) {
      if (u.side !== side) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      if (t.theater === 'space') space += t.health.value;
      else ground += t.health.value;
    }
  };
  for (const ss of Object.values(G.map.systems)) add(ss.units);
  add(G.map.rebelBaseSpace?.units);
  return { space, ground };
}

function groundHealthAt(G: GameState, side: Side, systemId: SystemId): number {
  let n = 0;
  const scan = (units: { side: Side; typeId: string }[] | undefined) => {
    for (const u of units ?? []) {
      if (u.side !== side) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (t && t.theater === 'ground') n += t.health.value;
    }
  };
  scan(G.map.systems[systemId]?.units);
  if (systemId === G.rebelBaseSystemId) scan(G.map.rebelBaseSpace?.units);
  return n;
}

function bfs(G: GameState, origin: SystemId): Map<string, number> {
  const dist = new Map<string, number>([[origin, 0]]);
  const q: SystemId[] = [origin];
  while (q.length) {
    const cur = q.shift() as SystemId;
    const d = dist.get(cur) as number;
    for (const nb of G.catalog.adjacency[cur] ?? []) {
      if (!dist.has(nb)) { dist.set(nb, d + 1); q.push(nb); }
    }
  }
  return dist;
}

/** Rounds before the Rebel's reputation-time win fires even if no further
 *  objective scores (rep only ever falls, time only ever rises). */
function roundsLeft(G: GameState): number {
  return Math.max(0, G.reputationMarker - G.timeMarker);
}

export interface HopelessVerdict {
  hopeless: boolean;
  /** Human-readable reasons, for the offer modal / logs. Empty when not hopeless. */
  reasons: string[];
}

/** Is `side` (the AI) in a position it cannot realistically win?
 *  Deliberately conservative: prefers "keep playing" over a wrong resignation. */
export function hopelessFor(G: GameState, side: Side): HopelessVerdict {
  const no: HopelessVerdict = { hopeless: false, reasons: [] };
  if (G.isGameOver) return no;
  // Never early: resignation is for endgames, and early-game force ratios are
  // noisy (setup asymmetry, undeployed build queues).
  if (G.timeMarker < 5) return no;

  const left = roundsLeft(G);

  if (side === 'Empire') {
    // The Empire wins only by taking or destroying the base before the
    // reputation clock runs out. The dominant real ending (measured over 173
    // human-Rebel reputation-time wins) is NOT fleet annihilation — the Empire
    // usually still holds >=50% of the space health at the end, base unfound in
    // 92% of them. Hopelessness is about the CLOCK: can any ground force (or a
    // Death Star, for the base-destroyed path) reach ANY system the base could
    // still be in, within the rounds that remain?
    //
    // Uses mctsAI.baseCandidates — the Empire's PUBLIC knowledge only (probe
    // cards in hand, searched rule-outs, self-revealing conditions); it never
    // reads the true base location, so this cannot leak hidden information.
    // One hop per round is generous (real delivery needs transports, orders,
    // and a won ground battle), so "unreachable at 1 hop/round" is a safe
    // definition of impossible.
    const reasons: string[] = [];
    if (left > 4) return no; // plenty of clock — never resign a mid-game

    const candidates: SystemId[] = G.rebelBaseRevealed && G.rebelBaseSystemId
      ? [G.rebelBaseSystemId]
      : baseCandidates(G);
    if (candidates.length === 0) return no; // degenerate state — do nothing

    // Where can Imperial force project from? Any system holding Imperial
    // ground (capture path) or a Death Star / DSUC (destruction path).
    const sources: SystemId[] = [];
    for (const [sid, ss] of Object.entries(G.map.systems)) {
      const hasGround = (ss.units ?? []).some((u) => u.side === 'Empire'
        && G.catalog.unitTypes[u.typeId]?.theater === 'ground');
      const hasDS = (ss.units ?? []).some((u) => u.side === 'Empire'
        && (u.typeId === 'death-star' || u.typeId === 'death-star-under-construction'));
      if (hasGround || hasDS) sources.push(sid as SystemId);
    }
    if (sources.length === 0) { reasons.push('no-force-left'); return { hopeless: true, reasons }; }

    for (const c of candidates) {
      const dist = bfs(G, c);
      for (const src of sources) {
        if ((dist.get(src) ?? Infinity) <= left) return no; // one live path — play on
      }
    }
    reasons.push(G.rebelBaseRevealed ? 'cannot-reach-base-in-time' : 'cannot-reach-any-possible-base-in-time');
    reasons.push(`rounds-left-${left}`);
    return { hopeless: true, reasons };
  }

  // AI Rebel: loses only by losing the base. Hopeless = base revealed, an
  // overwhelming ground force already at its doorstep, no fleet to contest,
  // and the reputation win too far away to arrive first.
  const reasons: string[] = [];
  if (!G.rebelBaseRevealed || !G.rebelBaseSystemId) return no;
  if (left <= 2) return no; // about to win on reputation — obviously not hopeless
  reasons.push('reputation-win-too-far');

  const mine = forceHealth(G, side);
  const theirs = forceHealth(G, other(side));
  if (mine.space >= 0.25 * Math.max(1, theirs.space)) return no;
  reasons.push('fleet-broken');

  const dist = bfs(G, G.rebelBaseSystemId);
  let threat = 0;
  for (const sid of Object.keys(G.map.systems)) {
    if ((dist.get(sid) ?? Infinity) <= 1) threat += groundHealthAt(G, 'Empire', sid as SystemId);
  }
  const garrison = groundHealthAt(G, 'Rebel', G.rebelBaseSystemId);
  if (threat < 3 * Math.max(1, garrison)) return no;
  reasons.push('base-overrun');

  return { hopeless: true, reasons };
}
