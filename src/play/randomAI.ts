// Heuristic AI. Plays strategically per the user's directives:
//
// REBEL: prefer missions over moves. Keep the base hidden — don't move
// units toward Empire-proximity areas. Use diplomacy. Prioritize
// objective-advancing missions.
//
// EMPIRE: reserve 1-2 leaders for opposition. Use probes aggressively to
// narrow the base location. Capture rebel leaders (cap at 1 to avoid
// the auto-release). Use diplomacy on high-value systems.
//
// "Look-ahead per phase" interpretation: when making the first Assignment-
// phase decision, the AI plans the full slate of leader-to-mission
// assignments and commits to the best one; subsequent calls re-plan
// against the updated state. For Command phase, each turn the AI scores
// all available actions (reveal, activate, pass) and picks the best.
//
// Contract: stepOnce(G, side) performs exactly one engine call when it's `side`'s
// turn. The caller is expected to call it in a loop (with refresh in between)
// until G.currentPlayer flips back to the human, the game ends, or we're in a
// state with no valid AI action.

import type { GameState, Side, LeaderId, SystemId } from '../engine/types';
import * as phases from '../engine/phases';
import * as combat from '../engine/combat';
import { unitsAvailableInSupply } from '../engine/mechanics';
import { PROJECT_ONLY_UNIT_IDS } from '../engine/units';
import { pickBestCinematicPlay } from '../engine/cinematicTactics';
import { missionTargets, missionRevealIsPointless, rebelLoyalSystemsInRegion } from '../engine/missionTargets';
// Re-exported so existing callers/tests that import it from the AI module keep
// working now that the canonical definition lives in the engine (#304).
export { missionRevealIsPointless } from '../engine/missionTargets';
import { COST_OBJECTIVES, objectiveProgress, objectiveConditionMet, objectiveReputationGain } from '../engine/objectives';
// Empire strike-fleet plan layer (#539) — a stateful delivery executor recomputed
// pure from public state each turn. Env-gated (SWR_EMPIRE_PLANNER=1); off by
// default → byte-identical to the pre-planner scorer.
import { derivePlan, planSystemBonus, deployProximityScore, PLANNER_ENABLED, HUNT_OCCUPY_ENABLED, type StrikeFleetPlan } from './empirePlanner';
import { log as logEvent } from '../engine/log';
import { rankerCoversSide, rankCandidates, RANKER_ROLLOUT } from './candidateRanker';

// AI randomness. Defaults to Math.random (live app), but the tournament
// harness calls seedAI() so AI-vs-AI runs are reproducible per seed — without
// this, the same game seed gives different outcomes run-to-run (the engine is
// seeded via rng.ts, but the AI's own coin-flips were not), which made
// intermittent stalls and win-rate comparisons impossible to pin down.

/** Pluggable per-side Command policy. When set for a side, stepOnce tries it
 *  FIRST for plain Command decisions and falls back to the built-in heuristic
 *  if it declines or throws. The CLIENT registers the depth-2 board-eval policy
 *  for the AI Rebel (confirmed +13.9pt over the heuristic across 900 post-#451
 *  self-play games); the SERVER deliberately never registers one — depth-2's
 *  ~2s/decision would blow Cloudflare's per-request CPU budget, so online vs-AI
 *  stays on the fast heuristic. Injection (rather than a direct import of
 *  boardEval) also avoids a module cycle: boardEval already imports this file. */
const commandPolicyOverride: Partial<Record<Side, (G: GameState, side: Side) => boolean>> = {};
export function setCommandPolicyOverride(
  side: Side, policy: ((G: GameState, side: Side) => boolean) | null,
): void {
  if (policy) commandPolicyOverride[side] = policy;
  else delete commandPolicyOverride[side];
}

let _aiRng: (() => number) | null = null;
export function seedAI(seed: number): void {
  let s = seed >>> 0;
  _aiRng = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function unseedAI(): void { _aiRng = null; }
function aiRand(): number { return _aiRng ? _aiRng() : Math.random(); }

/** Ordering key for tie-breaks: a hash of the candidate's id, salted with the
 *  game's current RNG state.
 *
 *  WHY A HASH AND NOT Math.random(). The bias being fixed here (see
 *  `argmaxTie`) is real, but curing it with live randomness would be worse than
 *  the disease: the app supports undo, so a nondeterministic AI would answer
 *  the same position differently after an undo/redo, and roughly forty engine
 *  tests that drive the AI without seeding it would become coin-flips. This
 *  keeps every position perfectly reproducible while removing the alphabet.
 *
 *  The rng state is READ, never advanced — no dice or draws are consumed, so
 *  this cannot desync a replay. It changes constantly as the game rolls and
 *  draws, so tied decisions resolve differently across turns and across games,
 *  but identically on a re-run of the same position. */
const CORUSCANT = 'coruscant';

/** Opt-out for assigning Capture Rebel Operative speculatively
 *  (SWR_CAPTURE_ASSIGN=0). Default ON. Off restores the old behaviour, where the
 *  mission was only assigned if a Rebel leader was ALREADY standing in a system
 *  with an Imperial unit — a condition that is false in 100% of Assignment
 *  phases, because Rebel leaders do not reach the board until they reveal their
 *  own missions during Command. Its two siblings (Detained, Collect Bounty)
 *  already had this exception; this one was left out. From jocke01's report.
 *  See docs/ab-levers.md. */
const CAPTURE_ASSIGN_SPECULATIVE: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_CAPTURE_ASSIGN === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Opt-out for the Coruscant threat response (SWR_DEFEND_CORUSCANT=0). Default
 *  ON. Off restores the old behaviour, which only noticed Rebels once they were
 *  standing ON the capital with the garrison already wiped out. From playtester
 *  jocke01's report that the Empire "reacts really slow" to fleets massing next
 *  to Coruscant. Self-play cannot measure this — the AI Rebel plays Heart of
 *  the Empire 0.027 times per game where a human plays it 2+ times in one — so
 *  the evidence is a fixture, not a win rate. See docs/ab-levers.md. */
/** Opt-out for valuing conversion of SUBJUGATED systems to Imperial loyalty
 *  (SWR_CONVERT_SUBJUGATED=0). Default ON — the old scoring priced control and
 *  ignored output; see the block in missionTargetScore and issue #738. */
const CONVERT_SUBJUGATED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_CONVERT_SUBJUGATED === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Candidate WIDTH (SWR_CAND_K, default 1 = the historical generator). How many
 *  targets each mission / each leader proposes to the search. Measured on 1,119
 *  exact Command-start positions from winning human games
 *  (scripts/eval-candidate-coverage.mjs): at K=1 the human's move is among the
 *  candidates only 31% of the time — 85% of reveal misses and 74% of activation
 *  misses are "right mission/leader, DIFFERENT target", because the generator
 *  emitted exactly one target each. MCTS can only choose among candidates, so
 *  this is a hard ceiling on the search regardless of budget. */
function candK(side: Side): number {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = Number(proc?.env?.SWR_CAND_K);
    if (Number.isFinite(v) && v >= 1) return Math.floor(v);
  } catch { /* browser: no process */ }
  // The imitation ranker was trained on K=4 generation and only pays off when
  // the human's move is actually generated (31% at K=1 vs 60% at K=4), so the
  // ranker implies width — but only for a side it actually ranks. Widening
  // the Empire without a ranker to order the extra targets broke two Empire
  // tripwires (a quiet Coruscant no longer bottom-ranked among duplicates;
  // #639's distinct-target invariant) for no measured benefit.
  return rankerCoversSide(side) ? 4 : 1;
}

/** Rapid Mobilization's hidden-base "massing" signal counts Empire ground
 *  within ONE hop (default) instead of two (SWR_RM_GATE=0). See the RM block in
 *  missionSituationalAdjust for the measurement. */
/** Rebel Assignment base-value calibration toward the recorded humans
 *  (Sabotage up, Hidden Fleet down); SWR_ASSIGN_CALIB=0 restores the old values. */
const ASSIGN_CALIB: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_ASSIGN_CALIB === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Empire Assignment calibration toward the recorded humans (2026-09-04,
 *  scripts/calibrate-assignment-values.mjs on 1150 exact human-Empire
 *  Assignment positions, split by game): (1) mission base values fitted so the
 *  planner's per-mission assignment rates match the humans' on the same
 *  positions (holdout mission-set agreement 0.26 -> 0.33); (2) the leader
 *  reserve scales with the pool — humans keep ~56% of their leaders for the
 *  Command phase (pool 8: keep 4.5, the AI kept 3); (3) Construct Death Star is
 *  gated on a Death Star Under Construction being in supply, not on owning a
 *  factory (RAW: it goes straight onto the build queue). SWR_EMPIRE_CALIB=0
 *  restores the old values, the flat reserve of 3, and the factory gate. */
const EMPIRE_CALIB: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_EMPIRE_CALIB === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

const RM_GATE_ONE_HOP: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_RM_GATE === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

const DEFEND_CORUSCANT: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_DEFEND_CORUSCANT === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Opt-out for the unbiased tie-break (SWR_TIEBREAK=0). Default ON. Off
 *  restores the old first-wins behaviour, which resolved every tied decision to
 *  the alphabetically-first system. Exists so the change stays measurable —
 *  see docs/ab-levers.md; the shipped measurement is a mission-target
 *  distribution, not a win rate. */
const UNBIASED_TIEBREAK: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_TIEBREAK === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

function tieKey(G: GameState, id: string): number {
  if (!UNBIASED_TIEBREAK) return 0; // all keys equal → first-wins, the old behaviour
  let h = ((G.rng?.state ?? 0) ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Highest-scoring item, breaking EXACT ties without favouring list order.
 *
 *  The naive `if (s > best)` loop keeps the first maximum, which is not a
 *  neutral choice: system candidates come from `Object.keys(G.map.systems)`,
 *  whose insertion order is the catalog's — and the catalog is stored
 *  alphabetically, with `alderaan` at index 0. So every tied decision silently
 *  resolved to whichever system sorts earliest, and the AI looked like it had a
 *  fixation. A playtester spotted the pattern from the outside and guessed the
 *  cause exactly: "it often targets alderaan with missions. I think it's
 *  because it's first in alphabetical order."
 *
 *  Ties are common because these scorers deal in small integers, so a flat
 *  board hands many systems the same number. Breaking ties by hash changes no
 *  ranking — a strictly better option still wins — it just stops the tiebreak
 *  from encoding the alphabet. */
function argmaxTie<T>(
  G: GameState, items: readonly T[], keyOf: (x: T) => string, score: (x: T) => number,
): { item: T; score: number } | null {
  let best: T[] = [];
  let bestScore = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s > bestScore) { bestScore = s; best = [it]; }
    else if (s === bestScore) best.push(it);
  }
  if (best.length === 0) return null;
  let winner = best[0];
  let winnerKey = tieKey(G, keyOf(best[0]));
  for (let i = 1; i < best.length; i++) {
    const k = tieKey(G, keyOf(best[i]));
    if (k < winnerKey) { winner = best[i]; winnerKey = k; }
  }
  return { item: winner, score: bestScore };
}

function pick<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(aiRand() * arr.length)];
}

/** A copy reordered by tie-key. Feed this to a `.sort()` that ranks by score
 *  when ties are meaningful: Array.prototype.sort is STABLE, so equal scores
 *  come out in input order — and system lists are built from
 *  `Object.keys(G.map.systems)`, which is the alphabetically-stored catalog.
 *  Sorting a raw system list therefore ranks every tied group alphabetically,
 *  and taking `[0]` picks the earliest name on the board. Pre-ordering by hash
 *  makes the stable sort's tie order arbitrary-but-reproducible, leaving the
 *  score ordering untouched. */
function tieOrdered(G: GameState, arr: readonly string[]): string[] {
  return arr.slice().sort((a, b) => tieKey(G, a) - tieKey(G, b));
}

/** Test hooks for scripts/test-alphabetical-tiebreak-bias.mjs. The tiebreak is
 *  the whole point of that test and isn't reachable from outside without
 *  driving a full tournament. Not used by the app. */
export const __testArgmaxTie = argmaxTie;
export const __testTieOrdered = tieOrdered;
export const __testPlannedMoveOrders = (
  G: GameState, side: Side, targetSystemId: SystemId,
): phases.MoveOrder[] => plannedMoveOrders(G, side, targetSystemId);

/** Max Rebel units the AI keeps at the hidden base during setup. The rest go
 *  to one Rebel/neutral "decoy" system. Empire's Gather Intel draws 1 probe
 *  card per 4 Rebel units AT THE BASE (min 1), so a leaner base = slower base
 *  discovery — at the cost of weaker base defense and exposed decoy units.
 *  Tournament-tunable: set SWR_REBEL_BASE_KEEP in the harness to sweep it.
 *  Default 99 = keep everything at base (original behavior) until a tuned
 *  value is baked in. Guarded so the browser build (no `process`) is safe. */
const REBEL_BASE_KEEP: number = (() => {
  try {
    // Access process via globalThis so the browser build typechecks without
    // @types/node (which CLAUDE.md forbids adding to the main tsconfig).
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const env = proc?.env;
    const raw = env?.SWR_REBEL_BASE_KEEP;
    if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
  } catch { /* browser: no process */ }
  return 99;
})();

/** Pick a Rebel/neutral system (not Coruscant, not the actual hidden base) to
 *  hold the Rebel's "decoy" overflow units at setup. Prefer Rebel-loyal
 *  systems far from Empire units so the decoy survives. null if none. */
