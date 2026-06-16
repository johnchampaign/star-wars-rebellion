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
import { pickBestCinematicPlay } from '../engine/cinematicTactics';
import { missionTargets, missionRevealIsPointless, rebelLoyalSystemsInRegion } from '../engine/missionTargets';
// Re-exported so existing callers/tests that import it from the AI module keep
// working now that the canonical definition lives in the engine (#304).
export { missionRevealIsPointless } from '../engine/missionTargets';
import { COST_OBJECTIVES } from '../engine/objectives';

// AI randomness. Defaults to Math.random (live app), but the tournament
// harness calls seedAI() so AI-vs-AI runs are reproducible per seed — without
// this, the same game seed gives different outcomes run-to-run (the engine is
// seeded via rng.ts, but the AI's own coin-flips were not), which made
// intermittent stalls and win-rate comparisons impossible to pin down.
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

function pick<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(aiRand() * arr.length)];
}

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

/** Static-ish strategic value of attempting a mission, before situational
 *  modifiers. Higher = AI cares more about this mission. */
function missionBaseValue(missionId: string, side: Side): number {
  const empireValues: Record<string, number> = {
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
    'sabotage': 6,
  };
  const rebelValues: Record<string, number> = {
    // Defensive / base protection
    'hit-and-run': 9,
    'hidden-fleet': 8,
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
  return table[missionId] ?? 5;
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
      if (!empireFactories) adj -= 8;
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
      const threatened = G.rebelBaseRevealed || empireProximityToBase(G) > 0;
      adj += threatened ? 20 : -6;
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
function empireProximityToBase(G: GameState): number {
  if (!G.rebelBaseSystemId) return 0;
  const dist = bfsDistances(G, G.rebelBaseSystemId, 2);
  let count = 0;
  for (const [sysId, d] of dist) {
    if (d > 2) continue;
    count += (G.map.systems[sysId]?.units ?? []).filter((u) => u.side === 'Empire').length;
  }
  return count;
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

/** True when revealing this Empire mission at this system would accomplish
 *  nothing, so the AI shouldn't burn the leader + card on it (players #276/#277). */
function empireMissionTargetScore(G: GameState, missionId: string, targetSysId: SystemId): number {
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
    else if (sysState?.subjugated) s -= 12;
  }
  // Captures / probes don't care about target system per se.
  if (missionId === 'gather-intel') s += 3;
  // Research & Development can REMOVE a sabotage marker from its target system
  // (Option B) while still drawing a project. The AI was running R&D on
  // arbitrary systems and never clearing sabotage, letting the Rebel choke its
  // production (player report #199). Strongly prefer a sabotaged Imperial system
  // as the target so Option B cleans it up.
  if (missionId === 'research-and-development' && sysState?.sabotage) s += 25;
  // Imperial Propaganda flips every Rebel-loyal system in the target's REGION to
  // neutral — so its value scales with how many Rebel-loyal systems that region
  // holds. Aim it at the region with the most to convert; a region with none is
  // already dropped by missionRevealIsPointless before scoring (#304).
  if (missionId === 'imperial-propaganda') {
    s += rebelLoyalSystemsInRegion(G, targetSysId) * 12;
  }
  // Prefer an undefended target so the attempt auto-succeeds (see helper).
  s += oppositionTargetTerm(G, 'Empire', missionId, targetSysId);
  return s;
}

/** Score a target system for a Rebel mission. `baseDist` is a precomputed
 *  hop-count map from the Rebel base (or null when base is revealed/missing). */
function rebelMissionTargetScore(
  G: GameState, missionId: string, targetSysId: SystemId,
  baseDist: Map<string, number> | null,
): number {
  let s = 0;
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
  ]);
  if (loyaltyGainMissions.has(missionId)) {
    s += (sysDef.resources?.length ?? 0) * 2;
    // Already Rebel-loyal & not subjugated → no loyalty to gain. Make this
    // strongly negative so the AI picks an unaligned/Imperial target (or,
    // if none qualifies, the assignment planner's situational damping skips
    // the mission entirely) rather than burning a leader on a no-op.
    if (sysState?.loyalty === 'rebel' && !sysState.subjugated) s -= 30;
  }
  // Sabotage (Rebel mission) should target ENEMY systems, never own.
  // Issues #10, #13: the AI was sabotaging Bespin / Alderaan when those
  // were Rebel-loyal, which is strategic self-harm.
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
      s += 10; // subjugated produces only 1 resource → denies 1
    } else if (sysState?.loyalty === 'imperial') {
      s += 6 + Math.min(resCount, 3) * 4; // 1-res:10, 2-res:14, 3-res:18
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
function planAssignment(G: GameState, side: Side): Array<{ missionId: string; leaderIds: LeaderId[] }> {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const hand = [...f.missionHand];
  if (f.leaderPool.length === 0 || hand.length === 0) return [];

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
    const used: LeaderId[] = [];
    let sum = 0;
    for (const r of ranked) {
      if (sum >= cost) break;
      used.push(r.lid);
      sum += r.fit;
    }
    if (sum < cost) return null; // infeasible — skip
    // Skip missions with NO legal target on the board right now. Assigning one
    // just leaves a face-down mission the AI can't reveal in the Command phase,
    // so it ends up passing while holding unplayable missions (player reports
    // #102/#118/#123). The Command phase already gates reveals on this same
    // check; mirror it at assignment time so we don't commit a leader to a
    // dead mission in the first place.
    const tgt = missionTargets(G, side, missionId);
    if (!tgt.permissive && tgt.systemIds.length === 0) return null;
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
  while (true) {
    const available = (f.leaderPool as LeaderId[]).filter((lid) => !usedLeaders.has(lid));
    if (available.length === 0) break;
    // Empire reserve: stop if we'd leave fewer than EMPIRE_RESERVE_LEADERS in pool.
    if (side === 'Empire' && f.leaderPool.length - usedLeaders.size <= EMPIRE_RESERVE_LEADERS) break;
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

type CommandAction =
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

function bestCommandAction(G: GameState, side: Side): CommandAction[] {
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
    const targets = missionTargets(G, side, am.missionId);
    // If the encoder couldn't narrow targets (permissive), allow all systems;
    // otherwise restrict to the engine-legal list.
    let candidateSystems = targets.permissive ? allSystemIds : targets.systemIds;
    // Drop targets where the mission would do nothing (e.g. Draw Them Out with
    // an empty Rebel pool, Single Reactor Ignition with no Rebel ground or
    // markers) so the AI doesn't waste it (#276/#277).
    candidateSystems = candidateSystems.filter((sid) => !missionRevealIsPointless(G, side, am.missionId, sid));
    if (candidateSystems.length === 0) continue;
    const baseValue = missionBaseValue(am.missionId, side) + missionSituationalAdjust(G, am.missionId, side);
    let bestTarget: SystemId | null = null;
    let bestTargetScore = -Infinity;
    for (const sysId of candidateSystems) {
      const t = side === 'Empire'
        ? empireMissionTargetScore(G, am.missionId, sysId)
        : rebelMissionTargetScore(G, am.missionId, sysId, baseDist);
      if (t > bestTargetScore) { bestTargetScore = t; bestTarget = sysId; }
    }
    if (!bestTarget) continue;
    actions.push({
      kind: 'reveal',
      missionId: am.missionId,
      targetSystemId: bestTarget,
      // Lock the specific leader NOW for capture-style missions, so the target
      // can't drift to whoever opposes (RAW: target chosen at perform time).
      targetLeaderId: captureTargetLeaderId(G, side, am.missionId, bestTarget),
      score: baseValue + bestTargetScore + 6,
    });
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
        return true;
      }),
    );
  }
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
  const systemScore = new Map<string, number>();
  for (const sysId of allSystemIds) {
    let ts = 0;
    const sys = G.map.systems[sysId];
    if (!sys) continue;
    const def = G.catalog.systems[sysId];
    const hasEnemyUnits = sys.units.some((u) => u.side !== side);
    const hasOwnUnits = sys.units.some((u) => u.side === side);
    if (side === 'Empire') {
      // Existing baseline.
      if (hasEnemyUnits) ts += 4;
      if (eliminatedByProbe.has(sysId)) ts -= 4;
      // Spread heuristic — reward visiting untouched neutral/Rebel-loyalty
      // systems to extend Imperial control + drop a unit for subjugation.
      // Worth more when the system has build resources.
      if (!hasOwnUnits && !sys.subjugated && sys.loyalty === 'imperial') {
        // Already Imperial-controlled and no enemy here: moving units in gains
        // nothing — there's no loyalty to flip, nothing to subjugate, and no
        // combat. Don't reward shuffling a fleet onto a system we already own
        // (player report #69: Empire moved units to an owned 2-resource system
        // for no benefit). Mild penalty so consolidation toward the marching
        // column (a separate +6 adjacency bonus) can still override when the
        // move actually serves a purpose.
        ts -= 3;
      } else if (!hasOwnUnits && !sys.subjugated) {
        const resourceWeight = def?.resources?.length ?? 0;
        ts += 2 + resourceWeight;
        // GERRY STRATEGY: prioritize subjugating Rebel-loyal systems —
        // strips Rebel production AND likely sits on the hidden base
        // (Rebels favor their loyalty for placement). Heavier early when
        // we should be spreading; tapers as timeMarker grows.
        if (sys.loyalty === 'rebel') ts += 8 + Math.max(0, 4 - G.timeMarker);
        // WEAKNESS 3: cap the subjugation-tourism behavior. Once Empire
        // already holds 6+ subjugated systems AND no invasion is pending
        // (base not revealed), spreading further is dilution — actively
        // penalize new subjugation pickups so leaders go consolidate
        // instead.
        if (subjugationCap && !G.rebelBaseRevealed) ts -= 10;
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
        const cleared = sys.units.some((u) => u.side === 'Empire')
          || sys.loyalty === 'imperial' || sys.subjugated;
        if (cleared) {
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
        for (const a of (G.catalog.adjacency[sysId] ?? [])) {
          if ((G.empire.leadersOnBoard[a] ?? []).length > 0) continue; // RAW p.2: leader-blocked
          for (const u of (G.map.systems[a]?.units ?? [])) {
            if (u.side === 'Empire') { empAll += strengthOf(u); if (isGround(u)) empGround += strengthOf(u); }
          }
        }
        // Overall outnumbered — scale the penalty by how lopsided it is.
        if (rebAll > 0 && empAll < rebAll) ts -= empAll < rebAll * 0.6 ? 24 : 12;
        // Can't win the ground fight (and the defender has ground to Confront a
        // leader / hold the system).
        if (rebGround > 0 && empGround < rebGround) ts -= 14;
      }
      // Don't waste activations on Coruscant or systems already saturated.
      if (sysId === 'coruscant') ts -= 3;
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
      const actF = side === 'Rebel' ? G.rebel : G.empire;
      const adj = G.catalog.adjacency[sysId] ?? [];
      // Transport-aware "can I actually bring units here?" — a ground unit or
      // restricted fighter only moves if a capital ship at the SAME source has
      // spare capacity to carry it (RR p.9). The old count treated every mobile
      // unit as pullable, so the AI would activate expecting a ground stack,
      // the move executor would find no carrier, and the leader landed alone
      // (player report #114: "activated leaders without accompanying troops").
      let movable = 0;
      for (const a of adj) {
        if ((actF.leadersOnBoard[a] ?? []).length > 0) continue;
        const ss2 = G.map.systems[a];
        if (!ss2) continue;
        let selfMoving = 0; // capital ships: move themselves + provide capacity
        let capacity = 0;
        let needCarry = 0; // ground + restricted fighters: need a carrier
        for (const u of ss2.units) {
          if (u.side !== side) continue;
          const t = G.catalog.unitTypes[u.typeId];
          if (!t || t.transport.immobile) continue;
          if (t.transport.capacity > 0) { selfMoving++; capacity += t.transport.capacity; }
          else needCarry++;
        }
        movable += selfMoving + Math.min(capacity, needCarry);
      }
      const ownHere = sys.units.filter((u) => u.side === side).length;
      if (movable === 0 && ownHere === 0) {
        // Nothing can actually be brought and no force already there → the
        // leader would sit alone. Strong negative so the AI moves a different
        // fleet, runs a mission, or passes (passing IS correct when no unit can
        // usefully move — user's clarification).
        ts = -50;
      }
    }
    systemScore.set(sysId, ts);
  }
  // For each pool leader, pick their best target.
  for (const leaderId of f.leaderPool as LeaderId[]) {
    const l = G.catalog.leaders[leaderId];
    if (!l) continue;
    // RR: "A leader that does not have tactic values cannot activate a system."
    // Skip the three no-tactic leaders (Boba Fett, Greejatus, Mon Mothma) —
    // they can still run missions / block enemy move-outs, just not lead a move.
    if (l.tacticValues.space + l.tacticValues.ground === 0) continue;
    let bestT: SystemId | null = null;
    let bestTS = -Infinity;
    for (const sysId of allSystemIds) {
      const ts = systemScore.get(sysId) ?? 0;
      if (ts > bestTS) { bestTS = ts; bestT = sysId; }
    }
    if (!bestT || bestTS <= 0) continue;
    actions.push({
      kind: 'activate',
      leaderId,
      targetSystemId: bestT,
      score: bestTS,
    });
  }

  actions.push({ kind: 'pass', score: 0.5 });
  actions.sort((a, b) => b.score - a.score);
  // Return the full sorted list (pass is in there with score 0.5). The executor
  // tries them in order and skips any that the engine rejects, so a high-score
  // mission it can't actually reveal no longer forces a pass while feasible
  // lower-score actions go untried (player report #190).
  return actions;
}

