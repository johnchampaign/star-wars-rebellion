// Seeded PRNG. Uses mulberry32 — small, fast, good enough for game shuffles.
// Source: https://stackoverflow.com/a/47593316 (public domain)
//
// All randomness inside the engine MUST flow through this. No Math.random, no
// Date.now. See docs/engine.md §12.

import type { SeededRngState } from './types';

export function createRng(seed: number): SeededRngState {
  // Coerce to a 32-bit integer; reject 0 (causes constant output).
  let s = Math.floor(seed) | 0;
  if (s === 0) s = 1;
  return { state: s };
}

/** Advance and return a number in [0, 1). Mutates the rng state. */
export function nextFloat(rng: SeededRngState): number {
  rng.state = (rng.state + 0x6d2b79f5) | 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform integer in [0, n). */
export function nextInt(rng: SeededRngState, n: number): number {
  return Math.floor(nextFloat(rng) * n);
}

/** Fisher–Yates shuffle in place, deterministic given the seed. */
export function shuffle<T>(rng: SeededRngState, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Pick a random element from arr (does not mutate). */
export function pick<T>(rng: SeededRngState, arr: readonly T[]): T {
  return arr[nextInt(rng, arr.length)];
}

/** Roll a single die face. Probabilities per the SWR custom dice:
 *  red:   2 hits, 1 direct hit, 1 special, 2 blanks (6 faces)
 *  black: 3 hits, 1 special, 2 blanks (6 faces)
 *  green: per Rise of Empire; ignored in base game */
const RED_FACES: import('./types').DieFace[] = ['hit', 'hit', 'direct-hit', 'special', 'blank', 'blank'];
const BLACK_FACES: import('./types').DieFace[] = ['hit', 'hit', 'hit', 'special', 'blank', 'blank'];
// RoE green die: 4 blanks + 2 direct hits, no regular hit and no special.
// Per the printed die (images/Green 1.PNG = blank face, images/Green 5_6.PNG =
// the direct-hit faces 5 & 6) and confirmed by player reports (green dice only
// ever show direct hits). Direct hits bypass health colour, so green hits are
// always assignable to any target.
const GREEN_FACES: import('./types').DieFace[] = ['blank', 'blank', 'blank', 'blank', 'direct-hit', 'direct-hit'];

export function rollDie(rng: SeededRngState, color: import('./types').DieColor): import('./types').DieResult {
  const faces = color === 'red' ? RED_FACES : color === 'black' ? BLACK_FACES : GREEN_FACES;
  return { color, face: pick(rng, faces) };
}