function chooseRebelDecoySystem(G: GameState): SystemId | null {
  const baseId = G.rebelBaseSystemId;
  const empireSystems = Object.keys(G.map.systems).filter((sid) =>
    G.map.systems[sid]?.units.some((u) => u.side === 'Empire'));
  const candidates = Object.keys(G.map.systems).filter((sid) => {
    if (sid === baseId) return false;
    const def = G.catalog.systems[sid];
    const ss = G.map.systems[sid];
    if (!def || !ss || def.isCoruscant || def.isRemote) return false;
    return !(ss.subjugated || ss.loyalty === 'imperial'); // populous Rebel/neutral only
  });
  if (candidates.length === 0) return null;
  const score = (sid: SystemId): number => {
    const ss = G.map.systems[sid];
    let s = ss?.loyalty === 'rebel' ? 5 : 0;
    let minDist = Infinity;
    for (const es of empireSystems) {
      const d = bfsDistances(G, es, 6).get(sid);
      if (d != null && d < minDist) minDist = d;
    }
    if (minDist !== Infinity) s += Math.min(minDist, 6);
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

/** Rebel AI setup deploy: keep up to REBEL_BASE_KEEP units at the hidden base
 *  (better defenders first; the no-attack transport ships out first), and
 *  send the overflow to one decoy system to cut the Empire's Gather-Intel
 *  yield. Places ALL pending Rebel units in one call. Falls back to plain
 *  auto-fill (all at base) when thinning is off or no decoy qualifies. */
function aiRebelSetupDeploy(G: GameState): boolean {
  const pending = G.pendingDeployment?.Rebel;
  if (!pending || pending.length === 0) return false;
  const decoy = REBEL_BASE_KEEP >= 99 ? null : chooseRebelDecoySystem(G);
  if (!decoy) return phases.setupAutoFill(G, 'Rebel').ok;
  const alreadyAtBase = G.map.rebelBaseSpace.units.filter((u) => u.side === 'Rebel').length;
  const keepRank = (typeId: string): number => {
    const t = G.catalog.unitTypes[typeId];
    if (!t) return 0;
    const atk = (t.attack?.red ?? 0) + (t.attack?.black ?? 0);
    let r = (t.health?.value ?? 1) * 2 + atk;
    if (t.class === 'capital') r += 3;
    if (t.theater === 'ground') r += 2;
    if (atk === 0) r -= 10; // transport (no attack): most expendable
    return r;
  };
  const order = [...pending].sort((a, b) => keepRank(b) - keepRank(a));
  let baseSlots = Math.max(0, REBEL_BASE_KEEP - alreadyAtBase);
  let placedAny = false;
  for (const typeId of order) {
    const dest: SystemId = baseSlots > 0 ? 'rebel-base-space' : decoy;
    const r = phases.setupDeployUnit(G, 'Rebel', typeId, dest);
    if (r.ok) {
      placedAny = true;
      if (dest === 'rebel-base-space') baseSlots--;
    } else if (dest !== 'rebel-base-space') {
      // Decoy placement failed for some reason — keep this one at base.
      if (phases.setupDeployUnit(G, 'Rebel', typeId, 'rebel-base-space').ok) placedAny = true;
    }
  }
  return placedAny;
}

// ============================================================================
// Strategy primitives
// ============================================================================

/** How many leaders the Empire AI tries to keep in the pool for opposition.
 *  At least one when revealable missions exist. */
// Empire reserves leaders for the Command phase. The path to Empire
// victory requires ACTIVATING systems (moving units, triggering combat).
// With reserve=1, Empire was assigning every available leader to a
// mission and never activating; tournament data showed 0 activations
// in 13-round games. Reserve=3 keeps 3 leaders free for the Command
// phase to do exploration + invasion (was 2; 3 lets Empire run multiple
// activations per turn even after recruiting picks up additional leaders).
const EMPIRE_RESERVE_LEADERS = 3;
/** Calibrated reserve: the recorded human Empires assign 1.3 / 2.3 / 2.8 / 3.3 /
 *  3.5 / 4.0 leaders from pools of 4..9 — i.e. they keep about 56% back for
 *  the Command phase, never fewer than 3 — where the flat reserve assigned
 *  pool-3 (up to 5.3 from a pool of 9). */
function empireReserveLeaders(pool: number): number {
  return EMPIRE_CALIB ? Math.max(EMPIRE_RESERVE_LEADERS, Math.round(pool * 0.56)) : EMPIRE_RESERVE_LEADERS;
}

/** Static-ish strategic value of attempting a mission, before situational
 *  modifiers. Higher = AI cares more about this mission. */
/** Fitted 2026-09-04 (see EMPIRE_CALIB). Human% / heuristic% on the same
 *  positions after the fit are in docs/ab-levers.md; the big moves: Lure of the
 *  Dark Side 9->17 (humans 53%, AI 16%), Gather Intel 15->8.6 (humans 24%, AI
 *  73%), Message from High Command / Display of Power / Fear Will Keep Them in
 *  Line up from the 5 default (humans 74% / 60% / 78%), Oversee Project 8->5
 *  (humans 26%, AI 61%), Research & Development 13->8.7. Fitted at 0.1
 *  resolution on purpose: rounding to halves tied nine missions at 8.5 and the
 *  greedy planner's agreement fell from 0.345 to 0.247. Unlisted missions keep
 *  the default 5. */
const EMPIRE_VALUES_CALIBRATED: Record<string, number> = {
  // probe pulls
  'gather-intel': 8.6, 'research-and-development': 8.7, 'probe-droid-initiative': 5.1, 'long-range-probe': 5,
  'homing-beacon': 5.9, 'intercept-transmissions': 5.7,
  // captures / captive plays
  'capture-rebel-operative': 8.6, 'detained': 4.7, 'carbon-freezing': 8.9, 'lure-of-the-dark-side': 17.2,
  'make-an-example': 9.1, 'interrogation': 6.2, 'retrieve-the-plans': 7.4, 'break-their-will': 7.2,
  'hunt-them-down': 5.2, 'secure-the-plans': 5.1, 'stolen-intel': 5.1,
  // loyalty / diplomacy
  'rule-by-fear': 8.7, 'trade-negotiations': 8.6, 'fear-will-keep-them-in-line': 8.7, 'message-from-high-command': 9.1,
  'display-of-power': 8.7, 'imperial-propaganda': 7, 'discredit-rebellion': 4.9, 'subversion-new': 4.4,
  'subversion-original': 5.1, 'planetary-conquest': 5.2, 'draw-them-out': 4.5, 'were-the-bait': 7.3,
  'exploit-weakness': 6.7,
  // projects / builds
  'construct-death-star': 16.7, 'construct-factory': 7.1, 'construct-super-star-destroyer': 8.5, 'oversee-project': 5.1,
  'superlaser-online': 11.3, 'interdictor-development': 8, 'deployment': 8.6, 'address-delays': 5.7,
  'single-reactor-ignition': 5.9, 'double-our-efforts': 5, 'secret-weapons-research': 5.1, 'imperial-promotion': 4.9,
  'imperial-might': 4.9,
};

function missionBaseValue(missionId: string, side: Side): number {
  const empireValues: Record<string, number> = EMPIRE_CALIB ? EMPIRE_VALUES_CALIBRATED : {
    // Probe-card pulls — narrowing base. Bumped: human Empire wins
    // showed running probe-draw missions twice in T1 + T2 is critical
    // to set up subjugation-search later. These should beat almost
    // everything else early.
    'gather-intel': 15,
    'research-and-development': 13,
    // Captures — rob the Rebel of a leader
    'capture-rebel-operative': 11,
    'collect-bounty': 10,
    'detained': 8,
    'carbon-freezing': 6,
    'lure-of-the-dark-side': 9,
    'interrogation': 7,
    'interrogation-droid': 8,
    'retrieve-the-plans': 8,
    // Diplomacy / loyalty
    'rule-by-fear': 9,
    'trade-negotiations': 7,
    'fear-will-keep-them-in-line': 7,
    // Projects (build queue plumbing)
    'construct-death-star': 14,
    'construct-factory': 9,
    'construct-super-star-destroyer': 11,
    'oversee-project': 8,
    'superlaser-online': 10,
    // Subjugation / sabotage
    // MEASURED 2026-09-03 on 335 exact human-Rebel Assignment positions (the
    // #555/#718 instrument, scripts/eval-assignment-agreement.mjs): recorded
    // humans assign Sabotage in 83% of rounds, the heuristic in 71% on the same
    // positions; Hidden Fleet human 2% vs heuristic 11%. SWR_ASSIGN_CALIB=0
    // restores 6 / 8.
    'sabotage': ASSIGN_CALIB ? 8 : 6,
  };
  const rebelValues: Record<string, number> = {
    // Defensive / base protection
    'hit-and-run': 9,
    'hidden-fleet': ASSIGN_CALIB ? 5 : 8,
    'demolition': 8,
    // Diplomacy / loyalty (user emphasized)
    'wookie-uprising': 12,
    'support-of-mon-calamari': 12,
    'establish-trade-relations': 10,
    'ignite-rebellion': 10,
    'public-uprising': 10,
    'for-the-greater-good': 11,
    // Recruit / rescue
    'daring-rescue': 12,
    'an-old-friend': 9,
    'seek-yoda': 11,
    // Sabotage / info
    'covert-operation': 8,
    'plant-false-lead': 9,
    'homing-beacon': 7,
    'intercept-transmissions': 7,
    'base-defenses': 8,
    'stolen-plans': 9,
    'misdirection': 7,
    // Critical-path
    'plan-the-assault': 10,
    'lead-the-strike-team': 11,
    'contingency-plan': 8,
    'rapid-mobilization': 9,
  };
  const table = side === 'Empire' ? empireValues : rebelValues;
  const ov = MISSION_VALUE_OVERRIDE[side];
  if (ov && missionId in ov) return ov[missionId];
  return table[missionId] ?? 5;
}

/** Calibration hook (scripts/calibrate-assignment-values.mjs): replace base
 *  values per side at runtime so the planner can be re-run on the stored human
 *  positions with a candidate table. Never set in the game. */
const MISSION_VALUE_OVERRIDE: Record<Side, Record<string, number> | null> = { Empire: null, Rebel: null };
export function __testMissionBaseValue(missionId: string, side: Side): number { return missionBaseValue(missionId, side); }
export function __setMissionValueOverride(side: Side, table: Record<string, number> | null): void {
  MISSION_VALUE_OVERRIDE[side] = table;
}

/** Skill-fit of a single leader for a single mission. Returns 0 if the
 *  leader contributes none of the mission's required skill, else weighted
 *  by skill icons. */
function leaderSkillFit(G: GameState, leaderId: LeaderId, missionId: string): number {
  const card = G.catalog.missions[missionId];
  const leader = G.catalog.leaders[leaderId];
  if (!card || !leader || !card.skill) return 0;
  // Mission counts-all-skills special-case (rare).
  const countsAll = card.id === 'interrogation-droid' || card.id === 'lure-of-the-dark-side';
  if (countsAll) {
    const sk = leader.skills;
    return (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0);
  }
  return leader.skills[card.skill as keyof typeof leader.skills] ?? 0;
}

/** Bonus for the leader matching the mission's preferred portrait (the
 *  illustrated leader on the card). Strong hint about intended-pairing. */
function leaderPortraitBonus(G: GameState, leaderId: LeaderId, missionId: string): number {
  const card = G.catalog.missions[missionId];
  if (!card || !card.leaderPortrait) return 0;
  return card.leaderPortrait === leaderId ? 4 : 0;
}

/** Hard-coded leader-mission pairings the engine especially values
 *  (e.g. mission-card text rewards specific leaders). */
function leaderMissionBespoke(leaderId: LeaderId, missionId: string): number {
  // An Old Friend: Han at Bespin/Kashyyyk to recruit Lando/Chewie.
  if (missionId === 'an-old-friend' && leaderId === 'han-solo') return 4;
  // Seek Yoda → Luke gets the Jedi swap.
  if (missionId === 'seek-yoda' && leaderId === 'luke-skywalker') return 5;
  // Contingency Plan: Lando gives +2 successes later.
  if (missionId === 'contingency-plan' && leaderId === 'lando-calrissian') return 3;
  // Construct Death Star / SSD prefer Jerjerrod or Tarkin.
  if (missionId === 'construct-death-star' && (leaderId === 'moff-jerjerrod' || leaderId === 'grand-moff-tarkin')) return 3;
  // Build/queue work prefers Tarkin.
  if ((missionId === 'oversee-project' || missionId === 'construct-factory')
    && leaderId === 'grand-moff-tarkin') return 3;
  return 0;
}

/** Combined "should this leader take this mission?" score. Returns -Infinity
 *  if it would be illegal (mission requires a different leader by name). */
function leaderMissionScore(G: GameState, leaderId: LeaderId, missionId: string, side: Side): number {
  const card = G.catalog.missions[missionId];
  if (!card) return -Infinity;
  const fit = leaderSkillFit(G, leaderId, missionId);
  // If the mission has a skill requirement and the leader contributes nothing,
  // they're a poor pick unless we're combining with another leader.
  // We still return a non-negative score (the planner can pair them).
  const value = missionBaseValue(missionId, side);
  const portrait = leaderPortraitBonus(G, leaderId, missionId);
  const bespoke = leaderMissionBespoke(leaderId, missionId);
  return value + fit * 2 + portrait + bespoke;
}

/** Does the Empire already hold a captured Rebel leader (cap at 1 — user's
 *  point that a second capture releases the first)? */
function empireHoldingCapture(G: GameState): boolean {
  return (G.empire.capturedLeaders ?? []).some((c) => c.ring === 'captured');
}

/** A mission's situational adjustment: amplify or suppress based on board
 *  state. E.g. capture missions are worthless if Empire already holds a
 *  captured leader; probe missions are worthless once base is revealed. */
function missionSituationalAdjust(G: GameState, missionId: string, side: Side): number {
  let adj = 0;
  if (side === 'Empire') {
    const captureKinds = new Set(['capture-rebel-operative', 'collect-bounty', 'detained']);
    if (captureKinds.has(missionId) && empireHoldingCapture(G)) adj -= 10;
    const probeKinds = new Set(['gather-intel', 'research-and-development']);
    if (probeKinds.has(missionId) && G.rebelBaseRevealed) adj -= 8;
    // WEAKNESS 1 (log analysis, 13-game corpus): in 3/3 losses, Empire spent
    // ~85% of revealed missions on probe-pull. Once probe info has already
    // narrowed the candidate set, more probes have sharply diminishing value
    // — the AI should pivot to invasion-support (rule-by-fear, builds, captures).
    // Halve probe value once probe deck is ≥60% depleted OR candidate set ≤8.
    if (probeKinds.has(missionId) && !G.rebelBaseRevealed) {
      const probeHand = G.empire.probeHand ?? [];
      const probeDeck = G.probeDeck ?? [];
      const totalProbes = probeHand.length + probeDeck.length;
      const flippedRatio = totalProbes > 0 ? probeHand.length / totalProbes : 0;
      // Candidate set = non-coruscant, non-remote, non-probe-eliminated systems.
      const eliminated = new Set(probeHand
        .map((pid) => G.catalog.probes[pid]?.systemId)
        .filter((s): s is string => !!s));
      let candidates = 0;
      for (const def of Object.values(G.catalog.systems)) {
        if (def.isRemote || def.isCoruscant) continue;
        if (eliminated.has(def.id)) continue;
        candidates++;
      }
      if (flippedRatio >= 0.6 || candidates <= 8) adj -= 8;
    }
    // WEAKNESS 4: construct-death-star revealed in losses but never used.
    // Damp the score when (a) no factory exists yet (can't build anyway)
    // or (b) the project is already on the project pile / built. Forces
    // the slot toward rule-by-fear / capture missions that move the
    // invasion forward.
    if (missionId === 'construct-death-star') {
      const empireFactories = Object.values(G.map.systems).some(
        (ss) => ss.units.some((u) => u.side === 'Empire' && u.typeId === 'construction-yard')
      );
      if (EMPIRE_CALIB) {
        // RAW: "Gain 1 Death Star Under Construction in this system and place 1
        // Death Star on space 3 of the build queue" — no factory involved. The
        // only real precondition is a DSUC left in supply; the old factory gate
        // skipped a mission the recorded humans assign in 39% of rounds held.
        if (unitsAvailableInSupply(G, 'death-star-under-construction') < 1) adj -= 20;
      } else if (!empireFactories) adj -= 8;
      // Already revealed once → don't re-reveal.
      const alreadyRevealed = G.turnLog.some((e) =>
        e.kind === 'reveal-mission' && e.payload?.missionId === 'construct-death-star'
      );
      if (alreadyRevealed) adj -= 10;
    }
  }
  if (side === 'Rebel') {
    // Daring Rescue worthless unless there's a captured leader.
    if (missionId === 'daring-rescue'
      && (G.empire.capturedLeaders?.length ?? 0) === 0) adj -= 8;
    if (missionId === 'for-the-greater-good'
      && (G.empire.capturedLeaders?.length ?? 0) === 0) adj -= 8;
    // Rapid Mobilization is the Rebel's escape hatch — it can relocate the
    // hidden base. Strongly prefer it when the base is in danger (revealed,
    // or Empire units closing in), and avoid wasting it when the base is
    // safe (relocating a safe hidden base mostly just disrupts your own
    // position). User-reported gap: the AI never relocated under threat.
    if (missionId === 'rapid-mobilization') {
      // Player reports #439/#445/#453: the AI mobilizes almost every turn / turn 1
      // / just to stack ships on the base. Root cause — the old "threatened" flag
      // fired on ANY Empire ground unit within 2 hops, so it was true almost every
      // game (the Empire is everywhere) and RM always got +20. Split it properly:
      //  - base REVEALED → imminent capture; escaping is the whole point (+20).
      //  - hidden but a real ground force is MASSING near it (>=2 within 2 hops) →
      //    a preemptive relocation is reasonable, but not urgent (+2).
      //  - otherwise the hidden base is safe → don't burn the slot; the Rebel
      //    should spend it on loyalty/economy (-14, net negative → planner skips).
      // MEASURED 2026-09-03 on 328 exact hidden-base positions from the archive
      // (#555/#718, "plays Rapid Mobilization every turn"): the massing branch
      // (>=2 Empire mobile ground within 2 hops) was TRUE in 67% of them — the
      // Empire garrisons everywhere — so RM scored 11 and the planner assigned
      // it in 66% of those rounds where the recorded humans assigned it in 15%.
      // And the humans' RM rate barely tracks that count (12-21% from 0 to 6+
      // units within 2 hops): a hidden base is treated as safe unless the
      // threat is IMMINENT. So the massing signal is now ground within ONE hop.
      // SWR_RM_GATE=0 restores the 2-hop branch for A/B.
      if (G.rebelBaseRevealed) adj += 20;
      else if (RM_GATE_ONE_HOP ? empireProximityToBase(G, 1) >= 2 : empireProximityToBase(G) >= 2) adj += 2;
      else adj -= 14;
    }
    // ECONOMY (divergence harness): the AI Rebel gained loyalty 43% less per
    // round than the expert, cascading into 30% fewer builds, 16% fewer
    // deploys, and 55% fewer unit moves — it simply controlled fewer loyal
    // resource systems. Build slots are 1:1 with loyal resource icons, and a
    // flipped system produces EVERY build turn for the rest of the game, so a
    // loyalty flip COMPOUNDS and is worth far more early. Amplify loyalty-gain
    // missions, strongest early, tapering to ~0 as the build turns run out.
    const REBEL_LOYALTY_MISSIONS = new Set([
      'build-alliance', 'establish-trade-relations', 'support-of-mon-calamari',
      'wookie-uprising', 'regional-aid',
    ]);
    if (REBEL_LOYALTY_MISSIONS.has(missionId)) {
      // Build turns remaining ≈ (16 − timeMarker)/2 (builds fire on even turns
      // 2..14). Each future build turn is one more harvest from a flip now.
      const buildTurnsLeft = Math.max(0, Math.ceil((16 - G.timeMarker) / 2));
      adj += Math.min(buildTurnsLeft, 7); // up to +7 early → 0 by end-game
    }
  }
  // Diminishing returns: each prior successful reveal of THIS mission by
  // THIS side reduces score by 3. Tournament data showed Empire running
  // gather-intel 10×/game and research-and-development 9×/game in no-reveal
  // games (vs 3× / 2.5× in won games) — the AI kept picking the same
  // mission because score was constant. Now repeats taper off, freeing
  // mission slots for activations / diversification.
  let priorReveals = 0;
  for (const e of G.turnLog) {
    if (e.kind === 'reveal-mission' && e.side === side && e.payload?.missionId === missionId) {
      priorReveals++;
    }
  }
  adj -= Math.min(priorReveals, 8); // -1 per repeat, capped at -8
  return adj;
}

/** Single-source shortest-paths over the adjacency graph from `origin`.
 *  Returns a Map of systemId → hop-count. Capped at maxHops to keep the
 *  search tight. */
function bfsDistances(G: GameState, origin: SystemId, maxHops = 10): Map<string, number> {
  const dist = new Map<string, number>([[origin, 0]]);
  let frontier: string[] = [origin];
  for (let d = 1; d <= maxHops; d++) {
    const next: string[] = [];
    for (const s of frontier) {
      for (const n of (G.catalog.adjacency[s] ?? [])) {
        if (!dist.has(n)) { dist.set(n, d); next.push(n); }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return dist;
}

/** Cached distance lookup. Caller passes the BFS map; absent entries are
 *  treated as Infinity. */
function distFrom(map: Map<string, number>, target: SystemId): number {
  return map.get(target) ?? Infinity;
}

/** Count Empire units within 2 hops of the Rebel base. Used by Rebel AI
 *  to detect base threat. */
function empireProximityToBase(G: GameState, hops = 2): number {
  if (!G.rebelBaseSystemId) return 0;
  const dist = bfsDistances(G, G.rebelBaseSystemId, hops);
  let count = 0;
  for (const [sysId, d] of dist) {
    if (d > hops) continue;
    // Count only the Empire's mobile GROUND force — that's what captures a base.
    // Counting every nearby ship/fighter made the Rebel flag a "threat" almost
    // every turn (the Empire is everywhere), so it relocated its base constantly
    // and never developed. Ground units approaching IS the real signal to flee.
    count += (G.map.systems[sysId]?.units ?? []).filter((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      return u.side === 'Empire' && t?.theater === 'ground'
        && t.class !== 'structure' && !t.transport.immobile;
    }).length;
  }
  return count;
}

/** Choose the Rebel base at setup: the SAFEST candidate, not a random one
 *  (two reporters independently: "just choose a base more than one move away
 *  from any Imperial starting planet"). Weights match the human corpus (30
 *  recorded setups: ~1 hop farther from the Empire than the average
 *  candidate, rebel-loyal at 3x the pool rate) with DISTANCE DOMINANT —
 *  a loyal system adjacent to the Empire is still a bad base:
 *  - +4 per hop of BFS distance from the nearest Imperial presence (imperial
 *    loyalty or Empire units), capped at 4. Distance >= 2 also means no
 *    turn-1 transport reach, freeing the start fleet to strike instead of
 *    turtling behind turn-1 Rapid Mobilization.
 *  - +2 if rebel-loyal (build synergy) — a same-distance tiebreak only.
 *  - Remote/resources deliberately unscored (corpus: both ~pool rate).
 *  Exported for tests. */
export function chooseRebelBaseSystem(G: GameState, candidates: SystemId[]): SystemId {
  const imperial = Object.keys(G.map.systems).filter((sid) =>
    G.map.systems[sid]?.loyalty === 'imperial'
    || G.map.systems[sid]?.units.some((u) => u.side === 'Empire'));
  const distTo = new Map<string, number>();
  let frontier = imperial.slice();
  for (const s of frontier) distTo.set(s, 0);
  let d = 0;
  while (frontier.length && d < 8) {
    d++; const next: string[] = [];
    for (const s of frontier) for (const a of (G.catalog.adjacency[s] ?? [])) {
      if (!distTo.has(a)) { distTo.set(a, d); next.push(a); }
    }
    frontier = next;
  }
  // DOCTRINE SWITCH (SWR_BASE_PLACEMENT / ?baseplacement=): 'safe' (default,
  // shipped d109be6, +7pt) maximises distance from the Empire — the base is
  // never threatened early, but there is then NO turn-1 alpha-strike target in
  // reach (measured 0/20 games with an Empire-occupied adjacent system).
  // 'aggressive' is jocke01's doctrine: sit next to an Empire system so the
  // Rebel's starting fleet can strike on turn 1 before the Empire acts at all,
  // accepting base risk for tempo. These are competing strategies, not a fix
  // and a bug — hence the A/B switch rather than a replacement.
  const aggressive = (() => {
    try {
      const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
      if (proc?.env?.SWR_BASE_PLACEMENT === 'aggressive') return true;
    } catch { /* browser */ }
    try {
      const g = globalThis as { location?: { search?: string } };
      return g.location?.search
        ? new URLSearchParams(g.location.search).get('baseplacement') === 'aggressive'
        : false;
    } catch { return false; }
  })();
  const hasStrikeTarget = (sid: string): boolean =>
    (G.catalog.adjacency[sid] ?? []).some((a) =>
      (G.map.systems[a]?.units ?? []).some((u) => u.side === 'Empire'));
  const score = (sid: string): number => {
    const far = Math.min(distTo.get(sid) ?? 8, 4); // unreached in 8 hops = max
    const loyal = G.map.systems[sid]?.loyalty === 'rebel' ? 2 : 0;
    if (aggressive) {
      // Strike target dominates; mild distance term still breaks ties toward
      // the less-swarmable of two adjacent-to-Empire candidates.
      return (hasStrikeTarget(sid) ? 12 : 0) + far + loyal;
    }
    return far * 4 + loyal;
  };
  // Sample among the near-best candidates instead of taking the deterministic
  // maximum. `sort(...)[0]` made the pick a pure function of the map, and the
  // map's geography barely varies — measured across 600 games the base was at
  // RYLOTH 53% OF THE TIME, and a playtester noticed from the other side of
  // the table: "the rebel base is almost every time at ryloth - a bit more
  // variability could be useful" (#718). That understates it. A hidden base's
  // value is partly its unpredictability; an Empire that knows to probe Ryloth
  // first gets the single most important piece of information in the game for
  // free, every game. Trading up to 4 points of placement score (one distance
  // step) for entropy is the same call a human makes when they don't always
  // pick the "obvious" base.
  // Eligibility is DISTANCE-AWARE rather than a flat score margin: a flat
  // margin of one hop (4 points) let the sampler trade the base to distance 1
  // on cramped maps — turn-1 transport reach for the Empire — which
  // test-base-placement-heuristic rightly rejects. Distance ties are always
  // eligible (the +2 loyalty bonus rides along and no safety is given up); a
  // one-hop concession is eligible only while it still leaves the base 2+ hops
  // out, i.e. beyond the Empire's turn-1 reach.
  const farOf = (sid: string): number => Math.min(distTo.get(sid) ?? 8, 4);
  // The aggressive doctrine's whole point is the strike target, so eligibility
  // there is "has one" (sampling only varies WHICH Empire neighbour to camp);
  // if none exists it degrades to the safe rule, same as its score formula.
  const strikers = aggressive ? candidates.filter(hasStrikeTarget) : [];
  const pool = strikers.length > 0 ? strikers : candidates;
  const bestFar = Math.max(...pool.map(farOf));
  const good = pool.filter((sid) =>
    farOf(sid) === bestFar || (farOf(sid) === bestFar - 1 && farOf(sid) >= 2));
  // `score` stays the within-pool preference for the degenerate single-option
  // maps; sampling handles everything else.
  if (good.length === 0) return [...pool].sort((a, b) => score(b) - score(a))[0];
  return good[Math.min(good.length - 1, Math.floor(aiRand() * good.length))];
}

/** How much the Rebel wants to KEEP a drawn objective (Infiltration / Covert
 *  Operation both offer "keep one, bury the other"). Was raw printed
 *  reputation, which reviewers flagged as the wrong axis: Ehlijen observed the
 *  Rebel's best games came when it drew objectives it was ALREADY working
 *  toward, and its worst when it drew ones the Empire had spent the game
 *  preventing — i.e. keep what's ACHIEVABLE, not what's worth most on paper.
 *  Reputation stays as the tiebreak, outweighed by:
 *   - Death Star Plans: jocke01's explicit turn-1 dig target, and the Rebel can
 *     now actually cash it (the DS-opportunism rule attacks a weakly-escorted
 *     Death Star when the plans are held).
 *   - Family synergy: another copy/tier of something already in hand means the
 *     board work is already underway.
 *  Deliberately NOT a full per-objective progress model — that needs the
 *  objective-requirement machinery; this is the cheap, directionally-right fix. */
function objectiveKeepValue(G: GameState, oid: string): number {
  const rep = G.catalog.objectives[oid]?.reputation ?? 0;
  let v = rep;
  if (oid.startsWith('death-star-plans')) v += 6;
  const family = (id: string) => id.replace(/-\d+$/, '');
  const fam = family(oid);
  if ((G.rebel.objectiveHand ?? []).some((h) => h !== oid && family(h) === fam)) v += 4;
  return v;
}

/** Best Rapid Mobilization move-units source: the leaderless system holding
 *  the most SELF-MOBILE Rebel ships (RM can't move out of systems with a
 *  friendly leader; ground needs carriers, structures can't move — ships are
 *  the always-legal cargo). Count capped at 5 = the card's move limit.
 *  NOTE (2026-07-16): gating the RM mission SCORE on this ("only reveal when
 *  a 2+ ship consolidation exists") A/B'd NEGATIVE across 3 seeds (-5pt mean,
 *  120 games/arm) — in self-play the frequent RM reveal-and-consolidate loop
 *  genuinely protects the base. Don't re-add the gate; this helper only
 *  improves WHICH pocket gets consolidated. */
function bestRmConsolidationSource(G: GameState): { systemId: SystemId | null; count: number; unitIds: string[] } {
  let best: { systemId: SystemId | null; count: number; unitIds: string[] } = { systemId: null, count: 0, unitIds: [] };
  for (const sysId of Object.keys(G.map.systems)) {
    if ((G.rebel.leadersOnBoard[sysId] ?? []).length > 0) continue;
    const ships = G.map.systems[sysId].units.filter((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      return u.side === 'Rebel' && t?.theater === 'space' && !t.transport.immobile;
    });
    if (ships.length > best.count) {
      best = { systemId: sysId as SystemId, count: Math.min(ships.length, 5), unitIds: ships.slice(0, 5).map((u) => u.instanceId) };
    }
  }
  return best;
}

/** Score a target system for an Empire mission, with situational bias. */
/** Opposition term shared by both sides' target scoring.
 *
 *  RAW: an ATTEMPT mission whose target system has NO opposing leader present
 *  AUTO-SUCCEEDS — no roll, strict upside (rr p.8). The expert engineers this
 *  constantly (they get ~3× the unopposed successes the current AI does, and
 *  roll ~2× less — see scripts/ai-divergence.mjs). The old target scoring never
 *  rewarded an undefended target, so the AI happily revealed into a system with
 *  an enemy leader sitting on it and gambled on dice.
 *
 *  Returns a score delta for choosing `targetSysId`:
 *   - undefended (no opposing leader)  → +bonus (auto-success)
 *   - defended                         → −penalty scaled by the opposers'
 *                                        icons in THIS mission's skill (a
 *                                        high-skill opposer rolls more dice and
 *                                        is likelier to beat the attempt).
 *  RESOLVE missions (isAttempt:false, e.g. Seek Yoda) skip opposition entirely,
 *  so they get no term. */
function oppositionTargetTerm(G: GameState, attackerSide: Side, missionId: string, targetSysId: SystemId): number {
  const card = G.catalog.missions[missionId];
  if (!card || !card.isAttempt) return 0; // RESOLVE missions can't be opposed
  const oppSide = attackerSide === 'Rebel' ? 'Empire' : 'Rebel';
  const oppF = oppSide === 'Rebel' ? G.rebel : G.empire;
  const oppLeaders = oppF.leadersOnBoard[targetSysId] ?? [];
  if (oppLeaders.length === 0) {
    return 6; // undefended → auto-success. The headline expert behavior.
  }
  // Defended: penalize by how hard they can oppose. Opposers roll dice equal to
  // their icons in the mission's skill, so a 0-icon opposer barely threatens the
  // attempt while a 2-icon opposer is a real wall. Always at least a small
  // penalty for the presence of ANY leader (they still roll a die / can react).
  let oppSkill = 0;
  for (const lid of oppLeaders) {
    const ld = G.catalog.leaders[lid];
    if (!ld || !card.skill) continue;
    oppSkill += (ld.skills[card.skill as keyof typeof ld.skills] ?? 0);
  }
  return -2 - oppSkill * 2; // -2 (any leader) down through -2/skill-icon
}

/** Strategic worth of DESTROYING one enemy unit, for the "destroy up to N
 *  health worth of units of your choice in this system" missions (Hit And Run,
 *  Hunt Them Down).
 *
 *  `unitStrength` alone (dice + health) is the wrong yardstick here: it prices
 *  a unit by how it fights, not by what losing it costs the owner. Two TIE
 *  Fighters and one Assault Carrier both come to 4 — but the carrier is 4
 *  transport capacity and a 2-resource build, and the TIEs cannot even move
 *  without a carrier to ride in. Report #727: the AI Rebel spent Hit And Run on
 *  two TIE Fighters at Corellia while an Assault Carrier sat at Naboo.
 *
 *  So add the two things strength misses:
 *   - build cost (×2) — what the owner must pay to replace it.
 *   - transport capacity (×2) — killing the ride strands everything it carries,
 *     which is the single most disruptive thing a 2-health budget can buy.
 */
function unitKillValue(G: GameState, u: { typeId: string }): number {
  const t = G.catalog.unitTypes[u.typeId];
  if (!t) return 0;
  return unitStrength(G, u) + (t.buildResource ?? 0) * 2 + (t.transport?.capacity ?? 0) * 2;
}

/** Best total `unitKillValue` obtainable at `targetSysId` with `healthBudget`
 *  health to spend — an exact 0/1 knapsack over the destroyable enemy units
 *  (weights are unit health; a dozen units and a budget of ≤4 make this tiny).
 *
 *  Candidate rule mirrors engine `queueDestroyUpToHealth` exactly: opposing
 *  side, optional theater filter, and never a `health.color === null` unit (the
 *  Death Star, destroyable only by the Plans).
 */
function bestDestroyValue(
  G: GameState, oppSide: Side, targetSysId: SystemId, healthBudget: number,
  theater?: 'space' | 'ground', unitCap?: number,
): number {
  const ss = targetSysId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[targetSysId];
  if (!ss || healthBudget <= 0) return 0;
  const items = ss.units
    .filter((u) => u.side === oppSide)
    .map((u) => ({ u, t: G.catalog.unitTypes[u.typeId] }))
    .filter((x) => !!x.t && x.t.health.color !== null)
    .filter((x) => !theater || x.t!.theater === theater)
    .map((x) => ({ hp: Math.max(1, x.t!.health.value ?? 1), val: unitKillValue(G, x.u) }));
  if (items.length === 0) return 0;
  const cap = unitCap ?? items.length;
  // best[k][h] = best value using at most k units and exactly ≤h health.
  let best: number[][] = Array.from({ length: cap + 1 }, () => new Array<number>(healthBudget + 1).fill(0));
  for (const it of items) {
    const next = best.map((row) => row.slice());
    for (let k = 1; k <= cap; k++) {
      for (let h = it.hp; h <= healthBudget; h++) {
        const cand = best[k - 1][h - it.hp] + it.val;
        if (cand > next[k][h]) next[k][h] = cand;
      }
    }
    best = next;
  }
  return best[cap][healthBudget];
}

/** True when revealing this Empire mission at this system would accomplish
 *  nothing, so the AI shouldn't burn the leader + card on it (players #276/#277). */
/** Exported for tests (#727): pure scorer, no side effects. */
export function empireMissionTargetScore(G: GameState, missionId: string, targetSysId: SystemId): number {
  let s = 0;
  const sys = G.catalog.systems[targetSysId];
  if (!sys) return -Infinity;
  // Generally prefer high-resource systems for build/diplomacy missions.
  const resourceWeight = (sys.resources?.length ?? 0);
  const sysState = G.map.systems[targetSysId];
  if (missionId.startsWith('rule-by-fear') || missionId.startsWith('trade-negotiations')
    || missionId === 'fear-will-keep-them-in-line') {
    s += resourceWeight * 2;
    // Loyalty-GAIN missions ("gain 1 loyalty in this system") are WASTED on a
    // system the Empire already controls — you can't push loyalty past
    // imperial. Mirror of the Rebel-side -30 penalty (issues #57/#58/#60); the
    // Empire side was missing it, so the AI ran diplomacy on already-Imperial
    // sectors (player report #72). Imperial loyalty can't coexist with
    // subjugation (#48), so these are distinct states: imperial-loyal = no gain
    // possible (-30); subjugated = already controlled, low value (-12).
    if (sysState?.loyalty === 'imperial') s -= 30;
    else if (sysState?.subjugated) {
      // Subjugation is CONTROL, not full OUTPUT. RR "Subjugation": "When
      // building units from a subjugated system, the Imperial player uses only
      // the LEFT-MOST resource icon", and "if a neutral subjugated system gains
      // Imperial loyalty, the system's subjugation marker is flipped to its
      // loyalty side". phases.ts enforces the slice(0,1). So converting a
      // subjugated system is NOT redundant with holding it — it unlocks every
      // icon past the first.
      //
      // Mon Calamari and Corellia both read [triangle, SQUARE]: while
      // subjugated the Empire collects the triangle and the capital-ship SQUARE
      // stays locked. That is exactly the reported failure (#738, BGG) — the
      // Empire subjugated both, never converted either, and never fielded
      // capital ships again. The old flat -12 ("already controlled, low value")
      // priced control and ignored the locked production, so the AI actively
      // avoided the highest-value loyalty play on the board.
      const locked = Math.max(0, (sys.resources?.length ?? 0) - 1);
      if (!CONVERT_SUBJUGATED) s -= 12;
      else if (sysState.loyalty === 'rebel') s -= 6;
      // Two gains from Imperial: this one only strips the Rebel marker and
      // leaves it neutral-subjugated, so it unlocks nothing by itself. Still
      // cheaper than the old -12 because it is a real step toward the unlock.
      else s += locked * 8;
      // Neutral + subjugated: ONE gain flips it to Imperial and unlocks
      // `locked` icons. Scaled by what is actually behind the lock, so a
      // 1-icon world (nothing to unlock) scores 0 rather than a false bonus.
    }
  }
  // Captures / probes don't care about target system per se.
  if (missionId === 'gather-intel') s += 3;
  // Research & Development can REMOVE a sabotage marker from its target system
  // (Option B) while still drawing a project. The AI was running R&D on
  // arbitrary systems and never clearing sabotage, letting the Rebel choke its
  // production (player report #199). Strongly prefer a sabotaged Imperial system
  // as the target so Option B cleans it up.
  if (missionId === 'research-and-development' && sysState?.sabotage) s += 25;
  // Construct Factory places build-queue units by the target's resource icons AND
  // removes a sabotage marker there before resolving (#468). The AI was building
  // on arbitrary Imperial systems, ignoring sabotaged ones where it would ALSO
  // clear the sabotage that's choking that system's production. Prefer a
  // high-resource Imperial system, and strongly prefer a sabotaged one.
  if (missionId === 'construct-factory') {
    s += resourceWeight * 3;
    if (sysState?.sabotage) s += 25;
  }
  // Imperial Propaganda flips every Rebel-loyal system in the target's REGION to
  // neutral — so its value scales with how many Rebel-loyal systems that region
  // holds. Aim it at the region with the most to convert; a region with none is
  // already dropped by missionRevealIsPointless before scoring (#304).
  if (missionId === 'imperial-propaganda') {
    s += rebelLoyalSystemsInRegion(G, targetSysId) * 12;
  }
  // Planetary Conquest moves up to 4 ground to the target and fights any Rebel
  // ground there — an OFFENSIVE strike, not a place to dump troops on an
  // already-safe Imperial world. It had NO target score, so the AI took the
  // first legal system alphabetically and just reinforced Alderaan (#561). Aim
  // it where the force does something: hit the exposed base, clear Rebel ground
  // (deny production / open an objective), or push into any Rebel presence.
  if (missionId === 'planetary-conquest') {
    const units = sysState?.units ?? [];
    const rebGround = units.filter((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      return u.side === 'Rebel' && t?.theater === 'ground' && t.class !== 'structure';
    }).length;
    const hasRebelHere = units.some((u) => u.side === 'Rebel');
    if (G.rebelBaseRevealed && targetSysId === G.rebelBaseSystemId) s += 30; // strike the exposed base
    else if (rebGround > 0) s += 18 + rebGround * 2;                         // clear Rebel ground
    else if (hasRebelHere) s += 8;                                          // any Rebel presence
    else if (sysState?.loyalty === 'imperial' || sysState?.subjugated) s -= 15; // pointless reinforce (#561)
    else s += 3;                                                            // mild forward push (neutral/Rebel-loyal, empty)
  }
  // Deployment ("Attempt on a system with no Rebel units or loyalty. Gain 1
  // triangle ground unit.") had NO target score — the same hole #561 left in
  // Planetary Conquest — so every legal target tied on the opposition term
  // alone and the pick was arbitrary. jocke01 (#719/#721): "The empire uses the
  // mission on alderaan that it already controls with massive fleet ... Same
  // issue again with the empire targeting a planet with a bunch of ground
  // units." A stormtrooper added to a 19-unit stack in the rear does nothing;
  // the same stormtrooper on a system with no Imperial ground is a garrison —
  // it plants the flag a subjugation needs (#696) and extends reach.
  if (missionId === 'deployment') {
    const units = sysState?.units ?? [];
    const impGround = units.filter((u) => {
      const t = G.catalog.unitTypes[u.typeId];
      return u.side === 'Empire' && t?.theater === 'ground' && t.class !== 'structure';
    }).length;
    // Worth is what the planet produces, weighed by shape like every other
    // take-the-planet term (#694) — a square icon is a capital ship, a triangle
    // is a trooper.
    const shapeWeight = RESOURCE_SHAPE_WEIGHT
      ? (sys.resources ?? []).reduce((a, r) =>
          a + (r.shape === 'square' ? 3 : r.shape === 'circle' ? 2 : 1), 0)
      : (sys.resources?.length ?? 0);
    if (impGround === 0) {
      // First boots on the ground here. Best on a system we don't yet hold,
      // where the trooper unlocks a subjugation; still good on an Imperial
      // world that has no garrison at all.
      s += 14 + shapeWeight * 3;
      if (sysState?.loyalty !== 'imperial' && !sysState?.subjugated) s += 6;
    } else {
      // Already garrisoned — reinforcing is the weakest use of the card, and
      // the more that's already parked there the weaker it gets.
      s -= 4 + Math.min(impGround, 8) * 2;
    }
  }
  // Hunt Them Down: "destroy up to 2-health worth of units of your choice in
  // this system." It had NO target score, so every system with any Rebel unit
  // tied and the pick fell to the first candidate — the Empire mirror of the
  // hole #727 reported on the Rebel side. Score a target by what the 2 health
  // can actually buy there (see bestDestroyValue).
  if (missionId === 'hunt-them-down') {
    s += Math.min(30, bestDestroyValue(G, 'Rebel', targetSysId, 2));
  }
  // Prefer an undefended target so the attempt auto-succeeds (see helper).
  s += oppositionTargetTerm(G, 'Empire', missionId, targetSysId);
  return s;
}

/** Score a target system for a Rebel mission. `baseDist` is a precomputed
 *  hop-count map from the Rebel base (or null when base is revealed/missing). */
/** Exported for tests (#663): pure scorer, no side effects. */
export function rebelMissionTargetScore(
  G: GameState, missionId: string, targetSysId: SystemId,
  baseDist: Map<string, number> | null,
): number {
  let s = 0;
  // Rapid Mobilization auto-targets the "Rebel Base" space, which is NOT a
  // catalog system. The old `if (!sysDef) return -Infinity` below scored it
  // unplayable, so the reveal action was never generated and the AI Rebel could
  // NEVER relocate its base (uploaded-log analysis: Rapid Mobilization assigned
  // 99% of games but resolved 0% — base captured by turn ~4-5, 0 relocations).
  // Score it neutrally; its real value (relocate when threatened) lives in
  // missionSituationalAdjust's +20.
  if (targetSysId === 'rebel-base-space') return 0;
  const sysDef = G.catalog.systems[targetSysId];
  const sysState = G.map.systems[targetSysId];
  if (!sysDef) return -Infinity;
  if (baseDist) {
    const d = distFrom(baseDist, targetSysId);
    if (d <= 1) s -= 6;
    else if (d === 2) s -= 2;
  }
  // Loyalty-GAIN missions: all of these "gain N loyalty in the target
  // system" on success. Running one on a system that already has Rebel
  // loyalty (and isn't subjugated) is wasted — the player reported the AI
  // sending Leia/Ackbar to already-Rebel Alderaan over and over (issues
  // #57, #58, #60). build-alliance was missing from this set, so it had
  // NO already-loyal penalty and Alderaan's high resource count made it
  // the top pick. Penalty is now decisive (-30), not a nudge.
  const loyaltyGainMissions = new Set([
    'establish-trade-relations', 'build-alliance',
    'wookie-uprising', 'support-of-mon-calamari',
    // regional-aid gains loyalty in its target too, but was missing here, so
    // it had NO already-loyal penalty and the AI burned it on already-Rebel
    // systems — the #1 source of the "loyalty-wasted" divergence (ai-divergence
    // 2026-06-17: AI 0.45 vs expert 0.22/round).
    'regional-aid',
  ]);
  if (loyaltyGainMissions.has(missionId)) {
    // REMOTE systems cannot hold loyalty at all — the engine no-ops the gain
    // (mechanics.gainLoyalty logs loyalty-blocked:remote). Reports #598/#610/
    // #611/#613: the AI burned loyalty missions on Endor/Dantooine. This was a
    // REGRESSION from the reach-check below (b78d2ba): its -12/-6 penalties
    // suppress every populous system near the Empire, and remotes — far from
    // everything, penalty-free — floated to the top. Hard-exclude them first.
    if (sysDef.isRemote) return s - 50;
    s += (sysDef.resources?.length ?? 0) * 2;
    // OPENING BOOK (jocke01): "pick a system the Empire can't subjugate turn 1".
    // A loyalty flip on a system the Empire already occupies — or can reach in
    // one move — gets subjugated straight back, so the mission buys nothing.
    // Penalise reachable targets so the AI flips somewhere the gain STICKS.
    // (Distinct from the already-loyal check below, which is about the flip
    // being a no-op; this is about the flip being immediately undone.)
    if (sysState?.units.some((u) => u.side === 'Empire')) s -= 12;
    else if ((G.catalog.adjacency[targetSysId] ?? []).some((a) =>
      (G.map.systems[a]?.units ?? []).some((u) => {
        const t = G.catalog.unitTypes[u.typeId];
        return u.side === 'Empire' && t?.theater === 'ground' && !t.transport.immobile;
      }))) s -= 6;
    // Underlying loyalty already Rebel → no loyalty to gain (a successful
    // mission just logs "loyalty-already" and wastes the leader). Strongly avoid
    // so the AI targets a neutral/Imperial system instead. NOTE: this must fire
    // even when the system is SUBJUGATED — a subjugated-Rebel system's loyalty
    // field is still 'rebel', and that was the actual waste source (build-
    // alliance kept targeting subjugated-Rebel systems because the old
    // `!subjugated` guard skipped them; ai-divergence loyalty-wasted gap).
    // (Deliberately NOT preferring Imperial targets — an early experiment that
    // did so sent the Rebel to attempt flips on defended Imperial strongholds,
    // where the mission failed and loyalty-gain crashed.)
    if (sysState?.loyalty === 'rebel') s -= 30;
    // OBJECTIVE STEERING (playtester: "gained quite a few loyalty but didn't
    // complete a single objective"). Gaining loyalty here flips the system
    // Rebel-loyal — reward that when it advances a HELD loyalty objective, scaled
    // so an objective we're NEAR pulls hardest, with a decisive bonus when it
    // would COMPLETE one. This concentrates loyalty into scored reputation
    // (the Rebel win condition) instead of scattering it across the map. The
    // flip-and-recount is exact, so region objectives only reward in-region gains
    // and unit-gated ones (defend-the-people) only when a Rebel unit is present.
    else if (sysState) {
      for (const oid of G.rebel.objectiveHand ?? []) {
        if (objectiveConditionMet(G, oid)) continue;
        const prog = objectiveProgress(G, oid);
        if (!prog || prog.have >= prog.need) continue;
        const saved: 'rebel' | 'imperial' | 'neutral' = sysState.loyalty;
        sysState.loyalty = 'rebel';
        const after = objectiveProgress(G, oid)?.have ?? prog.have;
        sysState.loyalty = saved;
        if (after > prog.have) {
          const rep = G.catalog.objectives[oid]?.reputation ?? 1;
          const remaining = prog.need - after;
          s += remaining <= 0 ? 20 + rep * 6 : 7 / Math.max(1, remaining);
        }
      }
    }
  }
  // Sabotage (Rebel mission) should target ENEMY systems, never own.
  // Issues #10, #13: the AI was sabotaging Bespin / Alderaan when those
  // were Rebel-loyal, which is strategic self-harm.
  if (missionId === 'lead-the-strike-team') {
    // "Move up to 4 ground units from the Rebel Base to this system, ignoring
    // transport and adjacency; if Imperial ground units are here, resolve
    // combat." This had NO scoring case at all, so every system tied and the
    // strictly-greater pick kept the first candidate — alphabetical order, i.e.
    // Alderaan, every time (#663).
    //
    // Deliverable troops first: with an empty Rebel Base space the mission
    // moves nothing and is pure waste.
    const baseGround = (G.map.rebelBaseSpace?.units ?? []).filter(
      (u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground').length;
    if (baseGround === 0) return s - 60;
    const landing = Math.min(4, baseGround);
    const enemyGround = (sysState?.units ?? []).filter(
      (u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground').length;
    // Remote systems hold no loyalty or production — troops there do nothing.
    if (sysDef.isRemote) return s - 40;
    // Liberating a subjugated system is a scoring objective in its own right,
    // and an Imperial-loyal system is worth contesting. A Rebel system with no
    // Imperial ground present gains nothing.
    if (sysState?.subjugated) s += 26;
    else if (sysState?.loyalty === 'imperial') s += 16;
    else if (sysState?.loyalty === 'rebel' && enemyGround === 0) s -= 25;
    // Only pick a fight we can plausibly win with what we can land.
    if (enemyGround === 0) s += 6;
    else if (landing > enemyGround) s += 10;
    else if (landing === enemyGround) s += 2;
    else s -= 8 * (enemyGround - landing);
    // Mild tiebreak so equally-valued targets prefer the richer system rather
    // than falling back to alphabetical order.
    s += (sysDef.resources?.length ?? 0) * 2;
    return s;
  }
  if (missionId === 'sabotage') {
    // Sabotage denies a system its production (the build step skips
    // sabotaged systems). So value a target by how much Empire production
    // it removes:
    //   - Imperial-loyal: denies ALL its resource icons (a 2-resource
    //     Imperial system is the best target — 2 fewer Empire units/build).
    //   - Subjugated: only its leftmost icon produces (1 resource), so it's
    //     worth denying 1 — same as a 1-resource Imperial system.
    //   - Remote: produces nothing → pointless.
    //   - Rebel-loyal (unsubjugated): your own production → never.
    //   - Neutral (non-remote): no Empire production → not worth it.
    //   - Already sabotaged → nothing to gain.
    const resCount = sysDef.resources?.length ?? 0;
    if (sysState?.sabotage) {
      s -= 50;
    } else if (sysDef.isRemote) {
      s -= 50; // no production to deny
    } else if (sysState?.loyalty === 'rebel' && !sysState.subjugated) {
      s -= 50; // never sabotage our own system
    } else if (sysState?.subjugated) {
      // DURABILITY (Dymond Kyng, twice): R&D resolves only in systems with
      // IMPERIAL LOYALTY, so a marker on a subjugated (non-loyal) system can
      // never be cleansed by it — permanent denial of the system's 1
      // producing icon, every build, forever. A marker on an Imperial-loyal
      // system denies more per build but the Empire clears it with one R&D
      // (which returns to hand — reusable every round). Rate the permanent
      // marker above the clearable 2-res one.
      s += 16;
    } else if (sysState?.loyalty === 'imperial') {
      s += 6 + Math.min(resCount, 3) * 4; // 1-res:10, 2-res:14, 3-res:18 — but clearable
    } else {
      s -= 10; // neutral, non-producing for the Empire — low value
    }
    // Easier to land (and likelier to auto-succeed) if there's no Imperial
    // spec-ops leader sitting at the target to make opposition cheap.
    const empLeadersHere = G.empire.leadersOnBoard[targetSysId] ?? [];
    const specOpsHere = empLeadersHere.some(
      (lid) => (G.catalog.leaders[lid]?.skills?.specOps ?? 0) > 0);
    s += specOpsHere ? -3 : 4;
  }
  // Plan the Assault commits Rebel ships from the base into a SPACE BATTLE at the
  // target. Only worth it if those ships can win — playtester saw the AI throw a
  // lone X-wing at a fleet and lose it. Compare the committable base ships against
  // the target's Imperial space force; heavily penalize a losing matchup (same
  // 1.2x edge the AI's other aggression gates use), reward a winnable strike.
  if (missionId === 'plan-the-assault') {
    const shipStr = (u: { typeId: string }): number => {
      const t = G.catalog.unitTypes[u.typeId];
      return t && t.theater === 'space'
        ? ((t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0)) : 0;
    };
    const baseLoc = G.rebelBaseRevealed ? G.rebelBaseSystemId : 'rebel-base-space';
    const baseUnits = baseLoc === 'rebel-base-space'
      ? (G.map.rebelBaseSpace?.units ?? []) : (G.map.systems[baseLoc]?.units ?? []);
    let reb = 0;
    for (const u of baseUnits) if (u.side === 'Rebel') reb += shipStr(u);
    let imp = 0;
    for (const u of (sysState?.units ?? [])) if (u.side === 'Empire') imp += shipStr(u);
    // Plan the Assault commits base ships into a SPACE BATTLE at the target. It's
    // only worth it against a REAL Empire fleet the committable force can actually
    // beat, AND with a non-trivial force. The old guard only caught the
    // defended-but-losing case, so it happily sent a lone X-wing at a lightly
    // defended system for no gain (#522). Cover all three losing shapes:
    //   - empty target      → no combat, nothing to assault
    //   - trivial own force  → a lone fighter (reb < 5, ~2 fighters) just dies
    //   - losing matchup     → outmatched by the defenders
    if (imp === 0) s -= 20;
    else if (reb < 5 || reb < imp * 1.2) s -= 40;
    else s += 8;
    // DEATH STAR OPPORTUNISM via Plan the Assault (#591): the reporter watched
    // the AI route 6 base fighters to a system with a single TIE while a LONE
    // Death Star sat elsewhere with the plans in hand. Plan the Assault commits
    // fighters into the target's space battle, and a lightly-escorted DS can't
    // damage black-health fighters (it rolls 4 RED) — so each surviving-fighter
    // round is another plans attempt. Both targets otherwise score the same +8;
    // this steers the strike at the DS. Mirrors the activation-side rule (which
    // couldn't fire here — the fighters route via the mission, not a move).
    const impShipUnits = (sysState?.units ?? []).filter((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'space');
    const hasLoneDS = impShipUnits.some((u) => u.typeId === 'death-star')
      && impShipUnits.filter((u) => u.typeId !== 'death-star').length <= 1;
    if (hasLoneDS && (G.rebel.objectiveHand ?? []).some((id) => id.startsWith('death-star-plans')) && reb >= 5) {
      s += 30;
    }
  }
  // Hit And Run: "destroy up to 2-health worth of units of your choice in this
  // system." No target score existed, so every system holding ANY destroyable
  // Imperial unit scored identically and the pick came down to the base-
  // distance term and tie-break order. Player report #727: the AI Rebel put
  // Han on Corellia and killed two TIE Fighters — "quite possibly the two most
  // useless units in the game" — while an Assault Carrier sat at Naboo, where
  // the same 2 health would have stranded a whole invasion's worth of ground.
  // Score the target by the best kill the budget can actually buy there.
  if (missionId === 'hit-and-run') {
    s += Math.min(30, bestDestroyValue(G, 'Empire', targetSysId, 2));
  }
  // Prefer an undefended target so the attempt auto-succeeds (see helper).
  s += oppositionTargetTerm(G, 'Rebel', missionId, targetSysId);
  return s;
}

// ============================================================================
// Assignment planner
// ============================================================================

/** Plan the full Assignment phase: which leaders should go on which missions
 *  for this side.
 *
 *  Algorithm: for each mission in hand, compute the CHEAPEST leader-set
 *  that meets its skill cost (or null if no such set exists). Score by
 *  mission value - leader-cost-penalty. Greedy-commit top-scoring missions
 *  in order, marking leaders used. Skip infeasible missions entirely —
 *  previous bug had the planner committing top leaders to high-value
 *  missions they could never reveal (cost not met), starving the actually-
 *  attemptable missions of leaders. */
/** Is there an attack the Rebel could actually launch this turn IF it kept a
 *  leader free to activate? Mirrors the Command-phase winnable-attack gate
 *  (own force >= 1.2x theirs AND can clear the ground), counting units already
 *  present plus those pullable from adjacent leader-unblocked systems and the
 *  base space. Used to decide whether reserving a leader is worth it. */
function rebelStrikeTargetExists(G: GameState): boolean {
  const str = (u: { typeId: string }) => {
    const t = G.catalog.unitTypes[u.typeId];
    return t ? (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0) : 0;
  };
  const gnd = (u: { typeId: string }) => G.catalog.unitTypes[u.typeId]?.theater === 'ground';
  for (const [sysId, ss] of Object.entries(G.map.systems)) {
    if (ss.destroyed) continue;
    let impAll = 0, impGround = 0, rebAll = 0, rebGround = 0;
    for (const u of ss.units) {
      if (u.side === 'Empire') { impAll += str(u); if (gnd(u)) impGround += str(u); }
      else if (u.side === 'Rebel') { rebAll += str(u); if (gnd(u)) rebGround += str(u); }
    }
    if (impAll <= 0) continue;
    for (const a of (G.catalog.adjacency[sysId] ?? [])) {
      if ((G.rebel.leadersOnBoard[a] ?? []).length > 0) continue; // leader-blocked source
      for (const u of (G.map.systems[a]?.units ?? [])) {
        if (u.side !== 'Rebel') continue;
        rebAll += str(u); if (gnd(u)) rebGround += str(u);
      }
    }
    // Base-space fleet counts when this target neighbours the base system.
    if (G.rebelBaseSystemId
        && (G.catalog.adjacency[sysId] ?? []).includes(G.rebelBaseSystemId)
        && (G.rebel.leadersOnBoard[G.rebelBaseSystemId] ?? []).length === 0) {
      for (const u of (G.map.rebelBaseSpace?.units ?? [])) {
        if (u.side !== 'Rebel') continue;
        rebAll += str(u); if (gnd(u)) rebGround += str(u);
      }
    }
    if (rebAll >= impAll * 1.2 && rebGround >= impGround) return true;
  }
  return false;
}

/** Score the Command phase gives the 'pass' action. Anything scoring at or
 *  below this loses to passing, so a mission whose best reveal lands here will
 *  never actually be played. */
const PASS_ACTION_SCORE = 0.5;

/** Opt-out for the assignment/command consistency gate below
 *  (SWR_ASSIGN_GATE=0). Default ON. Exists so the gate can be A/B'd against the
 *  old stranding behavior without a rebuild, matching the ?planner=0 / ?mcts=0 /
 *  ?hunt=0 escape hatches. Guarded so the browser build (no `process`) is safe. */
const ASSIGN_GATE_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_ASSIGN_GATE === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** A unit that moves BETWEEN systems under its own power while carrying
 *  nothing: a SPACE unit with no transport capacity that also lacks the
 *  transport-RESTRICTION icon. Per the printed reference mats only the TIE
 *  Fighter carries that icon among fighters — TIEs have no hyperdrive and must
 *  be ferried, while X-/Y-Wings move themselves (see the note on x-wing in
 *  units.ts). Self-movers need NO carrier and consume NO capacity.
 *
 *  This exists because the activation scorer and the activation move-packer
 *  each classified units independently and BOTH missed this case: the packer
 *  bucketed capacity>0 / ground / restricted-fighter and let anything else fall
 *  through unmoved, and the scorer split capacity>0 vs "needs a carrier". The
 *  only two unit types in the whole catalog that land in the gap are the X-Wing
 *  and the Y-Wing — both Rebel — which is why 80% of Rebel activations moved
 *  nothing against the Empire's 25% (#647 measurements). One predicate, used by
 *  both, so they cannot disagree again. */
export function isSelfMovingUnit(t: { theater?: string; transport?: { capacity: number; restriction: boolean; immobile: boolean } } | undefined): boolean {
  if (!t || !t.transport || t.transport.immobile) return false;
  return t.theater === 'space' && t.transport.capacity === 0 && !t.transport.restriction;
}

/** Opt-out for the self-moving-fighter fix (SWR_SELF_MOVER=0), task_a3b11e85.
 *  Default ON. Off restores the old behavior where X-/Y-Wings were invisible to
 *  both the activation scorer and the move-packer. Flagged because the note
 *  carrying this task said it "needs an A/B before ship". */
const SELF_MOVER_FIX: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_SELF_MOVER === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Opt-out for the tightened no-op activation guard (SWR_NOOP_GUARD=0), #647.
 *  Default ON. Off restores the older rule, which exempted ANY enemy-occupied
 *  target from the bring-nothing sink even when we had no units there to fight
 *  with. Flagged because the record warns that blocking "wasted" bring-nothing
 *  activations wholesale once cost the Empire 43% -> 30% — this is a much
 *  narrower cut (it only sinks activations that provably cannot move OR fight),
 *  but it needs the same A/B before it can be trusted. */
const NOOP_ACTIVATION_GUARD: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_NOOP_GUARD === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Opt-out for requiring deliverable GROUND before paying the take-the-planet
 *  bonus (SWR_SUBJ_GROUND=0), from playtester report #696. Default ON.
 *
 *  Measured over 1200 expansion games per arm: win rate unchanged (40.8% vs
 *  40.7%, one game) while ground-less "subjugation" activations fall from 30 of
 *  595 to 9 — the same trade as the #647/#653/#666 guards, removing visibly
 *  pointless moves for free.
 *
 *  Deliberately does NOT gate the Rebel-loyalty bonus: that one is also
 *  justified by clearing a base candidate, which ships can do on their own. */
const SUBJUGATION_NEEDS_GROUND: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_SUBJ_GROUND === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Build Shield Bunkers to garrison the Death Star site (SWR_BUNKERS=0 to opt
 *  out). NOW ON — this reverses the 2026-08-06 rejection, on the re-test that
 *  rejection explicitly asked for.
 *
 *  The original verdict was −2.5pp against a Rebel that "enters the Death Star's
 *  system in 3.3% of games and has never destroyed a DSUC", so the Bunker's
 *  whole purpose — making a Death Star immune to the Death Star Plans objective
 *  — never had an opportunity to pay for itself. That precondition no longer
 *  holds: the same 300-game bench now sees the Rebel destroy 21 Death Stars and
 *  5 DSUCs, so the threat is real and the protection has something to protect
 *  against.
 *
 *  Re-measured 2026-08-15, 300 RoE games per arm on paired seeds. The mechanism
 *  works: bunkers reaching the Death Star's system 22 → 111, Death Star Plans
 *  attempts BLOCKED 0 → 11, Death Stars lost 21 → 17. Win rate 36.0 → 38.0
 *  (+2.0pp, CI [−5.7,+9.7]) — still inside noise, but the sign has flipped from
 *  −2.5pp, which is exactly the direction the old entry predicted a stronger
 *  opponent would produce.
 *
 *  Also a playtester report: "it still never uses the shield bunker to try and
 *  protect the death star" (jocke01). He was right, and measurably so — with
 *  this off, only 22 of 288 bunkers ever reached the station they exist for. */
//
//  BACK TO OFF (2026-08-16), on the very re-test the ON flip asked for. Against
//  the MCTS-Rebel arm (60 games/arm, paired seeds — an opponent that DOES attack
//  the station: 18 assaults, 16 successful Death Star Plans rolls) the lever
//  built 2.4x the bunkers (34 -> 81) yet only 7 of 81 reached the Death Star,
//  and it blocked ZERO Death Star Plans rolls in 120 games. Empire win rate
//  21.7 -> 16.7 (CI [-19.1,+9.1], noise). The +2.0pp that flipped it ON was
//  self-play noise, and against a real threat the mechanism doesn't engage:
//  bunkers only chase a station present at deploy time, and the Plans hits
//  land where no bunker ever arrived. 81 build slots spent doing nothing,
//  against an opponent that punishes tempo. SWR_BUNKERS=1 to opt in.
const BUILD_SHIELD_BUNKERS: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return proc?.env?.SWR_BUNKERS === '1';
  } catch { return false; } // browser: no process
})();

/** Opt-out for letting a leader who CANNOT activate a system oppose missions
 *  the Empire would otherwise wave through (SWR_OPPOSE_IDLE=0), report #704.
 *  Default ON.
 *
 *  The oppose-only-high-impact rule is priced on "a leader spent opposing is an
 *  activation foregone". RAW gates activating on having tactic values, so for
 *  Boba Fett, Jabba and Greejatus that price is zero — they cannot activate
 *  anything, ever. This exempts exactly those leaders from the skip.
 *
 *  Measured over 1200 expansion games: win rate 40.2% -> 40.0% (two games,
 *  noise), passes 7.8 -> 7.8, activations 24.2 -> 24.2, base-found and
 *  invasions unchanged. Over 60 games the waste it targets nearly disappears:
 *  Empire passes while holding an idle no-tactic leader 27/477 (5.7%) ->
 *  3/475 (0.6%), and such leaders opposing 2.3% -> 7.6% of oppositions. */
const OPPOSE_WITH_IDLE_LEADERS: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_OPPOSE_IDLE === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Hold the Death Star back instead of sweeping it into reach of Rebel ships
 *  (#701/#708). Default ON since 2026-08-31; SWR_DS_CAUTION=0 restores the old
 *  sweeping for A/B.
 *
 *  The station has transport capacity 8, so it classifies as a capital ship and
 *  "bring all capitals" dragged it along with every activation sourced from its
 *  system. It is invulnerable except to a Death Star Plans attempt, so keeping
 *  it out of reach removes the only way it dies. Mechanism: station moves
 *  ending in or beside Rebel ships 69/204 (33.8%) -> 5/168 (3.0%) over 60
 *  games, games affected 61.7% -> 8.3%, and it still moves (168 vs 204). Win
 *  rate 40.2% -> 40.4% — noise, and self-play under-reads the benefit (the
 *  heuristic Rebel rarely pursues Death Star Plans; humans do).
 *
 *  HISTORY — read before touching. This sat WORKS, BLOCKED from 2026-08-09 to
 *  2026-08-31: enabling it originally made the Empire forfeit the #639 board
 *  8% of the time (0% without), and passivity is the most-reported Empire
 *  complaint, so the trade was refused. Re-measured 2026-08-31: 0/60 forfeits
 *  with the lever ON (P ≈ 0.007 vs the old 8%) — the cost vanished somewhere in
 *  three weeks of engine work, UNATTRIBUTED (not the pass floor, not the
 *  subjugation re-pricing; controls all 0/24). Because the cure is unexplained,
 *  the regression is guarded: test-ds-caution-passivity-tripwire re-runs the
 *  #639 forfeit check with this lever pinned ON, so if the old cost sneaks
 *  back, a test goes red instead of players re-reporting passivity. Shipped on
 *  John's call (#701, option b: mechanism numbers + tripwire). */
const DEATH_STAR_CAUTION: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_DS_CAUTION === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Opt-out for weighing subjugation targets by resource SHAPE rather than icon
 *  count (SWR_RESOURCE_SHAPE=0), from playtester report #694. Default ON.
 *
 *  Measured over 1200 expansion games per arm: Empire win rate 38.0% -> 40.8%,
 *  base found 61.4% -> 67.7% and a third of a round sooner, base invasions
 *  41.9% -> 45.9% — while the NUMBER of subjugations barely moves (13.7 ->
 *  13.8). It is not subjugating more, it is subjugating better: denying the
 *  Rebel the systems that actually build his fleet. */
const RESOURCE_SHAPE_WEIGHT: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_RESOURCE_SHAPE === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Opt-out for playing Start-of-Combat action cards (SWR_COMBAT_CARDS).
 *  Default ON for both sides. `0` restores the old stub, which declined the
 *  window in every combat of every game.
 *
 *  Also accepts `empire` / `rebel` to enable it for ONE side only. A symmetric
 *  self-play A/B cannot answer "is playing these cards good?" — both sides gain
 *  the ability, so the win rate nets out and the result reads as noise no matter
 *  how strong or weak the policy is. Enabling one side and playing it against
 *  the other is what actually measures the policy. */
const COMBAT_CARDS_MODE: string = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return proc?.env?.SWR_COMBAT_CARDS ?? '1';
  } catch { return '1'; } // browser: no process
})();
function combatCardsEnabled(side: Side): boolean {
  if (COMBAT_CARDS_MODE === '0') return false;
  if (COMBAT_CARDS_MODE === 'empire') return side === 'Empire';
  if (COMBAT_CARDS_MODE === 'rebel') return side === 'Rebel';
  return true;
}

/** Opt-out for opportunity-cost-aware leader assignment (SWR_ASSIGN_OPP=0).
 *  Default ON. Off restores pure best-skill-first staffing, which spent the
 *  Empire's best activator on a 1-icon intel mission every single game. Flagged
 *  because it trades mission success odds for Command-phase capability, so it
 *  needs the same A/B every other AI change here gets. */
const ASSIGN_OPPORTUNITY_COST: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_ASSIGN_OPP === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Opt-out for the transport/garrison-aware reinforcement estimate in the
 *  strength gates (SWR_REAL_REINFORCE=0), #653. Default ON. Off restores the
 *  old "sum every unit standing next door" count, which over-stated the
 *  attacking force and let hopeless assaults through the gate. Flagged because
 *  it makes the gate STRICTER, and the record warns that suppressing Empire
 *  aggression has backfired before — so it gets the same A/B. */
const REAL_REINFORCE_ESTIMATE: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_REAL_REINFORCE === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Opt-out for theater-aware attack odds (SWR_THEATER_ODDS=0). Default ON.
 *
 *  The Empire's "can't win the ground fight" penalty compared the Empire's
 *  ground strength against the Rebel's and docked up to 30 points — but it
 *  fired even when the Empire was bringing NO ground at all. combat.ts only
 *  runs a ground battle when `bothSidesHaveTheater(ground)`, so a fleet with
 *  no troops never has a ground battle to lose: it fights purely in space and
 *  the leader rides with the ships. Penalizing that as a ground rout scores a
 *  fight the rules will not run.
 *
 *  Player report #697: a Rebel force sat on Coruscant with zero Imperial units
 *  (Heart Of The Empire — 2 reputation at EVERY Refresh, since the card returns
 *  to hand). The Empire's nine-ship fleet was one jump away at Corellia and
 *  would have won the space battle outright — and merely BEING there denies the
 *  objective, which needs "no Imperial units". Coruscant scored −11 and was
 *  filtered out before the search ever saw it; the Empire shuffled the fleet to
 *  an empty neutral instead. Off restores the theater-blind comparison. */
const THEATER_AWARE_ODDS: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_THEATER_ODDS === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Opt-out for distinct-target activation candidates (SWR_ACTIVATE_DIVERSITY=0).
 *  Default ON. Off restores the old behavior where every pool leader proposed
 *  the SAME argmax system — kept so the change can be A/B'd without a rebuild. */
const ACTIVATE_DIVERSITY_ENABLED: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_ACTIVATE_DIVERSITY === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

// (SWR_RETRO_GUARD deleted 2026-08-30 — measured inert on 120 reveal replays,
// 3/120 moves changed, McNemar p=0.51; see #722 and docs/ab-levers.md. The
// wrong-direction cluster #722/#690/#538 is tracked under #539 instead.)

/** The reveal the COMMAND phase would make for `missionId` — its chosen target
 *  and the score it would attach — or null if the Command phase would generate
 *  no reveal at all.
 *
 *  Shared by planAssignment and bestCommandAction so the two phases cannot
 *  disagree about whether a mission is worth playing. They used to judge it by
 *  different rules, which is the main way the AI stranded leaders and then
 *  passed early (#581 "passed with 4 leaders on missions", #617 "five facedown
 *  missions", #600 the Rebel doing the same). Two concrete mismatches, both
 *  measured with scripts/diag-facedown-missions.mjs:
 *
 *   - Assignment mirrored the Command phase's "has a legal target" check but
 *     NOT its missionRevealIsPointless filter, which was added later. So the
 *     Empire kept assigning Superlaser Online (69% of its stranded missions),
 *     whose every target the Command phase then rejected as a no-op.
 *   - Assignment scored a mission by missionBaseValue + situational only, while
 *     the Command phase ALSO adds the per-target score, which carries decisive
 *     penalties (-50 remote, -30 already-loyal, -12 Empire-occupied). A
 *     "value 12" loyalty mission could therefore be assigned and then score
 *     below pass at every legal target — 68% of the Rebel's stranded missions
 *     were Support of Mon Calamari doing exactly this.
 *
 *  Because MCTS searches only over bestCommandAction's output, a mission
 *  suppressed here is invisible to the search too — which is why tuning the
 *  leaf evaluator never fixed the passivity reports. */
function bestRevealTarget(
  G: GameState,
  side: Side,
  missionId: string,
  baseDist: Map<SystemId, number> | null,
): { targetSystemId: SystemId; targetScore: number; revealScore: number } | null {
  const card = G.catalog.missions[missionId];
  if (!card || !card.skill) return null;
  const targets = missionTargets(G, side, missionId);
  const candidates = (targets.permissive ? Object.keys(G.map.systems) : targets.systemIds)
    .filter((sid) => !missionRevealIsPointless(G, side, missionId, sid));
  if (candidates.length === 0) return null;
  const bestTarget = argmaxTie(G, candidates, (sysId) => sysId, (sysId) => (side === 'Empire'
    ? empireMissionTargetScore(G, missionId, sysId)
    : rebelMissionTargetScore(G, missionId, sysId, baseDist)));
  if (!bestTarget) return null;
  const targetSystemId = bestTarget.item;
  const targetScore = bestTarget.score;
  const baseValue = missionBaseValue(missionId, side) + missionSituationalAdjust(G, missionId, side);
  return { targetSystemId, targetScore, revealScore: baseValue + targetScore + 6 };
}

/** The top-K reveal targets for a mission, best first (K = CAND_K). K=1 is
 *  exactly bestRevealTarget; higher K lets the search see the alternatives a
 *  human actually picks. Same legality/pointlessness filters. */
function rankedRevealTargets(
  G: GameState, side: Side, missionId: string, baseDist: Map<SystemId, number> | null, k: number,
): Array<{ targetSystemId: SystemId; targetScore: number; revealScore: number }> {
  const first = bestRevealTarget(G, side, missionId, baseDist);
  if (!first) return [];
  if (k <= 1) return [first];
  const card = G.catalog.missions[missionId];
  const targets = missionTargets(G, side, missionId);
  const candidates = (targets.permissive ? Object.keys(G.map.systems) : targets.systemIds)
    .filter((sid) => !missionRevealIsPointless(G, side, missionId, sid));
  const baseValue = missionBaseValue(missionId, side) + missionSituationalAdjust(G, missionId, side);
  const scored = tieOrdered(G, candidates as SystemId[]).map((sid) => {
    const targetScore = side === 'Empire'
      ? empireMissionTargetScore(G, missionId, sid)
      : rebelMissionTargetScore(G, missionId, sid, baseDist);
    return { targetSystemId: sid, targetScore, revealScore: baseValue + 6 + targetScore };
  }).filter((x) => Number.isFinite(x.revealScore)).sort((a, b) => b.revealScore - a.revealScore);
  void card;
  const out = [first];
  for (const x of scored) { if (out.length >= k) break; if (x.targetSystemId !== first.targetSystemId) out.push(x); }
  return out;
}

export function __testPlanAssignment(
  G: GameState, side: Side,
): Array<{ missionId: string; leaderIds: LeaderId[] }> {
  return planAssignment(G, side);
}

function planAssignment(G: GameState, side: Side): Array<{ missionId: string; leaderIds: LeaderId[] }> {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const hand = [...f.missionHand];
  if (f.leaderPool.length === 0 || hand.length === 0) return [];
  // Same base-distance map bestCommandAction builds, so the reveal scores we
  // predict here match the ones the Command phase will compute.
  const baseDist = (side === 'Rebel' && G.rebelBaseSystemId && !G.rebelBaseRevealed)
    ? bfsDistances(G, G.rebelBaseSystemId, 3)
    : null;

  // Score every mission's best feasible leader-set.
  type Plan = { missionId: string; leaderIds: LeaderId[]; score: number; leaderSkillSum: number };
  const computePlanForMission = (missionId: string, availableLeaders: LeaderId[]): Plan | null => {
    const card = G.catalog.missions[missionId];
    if (!card || !card.skill) return null;
    const sit = missionSituationalAdjust(G, missionId, side);
    if (sit < -5) return null;
    const cost = card.skillCost;
    // Rank leaders by skill fit for this mission (best first).
    const ranked = availableLeaders
      .map((lid) => ({ lid, fit: leaderSkillFit(G, lid, missionId) }))
      .filter((x) => x.fit > 0 || cost === 0) // include zero-fit only when no cost
      .sort((a, b) => b.fit - a.fit);
    // Greedy: add leaders in fit-order until cost is met.
    const greedy = (order: { lid: LeaderId; fit: number }[]) => {
      const picked: LeaderId[] = [];
      let s = 0;
      for (const r of order) {
        if (s >= cost) break;
        picked.push(r.lid);
        s += r.fit;
      }
      return { picked, sum: s };
    };
    const fitFirst = greedy(ranked);
    let used = fitFirst.picked;
    let sum = fitFirst.sum;
    if (sum < cost) return null; // infeasible — skip
    // OPPORTUNITY COST (jocke01: "on the first turn it's such a waste to send
    // palpatine on this mission"). Taking the best-skilled leader every time
    // spends the leader the COMMAND phase wants most. Gather Intel costs 1
    // intel; on turn 1 the Empire pool is Vader/Palpatine/Tagge/Tarkin, so
    // Tarkin's single intel icon covers it alone — but fit-order put Palpatine
    // (2 intel, and the best activator on the board) on it in 60 of 60 measured
    // games, and the 3-leader reserve means that is the turn's ONLY assignment.
    //
    // A leader's alternative use is activating systems, which RAW gates on
    // having tactic values at all — so tactic total is the opportunity cost.
    // Only sets of the SAME size are considered, so this never spends an extra
    // leader to save a good one, and the portrait/bespoke bonuses still get to
    // outvote it (a +4 pairing beats a 2-point tactic saving).
    if (ASSIGN_OPPORTUNITY_COST) {
      const oppCost = (lid: LeaderId) => {
        const l = G.catalog.leaders[lid];
        return (l?.tacticValues.space ?? 0) + (l?.tacticValues.ground ?? 0);
      };
      const cheap = greedy([...ranked].sort((a, b) =>
        oppCost(a.lid) - oppCost(b.lid) || b.fit - a.fit));
      if (cheap.sum >= cost && cheap.picked.length <= used.length) {
        const worth = (set: LeaderId[]) => set.reduce((s, l) =>
          s + leaderPortraitBonus(G, l, missionId) + leaderMissionBespoke(l, missionId)
            - oppCost(l), 0);
        if (worth(cheap.picked) > worth(used)) { used = cheap.picked; sum = cheap.sum; }
      }
    }
    // Skip missions the Command phase would refuse to play. Assigning one just
    // leaves a face-down mission the AI can't reveal, so it ends up passing
    // while holding unplayable missions (player reports #102/#118/#123, and the
    // whole #581/#617/#600 passivity cluster). bestRevealTarget IS the Command
    // phase's own decision, so the two can't drift apart: it applies the
    // pointless-target filter and returns the score the reveal would actually
    // get. A mission whose best reveal can't even beat passing is not worth a
    // leader — leaving that leader in the pool at least lets it activate.
    const reveal = bestRevealTarget(G, side, missionId, baseDist);
    const wouldStrand = ASSIGN_GATE_ENABLED
      ? (!reveal || reveal.revealScore <= PASS_ACTION_SCORE)
      // Legacy behavior: only the "no legal target at all" half of the check,
      // ignoring both the pointless filter and the reveal's actual score.
      : (() => { const t = missionTargets(G, side, missionId); return !t.permissive && t.systemIds.length === 0; })();
    if (wouldStrand) {
      // EXCEPTION: fresh-capture missions (Detained / Collect Bounty) target an
      // enemy leader "in any system". At ASSIGNMENT time those leaders are still
      // in the pool — they only land in systems as the opponent reveals missions
      // during the Command phase. So "no target right now" wrongly skipped them
      // every game (the Empire captured/detained 0 leaders despite ~2 surfacing
      // per game). Assign them anyway when the opponent has leaders that will
      // surface; the Command-phase reveal still gates on a live target.
      //
      // capture-rebel-operative belongs to this same class and was simply left
      // out of it, which is the whole of jocke01's "the empire uses capture
      // rebel operative way to little". Measured: across 60 games there were
      // ZERO Rebel leaders on the board at the start of EVERY Assignment phase
      // (513/513 rounds), so the "is a Rebel leader standing somewhere I can
      // reach?" question was being asked at the one moment each round when the
      // answer is guaranteed to be no. Result: assigned 0.23 times per game
      // against rule-by-fear's 5.33, and first attempted around turn 6.
      //
      // It does need a stricter test than its two siblings. Detained and
      // Collect Bounty target a leader "in any system"; Capture Rebel Operative
      // needs one "in a system that contains an IMPERIAL UNIT", so a surfaced
      // leader is not automatically a target. Require the Empire to actually
      // hold ground somewhere a leader could surface, or this trades one wasted
      // assignment for another.
      const CAPTURE_OP = side === 'Empire' && missionId === 'capture-rebel-operative'
        && CAPTURE_ASSIGN_SPECULATIVE;
      const FRESH_CAPTURE = side === 'Empire'
        && (missionId === 'detained' || missionId === 'collect-bounty' || CAPTURE_OP);
      const oppHasLeaders = FRESH_CAPTURE && (
        G.rebel.leaderPool.length > 0
        || (G.rebel.leadersOnMissions ?? []).length > 0
        || Object.values(G.rebel.leadersOnBoard).some((l) => l.length > 0));
      // The card's extra clause, modelled: somewhere for the capture to happen.
      const empireHoldsSomewhere = !CAPTURE_OP || Object.entries(G.map.systems).some(
        ([sid, ss]) => !G.catalog.systems[sid]?.isRemote
          && (ss.units ?? []).some((u) => u.side === 'Empire'));
      if (!oppHasLeaders || !empireHoldsSomewhere) return null;
    }
    // Base mission value + situational + leader bonuses minus the
    // opportunity cost of using N leaders (we'd rather a 1-leader plan
    // than a 2-leader one all else equal).
    const baseValue = missionBaseValue(missionId, side) + sit;
    const leaderBonus = used.reduce((s, l) => s + leaderPortraitBonus(G, l, missionId) + leaderMissionBespoke(l, missionId), 0);
    const score = baseValue + leaderBonus - used.length * 0.5;
    return { missionId, leaderIds: used, score, leaderSkillSum: sum };
  };

  // Greedy multi-round selection: each round, pick the highest-scoring
  // feasible plan with currently-free leaders, commit it, mark leaders used,
  // and recompute.
  const usedLeaders = new Set<string>();
  const planMap: Array<{ missionId: string; leaderIds: LeaderId[] }> = [];
  const usedMissions = new Set<string>();
  // Computed once: board-derived and unchanged by which missions we assign.
  const rebelStrikeReserveWanted = side === 'Rebel' && rebelStrikeTargetExists(G);
  while (true) {
    const available = (f.leaderPool as LeaderId[]).filter((lid) => !usedLeaders.has(lid));
    if (available.length === 0) break;
    // Empire reserve: stop if we'd leave fewer than EMPIRE_RESERVE_LEADERS in pool.
    if (side === 'Empire' && f.leaderPool.length - usedLeaders.size <= empireReserveLeaders(f.leaderPool.length)) break;
    // REBEL STRIKE RESERVE (the alpha-strike prerequisite). Activating a system
    // needs a leader from the POOL, but the planner happily committed all 4 to
    // missions — measured leaderPool=0 / activate-actions=0 at Command, which
    // made the turn-1 alpha strike structurally impossible no matter where the
    // base sat or how favourable the matchup (see #539). jocke01's opening book
    // deliberately holds a leader back for the strike as the turn's FIRST
    // action. So keep 1 leader free — but only when a genuinely winnable target
    // is in reach, so we never idle a leader for nothing.
    if (side === 'Rebel' && rebelStrikeReserveWanted && f.leaderPool.length - usedLeaders.size <= 1) break;
    let best: Plan | null = null;
    for (const missionId of hand) {
      if (usedMissions.has(missionId)) continue;
      const p = computePlanForMission(missionId, available);
      if (!p) continue;
      if (!best || p.score > best.score) best = p;
    }
    if (!best || best.score <= 0) break;
    planMap.push({ missionId: best.missionId, leaderIds: best.leaderIds });
    usedMissions.add(best.missionId);
    for (const l of best.leaderIds) usedLeaders.add(l);
  }
  return planMap;
}

// ============================================================================
// Command-phase action scorer
// ============================================================================

// Exported for the MCTS worker bridge: actions are plain JSON data, so a
// search result computed off-thread can be posted back and committed here.
export type CommandAction =
  | { kind: 'reveal'; missionId: string; targetSystemId: SystemId; targetLeaderId?: LeaderId; score: number }
  | { kind: 'activate'; leaderId: LeaderId; targetSystemId: SystemId; score: number }
  | { kind: 'pass'; score: number };

/** Enumerate command-phase actions and score them. Returns highest-scoring
 *  action. Precomputes one BFS distance map from the Rebel base (when
 *  hidden) for use across all per-system scoring. */
/** Rough "how much do we want this leader" score — combined skills + tactic
 *  values. Used to pick which enemy leader a capture mission should target. */
function leaderValue(G: GameState, lid: string): number {
  const l = G.catalog.leaders[lid];
  if (!l) return -1;
  const sk = l.skills;
  return (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0)
    + l.tacticValues.space + l.tacticValues.ground;
}

/** Leader-targeting missions must LOCK their target at reveal time (RAW: the
 *  target is chosen when the mission is performed, not after it succeeds).
 *  Without this the engine falls back to "capture whoever is on the board at
 *  the target system", which after the opponent opposes is the wrong leader —
 *  the defender they just sent in, not the leader the mission was aimed at
 *  (recurring report; cf. issue #41). Returns the highest-value enemy leader
 *  standing at the target system, or undefined for non-targeting missions. */
const LEADER_TARGETING_MISSIONS = new Set(['capture-rebel-operative', 'collect-bounty', 'detained']);
function captureTargetLeaderId(G: GameState, side: Side, missionId: string, sysId: SystemId): LeaderId | undefined {
  if (!LEADER_TARGETING_MISSIONS.has(missionId)) return undefined;
  const oppF = side === 'Empire' ? G.rebel : G.empire;
  const here = oppF.leadersOnBoard[sysId] ?? [];
  if (here.length === 0) return undefined;
  return [...here].sort((a, b) => leaderValue(G, b) - leaderValue(G, a))[0] as LeaderId;
}

/** Opt-out for the hold-or-flee assessment on a revealed base
 *  (SWR_HOLD_BASE=0). Default ON. Off restores the old unconditional flee. */
const HOLD_REVEALED_BASE: boolean = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.SWR_HOLD_BASE === '0') return false;
  } catch { /* browser: no process */ }
  return true;
})();

/** Should a REVEALED base stay put when Rapid Mobilization offers to move it?
 *  Compares the Imperial force that can reach the base next round against the
 *  Rebel force standing on it. Exported for tests. */
export function shouldHoldRevealedBase(G: GameState): boolean {
  const baseId = G.rebelBaseSystemId;
  if (!baseId) return false;
  const here = G.map.systems[baseId]?.units ?? [];
  const defence = here.filter((u) => u.side === 'Rebel').reduce((s, u) => s + unitStrength(G, u), 0);
  // Reachable Imperial force: standing on the base or one jump out.
  const reach = [baseId, ...(G.catalog.adjacency[baseId] ?? [])];
  let threat = 0;
  for (const sid of reach) {
    for (const u of (G.map.systems[sid]?.units ?? [])) {
      if (u.side !== 'Empire') continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (t?.class === 'structure') continue;
      threat += unitStrength(G, u);
    }
  }
  // A completed Death Star within two jumps wins by orbit — treat as decisive.
  const within2 = new Set<string>(reach);
  for (const a of reach) for (const b of (G.catalog.adjacency[a] ?? [])) within2.add(b);
  const dsNear = [...within2].some((sid) =>
    (G.map.systems[sid]?.units ?? []).some((u) => u.side === 'Empire' && u.typeId === 'death-star'));
  if (dsNear) return false;
  // Nothing can reach us next round → fleeing buys nothing and costs the turn.
  if (threat === 0) return true;
  // Hold when the defence clearly outmatches what can arrive. The 1.25 margin
  // is the attacker's edge for choosing the moment; below it, flee.
  return defence >= threat * 1.25;
}

/** Combat weight of a single unit: dice + health. The strength gates' own
 *  measure, lifted to module scope so the reinforcement estimate below scores
 *  units the same way the gate scores defenders. */
/** True when `sysId` holds Empire mobile ground but no Empire ship that could
 *  lift it — the "stranded ground, send a carrier" shape the near-base ferry
 *  bonus rewards. (A deleted retrograde-guard experiment once exempted this path — see #722.) Collecting a
 *  stranded stack necessarily means stepping away from the base first. */
function isFerryPickup(G: GameState, sysId: SystemId): boolean {
  const ss = G.map.systems[sysId];
  if (!ss) return false;
  let ground = false, carrier = false;
  for (const u of ss.units) {
    if (u.side !== 'Empire') continue;
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    if ((t.transport.capacity ?? 0) > 0) carrier = true;
    else if (t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile) ground = true;
  }
  return ground && !carrier;
}

function unitStrength(G: GameState, u: { typeId: string }): number {
  const t = G.catalog.unitTypes[u.typeId];
  if (!t) return 0;
  return (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0);
}

/** The EXACT set of move orders the activate executor would build for this
 *  target. Extracted so the scorer and the executor cannot disagree.
 *
 *  They used to. bestCommandAction carried two independent approximations of
 *  'what can I bring here' — a transport-aware `movable` count for the no-op
 *  guard, and a second strength estimate for the gates — while the executor
 *  did the real thing a third time. Every guard added to the executor (the
 *  garrison reserve, the prison-system guard, the revealed-base drain guard,
 *  holding the Death Star back) widened the gap, and each widening showed up
 *  as the AI choosing a move on a promise the executor then broke: #653's lone
 *  ship, and the passivity #701's Death Star guard caused.
 *
 *  Pure: reads G, mutates nothing. Callers must not mutate the result.
 */
function plannedMoveOrders(
  G: GameState, side: Side, targetSystemId: SystemId,
): phases.MoveOrder[] {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const orders: phases.MoveOrder[] = [];
  const adj = G.catalog.adjacency[targetSystemId] ?? [];
  // Never empty a system that imprisons a captured ENEMY leader — the
  // moment no friendly unit remains there, the leader is auto-freed
  // (player report #158: the AI moved every unit off Corellia and gifted
  // Luke his freedom). Simplest safe guard: don't pull units from a
  // prison system at all, keeping the garrison on watch.
  const prisonSystems = new Set<string>(
    (f.capturedLeaders ?? []).map((c) => c.systemId).filter(Boolean) as string[],
  );
  // Never DRAIN the revealed Rebel base: once exposed, the base system's
  // units are its last line of defense, and pulling them to a neighbor
  // hands the Empire the base (player report #196: "the rebels moved
  // troops away from their base as I was closing in"). The defensive
  // gradient already steers activations to converge ON the base; this
  // stops a competing activation (a mission target, an Imperial system)
  // from using the base as a source and emptying it.
  const baseDrainGuard = side === 'Rebel' && G.rebelBaseRevealed
    ? G.rebelBaseSystemId : undefined;
  // Never DRAIN Coruscant while a Rebel force is in or next to it. Heart of
  // the Empire pays the Rebel 2 reputation at EVERY Refresh while Coruscant
  // "contains a Rebel unit and no Imperial units" — so the last Imperial unit
  // walking off the capital with an enemy army one jump away is a standing
  // 2-rep gift, exactly like the revealed-base drain above. Player report
  // #489: "the empire player had a massive fleet next to coruscant and ...
  // decided to move the entire fleet to corellia to subjugate my planet
  // instead. This is a major blunder that will give me 2vp." The
  // DEFEND_CORUSCANT gradient pulls units toward the threatened capital;
  // this stops a competing activation from using it as a source. Only while
  // actually threatened — a quiet Coruscant is a normal staging system.
  const corDrainGuard = side === 'Empire' && DEFEND_CORUSCANT
    && [CORUSCANT, ...(G.catalog.adjacency[CORUSCANT] ?? [])].some((sid) =>
      (G.map.systems[sid]?.units ?? []).some((u) => u.side === 'Rebel'))
    ? CORUSCANT : undefined;
  const sources = adj.filter((sysId) => {
    if ((f.leadersOnBoard[sysId] ?? []).length > 0) return false;
    if (prisonSystems.has(sysId)) return false; // guard captured leaders
    if (sysId === baseDrainGuard) return false; // guard the revealed base
    if (sysId === corDrainGuard) return false;  // guard the threatened capital
    const ss = G.map.systems[sysId];
    return ss && ss.units.some((u) => u.side === side);
  });
  for (const fromId of sources) {
    const ss = G.map.systems[fromId];
    if (!ss) continue;
    const mine = ss.units.filter((u) => u.side === side);
    // Classify units at this source.
    const capitalShips: typeof mine = [];
    const fighters: typeof mine = []; // restriction-icon, need transport
    const ground: typeof mine = [];   // need transport
    const selfMovers: typeof mine = []; // X-/Y-Wings: own hyperdrive, no carrier
    const heldStations: typeof mine = []; // Death Star held back for safety
    // DON'T DRAG THE DEATH STAR INTO A KNIFE FIGHT (jocke01, #701).
    //
    // The station has transport capacity 8, so it classifies as a capital
    // ship and "bring all capitals" swept it along with EVERY activation
    // sourced from its system. The Empire never decided to move it — it
    // came as cargo capacity. Reporter: "it only moved once and that was
    // to check dantooine ... I had moved a death star killing fleet next
    // to it the same turn using behind enemy lines, so it was a free
    // death star kill for me."
    //
    // The station is invulnerable EXCEPT to a Death Star Plans attempt,
    // which needs the Rebel to reach it — so simply not parking it within
    // reach costs nothing and removes the only way it dies. Measured:
    // 33.8% of its moves landed it in, or next to, Rebel ships (69 of 204
    // across 60 games; 62% of games saw it at least once).
    //
    // Still moves when the destination is safe, and still goes to the
    // revealed base, which is the one place it is supposed to be risked.
    const dsUnsafeHere = DEATH_STAR_CAUTION
      && !(G.rebelBaseRevealed && targetSystemId === G.rebelBaseSystemId)
      && ((G.map.systems[targetSystemId]?.units ?? []).some((u) =>
            u.side !== side && G.catalog.unitTypes[u.typeId]?.theater === 'space')
        || (G.catalog.adjacency[targetSystemId] ?? []).some((adjId) =>
            (G.map.systems[adjId]?.units ?? []).some((u) =>
              u.side !== side && G.catalog.unitTypes[u.typeId]?.theater === 'space')));
    const isStation = (typeId: string) =>
      typeId === 'death-star' || typeId === 'death-star-under-construction';
    for (const u of mine) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t || t.transport.immobile) continue;
      // Leave the station home. Its capacity leaves with it, so the
      // fighter/ground fitting below sees the real figure and simply
      // brings fewer passengers rather than an illegal load.
      if (dsUnsafeHere && isStation(u.typeId)) { heldStations.push(u); continue; }
      if (t.transport.capacity > 0) capitalShips.push(u);
      else if (t.theater === 'ground' && t.class !== 'structure') ground.push(u);
      else if (t.transport.restriction) fighters.push(u);
      // Previously there was NO final branch, so a space unit with no
      // capacity and no restriction icon matched nothing and was silently
      // dropped from the move. The X-Wing and the Y-Wing are the only two
      // types in the catalog with that shape — both Rebel — so the Rebel
      // AI activated systems and then left its fighters standing there
      // (task_a3b11e85; 80% of Rebel activations moved nothing).
      else selfMovers.push(u);
    }
    // Empire subjugation reserve: keep 1 ground at subjugated systems
    // so the subjugation marker stays — EXCEPT once the Rebel base is
    // revealed, when capturing it wins the game outright and holding
    // subjugations is worthless: commit every ground unit to the assault
    // (log diagnosis 2026-06-17: the Empire was leaving ~6-10 ground
    // stranded as subjugation garrisons while it failed to muster an
    // assault force at the exposed base).
    //
    // Widened to Imperial-LOYAL systems that PRODUCE (#625/#632). The reserve
    // covered subjugated systems only, so the AI would march every unit out of
    // a loyal system and hand the Rebels an uncontested one: "AI Imperials
    // moved ALL units away from an imperial loyal system... removing the
    // ability for Imperials to deploy or generate any units."
    //
    // Gated on the system actually producing, for two reasons. It is the
    // concrete reported harm — a build skips any system with opponent units
    // present (rr p.3), so a system the Empire vacates and the Rebels walk into
    // stops producing for it. And it bounds the cost: reserving at EVERY loyal
    // system would strand ground across the map, which is the failure the
    // 2026-06-17 diagnosis above found and the post-reveal exemption exists to
    // prevent.
    const produces = (G.catalog.systems[fromId]?.resources?.length ?? 0) > 0;
    const worthHolding = ss.subjugated || (produces && ss.loyalty === 'imperial');
    const groundReserve = (side === 'Empire' && worthHolding && ground.length > 0
      && !G.rebelBaseRevealed) ? 1 : 0;
    const groundCandidates = ground.slice(0, Math.max(0, ground.length - groundReserve));
    // Transport-capacity math: capital ships' total capacity must
    // cover (fighters + ground) we move. Bring all capitals (they're
    // valuable + provide capacity), then fit as many fighters/ground
    // as capacity allows.
    let capacity = 0;
    for (const u of capitalShips) {
      const t = G.catalog.unitTypes[u.typeId];
      capacity += t?.transport.capacity ?? 0;
    }
    // Prefer fighters first (they're space, useful in space combat),
    // then ground (useful for ground combat at target). Both consume
    // 1 capacity each per RAW p.9.
    const fightersToBring: typeof mine = [];
    const groundToBring: typeof mine = [];
    let used = 0;
    for (const u of fighters) {
      if (used >= capacity) break;
      fightersToBring.push(u); used++;
    }
    for (const u of groundCandidates) {
      if (used >= capacity) break;
      groundToBring.push(u); used++;
    }
    // If no capacity-providing ships present, skip non-capital units
    // entirely (engine would reject). Could still send capital-ship-
    // only moves (useful for moving SDs alone).
    const pickIds: string[] = [
      ...capitalShips.map((u) => u.instanceId),
      // Self-movers ride along unconditionally: they need no carrier and
      // consume no capacity, so they never compete with ground/fighters
      // for transport space.
      ...(SELF_MOVER_FIX ? selfMovers.map((u) => u.instanceId) : []),
      ...fightersToBring.map((u) => u.instanceId),
      ...groundToBring.map((u) => u.instanceId),
    ];
    // If holding the station back leaves this source sending NOTHING, send
    // it after all. The station is often the only capital in its system,
    // and the alternatives are both worse than the risk: an activation
    // that moves nothing (the no-troop waste #647/#666 removed), or —
    // if we reject the action outright — the Empire passing instead.
    // Rejecting measured 9 passes in 25 on the #639 fixture and broke
    // #649 too, which is the passivity failure this project has fought
    // hardest against. Caution about the Death Star does not get to
    // reintroduce it.
    if (pickIds.length === 0 && heldStations.length > 0) {
      pickIds.push(...heldStations.map((u) => u.instanceId));
    }
    if (pickIds.length > 0) {
      orders.push({ fromSystemId: fromId, unitInstanceIds: pickIds });
    }
  }
  return orders;
}