/** Run one AI action for `side`. Returns true if something happened (caller
 *  should re-render and may call again), false if nothing left to do. */
export function stepOnce(G: GameState, side: Side): boolean {
  if (G.isGameOver) return false;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const did = stepOnceInner(G, side);
  const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  if (elapsed > 500) {
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
    // AI: spend the targeted burst on the most-damaged eligible enemy unit
    // (likeliest kill) — matches the old auto-pick heuristic.
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
    const target = [...c.candidates].sort((a, b) => remaining(a) - remaining(b))[0];
    return combat.resolveCinematicTargetPick(G, target).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'YodaReroll' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    if (c.context === 'dsplans') {
      // AI: reroll a blank toward the direct-hit the DSP roll needs, unless
      // it already has one. (#186)
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
    const rebelBase = G.map.rebelBaseSpace;
    const idToUnit = new Map(rebelBase.units.map((u) => [u.instanceId, u]));
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
      return phases.resolvePlayObjectivePick(G, '').ok;
    }
    return pc.window === 'combat'
      ? combat.resolveCombatObjectivePick(G, best).ok
      : phases.resolvePlayObjectivePick(G, best).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RaidOutpostsPlace' && G.pendingChoice.side === side) {
    // AI (Empire forced to place the Rebel's Raid Outposts markers): pick
    // remotes the Rebel is least likely to reach — prefer ones without a
    // Rebel ground unit, else the first legal ones. Deterministic.
    const pc = G.pendingChoice;
    const score = (sid: string) =>
      (G.map.systems[sid]?.units ?? []).some((u) => u.side === 'Rebel') ? 1 : 0;
    const picks = [...pc.legal].sort((a, b) => score(a) - score(b)).slice(0, pc.count);
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
    // AI: pick the deck with more remaining cards (avoid drawing 0 of 0).
    const theater: 'space' | 'ground' = G.groundTacticDeck.length >= G.spaceTacticDeck.length ? 'ground' : 'space';
    return combat.resolveMoreDangerousTheaterPick(G, theater).ok;
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
    const scoreSystem = (sysId: string): number => {
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
    let bestSys = c.candidates[0];
    let bestScore = -Infinity;
    for (const sysId of c.candidates) {
      const s = scoreSystem(sysId);
      if (s > bestScore) { bestScore = s; bestSys = sysId; }
    }
    return phases.resolveDeployUnitPick(G, bestSys).ok;
  }
  // Plant False Lead: AI Rebel buries all taken probe cards on the bottom of
  // the deck (denies the Empire that ruled-out intel for the longest).
  if (G.pendingChoice && G.pendingChoice.kind === 'PlantFalseLeadPlacement' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const placements = c.cards.map((cid) => ({ cardId: cid, position: 'bottom' as const }));
    return phases.resolvePlantFalseLeadPlacement(G, placements).ok;
  }
  // Detained: Empire picks any Rebel leader at the target.
  if (G.pendingChoice && G.pendingChoice.kind === 'DetainedTargetPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    return phases.resolveDetainedTargetPick(G, c.candidates[0]).ok;
  }
  // Retrieve The Plans: Empire bottoms the highest-rep Rebel objective.
  if (G.pendingChoice && G.pendingChoice.kind === 'RetrieveThePlansPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    let best = c.candidates[0];
    let bestRep = G.catalog.objectives[best]?.reputation ?? 0;
    for (const oid of c.candidates.slice(1)) {
      const r = G.catalog.objectives[oid]?.reputation ?? 0;
      if (r > bestRep) { best = oid; bestRep = r; }
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
    return phases.resolveRegionalAidPick(G, c.candidates[0]).ok;
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
    const src = c.candidateSourceSystemIds[0];
    if (!src) return phases.resolveCatchThemBySurpriseMovePick(G, '', []).ok;
    const units = G.map.systems[src].units.filter((u) => u.side === 'Empire');
    // Use the same greedy-pack heuristic.
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
    return phases.resolveCatchThemBySurpriseMovePick(G, src, picks).ok;
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
  // Start The Evacuation: pick the first non-Imperial system, move all
  // mobile Rebel Base units that fit.
  if (G.pendingChoice && G.pendingChoice.kind === 'StartEvacuationPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const target = c.candidateSystemIds[0];
    if (!target) return phases.resolveStartEvacuationPick(G, '', []).ok;
    // Greedy pack like Hidden Fleet.
    const baseUnits = G.map.rebelBaseSpace.units.filter((u) => c.candidateUnitIds.includes(u.instanceId));
    const capShipIds: string[] = [];
    const fighterIds: string[] = [];
    const groundIds: string[] = [];
    for (const u of baseUnits) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      if (t.transport.capacity > 0) capShipIds.push(u.instanceId);
      else if (t.transport.restriction) fighterIds.push(u.instanceId);
      else if (t.theater === 'ground' && t.class !== 'structure') groundIds.push(u.instanceId);
    }
    let cap = capShipIds.reduce((s, uid) => {
      const u = baseUnits.find((x) => x.instanceId === uid);
      return s + (u ? (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) : 0);
    }, 0);
    const picks = [...capShipIds];
    for (const uid of [...fighterIds, ...groundIds]) {
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
    const capShipIds: string[] = [];
    const fighterIds: string[] = [];
    const groundIds: string[] = [];
    for (const u of baseUnits) {
      const t = G.catalog.unitTypes[u.typeId];
      if (!t) continue;
      if (t.transport.capacity > 0) capShipIds.push(u.instanceId);
      else if (t.transport.restriction) fighterIds.push(u.instanceId);
      else if (t.theater === 'ground' && t.class !== 'structure') groundIds.push(u.instanceId);
    }
    let capacity = capShipIds.reduce((s, uid) => {
      const u = baseUnits.find((x) => x.instanceId === uid);
      return s + (u ? (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0) : 0);
    }, 0);
    const picks = [...capShipIds];
    for (const uid of [...fighterIds, ...groundIds]) {
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
    const picks = c.icons.map((icon) => {
      const need = tierRank[icon.shape] ?? 2;
      const opts = Object.values(G.catalog.unitTypes)
        .filter((t) => t.side === side && t.theater === icon.theater
          && t.class !== 'structure' && (tierRank[t.tier ?? 'square'] ?? 2) <= need
          // RoE units only buildable with the expansion's unit toggle on (#219).
          && (t.set !== 'rote' || G.expansion?.roeUnits === true))
        .sort((a, b) => (tierRank[a.tier ?? 'square'] ?? 2) - (tierRank[b.tier ?? 'square'] ?? 2));
      return opts.length > 0 ? opts[opts.length - 1].id : null; // highest tier <= icon
    });
    let r = phases.resolveBuildFromIconsPick(G, picks);
    // Fail-safe: a single invalid pick rejects the whole call, which would
    // leave this choice pending forever (tournament showed games stuck here).
    // Retry skipping every icon (all-null is always accepted) so we resolve.
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
    const threatened = G.rebelBaseRevealed || empireProximityToBase(G) > 0;
    // move-units is only legal while the base is unrevealed; when revealed
    // (always "threatened") we fall to establish-base anyway.
    const branch = threatened ? 'establish-base' : 'move-units';
    return phases.resolveRapidMobilizationBranch(G, branch).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationMovePick' && G.pendingChoice.side === side) {
    // Find any Rebel-occupied system and move up to 5 units to base.
    let srcSys: string | null = null;
    let picks: string[] = [];
    for (const sysId of Object.keys(G.map.systems)) {
      // Skip systems with a friendly leader — RM can't move units out of them
      // (rr p.2), and the engine now rejects such a move.
      if ((G.rebel.leadersOnBoard[sysId] ?? []).length > 0) continue;
      const rebels = G.map.systems[sysId].units.filter((u) => u.side === 'Rebel');
      if (rebels.length > 0) { srcSys = sysId; picks = rebels.slice(0, 5).map((u) => u.instanceId); break; }
    }
    if (!srcSys) {
      // Nothing to move — bail without picks.
      return phases.resolveRapidMobilizationMove(G, Object.keys(G.map.systems)[0], []).ok;
    }
    return phases.resolveRapidMobilizationMove(G, srcSys, picks).ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'RapidMobilizationBasePick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const candidates = c.baseRevealed
      ? Object.keys(G.map.systems)
      : (c.probeSystemIds ?? []);
    if (candidates.length === 0) {
      // No legal target — just clear the choice via no-op (pick current base
      // — engine will accept any valid system in revealed case).
      const fallback = Object.keys(G.map.systems)[0];
      return phases.resolveRapidMobilizationBasePick(G, fallback).ok;
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
  if (G.pendingChoice && G.pendingChoice.kind === 'InterrogationDroidDecoyPick' && G.pendingChoice.side === side) {
    const c = G.pendingChoice;
    const decoys = c.candidates.filter((sid) => sid !== G.rebelBaseSystemId).slice(0, c.count);
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
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const sorted = c.candidates
      .map((uid) => {
        const u = ss?.units.find((x) => x.instanceId === uid);
        const t = u ? G.catalog.unitTypes[u.typeId] : null;
        return { uid, hp: t?.health.value ?? 0, tier: tierRank[t?.tier ?? 'triangle'] ?? 0 };
      })
      .sort((a, b) => b.tier - a.tier || b.hp - a.hp);
    let spent = 0;
    const picks: string[] = [];
    for (const x of sorted) {
      if (spent + x.hp > c.budget) continue;
      if (c.unitCap != null && picks.length >= c.unitCap) break; // Plant Explosives: ≤3 units (#303)
      picks.push(x.uid); spent += x.hp;
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
    // AI: keep the higher-rep card.
    const c = G.pendingChoice;
    const [a, b] = c.drawnIds;
    const repA = G.catalog.objectives[a]?.reputation ?? 0;
    const repB = G.catalog.objectives[b]?.reputation ?? 0;
    const keep = repA >= repB ? a : b;
    const r = phases.resolveCovertOperationPick(G, keep);
    return r.ok;
  }
  if (G.pendingChoice && G.pendingChoice.kind === 'InfiltrationPick' && side === 'Rebel') {
    const c = G.pendingChoice;
    const repTop = G.catalog.objectives[c.topId]?.reputation ?? 0;
    const repBottom = G.catalog.objectives[c.bottomId]?.reputation ?? 0;
    const keep = repTop >= repBottom ? c.topId : c.bottomId;
    const r = phases.resolveInfiltrationPick(G, keep);
    return r.ok;
  }

  // From here on, only act on our own turn. Above are pendingChoice
  // handlers that may fire even when it's the other side's turn.
  if (G.currentPlayer !== side) return false;

  switch (G.phase) {
    case 'Setup': {
      // If we're the Rebel and a base pick is pending, pick first.
      if (side === 'Rebel' && G.pendingRebelBasePick && G.pendingRebelBasePick.length > 0) {
        const picked = pick(G.pendingRebelBasePick)!;
        const r = phases.pickRebelBase(G, picked);
        if (r.ok) return true;
      }
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
      // Try actions in descending score order, skipping any the engine rejects,
      // so a high-score mission we can't actually reveal no longer forces a
      // pass while feasible lower-score actions go untried (player report #190).
      const commandActions = bestCommandAction(G, side);
      for (const action of commandActions) {
      if (action.kind === 'pass') {
        return phases.pass(G, side).ok;
      }
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
        continue; // can't reveal this mission anywhere — try the next action
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
        const orders: phases.MoveOrder[] = [];
        const f = side === 'Rebel' ? G.rebel : G.empire;
        const adj = G.catalog.adjacency[action.targetSystemId] ?? [];
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
        const sources = adj.filter((sysId) => {
          if ((f.leadersOnBoard[sysId] ?? []).length > 0) return false;
          if (prisonSystems.has(sysId)) return false; // guard captured leaders
          if (sysId === baseDrainGuard) return false; // guard the revealed base
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
          for (const u of mine) {
            const t = G.catalog.unitTypes[u.typeId];
            if (!t || t.transport.immobile) continue;
            if (t.transport.capacity > 0) capitalShips.push(u);
            else if (t.theater === 'ground' && t.class !== 'structure') ground.push(u);
            else if (t.transport.restriction) fighters.push(u);
          }
          // Empire subjugation reserve: keep 1 ground at subjugated systems
          // so the subjugation marker stays.
          const groundReserve = (side === 'Empire' && ss.subjugated && ground.length > 0) ? 1 : 0;
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
            ...fightersToBring.map((u) => u.instanceId),
            ...groundToBring.map((u) => u.instanceId),
          ];
          if (pickIds.length > 0) {
            orders.push({ fromSystemId: fromId, unitInstanceIds: pickIds });
          }
        }
        // Don't waste an activation on a lone leader that moves NO units and
        // starts NO combat — it just sits there (player reports #92/#93:
        // "activated Palpatine but moved no units"). If there's an enemy at the
        // target a leaderless move still triggers a worthwhile fight; otherwise
        // pass and keep the leader available.
        if (orders.length === 0) {
          const tss = G.map.systems[action.targetSystemId];
          const enemyAtTarget = tss?.units.some((u) => u.side !== side) ?? false;
          if (!enemyAtTarget) continue; // useless activation — try the next action
        }
        const r = phases.activateSystem(G, side, action.leaderId, action.targetSystemId, orders);
        if (r.ok) return true;
        continue; // activation rejected — try the next action
      }
      } // end for over commandActions
      return phases.pass(G, side).ok;
    }
    default:
      return false;
  }
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
  // GERRY STRATEGY: Empire skips opposition in the early game (T1-T4)
  // unless the mission is genuinely high-impact. Every leader NOT spent
  // opposing is a leader free to activate, spread, and subjugate —
  // which is the Empire's real win condition. Late game (T5+) we
  // resume the normal "always defend" math.
  const empireEarlyGameSkip =
    side === 'Empire' &&
    G.timeMarker <= 4 &&
    !isHighImpactMissionForOpposer(c.missionId, side);
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
  const r = phases.resolveOpposition(G, sentLeader);
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
    if (sdFloor && p.iconShape === 'square' && p.iconType === 'space' && ok('star-destroyer')) choice = 'star-destroyer';
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
  const idx = c.blankIndices.length > 0 ? c.blankIndices[0] : null;
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

/** AI: skip Start-of-Combat action cards (effects aren't wired anyway). */
function handleCombatStartActionCards(G: GameState): boolean {
  const r = combat.resolveCombatStartActionCards(G, []);
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