export function bestCommandAction(G: GameState, side: Side): CommandAction[] {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const actions: CommandAction[] = [];
  const allSystemIds = Object.keys(G.map.systems);
  const baseDist = (side === 'Rebel' && G.rebelBaseSystemId && !G.rebelBaseRevealed)
    ? bfsDistances(G, G.rebelBaseSystemId, 3)
    : null;
  // Distance from a REVEALED base, for the Empire's multi-hop convergence
  // gradient (#141/#153): once the base is exposed, reward activating systems
  // along the path to it so force flows inward from deep in the map, not just
  // from immediate neighbors.
  const revealedBaseDist = (side === 'Empire' && G.rebelBaseRevealed && G.rebelBaseSystemId)
    ? bfsDistances(G, G.rebelBaseSystemId, 4)
    : null;
  // Mirror image for the REBEL: once the base is revealed an invasion is
  // imminent, and the expert rushes every outlying unit home to defend. The
  // Rebel branch had NO movement gradient for this (baseDist is only set while
  // the base is hidden, to AVOID telegraphing it), so scattered Rebel force
  // never converged on the threatened base — the AI moved units ~55% less than
  // the expert (divergence harness). This is the defensive twin of
  // revealedBaseDist: reward Rebel activations that flow force toward the base.
  const rebelDefendDist = (side === 'Rebel' && G.rebelBaseRevealed && G.rebelBaseSystemId)
    ? bfsDistances(G, G.rebelBaseSystemId, 4)
    : null;
  // Held Rebel objectives — used to PURSUE combat objectives (ai-divergence
  // tempo gap: the AI wins ~10 rounds vs the expert's ~6, scoring too few
  // objectives because it never steers play toward them; the Rebel wins faster
  // the faster it earns reputation, and objectives are the main source).
  const rebelObjHand = side === 'Rebel' ? (G.rebel.objectiveHand ?? []) : [];
  // Precompute the set of probe-eliminated systems for the Empire.
  const eliminatedByProbe = side === 'Empire'
    ? new Set((G.empire.probeHand ?? [])
        .map((pid) => G.catalog.probes[pid]?.systemId)
        .filter((s): s is string => !!s))
    : new Set<string>();

  // 1) Revealing assigned missions whose skill cost is met AND at least one
  //    legal target exists. Previously we'd score any system, pick the best
  //    one, and let the engine reject illegal targets — this resulted in
  //    missions like capture-rebel-operative scoring high every turn but
  //    failing to reveal (no Rebel-leader + Empire-unit shared system),
  //    causing the AI to pass instead.
  for (const am of f.leadersOnMissions) {
    const card = G.catalog.missions[am.missionId];
    if (!card || !card.skill) continue;
    let skillSum = 0;
    for (const lid of am.leaderIds) skillSum += leaderSkillFit(G, lid as LeaderId, am.missionId);
    if (skillSum < card.skillCost) continue;
    // Which target to reveal at, and what the reveal is worth. Shared with
    // planAssignment via bestRevealTarget so assignment can't commit leaders to
    // a mission this phase would then refuse to play — the stranding that drove
    // the passivity reports. It applies the permissive/legal target split and
    // drops targets where the mission would do nothing (e.g. Draw Them Out with
    // an empty Rebel pool, Single Reactor Ignition with no Rebel ground or
    // markers) so the AI doesn't waste it (#276/#277).
    const reveals = rankedRevealTargets(G, side, am.missionId, baseDist, candK(side));
    for (const reveal of reveals) {
      actions.push({
        kind: 'reveal',
        missionId: am.missionId,
        targetSystemId: reveal.targetSystemId,
        // Lock the specific leader NOW for capture-style missions, so the target
        // can't drift to whoever opposes (RAW: target chosen at perform time).
        targetLeaderId: captureTargetLeaderId(G, side, am.missionId, reveal.targetSystemId),
        score: reveal.revealScore,
      });
    }
  }

  // 2) Activating systems. Pre-score each system once (not per-leader) since
  //    the per-system signal doesn't change between leaders.
  // Pre-compute base candidates from the Empire perspective: systems the
  // Rebel base could still be at (not Coruscant, not remote, not probe-
  // eliminated). When this set shrinks, the Empire pivots to actively
  // visiting those systems to "stumble onto" the base.
  let baseCandidateSet: Set<string> | null = null;
  if (side === 'Empire' && !G.rebelBaseRevealed) {
    baseCandidateSet = new Set(
      allSystemIds.filter((sid) => {
        if (sid === 'coruscant') return false;
        const def = G.catalog.systems[sid];
        if (!def) return false;
        // INCLUDE remote systems: the Rebel base CAN be hidden on a remote
        // world (setup allows any non-Coruscant, non-Imperial system), and
        // smart Rebels pick remote precisely because the Empire neglects it.
        // Previously remote was excluded here, so a remote base was
        // effectively un-findable by the AI's sweep. They're swept LAST via
        // the value ordering below, but they ARE swept.
        if (eliminatedByProbe.has(sid)) return false;
        // The Empire KNOWS the base can't be at any system it has SEARCHED. What
        // counts as "searched" must match the engine's reveal condition
        // (recomputeRebelBaseReveal): the base reveals the instant the Empire has
        // GROUND or Imperial loyalty there — NOT on a space-only presence.
        // Baseline (occupy flag OFF) keeps the older any-unit exclusion; with the
        // flag ON we exclude only truly-searched systems (Empire ground OR
        // Imperial-loyal OR subjugated), so a candidate where only a FLEET parked
        // (no ground landed) stays live and the AI is steered to land ground and
        // actually clear it (expert-hunt-spec: occupy-to-clear, not force-less tap).
        const ssHere = G.map.systems[sid];
        if (HUNT_OCCUPY_ENABLED) {
          const empGroundHere = ssHere?.units.some((u) => {
            const t = G.catalog.unitTypes[u.typeId];
            return u.side === 'Empire' && t?.theater === 'ground';
          });
          if (empGroundHere || ssHere?.loyalty === 'imperial' || ssHere?.subjugated) return false;
        } else if (ssHere?.units.some((u) => u.side === 'Empire')) {
          return false;
        }
        return true;
      }),
    );
  }
  // A base candidate is "cleared" (ruled out — the base would have auto-revealed
  // if it were here) once the Empire has actually SEARCHED it. Reveal-accurate
  // definition (recomputeRebelBaseReveal): Empire GROUND, Imperial loyalty, or
  // subjugation. With the occupy flag OFF this widens to any Empire unit
  // (space-only counted as cleared — the older, RAW-inaccurate behavior) so
  // production is byte-identical.
  const isCandidateCleared = (ss: { units: { side: string; typeId: string }[]; loyalty?: string; subjugated?: boolean }): boolean => {
    if (ss.loyalty === 'imperial' || ss.subjugated) return true;
    if (HUNT_OCCUPY_ENABLED) {
      return ss.units.some((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground');
    }
    return ss.units.some((u) => u.side === 'Empire');
  };
  // narrowingMode triggers heavier candidate-system bonuses. Raised from
  // 6 to 10 so Empire pivots to base-stumble searches earlier in the
  // game (by T5 probes typically narrow to 8-12 systems).
  // (Tried bumping to 14 with bonuses 20/10 — net loss. Reveal rate was
  // unchanged, leader-only ratio rose. Reverted.)
  const narrowingMode = baseCandidateSet ? baseCandidateSet.size <= 10 : false;
  // WEAKNESS 3 (log analysis): one loss had 11 subjugations but only 6
  // combats — Empire kept sending single leaders to fresh Rebel-loyal
  // neutrals instead of consolidating force on a candidate. Count current
  // subjugated systems for a global "stop spreading" gate; also find the
  // single system with the largest Empire ground stack (the marching column).
  let subjugatedCount = 0;
  for (const ss of Object.values(G.map.systems)) if (ss.subjugated) subjugatedCount++;
  const subjugationCap = side === 'Empire' && subjugatedCount >= 6;
  let largestEmpireStackSys: string | null = null;
  let largestEmpireStackSize = 0;
  if (side === 'Empire') {
    for (const sysId of allSystemIds) {
      const ss = G.map.systems[sysId];
      if (!ss) continue;
      let n = 0;
      for (const u of ss.units) {
        if (u.side !== 'Empire') continue;
        const t = G.catalog.unitTypes[u.typeId];
        if (t && (t.theater === 'ground' || t.class === 'capital')) n++;
      }
      if (n > largestEmpireStackSize) { largestEmpireStackSize = n; largestEmpireStackSys = sysId; }
    }
  }
  // PRE-REVEAL STAGING (log diagnosis 2026-06-17): the AI finds the base about
  // as fast as a human but converts only ~44% of base-invasions, because force
  // isn't massed near the base BEFORE the reveal — so a late reveal can't be
  // finished before reputation-time runs out (it then spins leader-only x0
  // activations on the base with nothing to bring). The human pre-stages: once
  // probes narrow the base to a handful of candidates, march the column toward
  // the single most-probable one so ground force arrives massed and a reveal
  // converts same-turn. Pick the most-likely UNCLEARED candidate — Rebel-loyal
  // first (Rebels favor their own loyalty for placement), then the one nearest
  // the existing column to avoid backtracking.
  let suspectFocus: string | null = null;
  if (side === 'Empire' && !G.rebelBaseRevealed && largestEmpireStackSize >= 4 && baseCandidateSet) {
    const colDist = largestEmpireStackSys ? bfsDistances(G, largestEmpireStackSys, 12) : null;
    let bestScore = -Infinity;
    for (const cid of baseCandidateSet) {
      const ss = G.map.systems[cid];
      if (!ss) continue;
      if (isCandidateCleared(ss)) continue; // already swept — base would have auto-revealed
      let s = 0;
      if (ss.loyalty === 'rebel') s += 12;
      if (ss.units.some((u) => u.side === 'Rebel')) s += 6;
      if (colDist) s -= distFrom(colDist, cid) * 1.5; // prefer a reachable focus
      if (s > bestScore) { bestScore = s; suspectFocus = cid; }
    }
  }
  const suspectDist = suspectFocus ? bfsDistances(G, suspectFocus, 4) : null;
  // Empire strike-fleet plan (#539): a stable, dominant aim point the per-system
  // scoring defers to so consecutive activations compose into one multi-turn
  // maneuver (co-locate carrier↔ground, march inward, dash). Pure + recomputed
  // each turn; env-gated for A/B. null when disabled or no plan this turn.
  const empirePlan: StrikeFleetPlan | null =
    side === 'Empire' && PLANNER_ENABLED ? derivePlan(G) : null;
  // Rebel force IN OR ADJACENT TO Coruscant, and what the Empire has standing
  // on the capital to meet it. Both are public board state, so reacting to them
  // is not the AI peeking at the Rebel's objective hand.
  //
  // Adjacency is the point. Two Rebel objectives key off this square and the
  // engine's existing Coruscant term saw neither coming:
  //   Threaten the Core     "5 or more Rebel units are in AND/OR ADJACENT TO
  //                          Coruscant" — scores while the fleet is still next
  //                          door, so by the time units arrive it has paid out.
  //   Heart of the Empire   "If the Coruscant system contains a Rebel unit and
  //                          NO Imperial units" — and it RETURNS TO HAND rather
  //                          than being spent, so it pays 2 reputation at every
  //                          Refresh until the Empire puts something back.
  // A playtester scored the second one 2+ times in single games: "if the rebels
  // ever gathers a threatening fleet next to coruscant they have heart of the
  // empire in hand 8-9 out of 10 times ... it reacts really slow to it being
  // attacked."
  const corAdj = side === 'Empire' ? [CORUSCANT, ...(G.catalog.adjacency[CORUSCANT] ?? [])] : [];
  const corThreat = corAdj.reduce((n, sid) => n
    + (G.map.systems[sid]?.units ?? []).filter((u) => u.side === 'Rebel').length, 0);
  const corGarrison = (G.map.systems[CORUSCANT]?.units ?? []).filter((u) => {
    if (u.side !== 'Empire') return false;
    return G.catalog.unitTypes[u.typeId]?.class !== 'structure';
  }).length;

  const systemScore = new Map<string, number>();
  for (const sysId of allSystemIds) {
    let ts = 0;
    // Set when the force we could actually deliver is not merely outmatched but
    // routed (< 60% of the defenders). The strength gate's scaled penalty is a
    // flat -24, which large positional bonuses can simply outrun — the #653
    // fixture scores 38 before the gate and still comes out at +14 after it, so
    // the attack survives the `ts > 0` filter and gets made anyway. A rout is
    // not a trade-off to be weighed against loyalty and subjugation value, so
    // this hard-sinks the target after all bonuses land, the same way the no-op
    // guard sinks an activation that provably cannot move or fight.
    let hopelessAttack = false;
    const sys = G.map.systems[sysId];
    if (!sys) continue;
    const def = G.catalog.systems[sysId];
    // What the executor would ACTUALLY move here, computed once and shared by
    // every guard below. This is the single source of truth for "what can I
    // bring": the no-op guard, the strength gates and the executor all read the
    // same answer, so the AI can no longer pick a move on a promise the
    // executor then breaks.
    const plannedHere = plannedMoveOrders(G, side, sysId);
    const plannedUnits = plannedHere.flatMap((o) => {
      const ss = G.map.systems[o.fromSystemId];
      return o.unitInstanceIds
        .map((id) => ss?.units.find((u) => u.instanceId === id))
        .filter((u): u is NonNullable<typeof u> => !!u);
    });
    const hasEnemyUnits = sys.units.some((u) => u.side !== side);
    const hasOwnUnits = sys.units.some((u) => u.side === side);
    if (side === 'Empire') {
      // Existing baseline.
      if (hasEnemyUnits) ts += 4;
      if (eliminatedByProbe.has(sysId)) ts -= 4;
      // Spread heuristic — reward visiting untouched neutral/Rebel-loyalty
      // systems to extend Imperial control + drop a unit for subjugation.
      // Worth more when the system has build resources.
      if (!hasOwnUnits && !sys.subjugated && sys.loyalty === 'imperial'
          && !(THEATER_AWARE_ODDS && hasEnemyUnits)) {
        // Already Imperial-controlled and no enemy here: moving units in gains
        // nothing — there's no loyalty to flip, nothing to subjugate, and no
        // combat. Don't reward shuffling a fleet onto a system we already own
        // (player report #69: Empire moved units to an owned 2-resource system
        // for no benefit). Mild penalty so consolidation toward the marching
        // column (a separate +6 adjacency bonus) can still override when the
        // move actually serves a purpose.
        //
        // The "no enemy here" half of that sentence was never in the condition,
        // so the penalty also hit Imperial-loyal systems the REBEL had taken —
        // exactly the ones worth retaking. There is a fight to have and loyalty
        // to defend, so the "gains nothing" premise does not hold (#697).
        ts -= 3;
      } else if (!hasOwnUnits && !sys.subjugated && sys.loyalty !== 'imperial') {
        // The explicit loyalty test keeps this branch exactly where it always
        // was. It used to be implied — every Imperial-loyal system fell into the
        // branch above — but now that a contested one can skip that branch, it
        // must not fall through to here: there is no loyalty to flip and nothing
        // to subjugate on a system the Empire already owns. Retaking it is
        // scored as a fight, below, not as a land grab.
        //
        // Count icons, or weigh them by SHAPE. A square icon builds a capital
        // ship or an AT-AT; a triangle builds a fighter or a trooper — so two
        // systems with "2 resources" can be worth very different amounts, both
        // to take and to deny. jocke01 (#694): the Empire subjugated Kashyyyk
        // (two triangle/ground) and left Mon Calamari (triangle + SQUARE space)
        // alone, "giving the rebel player both a fighter and a cruiser ... a
        // play that no human opponent would do". Both scored 2 here.
        const resourceWeight = RESOURCE_SHAPE_WEIGHT
          ? (def?.resources ?? []).reduce((a, r) =>
              a + (r.shape === 'square' ? 3 : r.shape === 'circle' ? 2 : 1), 0)
          : (def?.resources?.length ?? 0);
        // Subjugating needs a GROUND unit standing there — ships cannot plant a
        // marker. This whole branch is the "go take that planet" bonus, so it
        // is only earned if we can actually deliver ground. jocke01 (#696): "The
        // empire just moved a big fleet of ships to corellia. The problem is
        // that it has 0 ground units ... This move does nothing for the empire
        // except make their situation worse." Measured at 30 of 595 spread
        // activations (5.0%) arriving with units but no ground.
        //
        // Only the take-the-planet bonus is withheld, not the whole target:
        // moving ships somewhere can still be right for a fight or for staging,
        // and those bonuses are scored elsewhere on their own merits.
        // Ground deliverability comes from the shared planner, so it matches
        // what the executor will really carry (#696).
        const canDeliverGround = !SUBJUGATION_NEEDS_GROUND
          || plannedUnits.some((u) => {
            const t = G.catalog.unitTypes[u.typeId];
            return t?.theater === 'ground' && t.class !== 'structure';
          });
        if (canDeliverGround) ts += 2 + resourceWeight;
        // GERRY STRATEGY: prioritize subjugating Rebel-loyal systems —
        // strips Rebel production AND likely sits on the hidden base
        // (Rebels favor their loyalty for placement). Heavier early when
        // we should be spreading; tapers as timeMarker grows.
        if (sys.loyalty === 'rebel') ts += 8 + Math.max(0, 4 - G.timeMarker);
        // WEAKNESS 3: cap the subjugation-tourism behavior. Once Empire
        // already holds 6+ subjugated systems AND no invasion is pending
        // (base not revealed), spreading further is dilution — actively
        // penalize new subjugation pickups so leaders go consolidate
        // instead. OCCUPY-TO-CLEAR exemption (expert-hunt-spec): a system that
        // is still a LIVE base candidate is not tourism — occupying it clears a
        // candidate the RAW way and rolls the frontier toward the base, so the
        // cap must not repel it. Only non-candidate pickups stay capped.
        const isLiveCandidate = HUNT_OCCUPY_ENABLED && (baseCandidateSet?.has(sysId) ?? false);
        if (subjugationCap && !G.rebelBaseRevealed && !isLiveCandidate) ts -= 10;
      }
      // WEAKNESS 3 cont.: reward consolidating onto or adjacent to the
      // largest existing Empire stack. The "marching column" pattern
      // wants new activations to flow toward the column, not scatter to
      // unrelated Rebel-loyal pockets. Only kicks in when we have a
      // real stack (≥4 units) and the base isn't revealed yet (when it
      // IS revealed, the converge bonus above takes over).
      if (largestEmpireStackSize >= 4 && !G.rebelBaseRevealed
          && largestEmpireStackSys && sysId !== largestEmpireStackSys) {
        const adj = G.catalog.adjacency[largestEmpireStackSys] ?? [];
        if (adj.includes(sysId)) ts += 6;
      }
      // Base-narrowing pivot: when probe info has narrowed candidates,
      // strongly reward visiting remaining candidate systems (looking
      // to bump into the base). Bonuses bumped because in tournament,
      // Empire was visiting non-candidates (combat hot spots) instead
      // of the actual base candidates even at T5+ when probes already
      // narrowed to ~10 systems. Now candidates ALWAYS get a strong
      // bonus, and narrowing-mode (≤10) makes it a near-mandate.
      if (baseCandidateSet?.has(sysId)) {
        // Value-order the sweep so every base-search move also does board
        // work (user's Empire heuristic). A candidate the Empire has already
        // been to (own units / Imperial-loyal / subjugated) is "cleared" —
        // the base would have auto-revealed on arrival — so it's nearly
        // worthless to revisit.
        if (isCandidateCleared(sys)) {
          ts += 1;
        } else {
          // Priority: hit Rebel units (combat impact) > Rebel-loyal (deny
          // their production) > populous double-resource > single > remote
          // LAST (lowest, but still > 0 so they DO get visited once the
          // better targets are exhausted — the base often hides there).
          let cand = 6;
          if (sys.units.some((u) => u.side === 'Rebel')) cand += 12;
          else if (sys.loyalty === 'rebel') cand += 8;
          else if (!def?.isRemote) cand += 2 + (def?.resources?.length ?? 0) * 3;
          // remote: +0 extra (visited last)
          if (narrowingMode) cand += 6; // push harder once the set is small
          // OCCUPY-TO-CLEAR (expert-hunt-spec): a candidate the Empire already
          // has SPACE on but no ground is a half-finished search — landing
          // ground here reveals the base if it hides here. Nudge finishing it
          // over starting a fresh candidate, so a force-less space tap doesn't
          // leave the candidate live-but-neglected. (Only meaningful with the
          // flag on, where such a candidate is no longer treated as cleared.)
          if (HUNT_OCCUPY_ENABLED && sys.units.some((u) => u.side === 'Empire')) cand += 5;
          ts += cand;
        }
      }
      // URGENCY: Empire's path to victory requires finding and invading
      // the base before reputation-time runs out. Tournament data showed
      // the AI picking endless mission reveals (score ~20+) over
      // activations (score ~10-15), resulting in 0 activations and 0
      // unit moves across an entire 13-round game. Scale every Empire
      // activation by time pressure so late-game forcefully prefers
      // moving units / triggering combat over passive mission ticking.
      // Magnitude tuned against the mission-reveal score baseline
      // (gather-intel = 15 + targetScore + 6 ≈ 25). With timeMarker = 5
      // this adds +10, pushing activations to parity. T8 adds +16.
      ts += G.timeMarker * 2;
      // Spread within the current Command turn: if an Empire leader is
      // already on this system, another leader going there is wasted
      // (they'd subjugate the same place). Penalize unless the base is
      // revealed there — in that case we WANT all leaders converging.
      const empireLeadersHere = (G.empire.leadersOnBoard[sysId] ?? []).length;
      if (G.rebelBaseRevealed && sysId === G.rebelBaseSystemId) {
        // CONVERGE on the revealed base — but ONLY if we have force to bring.
        // Tournament data (100 games): 68% of Empire base-invasions in lost
        // games were leader-only (no units, just sending Vader to die). In
        // won games it was 13%. The +25 bonus was overriding force-availability
        // checks. Now we gate it: count Empire combat units at adjacent
        // unblocked systems. If 0 → leader-only invasion → free leader
        // capture for the Rebels. Drop the bonus and let the AI do something
        // useful (recruit, run a mission, stage).
        // Capturing the base is a GROUND fight: you must destroy the Rebel
        // ground units + base structures. Fighters and capital ships win the
        // space battle but never take the system, so measure readiness by
        // GROUND force vs. the base's ground defenders — not "any mobile unit"
        // (baseline: Empire won only ~29% of base invasions because it rushed
        // in under-strength). Only throw the assault when we can actually win
        // the ground battle; otherwise prefer staging more force first.
        const adj = G.catalog.adjacency[sysId] ?? [];
        const isMobileGround = (uTypeId: string): boolean => {
          const t = G.catalog.unitTypes[uTypeId];
          return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile;
        };
        let empireGroundAvail = 0;
        // Ground already at the base (a prior wave that survived).
        for (const u of sys.units) {
          if (u.side === 'Empire' && isMobileGround(u.typeId)) empireGroundAvail++;
        }
        // Pullable ground from adjacent, non-leader-blocked systems.
        for (const a of adj) {
          if ((G.empire.leadersOnBoard[a] ?? []).length > 0) continue; // RAW p.2
          const ss2 = G.map.systems[a];
          if (!ss2) continue;
          for (const u of ss2.units) {
            if (u.side === 'Empire' && isMobileGround(u.typeId)) empireGroundAvail++;
          }
        }
        // Rebel ground to clear (includes structures — they must be destroyed
        // to take the system, even though they don't attack).
        let rebelGroundDef = 0;
        for (const u of sys.units) {
          const t = G.catalog.unitTypes[u.typeId];
          if (u.side === 'Rebel' && t?.theater === 'ground') rebelGroundDef++;
        }
        if (empireGroundAvail >= rebelGroundDef + 2) ts += 28;   // clear ground edge → assault
        else if (empireGroundAvail > rebelGroundDef) ts += 14;   // slight edge → maybe
        else if (empireGroundAvail >= 1) ts += 2;                // some ground, not enough → weak
        else ts -= 12;                                           // no ground → never gift the leader
      } else if (G.rebelBaseRevealed && G.rebelBaseSystemId
                 && (G.catalog.adjacency[G.rebelBaseSystemId] ?? []).includes(sysId)
                 && empireLeadersHere === 0) {
        // STAGING bonus: when the base is revealed but a single invasion
        // didn't capture it, the AI needs to mass more force at adjacent
        // systems before re-invading. Reward activating systems 1 hop
        // from the base so units flow inward from 2+ hops out. (No bonus
        // if a leader is already at this staging system — they can't
        // move units out per game rules.)
        ts += 18;
      } else if (empireLeadersHere > 0) {
        ts -= 5 * empireLeadersHere;
      }
      // Multi-hop convergence gradient (#141/#153): the base/adjacent branches
      // above only reward the final hop or two. Add a smaller pull for systems
      // 2-3 hops from a revealed base (no own leader present) so deep-map
      // Empire force marches inward over successive turns instead of idling on
      // the far side of the galaxy while the exposed base sits unmolested.
      if (revealedBaseDist && empireLeadersHere === 0 && sysId !== G.rebelBaseSystemId) {
        const dToBase = distFrom(revealedBaseDist, sysId);
        if (dToBase === 2) ts += 10;
        else if (dToBase === 3) ts += 5;
      }
      // Carrier-ferry consolidation (assault logistics, log diagnosis): in lost
      // invasions the Empire has carriers AND ground within ~2 hops of the
      // exposed base, but at DIFFERENT systems — the ground sits stranded with
      // no carrier to lift it. Reward activating a near-base system that holds
      // stranded Empire ground (ground present, no local carrier): a carrier
      // pulled in from an adjacent source co-locates with it, so next turn it
      // can ship the ground to the assault. Only fires when a carrier is
      // actually adjacent (else the activation can't load anything).
      if (revealedBaseDist && G.rebelBaseSystemId && sysId !== G.rebelBaseSystemId) {
        const dToBase = distFrom(revealedBaseDist, sysId);
        if (dToBase <= 2) {
          const hasCap = (u: { typeId: string }) => (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) > 0;
          const isGrnd = (u: { typeId: string }) => {
            const t = G.catalog.unitTypes[u.typeId];
            return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile;
          };
          const strandedGround = sys.units.filter((u) => u.side === 'Empire' && isGrnd(u)).length;
          const carrierHere = sys.units.some((u) => u.side === 'Empire' && hasCap(u));
          if (strandedGround > 0 && !carrierHere) {
            const carrierAdj = (G.catalog.adjacency[sysId] ?? []).some((a) =>
              (G.map.systems[a]?.units ?? []).some((u) => u.side === 'Empire' && hasCap(u)));
            if (carrierAdj) ts += Math.min(strandedGround, 4) * 4; // pull a carrier in to lift it
          }
        }
      }
      // Pre-reveal staging gradient: before the base is even revealed, flow the
      // marching column toward the suspected base region so ground force is
      // already adjacent when it's found (so the reveal converts same-turn). A
      // hair smaller than the revealed-base gradient so an actual reveal still
      // takes priority. Skipped on the focus system itself (it gets the
      // candidate bonus) and where a leader already sits (can't pull units out).
      if (suspectDist && empireLeadersHere === 0 && sysId !== suspectFocus) {
        const dToFocus = distFrom(suspectDist, sysId);
        if (dToFocus === 1) ts += 9;
        else if (dToFocus === 2) ts += 5;
      }
      // #246/#237: don't feed a leader + units into a battle we're clearly
      // going to lose. For an attack on a NON-base system holding Rebel units
      // (the revealed base has its own readiness logic above), weigh the Empire
      // force we can actually bring — units already here plus pullable force
      // from adjacent, non-leader-blocked systems — against the Rebel
      // defenders. Two guards: overall strength (an obviously-outnumbered
      // assault, #246) and ground strength specifically (committing a leader to
      // a ground fight it can't win can't take the system AND hands the Rebel a
      // free Confrontation kill, #237). Pullable-adjacent matches the base
      // invasion estimate above, so a real marching column still attacks.
      if (hasEnemyUnits && !(G.rebelBaseRevealed && sysId === G.rebelBaseSystemId)) {
        const strengthOf = (u: { typeId: string }): number => {
          const t = G.catalog.unitTypes[u.typeId];
          if (!t) return 0;
          return (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0);
        };
        const isGround = (u: { typeId: string }): boolean =>
          G.catalog.unitTypes[u.typeId]?.theater === 'ground';
        let empAll = 0, empGround = 0, rebAll = 0, rebGround = 0;
        for (const u of sys.units) {
          if (u.side === 'Empire') { empAll += strengthOf(u); if (isGround(u)) empGround += strengthOf(u); }
          else if (u.side === 'Rebel') { rebAll += strengthOf(u); if (isGround(u)) rebGround += strengthOf(u); }
        }
        // Reinforcements the executor would ACTUALLY bring, not every unit
        // parked next door — that was #653's lone ship. Now taken straight
        // from the shared planner rather than a second estimate of it, so the
        // gate prices the exact force that will show up.
        let reinforceSpace = 0;
        if (REAL_REINFORCE_ESTIMATE) {
          let rAll = 0, rGround = 0;
          for (const u of plannedUnits) {
            const v = strengthOf(u);
            rAll += v;
            if (isGround(u)) rGround += v;
          }
          empAll += rAll;
          empGround += rGround;
          reinforceSpace = rAll - rGround;
        } else {
          for (const a of (G.catalog.adjacency[sysId] ?? [])) {
            if ((G.empire.leadersOnBoard[a] ?? []).length > 0) continue; // RAW p.2: leader-blocked
            for (const u of (G.map.systems[a]?.units ?? [])) {
              if (u.side === 'Empire') { empAll += strengthOf(u); if (isGround(u)) empGround += strengthOf(u); }
            }
          }
        }
        // Overall outnumbered — scale the penalty by how lopsided it is.
        if (rebAll > 0 && empAll < rebAll) ts -= empAll < rebAll * 0.6 ? 24 : 12;
        // ...and a rout is excluded outright, not just discounted (see above).
        if (REAL_REINFORCE_ESTIMATE && rebAll > 0 && empAll < rebAll * 0.6) hopelessAttack = true;
        // Can't win the GROUND fight where the defender has ground: it doesn't
        // take the system AND lets the Rebel play Confrontation to ELIMINATE the
        // committed leader for good (#237/#479 — the AI marched Vader + ships and
        // barely any ground into a Rebel ground stronghold). The old flat -14 was
        // too weak against a big subjugation/search bonus, so a badly-outnumbered
        // assault still went through. Scale it: a ground force that's less than
        // HALF the defender's is a near-certain leader loss — penalize hard.
        //
        // ...but only when a ground battle is actually going to happen. combat.ts
        // gates each theatre on bothSidesHaveTheater(), so with empGround === 0
        // there is no ground battle at all — nothing to lose it in, and no
        // Confrontation window, because the leader is up in space with the fleet.
        // Docking 30 points for a rout that the rules will not roll is what made
        // Coruscant unreachable in #697 (final score −11, below the ts > 0 cutoff,
        // so it never even entered the candidate list).
        const groundBattleHappens = !THEATER_AWARE_ODDS || empGround > 0;
        if (rebGround > 0 && empGround < rebGround && groundBattleHappens) {
          ts -= empGround < rebGround * 0.5 ? 30 : 14;
        }
        // A groundless fleet is not thereby a free move: judge it on the fight it
        // WILL have. If the defender has ships, this is a space battle and the
        // space odds decide it. If the defender has none, no theatre is shared,
        // beginCombat no-ops, and the ships arrive to sit next to a Rebel army
        // they cannot touch — the #666 shape, worth less than nothing.
        if (THEATER_AWARE_ODDS && empGround === 0 && rebGround > 0) {
          const spaceStrength = (side2: 'Empire' | 'Rebel') => sys.units.reduce((a, u) =>
            a + (u.side === side2 && !isGround(u) ? strengthOf(u) : 0), 0);
          const rebSpace = spaceStrength('Rebel');
          const empSpace = spaceStrength('Empire') + reinforceSpace;
          if (rebSpace === 0) ts -= 12;            // no shared theatre — no fight
          else if (empSpace < rebSpace) ts -= 12;  // outgunned in the only theatre that matters
        }
      }
      // STRIKE-FLEET PLAN (#539): add the plan's dominant, stable bonus for
      // activating this system (sink dash / rendezvous massing / carrier↔ground
      // co-location / inward gradient). Only positive — never suppresses a
      // hunting move (#446). Added BEFORE the universal troop guard below so an
      // activation that can move nothing is still zeroed (no reject-then-pass).
      if (empirePlan) ts += planSystemBonus(G, empirePlan, sysId);
      // NOTE: a pre-reveal "hunt march" twin of the plan gradient (march the
      // army toward the top base suspect) was built and A/B'd here — and the
      // smoke suite killed it: Empire win 52.0→43.3 and base-finding down in
      // BOTH benches (marching burns the activations the hunt spends clearing
      // candidates), while the hunt-replays showed the clock leaves too few
      // rounds to march by the time candidates narrow. The unwired pieces
      // (deriveHuntTarget/huntMarchBonus) live in empirePlanner.ts with the
      // full post-mortem; a real hunt fix must engage EARLIER than narrowing.
      // Don't waste activations on Coruscant or systems already saturated —
      // while it is quiet. A Rebel force standing on the Imperial capital is the
      // opposite of a wasted activation: Heart Of The Empire pays the Rebel 2
      // reputation at EVERY Refresh for as long as Coruscant "contains a Rebel
      // unit and no Imperial units", and the card returns to hand rather than
      // being spent. That condition is public board state, so preferring to
      // break it is not the AI peeking at the Rebel's objective hand — it is the
      // Empire noticing an enemy army camped on its capital. Merely arriving
      // denies it; the Empire does not have to clear the ground (#697).
      // The "quiet capital" penalty must not apply while a Rebel army is within
      // one jump: that is the moment reinforcing is most valuable, and docking
      // it 3 was telling the Empire to look away right up until the Rebels
      // landed. Measured on a fixture before this change, with SIX Rebel units
      // next door and Coruscant EMPTY, activating to the capital scored 2 and
      // ranked last of four — defending an undefended capital was the Empire's
      // least attractive move on the board.
      const corQuiet = !DEFEND_CORUSCANT || corThreat === 0;
      if (sysId === 'coruscant' && corQuiet && !(THEATER_AWARE_ODDS && hasEnemyUnits)) ts -= 3;
      if (THEATER_AWARE_ODDS && sysId === 'coruscant' && hasEnemyUnits && !hasOwnUnits) ts += 20;
      if (DEFEND_CORUSCANT && sysId === CORUSCANT && corThreat > 0) {
        // Scale with how badly the capital is outnumbered, so a lone scout next
        // door is a nudge and a massed fleet is an emergency. Deliberately fires
        // BEFORE the garrison is gone: waiting for `!hasOwnUnits` means waiting
        // until Heart of the Empire is already scoreable, which is exactly the
        // reaction lag being reported. Capped so the capital cannot outbid every
        // other consideration on the map forever.
        ts += Math.min(26, 5 + 4 * Math.max(0, corThreat - corGarrison));
      }
    } else {
      if (baseDist) {
        // Base still hidden — don't cluster units onto/next to it and give the
        // location away.
        const d = distFrom(baseDist, sysId);
        if (d <= 1) ts -= 5;
      }
      if (rebelDefendDist) {
        // Base revealed → DEFENSIVE convergence. Pull outlying Rebel force
        // toward the threatened base, mirroring the Empire's attack gradient.
        // The subsequent universal troop guard zeroes out any of these that
        // can't actually bring a unit, so these bonuses only land where force
        // really flows inward.
        const rebLeadersHere = (G.rebel.leadersOnBoard[sysId] ?? []).length;
        const dToBase = distFrom(rebelDefendDist, sysId);
        if (sysId === G.rebelBaseSystemId) {
          // Activate the base itself to draw adjacent defenders INTO it for the
          // stand. (A leader already here can still pull from neighbors.)
          ts += 22;
        } else if (rebLeadersHere === 0) {
          // Staging inward: activating a system 1-3 hops out moves its units one
          // hop closer to the base each turn.
          if (dToBase === 1) ts += 14;
          else if (dToBase === 2) ts += 8;
          else if (dToBase === 3) ts += 4;
        }
      }
      if (sys.loyalty === 'imperial') ts += 3;
      // OFFENSIVE MANEUVER (ai-divergence 2026-06-17): the expert Rebel moves
      // units ~2x as often (2.58 vs 1.19/round), attacks 22% more, and gains
      // 35% more loyalty — it pushes force OUT to contest Imperial territory,
      // while this AI hoards everything at the hidden base and mission-spams.
      // While the base is hidden, reward sortieing force toward a BEATABLE
      // Imperial position, and building presence on an uncontested non-Rebel
      // core system. A strength gate (the Rebel had none — it was Empire-only)
      // keeps it from feeding a losing attack.
      if (!G.rebelBaseRevealed) {
        const strengthOf = (u: { typeId: string }): number => {
          const t = G.catalog.unitTypes[u.typeId];
          return t ? ((t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0)) : 0;
        };
        const isGround = (u: { typeId: string }): boolean => G.catalog.unitTypes[u.typeId]?.theater === 'ground';
        // Rebel force we can actually bring here = units present + pullable from
        // adjacent, leader-unblocked systems (mirrors the Empire estimate).
        let rebAll = 0, rebGround = 0, impAll = 0, impGround = 0, bringable = 0;
        for (const u of sys.units) {
          if (u.side === 'Rebel') { rebAll += strengthOf(u); if (isGround(u)) rebGround += strengthOf(u); }
          else if (u.side === 'Empire') { impAll += strengthOf(u); if (isGround(u)) impGround += strengthOf(u); }
        }
        for (const a of (G.catalog.adjacency[sysId] ?? [])) {
          if ((G.rebel.leadersOnBoard[a] ?? []).length > 0) continue; // RAW p.2: leader-blocked
          for (const u of (G.map.systems[a]?.units ?? [])) {
            if (u.side !== 'Rebel') continue;
            rebAll += strengthOf(u); bringable++;
            if (isGround(u)) rebGround += strengthOf(u);
          }
        }
        // The Rebel's own fleet was INVISIBLE here: starting units live in
        // G.map.rebelBaseSpace, which is not a map system, so the adjacency scan
        // above never saw them — rebAll stayed ~0 for any system next to the
        // base and the winnable-attack gate below could never pass. Measured
        // effect: the AI Rebel alpha-struck in 0/20 turn-1 games. Base-space
        // units sit AT the base system, so they can move to its neighbours;
        // count them when this target is adjacent to the base.
        if (G.rebelBaseSystemId
            && (G.catalog.adjacency[sysId] ?? []).includes(G.rebelBaseSystemId)
            && (G.rebel.leadersOnBoard[G.rebelBaseSystemId] ?? []).length === 0) {
          for (const u of (G.map.rebelBaseSpace?.units ?? [])) {
            if (u.side !== 'Rebel') continue;
            rebAll += strengthOf(u); bringable++;
            if (isGround(u)) rebGround += strengthOf(u);
          }
        }
        const dFromBase = baseDist ? distFrom(baseDist, sysId) : Infinity;
        if (hasEnemyUnits && impAll > 0) {
          // Winnable attack (overall edge AND can clear the ground to hold it).
          if (rebAll >= impAll * 1.2 && rebGround >= impGround) {
            ts += 12;
            // OBJECTIVE PURSUIT: a win here that satisfies a held combat
            // objective scores reputation now — the fastest path to the
            // reputation-time win. Steer the attack toward objective-relevant
            // targets (only inside the strength gate, so we never suicide for a
            // card). Bonus per matching held objective.
            if (rebelObjHand.length > 0) {
              const impUnits = sys.units.filter((u) => u.side === 'Empire');
              const hpIn = (theater: 'ground' | 'space') => impUnits
                .filter((u) => G.catalog.unitTypes[u.typeId]?.theater === theater)
                .reduce((acc, u) => acc + (G.catalog.unitTypes[u.typeId]?.health.value ?? 0), 0);
              const impGroundHp = hpIn('ground'), impShipHp = hpIn('space');
              const hasSD = impUnits.some((u) => u.typeId === 'star-destroyer' || u.typeId === 'super-star-destroyer');
              const hasImpShips = impShipHp > 0, hasImpGround = impGroundHp > 0;
              const hasSquareResource = !!def?.resources?.some((r) => r.shape === 'square');
              const has = (id: string) => rebelObjHand.includes(id);
              if (has('crippling-blow-1') && impGroundHp >= 3) ts += 10;
              if (has('rebel-assault-1') && hasSD) ts += 10;
              if (has('major-victory-3') && impShipHp >= 3) ts += 10;
              if (has('liberation-2') && sys.subjugated && hasImpGround) ts += 10;
              if (has('raid-imperial-factory-3') && hasSquareResource) ts += 8;
              if (has('seize-control-2') && sys.sabotage) ts += 8;
              if (has('decisive-victory-1') && hasImpShips && hasImpGround) ts += 8;
              // DEATH STAR OPPORTUNISM (jocke01: an unsupported Death Star sat
              // next to 6 Rebel fighters while the plans were in hand — no
              // attack). With Death Star Plans held, fighters vs a lightly
              // escorted DS is close to a freeroll: the DS rolls 4 RED dice,
              // which cannot damage black-health fighters, and every combat
              // round with a surviving fighter is another 3-dice shot at the
              // direct hit that destroys it (the in-combat attempt is already
              // automatic — this fixes never STARTING the fight). Weight by
              // bringable fighters; the surrounding strength gate already
              // filters genuinely suicidal escorts.
              if (rebelObjHand.some((id) => id.startsWith('death-star-plans'))
                  && impUnits.some((u) => u.typeId === 'death-star')) {
                const fightersBringable =
                  sys.units.filter((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.class === 'fighter').length
                  + (G.catalog.adjacency[sysId] ?? []).reduce((acc, a) =>
                    (G.rebel.leadersOnBoard[a] ?? []).length > 0 ? acc
                      : acc + (G.map.systems[a]?.units ?? []).filter((u) =>
                          u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.class === 'fighter').length, 0);
                if (fightersBringable >= 2) ts += 18;
              }
            }
          }
        } else if (!hasEnemyUnits && sys.loyalty !== 'rebel' && !def?.isRemote
                   && sysId !== 'coruscant' && bringable > 0 && dFromBase >= 2) {
          // Build presence on an uncontested core system (gain loyalty / deny
          // the Empire) — only force already away from the base, to not
          // telegraph its location.
          ts += 4 + (def?.resources?.length ?? 0);
        }
      }
    }
    if (hasOwnUnits && side === 'Rebel') ts += 1;
    // UNIVERSAL RULE (per user playtesting): never activate without troops.
    // A leader-only activation accomplishes nothing — no combat (needs units
    // on both sides), no subjugation (needs a unit present, not just a
    // leader), no spread (the leader can't drop a unit). The right play
    // when you want force somewhere is to activate the intermediate
    // system ONE HOP CLOSER and pull units inward — not to place the
    // leader at the eventual target with nothing.
    //
    // Exception: activating a system that already has your units is fine
    // (consolidation, joining a prior wave, leader+units defensive set).
    {
      // UNIVERSAL troop guard (applies to BOTH sides — the rule above is
      // explicitly universal, but this was historically gated to Empire only.
      // The expert-vs-AI divergence harness flagged Rebel as activating 59%
      // MORE than the expert while moving units 59% LESS — i.e. the Rebel AI
      // was landing leaders alone exactly the way the Empire guard was added to
      // prevent. Same logic, side-generic now.)
      // "Can I actually bring units here?" — now answered by the SAME planner
      // the executor runs (plannedMoveOrders), not by a parallel estimate.
      // This was already better than counting every mobile unit (player report
      // #114: "activated leaders without accompanying troops"), but it still
      // knew nothing about the garrison reserve, the prison-system guard, the
      // revealed-base drain guard, or a Death Star held back — so it kept
      // drifting from what the executor would really do.
      const movable = plannedUnits.length;
      const ownHere = sys.units.filter((u) => u.side === side).length;
      const enemyHere = sys.units.some((u) => u.side !== side);
      // An activation is worth something only if it BRINGS units (movable > 0)
      // or joins a fight already available at the target. phases.activateSystem
      // computes `willFight = oppHere && myHere`, so a fight needs units of OURS
      // already there — a leader arriving alone never triggers combat no matter
      // how many enemies are present.
      //
      // The guard used to exempt every enemy-occupied target (`!enemyHere`),
      // assuming an enemy meant a fight. #647: the Empire sent Vader alone to
      // Kessel, which held one Rebel trooper and zero Imperial units, with
      // nothing movable in range — logged as orders:0, unitsMoved:0. No combat,
      // no movement, top-scored at 32. Requiring own units present for the
      // enemy exemption closes that without touching the join-a-fight case.
      // Match beginCombat's ACTUAL gate, not a loose 'both sides have some
      // unit here'. combat.ts starts a fight only when both sides share a
      // THEATER (bothSidesPresent = bothSidesHaveTheater space || ground); its
      // own comment notes that when they disagree — Imperial ships arriving
      // where the Rebel has only ground units — beginCombat no-ops.
      //
      // Mirroring the loose form exempted such activations from the no-op sink
      // expecting a fight the engine then declined to start, so the leader
      // landed alone having moved nothing (#666, replayed to exactly this
      // shape: movable 0, both sides present, no shared theater, orders 0).
      const sharesTheater = (th: string) =>
        sys.units.some((u) => u.side === side && G.catalog.unitTypes[u.typeId]?.theater === th)
        && sys.units.some((u) => u.side !== side && G.catalog.unitTypes[u.typeId]?.theater === th);
      const canFightHere = enemyHere && ownHere > 0 && (sharesTheater('space') || sharesTheater('ground'));
      if (movable === 0 && (NOOP_ACTIVATION_GUARD ? !canFightHere : !enemyHere)) {
        // Activating this system moves nothing and starts no fight, so it's a
        // wasted action — and the executor (tryCommandAction) rejects it, so a
        // high score here just makes the AI reject-then-pass while a real move
        // goes untried. Two sub-cases both land here:
        //   • ownHere === 0: the leader would sit alone (nothing to bring).
        //   • ownHere  >  0: units can't move INTO their own system, so a
        //     resident stack just idles. RAW only lets you pull units from
        //     neighbors INTO the activated system — to march a big stack you
        //     activate a NEIGHBOR of it, not the stack's own system. Player
        //     report #517: a 14-unit Empire stack idled at Dagobah while the
        //     last leader passed, because the stack's own system out-scored
        //     every executable neighbor. Sinking this below pass lets the AI
        //     pick the neighbor-activation that actually advances the stack.
        ts = -50;
      }
    }
    // Applied last, after every bonus, so no amount of positional value can buy
    // its way past a rout (#653).
    if (hopelessAttack) ts = -50;
    systemScore.set(sysId, ts);
  }
  // Pair leaders with targets. This used to loop over leaders and give EVERY
  // one the argmax of a leader-independent systemScore — so N pool leaders
  // produced N candidates that all named the SAME system, and the AI never
  // compared two destinations in a single decision. Measured at 2.33 activate
  // candidates from 2.34 eligible leaders but only 1.00 DISTINCT target
  // (scripts/diag-idle-activations.mjs). That is player report #599
  // ("activating all leaders to one system") verbatim, and it also starved
  // MCTS: searchMctsCommand searches bestCommandAction(...).slice(0, topK), so
  // ~1.3 of the top-12 slots per decision were duplicate targets and genuine
  // alternatives never entered the search at all.
  //
  // Now: walk DISTINCT positive-scoring systems best-first and give each one
  // the best-suited leader still free, so the candidate list offers real
  // choices between destinations. Leader fit uses tactic values in the theatre
  // the fight would actually happen in — the old code took whichever leader
  // came first in pool order, which is how a low-tactic leader ended up leading
  // an activation while a better one idled (#605).
  {
    // RR: "A leader that does not have tactic values cannot activate a system."
    // Skips the no-tactic leaders (Boba Fett, Greejatus, Mon Mothma) — they can
    // still run missions / block enemy move-outs, just not lead a move.
    const eligible = (f.leaderPool as LeaderId[]).filter((lid) => {
      const l = G.catalog.leaders[lid];
      return !!l && (l.tacticValues.space + l.tacticValues.ground) > 0;
    });
    // tieOrdered first: this ranking picks the activation target, and a stable
    // sort over the alphabetical system list sent every tied fleet to the same
    // early-alphabet systems round after round. That is the "empire loves
    // shuffling fleets between ord mantel, cato nemodia and alderaan" report —
    // the Empire wasn't oscillating on purpose, it was re-picking the
    // alphabetically-first of several equally-scored destinations each turn.
    const ranked = tieOrdered(G, allSystemIds)
      .map((sid) => ({ sid, ts: systemScore.get(sid) ?? 0 }))
      .filter((x) => x.ts > 0)
      .sort((a, b) => b.ts - a.ts);
    // How well `lid` leads a fight at `sid`: weight each theatre's tactic value
    // by whether an enemy is actually there to fight in it. With no enemy
    // present (a reposition) both theatres stay in play, so fall back to the
    // leader's overall tactic strength rather than guessing a theatre.
    const leaderFit = (lid: LeaderId, sid: SystemId): number => {
      const l = G.catalog.leaders[lid];
      if (!l) return 0;
      const units = G.map.systems[sid]?.units ?? [];
      let enemySpace = false, enemyGround = false;
      for (const u of units) {
        if (u.side === side) continue;
        const t = G.catalog.unitTypes[u.typeId];
        if (!t || t.class === 'structure') continue;
        if (t.theater === 'ground') enemyGround = true; else enemySpace = true;
      }
      if (!enemySpace && !enemyGround) return l.tacticValues.space + l.tacticValues.ground;
      return (enemySpace ? l.tacticValues.space : 0) + (enemyGround ? l.tacticValues.ground : 0);
    };
    if (!ACTIVATE_DIVERSITY_ENABLED) {
      // Legacy: every eligible leader proposes the single best system.
      const top = ranked[0];
      if (top) for (const lid of eligible) {
        actions.push({ kind: 'activate', leaderId: lid, targetSystemId: top.sid, score: top.ts });
      }
    } else {
      const taken = new Set<LeaderId>();
      for (const { sid, ts } of ranked) {
        if (taken.size >= eligible.length) break;
        let pick: LeaderId | null = null;
        let pickFit = -Infinity;
        for (const lid of eligible) {
          if (taken.has(lid)) continue;
          const fit = leaderFit(lid, sid);
          if (fit > pickFit) { pickFit = fit; pick = lid; }
        }
        if (!pick) break;
        taken.add(pick);
        actions.push({ kind: 'activate', leaderId: pick, targetSystemId: sid, score: ts });
      }
      // Width (SWR_CAND_K > 1): the pass above gives each leader ONE target.
      // Add each eligible leader's next-best (K-1) systems, skipping pairs
      // already proposed, so the search can see the alternative destinations a
      // human picks 74% of the time it disagrees with the argmax.
      const K = candK(side);
      if (K > 1) {
        const have = new Set(actions.filter((a) => a.kind === 'activate').map((a) => `${(a as { leaderId: LeaderId }).leaderId}|${a.targetSystemId}`));
        for (const lid of eligible) {
          let added = 0;
          for (const { sid, ts } of ranked) {
            if (added >= K - 1) break;
            const key = `${lid}|${sid}`;
            if (have.has(key)) continue;
            have.add(key); added++;
            actions.push({ kind: 'activate', leaderId: lid, targetSystemId: sid, score: ts });
          }
        }
      }
    }
  }

  actions.push({ kind: 'pass', score: PASS_ACTION_SCORE });
  actions.sort((a, b) => b.score - a.score);
  // Return the full sorted list (pass is in there with score 0.5). The executor
  // tries them in order and skips any that the engine rejects, so a high-score
  // mission it can't actually reveal no longer forces a pass while feasible
  // lower-score actions go untried (player report #190).
  return actions;
}

/** Empire's forced placement of the Rebel's Raid Outposts markers. The Rebel
 *  scores each time a marker is REMOVED, so the Empire buries them where Rebel
 *  forces can't get at them. Threat per remote = Rebel units in the system
 *  (can clear it immediately, weighted heavily) + adjacent systems holding
 *  Rebel units (one move away). #576: the old check only looked INSIDE the
 *  system, so it placed a marker on an empty remote with a massive Rebel fleet
 *  parked right next door — free reputation. Prefer the lowest total threat.
 *  Deterministic (stable sort). Exported for direct testing. */
export function chooseRaidOutpostRemotes(
  G: GameState, legal: readonly SystemId[], count: number,
): SystemId[] {
  const rebelIn = (sid: SystemId) =>
    (G.map.systems[sid]?.units ?? []).some((u) => u.side === 'Rebel');
  const score = (sid: SystemId) => {
    const here = rebelIn(sid) ? 100 : 0;
    const adj = (G.catalog.adjacency[sid] ?? []).filter((n) => rebelIn(n)).length;
    return here + adj;
  };
  return [...legal].sort((a, b) => score(a) - score(b)).slice(0, count);
}

/** Run one AI action for `side`. Returns true if something happened (caller
 *  should re-render and may call again), false if nothing left to do. */
export function stepOnce(G: GameState, side: Side): boolean {
  if (G.isGameOver) return false;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const did = stepOnceInner(G, side);
  const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  // A deliberately-installed search policy (MCTS / eval-depth2) is SUPPOSED to
  // take seconds per Command decision — that is the whole trade. Warning on
  // every one of its steps turned a 300-game harness run into thousands of
  // lines of identical noise and hid the warnings that matter (a slow HEURISTIC
  // step, which is always a bug). Only warn when no override owns this side.
  if (elapsed > 500 && !commandPolicyOverride[side]) {
    // Per-step budget exceeded — log so the slow path can be diagnosed.
    console.warn(`[ai] slow stepOnce: ${elapsed.toFixed(0)}ms`, {
      side, phase: G.phase, pendingChoice: G.pendingChoice?.kind, currentPlayer: G.currentPlayer,
    });
  }
  return did;
}

function stepOnceInner(G: GameState, side: Side): boolean {
  if (G.isGameOver) return false;

  // Universal safety net: if a pendingCombat exists with no pendingChoice
  // currently posted, something stranded the combat sub-machine. Run it
  // now to either (a) advance to the next step and post a fresh choice,
  // or (b) finish the combat outright. This catches freezes like the
  // one in stuck-combat-live-state.json where Empire activated a system
  // while a Rebel mission's pendingChoice was still set — beginCombat
  // created pendingCombat at step=AddLeader, the follow-up runCombat()
  // bailed at "if (G.pendingChoice) return", and after the mission
  // choice eventually cleared nothing re-invoked runCombat. Runs OK
  // even on an active combat — runCombat reads c.step and resumes from
  // wherever it left off.
  if (G.pendingCombat && !G.pendingChoice) {
    combat.runCombat(G);
    return true; // re-render; the next step will handle whatever was queued
  }

  // Generic choice framework (src/engine/choices.ts): ONE branch answers every
  // data-driven Choice, so a new engine prompt can never soft-lock an AI turn.
  // A per-tag heuristic table (AI_CHOICE_HEURISTICS) supplies smart picks; the
  // fallback selects the minimum legal number of candidates.
  if (G.pendingChoice && G.pendingChoice.kind === 'Choice' && G.pendingChoice.side === side) {
    return handleGenericChoice(G);
  }

  // Pending-choice handlers run REGARDLESS of whose turn it is: an opponent
  // can owe a choice (e.g. OpposeMission during the other side's turn,
  // CombatAttackerTactics/CombatDefenderTactics mid-combat).
  if (G.pendingChoice && G.pendingChoice.kind === 'OpposeMission' && G.pendingChoice.opposerSide === side) {
    return handleOpposeMission(G, side);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatAttackerTactics' && G.pendingChoice.side === side) {
    return handleCombatAttackerTactics(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatDefenderTactics' && G.pendingChoice.side === side) {
    return handleCombatDefenderTactics(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'BuildPick' && G.pendingChoice.side === side) {
    return handleBuildPick(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatAssignDamage' && G.pendingChoice.side === side) {
    return handleCombatAssignDamage(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CinematicTargetPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const findUnit = (id: string) => {
      for (const sys of Object.values(G.map.systems)) {
        const u = sys.units?.find((x) => x.instanceId === id);
        if (u) return u;
      }
      return undefined;
    };
    const remaining = (id: string) => {
      const u = findUnit(id);
      if (!u) return Infinity;
      return (G.catalog.unitTypes[u.typeId]?.health.value ?? 0) - u.damage;
    };
    // Threat = combat power removed by killing it (attack dice + health).
    const threat = (id: string): number => {
      const u = findUnit(id);
      const t = u ? G.catalog.unitTypes[u.typeId] : undefined;
      return t ? ((t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0)) + (t.health?.value ?? 0) : 0;
    };
    // #470: Tow Cables (4 dmg) could kill BOTH the AT-ST and the AT-AT, but the
    // AI hit the weaker AT-ST because it only picked the LEAST-remaining unit.
    // Among units this burst can actually KILL, remove the biggest threat; only
    // fall back to "most-damaged" (closest to a future kill) when none die now.
    const amount = c.amount ?? 0;
    const killable = c.candidates.filter((id) => remaining(id) <= amount);
    const target = killable.length > 0
      ? [...killable].sort((a, b) => threat(b) - threat(a))[0]
      : [...c.candidates].sort((a, b) => remaining(a) - remaining(b))[0];
    return combat.resolveCinematicTargetPick(G, target).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'TractorBeamCapturePick' && G.pendingChoice.side === side) {
    // AI (Empire): capture the highest combined-tactic-value Rebel leader.
    const c = G.pendingChoice;
    const v = (lid: string) => {
      const l = G.catalog.leaders[lid];
      return l ? (l.tacticValues.space + l.tacticValues.ground + l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
    };
    const target = [...c.candidates].sort((a, b) => v(b) - v(a))[0];
    return combat.resolveTractorBeamCapturePick(G, target).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CinematicDestroyPick' && G.pendingChoice.side === side) {
    // AI: destroy the highest-health eligible enemy unit (the one the opponent
    // would most value / be hardest to roll down) — matches the old heuristic's
    // intent of spending the free kill where it hurts most.
    const c = G.pendingChoice;
    const hv = (id: string) => {
      for (const sys of Object.values(G.map.systems)) {
        const u = sys.units?.find((x) => x.instanceId === id);
        if (u) return G.catalog.unitTypes[u.typeId]?.health.value ?? 0;
      }
      return 0;
    };
    const target = [...c.candidates].sort((a, b) => hv(b) - hv(a))[0];
    return combat.resolveCinematicDestroyPick(G, target).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'YodaReroll' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    if (c.context === 'dsplans') {
      // AI: reroll a die toward the direct-hit the DSP roll needs. The offer
      // only fires on a not-yet-successful roll (#540 gate), where every face
      // is an equal dud — take the first candidate. (#186)
      const haveHit = (c.missionFaces ?? []).some((f) => f === 'direct-hit');
      const idx = haveHit ? -1 : (c.blankIndices[0] ?? -1);
      return combat.resolveDsPlansYoda(G, idx).ok;
    }
    if (c.context === 'mission') {
      // AI: always reroll the first blank (it's a free upgrade — same
      // policy as the auto-apply we replaced).
      const idx = c.blankIndices[0] ?? null;
      return phases.resolveYodaMissionReroll(G, idx).ok;
    }
    return handleYodaReroll(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'R2D2Flip' && G.pendingChoice.side === side) {
    // AI Rebel: flip the most valuable Empire die.
    const c = G.pendingChoice;
    const score = (face: string) =>
      face === 'direct-hit' ? 4 : face === 'hit' ? 3 : face === 'special' ? 2 : 0;
    let bestIdx = -1;
    let bestScore = -1;
    // Source the faces from the appropriate context.
    let faces: string[] = [];
    if (c.context === 'combat') {
      const dice = G.pendingCombat?.pendingAttack?.dice ?? [];
      faces = dice.map((d) => d.face);
    } else {
      faces = c.missionFaces ?? [];
    }
    for (const i of c.flippableDieIndices) {
      const s = score(faces[i] ?? 'blank');
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    // AI policy: only spend the once-per-game card if the target is at least
    // a hit (worth 3+). Otherwise save it.
    const flipIndex = bestScore >= 3 ? bestIdx : null;
    if (c.context === 'mission') return phases.resolveR2D2MissionFlip(G, flipIndex).ok;
    return combat.resolveR2D2Flip(G, flipIndex).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'SpecialDieSpend' && G.pendingChoice.side === side) {
    return handleSpecialDieSpend(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatStartActionCards' && G.pendingChoice.side === side) {
    return handleCombatStartActionCards(G);
  }
  // RoE Cinematic tactic selection: pick the AI's best play (or skip).
  if (G.pendingChoice && G.pendingChoice.kind === 'CinematicTacticSelect' && G.pendingChoice.side === side) {
    const c = G.pendingCombat;
    if (!c) return combat.resolveCinematicTacticSelect(G, null, false).ok;
    const pick = pickBestCinematicPlay(G, c, side, G.pendingChoice.theater);
    return combat.resolveCinematicTacticSelect(G, pick?.cardId ?? null, pick?.useTop ?? false).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RogueOneChoice' && G.pendingChoice.side === side) {
    // AI: prefer rescuing a captured leader; otherwise remove a target marker.
    const pc = G.pendingChoice;
    const action = pc.rescuable.length > 0
      ? `rescue:${pc.rescuable[0]}`
      : `marker:${pc.markerSources[0]}`;
    return combat.resolveRogueOneChoice(G, action).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ConfrontationLeaderPick' && G.pendingChoice.side === side) {
    // AI: mark the highest-tactic-value Imperial leader (candidates are already
    // sorted strongest-first) — the most impactful elimination.
    return combat.resolveConfrontationLeaderPick(G, G.pendingChoice.candidates[0]).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CinematicReroll' && G.pendingChoice.side === side) {
    // AI: take the suggested reroll (blanks first, up to the allowance).
    return combat.resolveCinematicReroll(G, [...G.pendingChoice.suggested]).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CinematicHeal' && G.pendingChoice.side === side) {
    // AI: take the suggested ★-spend (most-damaged matching-colour units first).
    return combat.resolveCinematicHeal(G, G.pendingChoice.suggested.map((s) => ({ ...s }))).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CinematicDeferredHeal' && G.pendingChoice.side === side) {
    // AI: take the suggested allocation (save staged ships first, then most-damaged).
    return combat.resolveCinematicDeferredHeal(G, G.pendingChoice.suggested.map((s) => ({ ...s }))).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CombatAddLeaderPick' && G.pendingChoice.side === side) {
    // AI: always add the highest-tactic-value pool leader. Captures are bad
    // but missing the tactic-card draws is worse for a side that has units
    // here but no leader. Future tuning could decline when the combat is
    // unwinnable anyway (e.g. defender vs overwhelming attacker).
    const c = G.pendingChoice;
    let best: { id: string; v: number } | null = null;
    for (const lid of c.candidates) {
      const ld = G.catalog.leaders[lid];
      if (!ld) continue;
      const v = ld.tacticValues.space + ld.tacticValues.ground;
      if (!best || v > best.v) best = { id: lid, v };
    }
    const r = combat.resolveCombatAddLeaderPick(G, best?.id ?? null);
    // Fail-safe: if the chosen leader is somehow rejected, decline (null) so
    // the choice always resolves and the game can't hang here (tournament
    // showed games stuck on this pending choice).
    if (!r.ok && best) return combat.resolveCombatAddLeaderPick(G, null).ok;
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PlanTheAssaultShips' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Pick a transport-valid subset: all capital ships (provide capacity),
    // plus as many restriction-icon fighters as that capacity supports.
    // Sending the raw availableShipIds typically fails validateMoveOrderTransport
    // when fighters outnumber capacity → freeze.
    // Source the units from the recorded container — Rebel Base space while
    // hidden, or the base's system once revealed (#427/#457) — not always
    // rebelBaseSpace (empty after reveal → AI would send 0 ships).
    const srcId = c.sourceSystemId ?? 'rebel-base-space';
    const srcContainer = srcId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[srcId];
    const idToUnit = new Map((srcContainer?.units ?? []).map((u) => [u.instanceId, u]));
    const caps: string[] = [];
    const fighters: string[] = [];
    const others: string[] = [];
    let capacity = 0;
    for (const sid of c.availableShipIds) {
      const u = idToUnit.get(sid);
      if (!u) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      if (t.transport.capacity > 0) { caps.push(sid); capacity += t.transport.capacity; }
      else if (t.transport.restriction) fighters.push(sid);
      else others.push(sid);
    }
    const picked = [...caps, ...others, ...fighters.slice(0, capacity)];
    let r = phases.resolvePlanTheAssaultShips(G, picked);
    // Fallback: if even that fails, try caps + others only.
    if (!r.ok) r = phases.resolvePlanTheAssaultShips(G, [...caps, ...others]);
    // Last resort: just caps (no fighters need transport).
    if (!r.ok) r = phases.resolvePlanTheAssaultShips(G, caps);
    return r.ok;
  }
  // Lead The Strike Team: bring up to 4 of the strongest ground units from the
  // base to the target (then combat resolves). Prefer high ground-combat value
  // + health so the strike actually threatens the Imperial garrison.
  if (G.pendingChoice && G.pendingChoice.kind === 'LeadStrikeTeamUnits' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const rebelBase = G.map.rebelBaseSpace;
    const idToUnit = new Map(rebelBase.units.map((u) => [u.instanceId, u]));
    const unitScore = (uid: string): number => {
      const u = idToUnit.get(uid);
      const t = u && G.catalog.unitTypes[u.typeId];
      if (!t) return 0;
      return ((t.attack?.red ?? 0) + (t.attack?.black ?? 0)) * 2 + (t.health?.value ?? 0);
    };
    // Don't strip the base of all its defenders when it's REVEALED — sortieing
    // every ground unit out leaves the exposed base to be walked into and
    // captured for the win (player report #167). Reserve a garrison: keep at
    // least half the base ground (min 1) home when revealed; when the base is
    // still hidden, the old "send the strongest up to 4" behavior is fine.
    let sendCap = c.max;
    if (G.rebelBaseRevealed) {
      const reserve = Math.max(1, Math.floor(c.availableUnitIds.length / 2));
      sendCap = Math.max(0, Math.min(c.max, c.availableUnitIds.length - reserve));
    }
    const picked = [...c.availableUnitIds].sort((a, b) => unitScore(b) - unitScore(a)).slice(0, sendCap);
    return phases.resolveLeadStrikeTeamUnits(G, picked).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RetreatDecision' && G.pendingChoice.side === side) {
    return handleRetreatDecision(G);
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DeathStarPlansAttempt' && G.pendingChoice.side === side) {
    // AI: always attempt — it's a free shot at destroying the Death Star.
    return combat.resolveDeathStarPlansAttempt(G, true).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PlayObjective' && G.pendingChoice.side === side) {
    // AI: score the highest-reputation eligible objective (only one per
    // refresh / combat). Dispatch by window — refresh vs combat live in
    // different modules.
    const pc = G.pendingChoice;
    // Prefer free objectives; never pay a cost objective's price (#183). If
    // only cost objectives are eligible and the choice allows it, decline.
    const free = pc.legal.filter((id) => !COST_OBJECTIVES.has(id));
    const pool = free.length > 0 ? free : pc.legal;
    const best = [...pool].sort(
      (a, b) => (G.catalog.objectives[b]?.reputation ?? 0) - (G.catalog.objectives[a]?.reputation ?? 0)
    )[0];
    if (free.length === 0 && pc.allowDecline && pc.window === 'refresh') {
      // The Long War exception (#478): "discard 2 other objective cards" for
      // 1 reputation exists precisely for a hand clogged with dead objectives
      // — the Rebel's win track IS reputation. The blanket never-pay rule made
      // it a permanently dead card (the AI declined every refresh while
      // sitting on 6 unscorable objectives). Play it when the hand is big
      // (4+) and holds at least 2 EXPENDABLE cards — condition not currently
      // met and not a Death Star Plans (the hold-anyway card) — so the cost
      // is paid entirely with dead weight. The 'the-long-war-discard'
      // heuristic then picks those same low-value cards to toss.
      if (pc.legal.includes('the-long-war-1')) {
        const hand = G.rebel.objectiveHand ?? [];
        const expendable = hand.filter((id) =>
          id !== 'the-long-war-1'
          && !id.startsWith('death-star-plans')
          && !engineTry(() => objectiveConditionMet(G, id), false));
        if (hand.length >= 4 && expendable.length >= 2) {
          return phases.resolvePlayObjectivePick(G, 'the-long-war-1').ok;
        }
      }
      return phases.resolvePlayObjectivePick(G, '').ok;
    }
    return pc.window === 'combat'
      ? combat.resolveCombatObjectivePick(G, best).ok
      : phases.resolvePlayObjectivePick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RaidOutpostsPlace' && G.pendingChoice.side === side) {
    // AI (Empire forced to place the Rebel's Raid Outposts markers): bury them
    // where Rebel forces can't reach (see chooseRaidOutpostRemotes / #576).
    const pc = G.pendingChoice;
    const picks = chooseRaidOutpostRemotes(G, pc.legal, pc.count);
    return phases.resolveRaidOutpostsPlace(G, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RebelCellPlace' && G.pendingChoice.side === side) {
    // AI: place the marker in the Rebel system with the most Rebel units (the
    // most defensible), so it's likely to still be Rebel-held later.
    const pc = G.pendingChoice;
    const count = (sid: string) => (G.map.systems[sid]?.units ?? []).filter((u) => u.side === 'Rebel').length;
    const best = [...pc.legal].sort((a, b) => count(b) - count(a))[0] ?? pc.legal[0];
    return phases.resolveRebelCellPlace(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RebelCellDiscard' && G.pendingChoice.side === side) {
    // AI: don't burn objectives for 1 reputation by default — decline. (A
    // smarter policy could discard a stuck/low-value objective.)
    return phases.resolveRebelCellDiscard(G, null).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'MoreDangerousTheaterPick' && G.pendingChoice.side === side) {
    // AI: in cinematic combat pick the theater with the fuller DISCARD (that's
    // what MDTYR retrieves from, #449); in base combat the fuller DECK.
    let theater: 'space' | 'ground';
    if (G.pendingCombat?.cinematic) {
      const f = side === 'Rebel' ? G.rebel : G.empire;
      const disc = f.cinematicTacticDiscard ?? [];
      const n = (th: 'space' | 'ground') =>
        disc.filter((cid) => G.catalog.tactics[cid]?.theater === th).length;
      theater = n('ground') >= n('space') ? 'ground' : 'space';
    } else {
      theater = G.groundTacticDeck.length >= G.spaceTacticDeck.length ? 'ground' : 'space';
    }
    return combat.resolveMoreDangerousTheaterPick(G, theater).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'MoreDangerousRetrievePick' && G.pendingChoice.side === side) {
    // AI: retrieve the first N candidates (no per-card ranking available).
    const c = G.pendingChoice;
    return combat.resolveMoreDangerousRetrievePick(G, c.candidates.slice(0, c.count)).ok;
  }
  // Fully Operational: prefer highest-value Rebel ship (capital > fighter).
  if (G.pendingChoice && G.pendingChoice.kind === 'FullyOperationalTargetPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId];
    const rank = (typeId: string) => {
      const cls = G.catalog.unitTypes[typeId]?.class ?? '';
      return cls === 'capital' ? 3 : cls === 'fighter' ? 1 : 2;
    };
    const target = [...c.candidates].sort((a, b) => {
      const ua = ss?.units.find((u) => u.instanceId === a);
      const ub = ss?.units.find((u) => u.instanceId === b);
      return rank(ub?.typeId ?? '') - rank(ua?.typeId ?? '');
    })[0];
    return combat.resolveFullyOperationalTargetPick(G, target).ok;
  }
  // Baze's Loyalty: spend the 2-health budget on the biggest affordable unit
  // first (a capital ship is worth more than two fighters). Re-posts itself
  // until the budget is spent, so one pick per call is fine.
  if (G.pendingChoice && G.pendingChoice.kind === 'BazesLoyaltyTarget' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId];
    const hv = (id: string) => G.catalog.unitTypes[ss?.units.find((u) => u.instanceId === id)?.typeId ?? '']?.health.value ?? 0;
    const target = [...c.candidates].sort((a, b) => hv(b) - hv(a))[0];
    return combat.resolveBazesLoyaltyTarget(G, target).ok;
  }
  // Target the Generator: prefer ion-cannon over shield-generator (denies
  // the Rebel base's "ion-cannon-special" defensive bonus first).
  if (G.pendingChoice && G.pendingChoice.kind === 'TargetTheGeneratorPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId];
    const score = (typeId: string) => typeId === 'ion-cannon' ? 2 : 1;
    const target = [...c.candidates].sort((a, b) => {
      const ua = ss?.units.find((u) => u.instanceId === a);
      const ub = ss?.units.find((u) => u.instanceId === b);
      return score(ub?.typeId ?? '') - score(ua?.typeId ?? '');
    })[0];
    return combat.resolveTargetTheGeneratorPick(G, target).ok;
  }
  // Ready For Action: pick the highest combined-tactic-value leader still in pool.
  if (G.pendingChoice && G.pendingChoice.kind === 'ReadyForActionLeaderPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestV = -1;
    for (const lid of c.candidates) {
      const ldr = G.catalog.leaders[lid];
      if (!ldr) continue;
      const v = ldr.tacticValues.space + ldr.tacticValues.ground;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return combat.resolveReadyForActionLeaderPick(G, best).ok;
  }
  // Assignment-timed action card play: the AI never proactively opens this
  // modal (random Assignment branch just assigns or skips). But if for some
  // reason the choice is posted, cancel out / pick a random candidate-system
  // so we don't deadlock.
  if (G.pendingChoice && G.pendingChoice.kind === 'PlayAssignmentActionCard' && G.pendingChoice.side === side) {
    return phases.cancelAssignmentActionCardPlay(G).ok;
  }
  // False Orders end-of-Assignment window (#293): the AI plays it to disrupt
  // the first lone Imperial assignment (a free tempo hit — return a leader +
  // mission to the Empire). Resolves the choice either way so it can't stall.
  if (G.pendingChoice && G.pendingChoice.kind === 'FalseOrdersWindow' && G.pendingChoice.side === side) {
    const target = G.pendingChoice.candidates[0]?.leaderId ?? null;
    return phases.resolveFalseOrders(G, target).ok;
  }
  // Droid ring attach (R2-D2 / C-3PO). The AI doesn't proactively open this,
  // but resolve it if posted so the game can't deadlock: prefer a leader
  // already on the board (the ring only works in that leader's system).
  if (G.pendingChoice && G.pendingChoice.kind === 'AttachRingPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const onBoard = new Set<string>();
    for (const list of Object.values(G.rebel.leadersOnBoard)) for (const lid of list) onBoard.add(lid);
    const target = c.candidates.find((lid) => onBoard.has(lid)) ?? c.candidates[0];
    if (!target) return phases.cancelAssignmentActionCardPlay(G).ok;
    return phases.resolveAttachRing(G, target).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ActionCardSystemPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const sysId = pick(c.candidates);
    if (!sysId) return false;
    return phases.resolveActionCardSystemPick(G, sysId).ok;
  }

  // RecruitActionCardPick fires during the Refresh phase where
  // G.currentPlayer doesn't match the side that owes the choice (refresh
  // is bilateral). Handle it before the "my turn only" gate so the AI
  // doesn't deadlock when its own recruit pick is queued during Rebel's
  // refresh turn (or vice versa).
  if (G.pendingChoice && G.pendingChoice.kind === 'RecruitActionCardPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const f = side === 'Rebel' ? G.rebel : G.empire;
    const canRecruit = (cid: string) => {
      const card = G.catalog.actions[cid];
      // A card is worth keeping if ANY leader it lists is still recruitable
      // (not already in play anywhere). Multi-leader cards list two.
      return (card?.leaderRequirement ?? []).some((lid) => phases.leaderRecruitable(G, side, lid));
    };
    const recruitable = c.drawnIds.find(canRecruit);
    if (recruitable) return phases.resolveRecruitActionCardPick(G, recruitable).ok;
    // No drawn card recruits anyone. RAW: dig deeper while allowed, so the AI
    // keeps drawing until it can recruit (or the deck runs dry). Only when it
    // genuinely can't recruit does it keep the first card for its action.
    if (c.canDrawMore) return phases.recruitDrawAnother(G).ok;
    return phases.resolveRecruitActionCardPick(G, c.drawnIds[0]).ok;
  }
  // RecruitLeaderPick: a kept multi-leader card (e.g. the Falcon → Han or
  // Chewbacca) offers a choice of which leader to recruit. AI takes the
  // higher-value one (combined skills + tactic value). Bilateral during
  // refresh, so handle regardless of currentPlayer. (#62)
  if (G.pendingChoice && G.pendingChoice.kind === 'RecruitLeaderPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const value = (lid: string): number => {
      const l = G.catalog.leaders[lid];
      if (!l) return -1;
      const sk = l.skills;
      return (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0)
        + l.tacticValues.space + l.tacticValues.ground;
    };
    const best = [...c.candidates].sort((x, y) => value(y) - value(x))[0];
    return phases.resolveRecruitLeaderPick(G, best).ok;
  }
  // BuildPick is also bilateral during refresh — same fix.
  if (G.pendingChoice && G.pendingChoice.kind === 'BuildPick' && G.pendingChoice.side === side) {
    return handleBuildPick(G);
  }
  // HandLimitDiscard (refresh, bilateral): discard the lowest-value missions.
  if (G.pendingChoice && G.pendingChoice.kind === 'HandLimitDiscard' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ranked = [...c.discardable].sort((a, b) =>
      missionBaseValue(a, side) - missionBaseValue(b, side));
    return phases.resolveHandLimitDiscard(G, ranked.slice(0, c.count)).ok;
  }
  // DeployUnitPick is also a bilateral refresh-phase pause.
  if (G.pendingChoice && G.pendingChoice.kind === 'DeployUnitPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Smart deploy: think of units as forming "armies" — capital ships
    // (transport-providers) want to spawn where ground/fighters are
    // stranded; ground/fighters want to spawn where capital-ship
    // capacity is available. Per-system stranded score = max(0,
    // ground+fighters - capital-capacity).
    const t = G.catalog.unitTypes[c.typeId];
    const provides = (t?.transport.capacity ?? 0) > 0;
    const needsTransport = t && (
      t.theater === 'ground' && t.class !== 'structure' ||
      t.transport.restriction
    );
    // A Shield Bunker only earns its icon at the Death Star's system; anywhere
    // else it is an immobile structure doing nothing.
    const bunkerHome = BUILD_SHIELD_BUNKERS && c.typeId === 'shield-bunker'
      ? Object.entries(G.map.systems).find(([, ss]) => ss.units.some((u) => u.side === side
          && (u.typeId === 'death-star-under-construction' || u.typeId === 'death-star')))?.[0]
      : undefined;
    const scoreSystem = (sysId: string): number => {
      if (bunkerHome) return sysId === bunkerHome ? 1000 : -1000;
      const ss = sysId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[sysId];
      if (!ss) return -Infinity;
      let capacity = 0;
      let needs = 0;
      for (const u of ss.units) {
        if (u.side !== side) continue;
        const ut = G.catalog.unitTypes[u.typeId];
        if (!ut) continue;
        if (ut.transport.capacity > 0) capacity += ut.transport.capacity;
        else if (ut.theater === 'ground' && ut.class !== 'structure') needs++;
        else if (ut.transport.restriction) needs++;
      }
      const stranded = Math.max(0, needs - capacity);
      const spareCapacity = Math.max(0, capacity - needs);
      if (provides) {
        // Transport ship: place where most stranded units await pickup.
        // Tiebreak: prefer systems with own units already (build the army).
        return stranded * 4 + (ss.units.some((u) => u.side === side) ? 1 : 0);
      }
      if (needsTransport) {
        // Ground or restriction-fighter: place where there's spare
        // capacity (the new unit will fit on existing transports).
        // If nowhere has spare capacity, prefer the system with the
        // FEWEST stranded so we don't pile up more orphans.
        return spareCapacity * 4 - (stranded > 0 ? stranded : 0);
      }
      // Other (shouldn't really hit) — prefer own-unit systems.
      return ss.units.some((u) => u.side === side) ? 1 : 0;
    };
    // Ties broken at random, not by catalog position — new units were otherwise
    // funnelled into the same early-alphabet systems every build.
    // Strike-fleet plan (#539): once the base is revealed, pull the strongest
    // ground (ATAT) and capital ships (SD/SSD) toward base-adjacent systems
    // with transport, per the Empire's massing doctrine. Env-gated; 0 when off.
    const bestDeploy = argmaxTie(G, c.candidates, (sysId) => sysId, (sysId) => scoreSystem(sysId)
      + (side === 'Empire' ? deployProximityScore(G, sysId, c.typeId) : 0));
    return phases.resolveDeployUnitPick(G, bestDeploy?.item ?? c.candidates[0]).ok;
  }
  // Plant False Lead: AI Rebel buries all taken probe cards on the bottom of
  // the deck (denies the Empire that ruled-out intel for the longest).
  if (G.pendingChoice && G.pendingChoice.kind === 'PlantFalseLeadPlacement' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const placements = c.cards.map((cid) => ({ cardId: cid, position: 'bottom' as const }));
    return phases.resolvePlantFalseLeadPlacement(G, placements).ok;
  }
  // Under the Radar reorder: AI Rebel buries the un-kept peeked probes on the
  // bottom (same logic as Plant False Lead — deny the Empire that search intel).
  if (G.pendingChoice && G.pendingChoice.kind === 'UnderTheRadarReorder' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const placements = c.cards.map((cid) => ({ cardId: cid, position: 'bottom' as const }));
    return phases.resolveUnderTheRadarReorder(G, placements).ok;
  }
  // Detained: Empire picks any Rebel leader at the target.
  if (G.pendingChoice && G.pendingChoice.kind === 'DetainedTargetPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveDetainedTargetPick(G, c.candidates[0]).ok;
  }
  // Retrieve The Plans: Empire bottoms the highest-rep Rebel objective.
  if (G.pendingChoice && G.pendingChoice.kind === 'RetrieveThePlansPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Death Star Plans first, whenever the Empire has something for it to blow
    // up. Ranking purely by printed reputation missed it (#662): the Plans are
    // worth 2, which TIES with Heart of the Empire / Return of the Jedi /
    // Uprising, and this loop only replaced on strictly-greater — so a tie kept
    // whichever card came first and left the Plans in the Rebel's hand.
    // Reputation understates them anyway: they don't merely score 2, they can
    // destroy the Death Star outright.
    const vulnerable = Object.values(G.map.systems).some((ss) => ss.units.some(
      (u) => u.side === 'Empire'
        && (u.typeId === 'death-star' || u.typeId === 'death-star-under-construction')));
    const plans = vulnerable ? c.candidates.find((oid) => oid.startsWith('death-star-plans')) : undefined;
    let best = plans ?? c.candidates[0];
    if (!plans) {
      let bestRep = G.catalog.objectives[best]?.reputation ?? 0;
      for (const oid of c.candidates.slice(1)) {
        const r = G.catalog.objectives[oid]?.reputation ?? 0;
        if (r > bestRep) { best = oid; bestRep = r; }
      }
    }
    return phases.resolveRetrieveThePlansPick(G, best).ok;
  }
  // One In A Million: set up to 2 worst dice to direct-hit (always good for Rebel).
  if (G.pendingChoice && G.pendingChoice.kind === 'OneInAMillionOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Rank: blanks worst (0), specials (1), hits (2), direct-hits (3).
    const rank = (f: string) => f === 'blank' ? 0 : f === 'special' ? 1 : f === 'hit' ? 2 : 3;
    const indexed = c.faces.map((f, i) => ({ i, r: rank(f) }))
      .sort((a, b) => a.r - b.r);
    if (c.context === 'dsplans') {
      // DSP needs exactly one direct-hit to succeed — set a single worst die
      // to direct-hit (and spend the card) only if there isn't one already.
      const haveHit = c.faces.some((f) => f === 'direct-hit');
      const picks = haveHit ? [] : [{ index: indexed[0].i, face: 'direct-hit' }];
      return combat.resolveDsPlansOneInAMillion(G, picks).ok;
    }
    if (c.preRoll && c.context === 'mission') {
      // PRE-ROLL mission (#743): unrolled dice, so the decision is blind. A
      // one-shot card is worth spending on a thin roll — with 2 dice or fewer
      // two placed direct-hits turn a coin flip into a near-certain success.
      // On a fat pool the roll is likely to win anyway; keep the card.
      const n = Math.min(2, c.colors.length);
      const picks = c.rebelRoleInRoll === 'attacker' && c.colors.length <= 2
        ? Array.from({ length: n }, (_, i) => ({ index: i, face: 'direct-hit' }))
        : [];
      return phases.resolveOneInAMillionMission(G, picks).ok;
    }
    if (c.preRoll) {
      // PRE-ROLL (#564): the dice are unrolled, so ranking faces is meaningless.
      // Blind, the card is worth its most on the roll that matters most —
      // attacking a Death Star, where two placed direct-hits are the difference
      // between chipping it and killing it. Anywhere else, keep the one-time
      // card for that moment.
      const sysId = G.pendingCombat?.systemId;
      const dsHere = !!sysId && (G.map.systems[sysId]?.units ?? []).some((u) =>
        u.side === 'Empire' && (u.typeId === 'death-star' || u.typeId === 'death-star-under-construction'));
      const n = Math.min(2, c.colors.length);
      const picks = dsHere ? Array.from({ length: n }, (_, i) => ({ index: i, face: 'direct-hit' })) : [];
      return combat.resolveOneInAMillionCombat(G, picks).ok;
    }
    const picks = indexed.slice(0, Math.min(2, indexed.length))
      .filter((x) => x.r < 3) // don't bother overriding direct-hits
      .map((x) => ({ index: x.i, face: 'direct-hit' }));
    if (c.context === 'combat') {
      return combat.resolveOneInAMillionCombat(G, picks).ok;
    }
    return phases.resolveOneInAMillionMission(G, picks).ok;
  }
  // Noble Sacrifice: always accept (+1 reputation, Obi out of capture).
  if (G.pendingChoice && G.pendingChoice.kind === 'NobleSacrificeOffer' && G.pendingChoice.side === side) {
    return phases.resolveNobleSacrificeOffer(G, true).ok;
  }
  // It Is Your Destiny: always capture highest-value rescuer.
  if (G.pendingChoice && G.pendingChoice.kind === 'ItIsYourDestinyOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestScore = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      if (!l) continue;
      const sk = l.skills;
      const score = (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0);
      if (score > bestScore) { best = lid; bestScore = score; }
    }
    return phases.resolveItIsYourDestinyOffer(G, best).ok;
  }
  // Undercover: always relocate the first available candidate.
  if (G.pendingChoice && G.pendingChoice.kind === 'UndercoverOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveUndercoverOffer(G, c.candidates[0] ?? null).ok;
  }
  // Son of Skywalker offer: always pull a mission (free card).
  if (G.pendingChoice && G.pendingChoice.kind === 'SonOfSkywalkerOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveSonOfSkywalkerOffer(G, c.candidates[0] ?? null).ok;
  }
  // Track Them (RoE): always pull the highest-skill leader home (strict
  // improvement — getting a leader off the board frees them for missions).
  if (G.pendingChoice && G.pendingChoice.kind === 'TrackThemOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestScore = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      if (!l) continue;
      const sk = l.skills;
      const score = (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0);
      if (score > bestScore) { best = lid; bestScore = score; }
    }
    return combat.resolveTrackThemOffer(G, best ?? null).ok;
  }
  // Something to Fight For (RoE): always recycle the highest-rep objective
  // (best value for the discard).
  if (G.pendingChoice && G.pendingChoice.kind === 'SomethingToFightForOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestRep = -1;
    for (const oid of c.candidates) {
      const o = G.catalog.objectives[oid];
      if (!o) continue;
      if (o.reputation > bestRep) { best = oid; bestRep = o.reputation; }
    }
    return combat.resolveSomethingToFightForOffer(G, best ?? null).ok;
  }
  // Post Bounty (RoE): always bounty the highest-major-skill Rebel leader
  // who attempted the failed mission — they're the highest-value catch.
  if (G.pendingChoice && G.pendingChoice.kind === 'PostBountyOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestScore = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      if (!l) continue;
      const sk = l.skills;
      const score = (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0);
      if (score > bestScore) { best = lid; bestScore = score; }
    }
    return phases.resolvePostBountyOffer(G, best ?? null).ok;
  }
  // Ambitions of Power (RoE): always accept. The card costs an action card
  // but saves a leader from elimination, which is strictly better
  // mid-game (action cards refresh; eliminated leaders don't).
  if (G.pendingChoice && G.pendingChoice.kind === 'AmbitionsOfPowerOffer' && G.pendingChoice.side === side) {
    return phases.resolveAmbitionsOfPowerOffer(G, true).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'LeaderPoolEliminate' && G.pendingChoice.side === side) {
    // RoE leader-pool cap: eliminate the LOWEST-value leader (keep the best 8).
    // Value = combined tactic values + total skill icons (major + minor).
    const value = (lid: string): number => {
      const l = G.catalog.leaders[lid];
      if (!l) return 0;
      const tac = (l.tacticValues?.space ?? 0) + (l.tacticValues?.ground ?? 0);
      const sk = Object.values(l.skills ?? {}).reduce((a, b) => a + (b ?? 0), 0);
      const minor = Object.values(l.minorSkills ?? {}).reduce((a, b) => a + (b ?? 0), 0);
      return tac + sk + minor;
    };
    const worst = [...G.pendingChoice.candidates].sort((a, b) => value(a) - value(b))[0];
    return phases.resolveLeaderPoolEliminate(G, worst).ok;
  }
  // Early Promotion / Rebel Extremist branch (RoE): take the recruit
  // branch — a new leader (Motti / Saw) in the pool is generally stronger
  // than a random starting action card.
  if (G.pendingChoice && G.pendingChoice.kind === 'StartingCardBranch' && G.pendingChoice.side === side) {
    return phases.resolveStartingCardBranch(G, 'recruit').ok;
  }
  // Under the Radar keep (Rebel/RoE): hold the FIRST peeked probe. Ideally
  // the AI would hold a probe pointing at a system near its base to keep it
  // out of the Empire's reach, but it doesn't reason about its own base
  // here; first card is a safe default.
  if (G.pendingChoice && G.pendingChoice.kind === 'UnderTheRadarKeep' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveUnderTheRadarKeep(G, c.candidates[0]).ok;
  }
  // Under the Radar return (Rebel/RoE): keep holding the probe (decline the
  // return) — holding a probe out of the Empire's deck is the whole point.
  if (G.pendingChoice && G.pendingChoice.kind === 'UnderTheRadarReturn' && G.pendingChoice.side === side) {
    return phases.resolveUnderTheRadarReturn(G, false).ok;
  }
  // Heist (Rebel/RoE): if the draw-objective branch is available (DS/DSUC
  // present), take it — a free objective card is strictly stronger than
  // removing one Imperial marker. Otherwise remove the first marker.
  if (G.pendingChoice && G.pendingChoice.kind === 'HeistChoice' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    if (c.canDrawObjective) return phases.resolveHeistChoice(G, 'draw').ok;
    return phases.resolveHeistChoice(G, `remove:${c.markerSources[0]}`).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'EstablishTradeChoice' && G.pendingChoice.side === side) {
    // AI Rebel: take the Mon Calamari Cruiser (a strong ship beats 2 loyalty).
    return phases.resolveEstablishTradeChoice(G, 'cruiser').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'SabotageChoice' && G.pendingChoice.side === side) {
    // AI Rebel: destroy the Shield Bunker — it shields the Death Star/DSUC and
    // grants combat advantages, so removing it beats a build/deploy marker.
    return phases.resolveSabotageChoice(G, 'destroy-bunker').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RescuerReturn' && G.pendingChoice.side === side) {
    // AI Rebel: pull the rescuing leaders back to the safety of the base rather
    // than leaving them exposed at the (Imperial-held) rescue system.
    return phases.resolveRescuerReturn(G, [...G.pendingChoice.leaderIds]).ok;
  }
  // Discredit Rebellion (RoE): heuristic — always prefer the ROLL branch.
  // Sabotage markers are a strategic asset (they cripple Imperial systems
  // every refresh); a single rep loss on a 1/3 or so chance is the better
  // trade. Closer to optimal would be: roll if many markers, remove if 1
  // marker AND Motti is assigned (2-dice ~5/9 chance of losing rep).
  if (G.pendingChoice && G.pendingChoice.kind === 'DiscreditRebellionChoice' && G.pendingChoice.side === side) {
    return phases.resolveDiscreditRebellion(G, 'roll').ok;
  }
  // Secret Mission (RoE): always pick the first remaining mission. A
  // smarter AI would prefer high-information / high-impact missions
  // (starting missions, no-leader-requirement); the MVP keeps it simple.
  if (G.pendingChoice && G.pendingChoice.kind === 'SecretMissionPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    if (c.remaining.length === 0) return false; // safety
    return phases.resolveSecretMissionPick(G, c.remaining[0]).ok;
  }
  // Reconnaissance (RoE): grab the first discarded mission. A smarter AI
  // would prefer high-value missions (starting cards, no-leader-required
  // resolves); MVP keeps it simple.
  if (G.pendingChoice && G.pendingChoice.kind === 'ReconnaissancePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveReconnaissancePick(G, c.candidates[0]).ok;
  }
  // Draw Them Out (Empire/RoE): pull the highest-major-skill Rebel leader
  // out of their pool — disrupting their best mission-runner is the
  // strongest play.
  if (G.pendingChoice && G.pendingChoice.kind === 'DrawThemOutPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestScore = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      if (!l) continue;
      const sk = l.skills;
      const score = (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0);
      if (score > bestScore) { best = lid; bestScore = score; }
    }
    return phases.resolveDrawThemOutPick(G, best ?? c.candidates[0]).ok;
  }
  // Regional Aid (Rebel/RoE): pick the first eligible "elsewhere" system
  // for the second loyalty marker. A smarter AI would prefer a contested
  // or Imperial-loyal system; MVP keeps it simple.
  if (G.pendingChoice && G.pendingChoice.kind === 'RegionalAidPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Regional Aid's second loyalty gain — was blindly candidates[0], frequently
    // an already-Rebel system, wasting the loyalty (ai-divergence loyalty-wasted
    // gap). Prefer flipping an Imperial system (denies the Empire), then a
    // neutral (straight gain); never an already-Rebel one.
    const aidScore = (sid: string): number => {
      const ss = G.map.systems[sid];
      const res = G.catalog.systems[sid]?.resources?.length ?? 0;
      if (!ss) return -100;
      if (ss.loyalty === 'rebel' && !ss.subjugated) return -100; // wasted
      if (ss.loyalty === 'imperial') return 20 + res;            // flip = deny Empire
      return 10 + res;                                            // neutral gain
    };
    const best = [...c.candidates].sort((a, b) => aidScore(b) - aidScore(a))[0];
    return phases.resolveRegionalAidPick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DestroyedSystemCull' && G.pendingChoice.side === side) {
    // Superlaser overflow (#286): keep the most valuable ground, destroy the
    // cheapest (square < circle < triangle), matching the old auto-cull order.
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId];
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const sorted = [...c.candidates].sort((a, b) => {
      const ua = ss?.units.find((x) => x.instanceId === a);
      const ub = ss?.units.find((x) => x.instanceId === b);
      const ra = tierRank[G.catalog.unitTypes[ua?.typeId ?? '']?.tier ?? 'triangle'] ?? 0;
      const rb = tierRank[G.catalog.unitTypes[ub?.typeId ?? '']?.tier ?? 'triangle'] ?? 0;
      return ra - rb; // cheapest (lowest tier rank) first
    });
    return phases.resolveDestroyedSystemCull(G, sorted.slice(0, c.destroyCount)).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'SuperlaserLoyaltyPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Prefer flipping a Rebel-loyal (or subjugated-rebel) system; else the first.
    const best = c.candidates.find((sid) => {
      const ss = G.map.systems[sid];
      return ss?.loyalty === 'rebel';
    }) ?? c.candidates[0];
    return phases.resolveSuperlaserLoyaltyPick(G, best).ok;
  }
  // Break Their Will (Empire/RoE): name a populous, non-ruled-out system —
  // an unchecked region is the most informative probe. Falls back to the
  // first candidate if everything's been ruled out.
  if (G.pendingChoice && G.pendingChoice.kind === 'BreakTheirWillPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ruledOut = new Set(G.empireSearchedRuledOut ?? []);
    const fresh = c.candidates.find((sid) => {
      const s = G.catalog.systems[sid];
      return s && !s.isRemote && !ruledOut.has(sid);
    });
    return phases.resolveBreakTheirWillPick(G, fresh ?? c.candidates[0]).ok;
  }
  // Behind Enemy Lines (Rebel/RoE): send the strongest `max` units (highest
  // combined attack) into the assault. A simple proxy: sort by total attack
  // dice and take the top `max`.
  if (G.pendingChoice && G.pendingChoice.kind === 'BehindEnemyLinesUnits' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Behind Enemy Lines waives leaders/adjacency but NOT transport (#281): ground
    // and restriction-icon fighters still need carrier capacity from the moved
    // ships. A naive "highest-attack" pick can exceed capacity and the resolver
    // rejects it, stalling the AI (#314 follow-up). Build a TRANSPORT-VALID set:
    // take carriers first, then free units, then needy units within capacity.
    const container = c.sourceSystemId === 'rebel-base-space'
      ? G.map.rebelBaseSpace : G.map.systems[c.sourceSystemId];
    const avail = c.availableUnitIds.map((uid) => {
      const u = container?.units.find((x) => x.instanceId === uid);
      const t = u ? G.catalog.unitTypes[u.typeId] : undefined;
      const cap = t?.transport.capacity ?? 0;
      const needs = t && (t.transport.restriction || (t.theater === 'ground' && t.class !== 'structure')) ? 1 : 0;
      const atk = t ? (t.attack.red + t.attack.black + t.attack.green) : 0;
      return { uid, cap, needs, atk };
    });
    const pick: string[] = [];
    let capSum = 0, needSum = 0;
    for (const x of avail.filter((a) => a.cap > 0).sort((a, b) => b.cap - a.cap)) {
      if (pick.length >= c.max) break;
      pick.push(x.uid); capSum += x.cap;
    }
    for (const x of avail.filter((a) => a.cap === 0 && a.needs === 0).sort((a, b) => b.atk - a.atk)) {
      if (pick.length >= c.max) break;
      pick.push(x.uid);
    }
    for (const x of avail.filter((a) => a.cap === 0 && a.needs > 0).sort((a, b) => b.atk - a.atk)) {
      if (pick.length >= c.max || needSum + x.needs > capSum) continue;
      pick.push(x.uid); needSum += x.needs;
    }
    return phases.resolveBehindEnemyLinesUnits(G, pick).ok;
  }
  // We're the Bait (Empire/RoE): drag as many Rebel ground units as the
  // 4-health budget allows — smallest-health-first maximizes the count of
  // Rebel units yanked out of their base into the kill zone.
  if (G.pendingChoice && G.pendingChoice.kind === 'WereTheBaitUnits' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const container = c.sourceSystemId === 'rebel-base-space'
      ? G.map.rebelBaseSpace : G.map.systems[c.sourceSystemId];
    const scored = c.availableUnitIds.map((uid) => {
      const u = container?.units.find((x) => x.instanceId === uid);
      const h = u ? (G.catalog.unitTypes[u.typeId]?.health.value ?? 0) : 99;
      return { uid, h };
    }).sort((a, b) => a.h - b.h);
    let budget = c.healthBudget;
    const pick: string[] = [];
    for (const s of scored) {
      if (s.h > 0 && s.h <= budget) { pick.push(s.uid); budget -= s.h; }
    }
    return phases.resolveWereTheBaitUnits(G, pick).ok;
  }
  // Imperial Might (Empire/RoE): deploy the strongest `max` queued units
  // (highest combined attack) into the target.
  if (G.pendingChoice && G.pendingChoice.kind === 'ImperialMightUnits' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const scored = c.queueTypeIds.map((typeId, i) => {
      const t = G.catalog.unitTypes[typeId];
      const atk = t ? (t.attack.red + t.attack.black + t.attack.green) : 0;
      return { i, atk };
    }).sort((a, b) => b.atk - a.atk);
    const pick = scored.slice(0, c.max).map((s) => s.i);
    return phases.resolveImperialMightUnits(G, pick).ok;
  }
  // MissionRecruitLeaderPick (RoE): pick the highest-tactic-total leader
  // (Hire Mercenaries / Imperial Promotion / Rebel Promotion / My Only
  // Hope). For Hire Mercenaries the candidates are no-tactic-value
  // leaders, so this falls back to first-in-list by tie.
  if (G.pendingChoice && G.pendingChoice.kind === 'MissionRecruitLeaderPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestScore = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      if (!l) continue;
      const score = (l.tacticValues.space ?? 0) + (l.tacticValues.ground ?? 0);
      if (score > bestScore) { best = lid; bestScore = score; }
    }
    return phases.resolveMissionRecruitLeaderPick(G, best ?? c.candidates[0]).ok;
  }
  // PlayImmediateActionCard (RoE): the AI never PROACTIVELY opens this
  // modal (no requestImmediateActionCardPlay call in the AI driver yet),
  // but if it somehow gets posted to it, just pick the first candidate.
  // Most Immediate cards are strict upsides for the playing side.
  if (G.pendingChoice && G.pendingChoice.kind === 'PlayImmediateActionCard' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    if (c.candidates.length === 0) return phases.cancelImmediateActionCardPlay(G).ok;
    return phases.playImmediateActionCard(G, c.candidates[0]).ok;
  }
  // ArmCardProbePick (RoE Secret Facility / Sweep the Area): auto-pick the
  // first probe in hand. A smarter AI would target a system with a Rebel
  // leader for Sweep / a low-defended remote for Secret Facility, but the
  // MVP just commits to the first probe so the card resolves.
  if (G.pendingChoice && G.pendingChoice.kind === 'ArmCardProbePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveArmCardProbePick(G, c.candidates[0]).ok;
  }
  // Secret Facility triangle-unit pick (#396): prefer the AT (Assault Tank) when
  // available — sturdier ground — else the Stormtrooper.
  if (G.pendingChoice && G.pendingChoice.kind === 'SecretFacilityUnitPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const pick = c.candidates.includes('assault-tank') ? 'assault-tank' : c.candidates[0];
    return phases.resolveSecretFacilityUnitPick(G, pick).ok;
  }
  // Armed-card "you may reveal" offer (#396). Secret Facility is pure upside →
  // always reveal. Sweep the Area only pays off if a Rebel leader is in the
  // system to capture; otherwise decline and keep it armed for a better moment.
  if (G.pendingChoice && G.pendingChoice.kind === 'ArmedCardRevealOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const reveal = c.cardId === 'sweep-the-area'
      ? (G.rebel.leadersOnBoard[c.systemId] ?? []).length > 0
      : true;
    return phases.resolveArmedCardRevealOffer(G, reveal).ok;
  }
  // Blindside: always accept (denies pool opposition; clear upside).
  if (G.pendingChoice && G.pendingChoice.kind === 'BlindsideOffer' && G.pendingChoice.side === side) {
    return phases.resolveBlindsideOffer(G, true).ok;
  }
  // Wookie Guardian: always accept (auto-fails Empire specOps).
  if (G.pendingChoice && G.pendingChoice.kind === 'WookieGuardianOffer' && G.pendingChoice.side === side) {
    return phases.resolveWookieGuardianOffer(G, true).ok;
  }
  // C-3PO offer: always accept (converts failure → success; no downside).
  if (G.pendingChoice && G.pendingChoice.kind === 'C3POOffer' && G.pendingChoice.side === side) {
    return phases.resolveC3POOffer(G, true).ok;
  }
  // Falcon offer: always rescue the highest-value captured leader.
  if (G.pendingChoice && G.pendingChoice.kind === 'FalconOffer' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Pick whichever has the highest combined skill total — a rough proxy.
    let best = c.candidates[0];
    let bestScore = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      if (!l) continue;
      const sk = l.skills;
      const score = (sk.diplomacy ?? 0) + (sk.intel ?? 0) + (sk.specOps ?? 0) + (sk.logistics ?? 0);
      if (score > bestScore) { best = lid; bestScore = score; }
    }
    return phases.resolveFalconOffer(G, best).ok;
  }
  // Brilliant Administrator: default to highest-tier-legal per icon (mirror of TA AI).
  if (G.pendingChoice && G.pendingChoice.kind === 'BrilliantAdministratorBuildPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const pickDefault = (icon: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }): string | null => {
      const need = tierRank[icon.shape] ?? 2;
      const legal = Object.values(G.catalog.unitTypes)
        .filter((t) => t.side === 'Empire' && t.theater === icon.theater
          && (tierRank[t.tier ?? 'square'] ?? 2) <= need && t.class !== 'structure'
          // RoE units only buildable with the expansion's unit toggle on (#219).
          && (t.set !== 'rote' || G.expansion?.roeUnits === true))
        .map((t) => t.id);
      return legal[legal.length - 1] ?? null;
    };
    return phases.resolveBrilliantAdministratorBuildPick(G, c.icons.map(pickDefault)).ok;
  }
  // Catch Them By Surprise: pick first source, move all Empire units there
  // that can travel (greedy-pack).
  if (G.pendingChoice && G.pendingChoice.kind === 'CatchThemBySurpriseMovePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Card allows pulling from ALL adjacent sources (#548) — greedy-pack every
    // candidate system into its own transport-legal order (same heuristic the
    // activation executor uses: all capitals, then riders up to capacity).
    const orders: { fromSystemId: SystemId; unitInstanceIds: string[] }[] = [];
    for (const src of c.candidateSourceSystemIds) {
      const units = G.map.systems[src].units.filter((u) => u.side === 'Empire');
      const capShipIds: string[] = [];
      const fighterIds: string[] = [];
      const groundIds: string[] = [];
      for (const u of units) {
        const t = G.catalog.unitTypes[u.typeId];
        if (!t || t.transport.immobile) continue;
        if (t.transport.capacity > 0) capShipIds.push(u.instanceId);
        else if (t.transport.restriction) fighterIds.push(u.instanceId);
        else if (t.theater === 'ground' && t.class !== 'structure') groundIds.push(u.instanceId);
      }
      let cap = capShipIds.reduce((s, uid) => {
        const u = units.find((x) => x.instanceId === uid);
        return s + (u ? (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) : 0);
      }, 0);
      const picks = [...capShipIds];
      for (const uid of [...fighterIds, ...groundIds]) {
        if (cap <= 0) break;
        picks.push(uid); cap--;
      }
      if (picks.length > 0) orders.push({ fromSystemId: src, unitInstanceIds: picks });
    }
    return phases.resolveCatchThemBySurpriseMovePick(G, orders).ok;
  }
  // Scouting Mission: relocate up to 4 TIEs from candidates.
  if (G.pendingChoice && G.pendingChoice.kind === 'ScoutingMissionTIEPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveScoutingMissionTIEPick(G, c.candidateUnitIds.slice(0, c.maxPicks)).ok;
  }
  // Our Most Desperate Hour: pick a random mission from the deck.
  if (G.pendingChoice && G.pendingChoice.kind === 'OurMostDesperateHourPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveOurMostDesperateHourPick(G, c.candidates[0]).ok;
  }
  // Proceeding As Planned: pick a random project from the deck.
  if (G.pendingChoice && G.pendingChoice.kind === 'ProceedingAsPlannedPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveProceedingAsPlannedPick(G, c.candidates[0]).ok;
  }
  // Second-leader offer after OMDH / Proceeding As Planned (#309): decline —
  // keep the leader free for its own action rather than doubling up.
  if (G.pendingChoice && G.pendingChoice.kind === 'AssignSecondLeaderPick' && G.pendingChoice.side === side) {
    return phases.resolveAssignSecondLeader(G, null).ok;
  }
  // Start The Evacuation: pick the first non-Imperial system, move all
  // mobile Rebel Base units that fit.
  if (G.pendingChoice && G.pendingChoice.kind === 'StartEvacuationPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const target = c.candidateSystemIds[0];
    if (!target) return phases.resolveStartEvacuationPick(G, '', []).ok;
    // Greedy pack like Hidden Fleet: self-moving ships (every space ship without
    // a transport-restriction icon — capital ships AND restriction-free fighters
    // like the Rebel X-/Y-wing) always move; restriction fighters + ground ride
    // along up to carrier capacity. Bucketing self-movers off capacity>0 alone
    // stranded X-/Y-wings (same defect as #589/#590's Hidden Fleet resolver).
    const baseUnits = G.map.rebelBaseSpace.units.filter((u) => c.candidateUnitIds.includes(u.instanceId));
    const selfMovingIds: string[] = [];
    const riderIds: string[] = [];
    let cap = 0;
    for (const u of baseUnits) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t || t.transport.immobile || t.class === 'structure') continue;
      if (t.theater === 'space' && !t.transport.restriction) {
        selfMovingIds.push(u.instanceId);
        cap += t.transport.capacity;
      } else {
        riderIds.push(u.instanceId);
      }
    }
    const picks = [...selfMovingIds];
    for (const uid of riderIds) {
      if (cap <= 0) break;
      picks.push(uid); cap--;
    }
    return phases.resolveStartEvacuationPick(G, target, picks).ok;
  }
  // Independent Operation: Empire picks first Imperial system to retreat to.
  if (G.pendingChoice && G.pendingChoice.kind === 'IndependentOperationEvacPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveIndependentOperationEvacPick(G, c.candidateSystemIds[0]).ok;
  }
  // Hidden Fleet: greedy-pack capital ships first, then fighters/ground
  // up to capacity. Mirrors the old engine auto-pick heuristic.
  if (G.pendingChoice && G.pendingChoice.kind === 'HiddenFleetUnitPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const baseUnits = G.map.rebelBaseSpace.units.filter((u) => c.candidateUnitIds.includes(u.instanceId));
    // Hidden Fleet obeys transport capacity (RR: "he must obey transport
    // capacity and cannot move immobile units"). Split candidates into units
    // that move on their OWN — every space ship without a transport-restriction
    // icon: capital ships AND restriction-free fighters like the Rebel X-/Y-wing
    // (capacity 0, restriction false) — and RIDERS (restriction fighters +
    // ground) that need a co-moving carrier's capacity. The old split keyed
    // self-movers off capacity > 0, so restriction-free fighters fell through
    // all three buckets and were never picked — the AI ran Hidden Fleet on a
    // base of X-wings and moved nothing (#589/#590).
    const selfMovingIds: string[] = [];
    const riderIds: string[] = [];
    let capacity = 0;
    for (const u of baseUnits) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t || t.transport.immobile || t.class === 'structure') continue;
      if (t.theater === 'space' && !t.transport.restriction) {
        selfMovingIds.push(u.instanceId);
        capacity += t.transport.capacity;
      } else {
        riderIds.push(u.instanceId);
      }
    }
    const picks = [...selfMovingIds];
    for (const uid of riderIds) {
      if (capacity <= 0) break;
      picks.push(uid); capacity--;
    }
    return phases.resolveHiddenFleetUnitPick(G, picks).ok;
  }
  // Temporary Alliance: default unit per icon (lowest-tier matching).
  if (G.pendingChoice && G.pendingChoice.kind === 'TemporaryAllianceBuildPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const pickDefault = (icon: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }): string | null => {
      if (icon.theater === 'space') {
        if (icon.shape === 'triangle') return 'x-wing';
        if (icon.shape === 'circle') return 'corellian-corvette';
        return 'mc-cruiser';
      }
      if (icon.shape === 'triangle') return 'rebel-trooper';
      // No square ground unit for Rebel — fall back to airspeeder.
      return 'airspeeder';
    };
    const picks = c.icons.map(pickDefault);
    return phases.resolveTemporaryAllianceBuildPick(G, picks).ok;
  }
  // Build-from-icons (Construct Factory / Address Delays / Establish Trade
  // Relations): pick the strongest legal unit per icon (highest tier <= icon
  // shape, matching side+theater, non-structure). Catalog-driven so it works
  // for both sides.
  if (G.pendingChoice && G.pendingChoice.kind === 'BuildFromIconsPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    // The engine requires an EXACT tier match (a resource icon builds a unit of
    // THAT size — phases.ts resolveBuildFromIconsPick) and rejects out-of-supply
    // or project-only types. The old picker used `tier <= need` and ignored
    // supply, so a triangle icon whose only exact-tier unit (e.g. TIE Fighter) is
    // out of supply, or a square icon that landed on a project-only Star Destroyer
    // variant, made the WHOLE submission invalid — and the fail-safe then nulled
    // EVERY icon, so the Empire built nothing even when a valid unit was available
    // on another icon (player report #461). Now each icon is filled independently
    // with a valid, in-supply, exact-tier combat unit, tracking supply consumed by
    // earlier picks so two icons of the same shape can't both claim the last mini.
    const consumed = new Map<string, number>();
    const threatOf = (t: (typeof G.catalog.unitTypes)[string]) =>
      (t.attack?.red ?? 0) + (t.attack?.black ?? 0) + (t.attack?.green ?? 0) + (t.health?.value ?? 0);
    const picks = c.icons.map((icon) => {
      const need = tierRank[icon.shape] ?? 2;
      const opts = Object.values(G.catalog.unitTypes)
        .filter((t) => t.side === side && t.theater === icon.theater
          && t.class !== 'structure'
          && (tierRank[t.tier ?? 'square'] ?? 2) === need   // EXACT tier, per engine
          && !PROJECT_ONLY_UNIT_IDS.has(t.id)               // SSD/Death Star/Interdictor never icon-build
          // RoE units only buildable with the expansion's unit toggle on (#219).
          && (t.set !== 'rote' || G.expansion?.roeUnits === true)
          // Must have supply left after earlier picks in THIS submission.
          && (consumed.get(t.id) ?? 0) < unitsAvailableInSupply(G, t.id))
        .sort((a, b) => threatOf(b) - threatOf(a)); // best combat unit first
      const chosen = opts.length > 0 ? opts[0] : null;
      if (chosen) consumed.set(chosen.id, (consumed.get(chosen.id) ?? 0) + 1);
      return chosen?.id ?? null;
    });
    let r = phases.resolveBuildFromIconsPick(G, picks);
    // Fail-safe: if some pick is still rejected for a reason we didn't model,
    // fall back to all-null (always accepted) so the choice can't soft-lock.
    if (!r.ok) r = phases.resolveBuildFromIconsPick(G, c.icons.map(() => null));
    return r.ok;
  }
  // Contingency Plan: pick a random starting mission from the candidates.
  if (G.pendingChoice && G.pendingChoice.kind === 'ContingencyPlanPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveContingencyPlanPick(G, c.candidates[0]).ok;
  }
  // Rapid Mobilization branch: if the base is in danger (revealed, or Empire
  // units closing in), RELOCATE it (establish-base) to escape. If it's still
  // safe and hidden, just reinforce it (move-units). Previously always chose
  // establish-base, which relocated even a safe base for no reason.
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationBranch' && G.pendingChoice.side === side) {
    // ABANDON the base (establish-base = relocate) ONLY when it's REVEALED —
    // capture is imminent and escaping is the whole point. Relocating merely
    // because an Empire ground force is NEAR a still-HIDDEN base is a trap
    // (#551/#579): RM's relocate moves only the base marker, so the starting
    // fleet is STRANDED at the old site and never used again, and you've thrown
    // away a hidden position the Empire hadn't even found. When hidden, always
    // take move-units instead — pull ships INTO the base to defend/consolidate
    // (which never strands anything) and keep hiding.
    // REVEALED: hold or flee? (#638 / #508). This used to be an unconditional
    // flee — `revealed ? 'establish-base' : 'move-units'` — so the Rebel
    // abandoned even a base it could easily have held ("Rebels moved the base
    // even though they had MUCH better unit numbers and the death star was
    // far away"). Self-play says always-flee is no better than a coin flip:
    // after a reveal, relocated bases were captured 70/119 and held bases
    // 43/81 — the same ~45% either way. Fleeing costs the position and the
    // turn; it should be paid for by an actual threat.
    //
    // Weigh what can reach the base NEXT round against what is standing on
    // it, in the strength gates' own units (dice + health). No reachable
    // threat → hold; the Death Star anywhere within two jumps counts as an
    // overwhelming threat regardless of the ground fight, because it wins by
    // orbit. Env-gated (SWR_HOLD_BASE=0 restores always-flee) — see
    // docs/ab-levers.md.
    //
    // HOW to hold when revealed: NOT via move-units — the card reads "IF the
    // Rebel base is not revealed, move up to 5 units", so that branch is
    // illegal once revealed and the engine rejects it (`move-units-
    // unavailable`). A first cut of this holding rule chose it anyway and
    // 79 of 300 self-play games hung on the choice forever. The legal hold is
    // RR p.11: take establish-base, draw the probes (free intel either way),
    // and DECLINE at the base pick — see the RapidMobilizationBasePick handler
    // below, which consults the same assessment.
    const branch = G.rebelBaseRevealed ? 'establish-base' : 'move-units';
    return phases.resolveRapidMobilizationBranch(G, branch).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationMovePick' && G.pendingChoice.side === side) {
    // Move up to 5 SELF-MOBILE ships to the base. RM moves ignore adjacency but
    // NOT transport: ground units need carrier capacity and structures are
    // immobile, so picking them is rejected and stalled the AI (self-play). Ships
    // carry themselves, so they're always a legal move; if none, move nothing.
    // Consolidate the BIGGEST leaderless pocket (was: first-found, which often
    // moved 0-1 ships while a real scattered fleet sat elsewhere — playtest
    // log 514ac76b showed movedCount:0 reveals).
    const src = bestRmConsolidationSource(G);
    // No movable ships → keep the base, move nothing (always a legal resolve).
    if (!src.systemId) return phases.resolveRapidMobilizationMove(G, Object.keys(G.map.systems)[0], []).ok;
    return phases.resolveRapidMobilizationMove(G, src.systemId, src.unitIds).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationBasePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // The new base MUST be one of the DRAWN probe systems, even when the old
    // base was revealed (#365 made the engine enforce this). Picking any other
    // system is rejected by the resolver — which previously stalled the AI when
    // it used the whole map in the revealed case. Pick from the drawn probes.
    const candidates = c.probeSystemIds ?? [];
    if (candidates.length === 0) {
      // No legal relocation target this draw — decline (keep current base).
      return phases.resolveRapidMobilizationBasePick(G, null).ok;
    }
    // HOLD a revealed base that can be held (#638/#508): decline the
    // relocation. The probes were still drawn and go to the bottom — that is
    // the "draw and look, then decide not to establish" option RR p.11 grants,
    // and it costs nothing the flee would not also have spent.
    if (G.rebelBaseRevealed && HOLD_REVEALED_BASE && shouldHoldRevealedBase(G)) {
      return phases.resolveRapidMobilizationBasePick(G, null).ok;
    }
    // Relocate to the SAFEST candidate: farthest from Empire units, not the
    // current base, Rebel/neutral preferred. Picking candidates[0] could
    // drop the new base right next to the Empire.
    const empireSystems = Object.keys(G.map.systems).filter((sid) =>
      G.map.systems[sid]?.units.some((u) => u.side === 'Empire'));
    const safety = (sid: string): number => {
      if (sid === G.rebelBaseSystemId) return -100; // don't "relocate" in place
      const ss = G.map.systems[sid];
      let s = ss?.loyalty === 'rebel' ? 3 : 0;
      let minDist = Infinity;
      for (const es of empireSystems) {
        const d = bfsDistances(G, es, 8).get(sid);
        if (d != null && d < minDist) minDist = d;
      }
      s += minDist === Infinity ? 8 : Math.min(minDist, 8);
      return s;
    };
    const best = [...candidates].sort((a, b) => safety(b) - safety(a))[0];
    return phases.resolveRapidMobilizationBasePick(G, best).ok;
  }
  // Interrogation Droid: Rebel picks 2 decoy systems that AREN'T the base.
  // The old pick was `.slice(0, count)` off raw map order, which routinely
  // named systems the Empire could dismiss on sight — most often ones holding
  // Imperial units, where the base would already have been found (#601). A
  // decoy is only worth naming if the Empire cannot rule it out for free, and
  // the best ones are far from Imperial forces so verifying them costs turns.
  if (G.pendingChoice && G.pendingChoice.kind === 'InterrogationDroidDecoyPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ruledOut = new Set(G.empireSearchedRuledOut ?? []);
    const empireSystems = Object.keys(G.map.systems).filter((sid) =>
      G.map.systems[sid]?.units.some((u) => u.side === 'Empire'));
    const empireDists = empireSystems.map((es) => bfsDistances(G, es, 8));
    const bluffScore = (sid: SystemId): number => {
      const ss = G.map.systems[sid];
      let s = 0;
      // Dead giveaways: the Empire is standing there (no hidden base), or its
      // probe map already crossed the system off.
      if (ss?.units.some((u) => u.side === 'Empire')) s -= 100;
      if (ruledOut.has(sid)) s -= 100;
      // A base needs somewhere to hide: Rebel/neutral loyalty reads plausible.
      if (ss?.loyalty === 'rebel') s += 3;
      else if (ss?.loyalty !== 'imperial') s += 1;
      // Farther from every Imperial force = more expensive to go check.
      let minDist = Infinity;
      for (const m of empireDists) {
        const d = m.get(sid);
        if (d != null && d < minDist) minDist = d;
      }
      s += minDist === Infinity ? 8 : Math.min(minDist, 8);
      return s;
    };
    const decoys = c.candidates
      .filter((sid) => sid !== G.rebelBaseSystemId)
      .sort((a, b) => bluffScore(b) - bluffScore(a))
      .slice(0, c.count);
    return phases.resolveInterrogationDroidDecoyPick(G, decoys).ok;
  }

  // (The currentPlayer gate that used to live here has been moved DOWN to
  // just before the proactive-command switch. Mission-resolution choices
  // — StolenPlansReorder, InfiltrationPick, CovertOperationPick,
  // DestroyUpToHealth, etc. — must fire regardless of whose turn it is,
  // because they can be posted to one side while the OTHER side is
  // currentPlayer (e.g. Rebel reveals a mission with a Rebel choice
  // payload, then control passes to Empire before the choice is
  // resolved). Pre-fix, the gate trapped them and caused freezes.)

  // If a player choice is pending and this side owns it, resolve it first.
  if (G.pendingChoice && G.pendingChoice.kind === 'PrepareForBattleDeckPick' && G.pendingChoice.side === side) {
    // AI: peek whichever tactic deck is larger (more to gain from arranging).
    const c = G.pendingChoice;
    const sz = (k: string) => k === 'space-tactic' ? (G.spaceTacticDeck?.length ?? 0) : (G.groundTacticDeck?.length ?? 0);
    const pick = [...c.options].sort((a, b) => sz(b) - sz(a))[0];
    return phases.resolvePrepareForBattleDeckPick(G, pick).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'StolenPlansReorder' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Pick the highest-rep remaining card to place next on top.
    let best = c.remaining[0];
    let bestRep = G.catalog.objectives[best]?.reputation ?? 0;
    for (const cid of c.remaining.slice(1)) {
      const rep = G.catalog.objectives[cid]?.reputation ?? 0;
      if (rep > bestRep) { best = cid; bestRep = rep; }
    }
    const r = phases.resolveStolenPlansPick(G, best);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'SafeHavenPick' && side === 'Rebel') {
    // AI: take up to 2 units — prefer the higher build slots (closer to done).
    const c = G.pendingChoice;
    const order = c.units
      .map((_u, i) => i)
      .sort((a, b) => c.units[b].slot - c.units[a].slot)
      .slice(0, 2);
    return phases.resolveSafeHavenPick(G, order).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PlanTheAssaultShips' && side === 'Rebel') {
    // AI: send every available ship.
    const c = G.pendingChoice;
    const r = phases.resolvePlanTheAssaultShips(G, c.availableShipIds);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DestroyUpToHealth' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
    // Spend the health budget on the units it actually hurts to lose. The old
    // rule sorted by tier-then-health and took greedily, which prices a unit by
    // its silhouette rather than by what replacing it costs — a transport is a
    // circle, same as an AT-ST (#727). Exact knapsack over unitKillValue, with
    // the same weights the target scorer uses so the two cannot disagree about
    // which system was worth attacking.
    const items = c.candidates
      .map((uid) => {
        const u = ss?.units.find((x) => x.instanceId === uid);
        const t = u ? G.catalog.unitTypes[u.typeId] : null;
        return { uid, hp: Math.max(1, t?.health.value ?? 1), val: u ? unitKillValue(G, u) : 0 };
      });
    const cap = c.unitCap ?? items.length;          // Plant Explosives: ≤3 units (#303)
    const budget = Math.max(0, c.budget);
    // dp[k][h] = best value using ≤k units and ≤h health; keep[i][k][h] records
    // whether item i was taken, so the winning set can be read back out.
    let dp: number[][] = Array.from({ length: cap + 1 }, () => new Array<number>(budget + 1).fill(0));
    const keep: boolean[][][] = [];
    for (const it of items) {
      const next = dp.map((row) => row.slice());
      const took: boolean[][] = Array.from({ length: cap + 1 }, () => new Array<boolean>(budget + 1).fill(false));
      for (let k = 1; k <= cap; k++) {
        for (let h = it.hp; h <= budget; h++) {
          const cand = dp[k - 1][h - it.hp] + it.val;
          if (cand > next[k][h]) { next[k][h] = cand; took[k][h] = true; }
        }
      }
      keep.push(took);
      dp = next;
    }
    const picks: string[] = [];
    let k = cap; let h = budget;
    for (let i = items.length - 1; i >= 0; i--) {
      if (keep[i][k][h]) { picks.push(items[i].uid); h -= items[i].hp; k -= 1; }
    }
    return phases.resolveDestroyUpToHealth(G, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RogueSquadronRaidPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const sorted = [...c.candidates].sort((a, b) => b.health - a.health);
    let spent = 0;
    const picks: { slot: 1 | 2 | 3; queueIndex: number }[] = [];
    for (const x of sorted) {
      if (spent + x.health > c.budget) continue;
      picks.push({ slot: x.slot, queueIndex: x.queueIndex });
      spent += x.health;
    }
    return phases.resolveRogueSquadronRaidPick(G, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'DoubleOurEffortsPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const sorted = [...c.candidates].sort((a, b) => {
      const tA = tierRank[G.catalog.unitTypes[a.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      const tB = tierRank[G.catalog.unitTypes[b.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      return tB - tA || a.slot - b.slot;
    });
    return phases.resolveDoubleOurEffortsPick(G, sorted.slice(0, c.picksAllowed).map((x) => ({ slot: x.slot, queueIndex: x.queueIndex }))).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PlanetaryConquestSourcePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const best = c.sources.reduce((a, b) => (b.picks.length > a.picks.length ? b : a));
    return phases.resolvePlanetaryConquestSourcePick(G, best.sourceSystemId).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'FearWillKeepThemInLinePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Prefer non-Imperial systems first.
    const ranked = [...c.candidates].sort((a, b) => {
      const aRebel = G.map.systems[a]?.loyalty !== 'imperial' ? 1 : 0;
      const bRebel = G.map.systems[b]?.loyalty !== 'imperial' ? 1 : 0;
      return bRebel - aRebel;
    });
    return phases.resolveFearWillKeepThemInLinePick(G, ranked.slice(0, c.count)).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'PublicUprisingPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId];
    let empireSpace = 0, empireGround = 0;
    if (ss) for (const u of ss.units) {
      if (u.side !== 'Empire') continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (t?.theater === 'space') empireSpace++; else empireGround++;
    }
    const circle = empireGround > empireSpace ? 'airspeeder' : 'corellian-corvette';
    const triangle = (empireSpace > 0 && empireGround === 0) ? 'x-wing' : 'rebel-trooper';
    return phases.resolvePublicUprisingPick(G, { circle, triangles: [triangle, triangle] }).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'SupportOfMonCalamariPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    // Take the 2 loyalty only when it can actually shift Mon Calamari toward
    // us. If it's already Rebel (no gain) OR the Empire is occupying it
    // (subjugated — the marker masks any loyalty we add), the loyalty is
    // wasted, so take the guaranteed Mon Cala Cruiser instead. (Player report
    // #95: the Rebel AI kept gaining masked loyalty on Empire-held Mon Cala.)
    const loyaltyWasted = c.monCalaSubjugated || c.monCalaLoyalty === 'rebel';
    // If no cruiser remains in supply (all 3 already in play), the cruiser
    // option is illegal — fall back to loyalty even when it's "wasted".
    const wantCruiser = loyaltyWasted && c.cruiserAvailable !== false;
    return phases.resolveSupportOfMonCalamariPick(G, wantCruiser ? 'cruiser' : 'loyalty').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'MisdirectionPick' && G.pendingChoice.side === side) {
    // AI: protect the highest-value Rebel leader.
    const c = G.pendingChoice;
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics + l.tacticValues.space + l.tacticValues.ground) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveMisdirectionPick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'TrustInTheForceDestroyPick' && G.pendingChoice.side === side) {
    // AI: destroy the highest-health triangle ground unit (assault-tank over a
    // stormtrooper) — spend the free kill where it hurts most.
    const c = G.pendingChoice;
    const ss = G.map.systems[c.systemId];
    const hv = (id: string) => G.catalog.unitTypes[ss?.units.find((u) => u.instanceId === id)?.typeId ?? '']?.health.value ?? 0;
    const target = [...c.candidates].sort((a, b) => hv(b) - hv(a))[0];
    return phases.resolveTrustInTheForceDestroyPick(G, target).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ResearchAndDevelopmentOption' && side === 'Empire') {
    // AI: cleanse sabotage if available (B), else peek-and-keep (A).
    const c = G.pendingChoice;
    return phases.resolveResearchAndDevelopmentOption(G, c.hasSabotage ? 'B' : 'A').ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'ResearchAndDevelopmentProjectPick' && side === 'Empire') {
    // AI: keep the first card (heuristic — both project cards are valuable).
    const c = G.pendingChoice;
    return phases.resolveResearchAndDevelopmentProjectPick(G, c.drawnIds[0]).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'OverseeProjectPick' && side === 'Empire') {
    const c = G.pendingChoice;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    let best = c.candidates[0];
    for (const cand of c.candidates.slice(1)) {
      const r = tierRank[G.catalog.unitTypes[cand.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      const rBest = tierRank[G.catalog.unitTypes[best.unitTypeId]?.tier ?? 'triangle'] ?? 0;
      if (r > rBest || (r === rBest && cand.slot < best.slot)) best = cand;
    }
    return phases.resolveOverseeProjectPick(G, best.queueIndex, best.slot).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CaptureOperativePick' && side === 'Empire') {
    const c = G.pendingChoice;
    // Pick highest-value Rebel leader (catalog skills sum).
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics + l.tacticValues.space + l.tacticValues.ground) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveCaptureOperativePick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CarbonFreezingPick' && side === 'Empire') {
    const c = G.pendingChoice;
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveCarbonFreezingPick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'LureOfTheDarkSidePick' && side === 'Empire') {
    const c = G.pendingChoice;
    let best = c.candidates[0]; let bestV = -1;
    for (const lid of c.candidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveLureOfTheDarkSidePick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'HomingBeaconPlace' && side === 'Rebel') {
    const c = G.pendingChoice;
    // AI: rescue highest-value leader; place at first system in region.
    let best = c.leaderCandidates[0]; let bestV = -1;
    for (const lid of c.leaderCandidates) {
      const l = G.catalog.leaders[lid];
      const v = l ? (l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics) : 0;
      if (v > bestV) { best = lid; bestV = v; }
    }
    return phases.resolveHomingBeaconPlace(G, best, c.systemCandidates[0]).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'CovertOperationPick' && side === 'Rebel') {
    const c = G.pendingChoice;
    const [a, b] = c.drawnIds;
    const keep = objectiveKeepValue(G, a) >= objectiveKeepValue(G, b) ? a : b;
    const r = phases.resolveCovertOperationPick(G, keep);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'InfiltrationPick' && side === 'Rebel') {
    const c = G.pendingChoice;
    const keep = objectiveKeepValue(G, c.topId) >= objectiveKeepValue(G, c.bottomId)
      ? c.topId : c.bottomId;
    const r = phases.resolveInfiltrationPick(G, keep);
    return r.ok;
  }

  // From here on, only act on our own turn. Above are pendingChoice
  // handlers that may fire even when it's the other side's turn.
  if (G.currentPlayer !== side) return false;

  // Rebel base pick — handled BEFORE the phase switch because the pick can
  // outlive Setup (RoE preset-unit configs advance to Assignment with the
  // pick still pending; the phase-gated handler never fired there and the
  // game silently ran on the placeholder candidates[0] base).
  if (side === 'Rebel' && G.pendingRebelBasePick && G.pendingRebelBasePick.length > 0) {
    const r = phases.pickRebelBase(G, chooseRebelBaseSystem(G, G.pendingRebelBasePick));
    if (r.ok) return true;
  }

  switch (G.phase) {
    case 'Setup': {
      // Rebel: thin the base to cut Gather-Intel yield (places overflow at a
      // decoy system); Empire: plain auto-fill.
      if (side === 'Rebel') return aiRebelSetupDeploy(G);
      const r = phases.setupAutoFill(G, side);
      return r.ok;
    }
    case 'Assignment': {
      // Plan the full Assignment phase; execute one assignment per call.
      // Re-plans every call so the latest state (including action-card
      // recruits, leader captures, etc.) is reflected.
      const plan = planAssignment(G, side);
      const f = side === 'Rebel' ? G.rebel : G.empire;
      for (const entry of plan) {
        if (!f.missionHand.includes(entry.missionId)) continue;
        if (!entry.leaderIds.every((l) => f.leaderPool.includes(l))) continue;
        // Hard rule (both sides): never assign a leader to a mission they
        // can't perform. Drop any leader with zero skill fit for this
        // mission's required skill. The planner already filters these
        // out, but this is a defensive check so the rule holds even if
        // the planner is later refactored.
        const useful = entry.leaderIds.filter((lid) =>
          leaderSkillFit(G, lid as LeaderId, entry.missionId) > 0);
        if (useful.length === 0) continue;
        const r = phases.assignLeader(G, side, entry.missionId, useful);
        if (r.ok) return true;
      }
      return phases.skipAssignment(G, side).ok;
    }
    case 'Command': {
      // Pluggable Command policy (see setCommandPolicyOverride): the CLIENT
      // registers the depth-2 board-eval policy for the AI Rebel here; the
      // SERVER (online vs-AI) never registers it, keeping its per-request CPU
      // within Cloudflare limits. Falls through to the heuristic on any miss.
      const override = commandPolicyOverride[side];
      if (override) {
        try {
          if (override(G, side)) return true;
        } catch (e) {
          // A policy crash must never stall the game — heuristic takes over.
          console.warn('[ai] command policy override threw; falling back', e);
        }
      }
      // Try actions in descending score order, skipping any the engine rejects,
      // so a high-score mission we can't actually reveal no longer forces a
      // pass while feasible lower-score actions go untried (player report #190).
      // Rollout ranker (SWR_RANKER_ROLLOUT): with the imitation ranker on, the
      // heuristic — which is also the ROLLOUT policy inside every MCTS search —
      // tries candidates in ranker order. rankCandidates is a no-op unless the
      // ranker is on and covers this side, so the default path is untouched.
      const commandActions = RANKER_ROLLOUT ? rankCandidates(G, side, bestCommandAction(G, side)) : bestCommandAction(G, side);
      // Planner state AT decision time, for the trace (recomputing after the
      // action would describe the post-move board, not what the scorer saw).
      const planAtDecision = side === 'Empire' && PLANNER_ENABLED ? derivePlan(G) : null;
      let rejected = 0;
      for (const action of commandActions) {
        if (action.kind === 'pass') {
          const ok = phases.pass(G, side).ok;
          if (ok) logCommandDecision(G, side, action, commandActions, rejected, planAtDecision);
          return ok;
        }
        if (tryCommandAction(G, side, action)) {
          logCommandDecision(G, side, action, commandActions, rejected, planAtDecision);
          return true;
        }
        rejected++;
      }
      const fell = phases.pass(G, side).ok;
      if (fell) logCommandDecision(G, side, { kind: 'pass', score: 0 }, commandActions, rejected, planAtDecision);
      return fell;
    }
    default:
      return false;
  }
}

/** AI decision trace (log-format v2): one `ai-decision` event per heuristic
 *  Command decision, recording what was chosen, the top-scored alternatives it
 *  beat, how many higher-scored candidates the engine rejected first, and the
 *  strike-fleet plan state at decision time (when the planner is enabled).
 *  This is the "why" the logs never carried — diagnosing a bad Empire turn
 *  becomes reading one line instead of reverse-engineering intent from moves.
 *  Logged AFTER the chosen action executes (we only know the choice once the
 *  engine accepts it), so its seq follows the action's own events.
 *  NOTE: depth-2 override decisions (client AI Rebel) are not traced — they
 *  bypass this path entirely via setCommandPolicyOverride. */
function logCommandDecision(
  G: GameState,
  side: Side,
  chosen: CommandAction,
  all: CommandAction[],
  rejected: number,
  plan: StrikeFleetPlan | null,
): void {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const brief = (a: CommandAction): Record<string, unknown> =>
    a.kind === 'reveal'
      ? { kind: a.kind, missionId: a.missionId, target: a.targetSystemId, score: r1(a.score) }
      : a.kind === 'activate'
        ? { kind: a.kind, leaderId: a.leaderId, target: a.targetSystemId, score: r1(a.score) }
        : { kind: a.kind, score: r1(a.score) };
  const payload: Record<string, unknown> = {
    chose: brief(chosen),
    alts: all.filter((a) => a !== chosen).slice(0, 5).map(brief),
    rejected,
  };
  if (plan) {
    payload.plan = {
      mode: plan.mode, target: plan.targetSystemId,
      needed: plan.neededGround, massed: plan.massedGround, ships: plan.massedShips,
      staged: plan.stagedGround,
    };
  }
  logEvent(G, { kind: 'ai-decision', side, payload });
}

/** Apply ONE non-pass Command action (reveal/activate) to G. Returns true if an
 *  action was taken (the turn is used), false if it couldn't be applied and the
 *  caller should try the next candidate. Extracted from stepOnce so rollout /
 *  search can apply a specific candidate move to a forked state. */
export function tryCommandAction(G: GameState, side: Side, action: CommandAction): boolean {
      if (action.kind === 'reveal') {
        const r = phases.revealMission(G, side, action.missionId, action.targetSystemId, action.targetLeaderId);
        if (r.ok) return true;
        // The chosen target was illegal — try every REAL legal candidate system
        // for this mission (from missionTargets). If none work, fall through to
        // the next-best action rather than passing the whole turn.
        const tr = missionTargets(G, side, action.missionId);
        const candidates = tr.permissive ? Object.keys(G.map.systems) : tr.systemIds;
        let revealed = false;
        for (const sysId of candidates) {
          const tgt = captureTargetLeaderId(G, side, action.missionId, sysId);
          const r2 = phases.revealMission(G, side, action.missionId, sysId, tgt);
          if (r2.ok) { revealed = true; break; }
        }
        if (revealed) return true;
        return false; // can't reveal this mission anywhere — try the next action
      }
      if (action.kind === 'activate') {
        // Pull units from EVERY adjacent friendly system with no own
        // leader present (one MoveOrder per source system).
        // Rules implemented (from playtester feedback):
        //   1. Leader-occupied systems can't move units out (filtered).
        //   2. Empire leaves 1 GROUND unit at SUBJUGATED systems only
        //      (un-garrisoning a subjugated system loses subjugation;
        //      non-subjugated own systems don't need a garrison).
        //   3. Transport-capacity validation per source: ground units +
        //      restriction-icon fighters consume transport capacity;
        //      only capital ships (transport.capacity > 0) provide it.
        //      Without enough capacity from this source's same-move
        //      capital ships, the engine rejects the order — pick
        //      conservatively to stay legal.
        // Build the orders the same way the scorer priced them — one shared
        // function, so the move that happens is the move that was scored.
        const orders = plannedMoveOrders(G, side, action.targetSystemId);
        // Don't waste an activation on a lone leader that moves NO units and
        // starts NO combat — it just sits there (player reports #92/#93:
        // "activated Palpatine but moved no units"). If there's an enemy at the
        // target a leaderless move still triggers a worthwhile fight; otherwise
        // pass and keep the leader available.
        //
        // NOTE (#446): a bare leader walking into an enemy-held base-CANDIDATE
        // system looks wasteful, but it isn't — a leader's arrival REVEALS the
        // Rebel base if it's hiding there, which is the Empire's whole win
        // condition. An earlier attempt to also require own combat units at the
        // target dropped the Empire self-play win rate 43%→30% (it stopped
        // finding the base), so the enemy-at-target exception stands as-is.
        if (orders.length === 0) {
          const tss = G.map.systems[action.targetSystemId];
          const enemyAtTarget = tss?.units.some((u) => u.side !== side) ?? false;
          if (!enemyAtTarget) return false; // useless activation — try the next action
        }
        const r = phases.activateSystem(G, side, action.leaderId, action.targetSystemId, orders);
        if (r.ok) return true;
        return false; // activation rejected — try the next action
      }
      return false; // no applicable action kind
}

function handleOpposeMission(G: GameState, side: Side): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'OpposeMission' }>;
  const skill = c.skill;
  // Existing opposers' skill dice.
  const existingSkill = c.existingAtTarget.reduce((s, lid) => {
    const ld = G.catalog.leaders[lid];
    return s + ((ld?.skills as Record<string, number>)?.[skill] ?? 0);
  }, 0);
  // Find the best pool candidate.
  let best: { lid: LeaderId; m: number; v: number } | null = null;
  for (const lid of c.poolLeaders) {
    const ld = G.catalog.leaders[lid];
    if (!ld) continue;
    const m = (ld.skills as Record<string, number>)[skill] ?? 0;
    const v = ld.skills.diplomacy + ld.skills.intel + ld.skills.specOps + ld.skills.logistics
           + ld.tacticValues.space + ld.tacticValues.ground;
    if (!best || m > best.m || (m === best.m && v < best.v)) best = { lid, m, v };
  }
  // Dice math: ~0.5 successes per die. Mission attacker wins ties (no — they
  // need strictly more). With portrait bonuses unknown to us here, treat as
  // expected-equal contest.
  const attExpected = c.attackerDice * 0.5;
  const noOpposeExpected = existingSkill * 0.5;
  // Auto-decline if we already have enough to win without burning a card,
  // or if no pool candidate exists.
  let sentLeader: LeaderId | null = null;
  // GERRY STRATEGY, extended whole-game (forum: jocke01, 2026-07-16): Empire
  // opposes ONLY genuinely high-impact missions. Every leader spent opposing
  // is an activation foregone — and reporters kept watching the Empire burn
  // its pool on low-impact Rebel missions (sabotage/infiltration) while its
  // fleets sat idle (#516). Was T1-4 only; A/B'd whole-game before shipping.
  //
  // REFINEMENT (jocke01 again, #704): "Jabba had nothing to do this round
  // except opposing since he can't move ships. If the rebel does their last
  // mission he should auto oppose if nothing else since otherwise he is a
  // complete waste." He is right, and it is a correction to his OWN earlier
  // rule. The skip is priced on "a leader spent opposing is an activation
  // foregone" — but RAW gates activating a system on having tactic values, so
  // for Boba Fett, Jabba and Greejatus that cost is exactly zero. They cannot
  // activate anything, ever. Sitting in the pool is not saving them for
  // something better; it is wasting them.
  const bestCannotActivate = !!best
    && ((G.catalog.leaders[best.lid]?.tacticValues.space ?? 0)
      + (G.catalog.leaders[best.lid]?.tacticValues.ground ?? 0)) === 0;
  const empireEarlyGameSkip =
    side === 'Empire' &&
    !isHighImpactMissionForOpposer(c.missionId, side) &&
    !(OPPOSE_WITH_IDLE_LEADERS && bestCannotActivate);
  if (best && !empireEarlyGameSkip) {
    const withBestExpected = (existingSkill + best.m) * 0.5;
    // Send a pool leader if it materially improves the math AND
    // (a) we currently lose without them, OR
    // (b) the mission is high-impact for the attacker (captures, key effects).
    const improves = withBestExpected > noOpposeExpected + 0.4;
    const losingWithout = noOpposeExpected < attExpected - 0.5;
    const highImpact = isHighImpactMissionForOpposer(c.missionId, side);
    if (improves && (losingWithout || highImpact)) sentLeader = best.lid;
    // Always send if there are NO existing opposers and the attacker has
    // any dice — a guaranteed loss otherwise.
    if (!sentLeader && existingSkill === 0 && c.attackerDice >= 1 && best.m >= 1) {
      sentLeader = best.lid;
    }
  }
  // Only spend Subversion when it AUGMENTS a real opposition — i.e. we're
  // sending a leader or already have opposers at the target. Don't burn the
  // card to oppose a mission we've otherwise decided to let through (mirrors the
  // human "Don't oppose" = no Subversion fix, #343).
  const useSubv = sentLeader !== null || c.existingAtTarget.length > 0;
  const r = phases.resolveOpposition(G, sentLeader, useSubv);
  return r.ok;
}

/** Missions whose effect on the OPPOSING side is particularly bad; the
 *  opposer should commit harder to stopping these. */
function isHighImpactMissionForOpposer(missionId: string, opposerSide: Side): boolean {
  if (opposerSide === 'Rebel') {
    // Empire missions the Rebel REALLY wants to stop.
    return new Set([
      'capture-rebel-operative', 'collect-bounty', 'detained',
      'gather-intel', 'research-and-development',
      'lure-of-the-dark-side', 'carbon-freezing', 'interrogation-droid',
      'retrieve-the-plans',
    ]).has(missionId);
  }
  // Rebel missions the Empire REALLY wants to stop.
  return new Set([
    'daring-rescue', 'for-the-greater-good',
    'plant-false-lead', 'stolen-plans',
    'wookie-uprising', 'support-of-mon-calamari',
    'lead-the-strike-team',
  ]).has(missionId);
}

// ---------- Combat tactic-card heuristics --------------------------------
// Mirrors the prior auto-play behaviour now that those helpers are gone.

function handleCombatAttackerTactics(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAttackerTactics' }>;
  const hits = c.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
  const blanks = c.dice.filter((d) => d.face === 'blank').length;
  let concentrateFire: string | null = null;
  // Concentrate Fire if hit rate < 50% AND we have blanks to reroll.
  if (c.dice.length > 0 && blanks > 0 && hits < Math.ceil(c.dice.length / 2)) {
    concentrateFire = c.hand.find((cid) => cid.includes('concentrate-fire')) ?? null;
  }
  // Only the FREE boost (Critical Hit) is playable in the regular-tactics step.
  // Onslaught / Take It Down need a rolled special (requiresSpecial) and are
  // played via the Special Die Spend path instead (#204) — the engine now skips
  // them here, so don't bother offering them.
  const damageBoosts: string[] = [];
  for (const sub of ['take-it-down', 'critical-hit', 'onslaught']) {
    const cid = c.hand.find((x) => x.includes(sub));
    if (cid && G.catalog.tactics[cid]?.requiresSpecial !== true) damageBoosts.push(cid);
  }
  const r = combat.resolveCombatAttackerTactics(G, {
    concentrateFireCardId: concentrateFire,
    damageBoostCardIds: damageBoosts,
  });
  return r.ok;
}

function handleCombatDefenderTactics(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatDefenderTactics' }>;
  const blockCards: string[] = [];
  const sacrifices: string[] = [];
  if (c.incomingHits > 0) {
    // Free block first.
    const free = c.hand.find((cid) => cid.includes('defensive-formation'));
    if (free) blockCards.push(free);
    // Then dig-in / outmaneuver if we have a sacrificial spare.
    const paid = c.hand.find((cid) =>
      (cid.includes('dig-in') && c.theater === 'ground') ||
      (cid.includes('outmaneuver') && c.theater === 'space')
    );
    if (paid && c.hand.length >= 2) {
      const sacrifice = c.hand.find((cid) =>
        cid !== paid && cid !== free && !cid.includes('concentrate-fire') // keep concentrate-fire if we have it for next time
      );
      if (sacrifice) { blockCards.push(paid); sacrifices.push(sacrifice); }
    }
  }
  const r = combat.resolveCombatDefenderTactics(G, { blockCardIds: blockCards, sacrificeCardIds: sacrifices });
  return r.ok;
}

// ---------- Build-pick heuristic --------------------------------
// WEAKNESS 2 (log analysis): in 3/3 Empire losses, Empire finished with
// 0-1 Star Destroyers and 0-1 AT-ATs; in wins it had 4-10 SDs and 5-8
// AT-ATs. Capital units are the difference between "found the base and
// bounced" vs "found the base and crushed it." Apply a hard floor by
// time T3+: for Empire square slots, prefer star-destroyer (space)
// and at-at (ground) until at least 2 of each exist on board + in
// queue, then fall through to whatever legalUnitTypes[0] would have
// been. Rebel uses the prior first-legal behaviour.
type GenericChoiceReq = Extract<NonNullable<GameState['pendingChoice']>, { kind: 'Choice' }>;

/** Per-tag AI heuristics for generic choices. A tag with no entry falls back to
 *  "pick the minimum legal number of candidates" — always valid, never a
 *  soft-lock. Add an entry to make the AI play a specific choice well. */
const AI_CHOICE_HEURISTICS: Record<string, (G: GameState, choice: GenericChoiceReq) => string[]> = {
  // Show No Fear reveal (#512/#515): revealing places a public marker on the base
  // system. If the base is already revealed there's no downside — take the free
  // reputation. If it's still hidden, keep it hidden rather than hand the Empire
  // the base location.
  'show-no-fear-reveal': (G) => [G.rebelBaseRevealed ? 'reveal' : 'decline'],
  // The Long War: discard the 2 objectives worth the least right now — prefer
  // dropping ones whose scoring condition is NOT currently met (dead weight),
  // breaking ties by lowest reputation value, so the AI keeps its live/high-
  // value objectives (e.g. Death Star Plans) and pays with the rest.
  'the-long-war-discard': (G, choice) => {
    const ids = choice.candidates.filter((c) => !c.disabled).map((c) => c.id);
    const scored = ids.map((id) => ({
      id,
      met: engineTry(() => objectiveConditionMet(G, id), false),
      rep: engineTry(() => objectiveReputationGain(G, id), 1),
    }));
    scored.sort((a, b) =>
      (a.met === b.met ? 0 : a.met ? 1 : -1) || (a.rep - b.rep));
    return scored.slice(0, choice.min).map((s) => s.id);
  },
  // Homing Beacon target (#637): the Empire releases ONE captive so the Rebel's
  // forced placement betrays the base region. Give up the least valuable one —
  // and hold on to anyone in carbonite, since releasing them also discards the
  // ring (the Rebel doesn't get the Carbon Freezing reputation back either way,
  // but the freeze keeps that leader out of play harder).
  'homing-beacon-target': (G, choice) => {
    const ids = choice.candidates.filter((c) => !c.disabled).map((c) => c.id);
    const frozen = (id: string) =>
      (G.empire.capturedLeaders ?? []).find((c) => c.leaderId === id)?.ring === 'carbonite';
    const scored = ids.map((id) => ({ id, frozen: frozen(id), value: leaderValue(G, id) }));
    // Non-frozen first, then cheapest — that leader is the one we can spare.
    scored.sort((a, b) => (a.frozen === b.frozen ? 0 : a.frozen ? 1 : -1) || (a.value - b.value));
    return scored.slice(0, Math.max(1, choice.min)).map((s) => s.id);
  },
};

/** Run an engine query that might throw / be undefined, returning a fallback. */
function engineTry<T>(fn: () => T, fallback: T): T {
  try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; }
}

/** Answer any generic (data-driven) choice. Uses the per-tag heuristic when one
 *  exists, else selects the minimum legal number of live candidates. Always
 *  clamps the result to a valid selection so it can never reject/soft-lock. */
function handleGenericChoice(G: GameState): boolean {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'Choice') return false;
  const live = pc.candidates.filter((c) => !c.disabled).map((c) => c.id);
  const liveSet = new Set(live);
  const heuristic = AI_CHOICE_HEURISTICS[pc.tag];
  let selection = (heuristic ? heuristic(G, pc) : live.slice(0, pc.min)).filter((id) => liveSet.has(id));
  // Clamp to [min, max]. Top up from unused live candidates if the heuristic
  // under-picked; trim if it over-picked.
  if (selection.length < pc.min) {
    for (const id of live) {
      if (selection.length >= pc.min) break;
      if (!selection.includes(id)) selection.push(id);
    }
  }
  if (selection.length > pc.max) selection = selection.slice(0, pc.max);
  return phases.resolveGenericChoice(G, selection).ok;
}

function handleBuildPick(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'BuildPick' }>;
  const side = c.side;
  const countOnBoardAndQueue = (typeId: string): number => {
    let n = 0;
    for (const ss of Object.values(G.map.systems)) {
      for (const u of ss.units) if (u.side === side && u.typeId === typeId) n++;
    }
    for (const u of G.map.rebelBaseSpace.units) {
      if (u.side === side && u.typeId === typeId) n++;
    }
    const bq = side === 'Empire' ? G.empire.buildQueue : G.rebel.buildQueue;
    for (const slot of [1, 2, 3] as const) {
      for (const t of bq[slot]) if (t === typeId) n++;
    }
    return n;
  };
  const enforceFloor = side === 'Empire' && G.timeMarker >= 3;
  const sdFloor = enforceFloor && countOnBoardAndQueue('star-destroyer') < 2;
  const atatFloor = enforceFloor && countOnBoardAndQueue('at-at') < 2;
  // Shield Bunkers are OFF by default (SWR_BUNKERS), and this is the lever
  // whose verdict deserves the least confidence in the whole ledger.
  //
  // jocke01 suggested building them to garrison the Death Star site ("in case
  // of a later deployment"). Sound on paper: a Bunker makes the station
  // indestructible and opens a Rebel-free remote for direct deployment.
  // Measured:
  //
  //   vs heuristic Rebel (1200 games)  38.0% -> 35.5%   (-2.5pp)
  //   vs eval-depth2 Rebel (400 games) 29.8% -> 28.8%   (-1.0pp)
  //
  // Read that second row carefully before trusting either. The Bunker's whole
  // function is protecting the station, and the heuristic Rebel enters the
  // Death Star's system in 3.3% of games and has NEVER destroyed a DSUC across
  // 60 games — so the first measurement could only ever see the cost, never the
  // benefit. Against the stronger Rebel the penalty more than halves, which is
  // what you would expect if some defensive value is finally registering, and
  // at n=400 it is inside noise either way.
  //
  // Two further caveats: the lever is weakly expressed (a Bunker actually
  // reaches the station in a minority of games, so even a real benefit is
  // diluted), and the opponent that matters most — a human who deliberately
  // raids an undefended Death Star, which is exactly what the reporter says he
  // does — is stronger than anything measured here. Kept wired for that
  // re-test. See docs/ab-levers.md.
  const dsucSite = side === 'Empire' && BUILD_SHIELD_BUNKERS
    ? Object.entries(G.map.systems).find(([, ss]) => ss.units.some((u) => u.side === 'Empire'
        && (u.typeId === 'death-star-under-construction' || u.typeId === 'death-star')))?.[0]
    : undefined;
  const bunkerWanted = !!dsucSite
    && !G.map.systems[dsucSite].units.some((u) => u.side === 'Empire' && u.typeId === 'shield-bunker')
    && countOnBoardAndQueue('shield-bunker') < 1;
  let bunkerQueued = false; // at most one Bunker per build batch
  // Track within-batch consumption so the AI doesn't pick the same exhausted
  // type twice (the engine hard-rejects 0-supply picks now). `available` is
  // the engine's snapshot; fall back to a live count if it's absent.
  const consumed = new Map<string, number>();
  const supplyLeft = (t: string): number => {
    const cap = G.catalog?.unitTypes?.[t]?.supplyCount;
    if (typeof cap !== 'number') return Infinity;
    return cap - countOnBoardAndQueue(t) - (consumed.get(t) ?? 0);
  };
  const choices = c.picks.map((p) => {
    const ok = (t: string) => p.legalUnitTypes.includes(t) && supplyLeft(t) > 0;
    let choice: string | undefined;
    if (bunkerWanted && !bunkerQueued && p.iconType === 'ground' && ok('shield-bunker')) {
      choice = 'shield-bunker'; bunkerQueued = true;
    }
    else if (sdFloor && p.iconShape === 'square' && p.iconType === 'space' && ok('star-destroyer')) choice = 'star-destroyer';
    else if (atatFloor && p.iconShape === 'square' && p.iconType === 'ground' && ok('at-at')) choice = 'at-at';
    if (!choice) choice = p.legalUnitTypes.find((t) => supplyLeft(t) > 0);
    if (!choice) choice = p.legalUnitTypes[0]; // all exhausted — engine will reject; harmless
    consumed.set(choice, (consumed.get(choice) ?? 0) + 1);
    return choice;
  });
  const r = phases.resolveBuildPicks(G, choices);
  return r.ok;
}

/** AI damage-assignment heuristic — for each incoming hit, pick the
 *  weakest legal target (lowest current effective HP, ties broken by
 *  smaller tier first). Tracks already-staged targets across hits so we
 *  don't waste damage on the same instance. */
function handleCombatAssignDamage(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAssignDamage' }>;
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  const assigned = new Map<string, number>(); // instanceId → damage already queued
  const assignments: (string | null)[] = [];
  // Track per-source-card targets to respect RAW constraints:
  //   take-it-down: subsequent hits MUST go to the same target as the first
  //   onslaught:    subsequent hits MUST go to a DIFFERENT target
  const sourceFirstTarget = new Map<string, string>();
  const sourceTargets = new Map<string, Set<string>>();

  // Find the live unit instance from catalog data + current map state.
  const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
  for (let i = 0; i < c.hits.length; i++) {
    const targets = c.targetsByHit[i];
    if (targets.length === 0) { assignments.push(null); continue; }
    const src = c.hits[i].source;
    const isTakeItDown = src && src.includes('take-it-down');
    const isOnslaught = src && src.includes('onslaught');
    let best: { id: string; remaining: number; tier: number; threat: number } | null = null;
    for (const tid of targets) {
      // Per-source constraint filtering.
      if (isTakeItDown && sourceFirstTarget.has(src)) {
        if (tid !== sourceFirstTarget.get(src)) continue;
      }
      if (isOnslaught && sourceTargets.get(src)?.has(tid)) continue;
      const u = ss?.units.find((x) => x.instanceId === tid);
      if (!u) continue;
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      const queued = assigned.get(tid) ?? 0;
      const remaining = (t.health.value ?? 1) - (u.damage ?? 0) - queued;
      if (remaining <= 0) continue; // already dead under queued damage
      const tier = tierRank[t.tier ?? 'square'] ?? 9;
      // Combat threat = total attack dice. Among equally-killable targets, take
      // out the bigger threat first: a Rebel Transport (0 attack) and a Corellian
      // Corvette (2 attack) have the SAME health, and the old tie-break (smaller
      // tier) wasted hits on the harmless Transport (player report #198). Finish
      // the easiest kill first (lowest remaining), then break ties by threat,
      // then by smaller tier.
      const threat = (t.attack?.red ?? 0) + (t.attack?.black ?? 0) + (t.attack?.green ?? 0);
      const better = !best
        || remaining < best.remaining
        || (remaining === best.remaining && threat > best.threat)
        || (remaining === best.remaining && threat === best.threat && tier < best.tier);
      if (better) {
        best = { id: tid, remaining, tier, threat };
      }
    }
    if (best) {
      assignments.push(best.id);
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1);
      if (src) {
        if (!sourceFirstTarget.has(src)) sourceFirstTarget.set(src, best.id);
        if (!sourceTargets.has(src)) sourceTargets.set(src, new Set());
        sourceTargets.get(src)!.add(best.id);
      }
    } else {
      assignments.push(null);
    }
  }
  const r = combat.resolveCombatAssignDamage(G, assignments);
  return r.ok;
}

/** AI: always take the Yoda reroll if available. Reroll the first blank. */
function handleYodaReroll(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'YodaReroll' }>;
  // Candidates now include every non-direct-hit die (#540) — the AI only ever
  // rerolls a BLANK (rerolling a hit/special is a downgrade risk). With no
  // blank it skips, which no longer spends the ring, so it stays available
  // for the Death Star Plans window or a later roll this game round.
  const dice = G.pendingCombat?.pendingAttack?.dice ?? [];
  const idx = c.blankIndices.find((i) => dice[i]?.face === 'blank') ?? null;
  const r = combat.resolveYodaReroll(G, idx);
  return r.ok;
}

/** AI: spend every available special on drawing tactic cards. Doesn't play
 *  any special-required cards (we'd need card-by-card logic). */
function handleSpecialDieSpend(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'SpecialDieSpend' }>;
  // Spend specials on playing ★-cost damage cards already in hand FIRST (each
  // costs 1 special), then draw with whatever specials remain. Previously the AI
  // always drew and never played its special cards — and the damage cards used
  // to leak through the regular tactics path for free (#204). Now that that's
  // closed, the AI must spend a special to play them, like the rules require.
  // Prefer the biggest immediate damage (Take It Down +2, Onslaught +2).
  const rank = (cid: string) => cid.includes('take-it-down') ? 2 : cid.includes('onslaught') ? 1 : 0;
  const playable = [...(c.specialCards ?? [])].sort((a, b) => rank(b) - rank(a));
  const playCardIds = playable.slice(0, c.specialCount);
  const draws = c.specialCount - playCardIds.length;
  const r = combat.resolveSpecialDieSpend(G, { draws, playCardIds });
  return r.ok;
}

/** Pick which Start-of-Combat action cards to play.
 *
 *  This used to hand back an empty array with the note "effects aren't wired
 *  anyway". That stopped being true — processStartOfCombatBatch calls
 *  applyStartOfCombatActionCardEffect for every card, and the audit that wired
 *  all 48 action cards covered these — but the stub was never revisited. So the
 *  AI declined the window in every combat of every game, which is most of why
 *  playtesters see it finish holding a hand it never used (jocke01: "the ai sit
 *  most games with 4-5 action cards that they never play").
 *
 *  Conservative on purpose: these are one-shot cards, so a card is played only
 *  when its effect actually bites in THIS combat. `playable` has already been
 *  filtered by the engine for timing and leader requirements, so what is left
 *  here is board applicability and worth. */
export function chooseStartOfCombatCards(
  G: GameState, side: Side, systemId: SystemId, playable: string[],
): string[] {
  const ss = G.map.systems[systemId] ?? (systemId === 'rebel-base-space' ? G.map.rebelBaseSpace : undefined);
  if (!ss) return [];
  const mine = ss.units.filter((u) => u.side === side);
  const theirs = ss.units.filter((u) => u.side !== side);
  // No real fight, no reason to burn a card.
  if (mine.length === 0 || theirs.length === 0) return [];
  const tOf = (u: { typeId: string }) => G.catalog.unitTypes[u.typeId];
  const inTheater = (us: typeof mine, th: string) =>
    us.filter((u) => tOf(u)?.theater === th && tOf(u)?.class !== 'structure');
  const spaceFight = inTheater(mine, 'space').length > 0 && inTheater(theirs, 'space').length > 0;
  const groundFight = inTheater(mine, 'ground').length > 0 && inTheater(theirs, 'ground').length > 0;
  const dice = (us: typeof mine) => us.reduce((a, u) => {
    const t = tOf(u);
    return a + (t?.attack.red ?? 0) + (t?.attack.black ?? 0) + (t?.attack.green ?? 0);
  }, 0);
  const hp = (us: typeof mine) => us.reduce((a, u) => a + (tOf(u)?.health.value ?? 0), 0);
  const stronger = dice(mine) > dice(theirs);
  const enemyStructure = theirs.some((u) => tOf(u)?.class === 'structure');
  const hasDeathStar = mine.some((u) =>
    u.typeId === 'death-star' || u.typeId === 'death-star-under-construction');
  const enemyShips = inTheater(theirs, 'space').length > 0;
  const myBlackHits = mine.some((u) => (tOf(u)?.attack.black ?? 0) > 0);

  // Worth of each card GIVEN it applies. Only cards listed here are ever
  // played, so a newly-added card is skipped rather than played blindly.
  const value = (cardId: string): number => {
    switch (cardId) {
      // --- Empire ---
      // Straight dice reduction on the opponent's first round; always bites.
      case 'according-to-my-design': return 8;
      // Free kill, but only with the station present and a ship to shoot.
      case 'fully-operational': return hasDeathStar && enemyShips ? 10 : -1;
      case 'target-the-generator': return enemyStructure ? 9 : -1;
      // Denying the retreat only matters if we're winning the fight.
      case 'keep-them-from-escaping': return stronger ? 7 : -1;
      case 'more-dangerous-than-you-realize': return 5;
      case 'good-intel': return 4;
      // Ready For Action brings Piett or Veers in from the pool for the fight
      // and hands him back afterwards. It was excluded while report #596 was
      // open; that turned out to be already fixed (#659 restricted the card to
      // the leader named on it), so it is back in.
      //
      // The real cost is that the borrowed leader CANNOT RETREAT — losing the
      // battle can cost the leader outright. So only when we're winning it.
      case 'ready-for-action': return stronger ? 7 : -1;
      // --- Rebel ---
      case 'baze-s-loyalty': return 9;
      case 'target-the-star-destroyers': return spaceFight && myBlackHits ? 8 : -1;
      case 'its-a-trap': return spaceFight ? 6 : -1;
      // -1 health to EVERY unit including ours: it speeds up whoever is already
      // killing faster, so only when we out-shoot them and aren't the fragile
      // side of the exchange.
      case 'point-blank-assault':
        return (stronger && hp(mine) >= hp(theirs) && (spaceFight || groundFight)) ? 6 : -1;
      default: return -1;
    }
  };

  const ranked = playable
    .map((cid) => ({ cid, v: value(cid) }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v);
  // Cap the spend: combats are frequent and the hand refills slowly, so dumping
  // every applicable card into one fight trades a whole hand for one battle.
  return ranked.slice(0, 2).map((x) => x.cid);
}

/** AI: Start-of-Combat action-card window. */
function handleCombatStartActionCards(G: GameState): boolean {
  const ch = G.pendingChoice;
  let picks: string[] = [];
  if (ch && ch.kind === 'CombatStartActionCards' && combatCardsEnabled(ch.side)) {
    picks = chooseStartOfCombatCards(G, ch.side, ch.systemId, ch.playable);
  }
  const r = combat.resolveCombatStartActionCards(G, picks);
  return r.ok;
}

/** AI retreat heuristic: retreat only if outnumbered ≥2:1 in either theater.
 *  Take all units. */
function handleRetreatDecision(G: GameState): boolean {
  const c = G.pendingChoice as Extract<NonNullable<GameState['pendingChoice']>, { kind: 'RetreatDecision' }>;
  const ss = G.map.systems[c.systemId];
  const my = ss?.units.filter((u) => u.side === c.side).length ?? 0;
  const opp = ss?.units.filter((u) => u.side !== c.side).length ?? 0;
  // NEVER retreat the Rebel garrison out of its own base system: leaving the
  // base undefended lets the Empire conquer it and win on the spot. Defend it
  // to the last (player report #85 — AI retreated a winning base defense and
  // handed the Empire the game).
  const isOwnBase = c.side === 'Rebel' && c.systemId === G.rebelBaseSystemId;
  const shouldRetreat = !isOwnBase && my > 0 && opp >= my * 2 && c.legalDestinations.length > 0;
  if (!shouldRetreat) {
    const r = combat.resolveRetreatDecision(G, null, null);
    return r.ok;
  }
  // Retreat via the first legal destination. If the engine rejects it (e.g. no
  // unit can actually move), fall back to staying rather than stalling.
  const r = combat.resolveRetreatDecision(G, c.legalDestinations[0], null);
  if (!r.ok) return combat.resolveRetreatDecision(G, null, null).ok;
  return r.ok;
}
