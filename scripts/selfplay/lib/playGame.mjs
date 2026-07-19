// Headless single-game runner shared by the self-play batch (run-batch.mjs)
// and the strength harness (ai-strength/eval-strength.mjs).
//
// Policies per side: 'heuristic' (randomAI as-is), 'depth2' (eval-beam, the
// production Rebel), 'mcts' (determinized search, the production Empire),
// 'random' (uniform over the legal Command enumeration — the strength
// baseline; NON-Command choices stay on the shared heuristic handlers, since
// uniformly-random choice resolution mostly soft-locks into nonsense and
// measures nothing).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let _mods = null;
export async function loadModules() {
  if (_mods) return _mods;
  const { register } = await import('tsx/esm/api');
  register();
  const setup = await import('../../../src/engine/setup.ts');
  const phases = await import('../../../src/engine/phases.ts');
  const AI = await import('../../../src/play/randomAI.ts');
  const BE = await import('../../../src/play/boardEval.ts');
  const mcts = await import('../../../src/play/mctsAI.ts');
  const feats = await import('../../../src/play/evalFeatures.ts');
  const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
  const data = {
    systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
    actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
    tactics: j('tactics.json'), probes: j('probes.json'),
  };
  _mods = { setup, phases, AI, BE, mcts, feats, data };
  return _mods;
}

/** Deterministic PRNG for the 'random' policy (separate from the engine rng). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePolicy(mods, name, side, seed) {
  const { AI, BE, mcts, phases } = mods;
  if (name === 'heuristic') return null; // no override
  if (name === 'depth2') return (g, s) => BE.evalCommandStepDeep(g, s, 2);
  if (name === 'mcts') return (g, s) => mcts.mctsCommandStep(g, s);
  if (name === 'random') {
    const rng = mulberry32(seed * 7919 + (side === 'Rebel' ? 1 : 2));
    return (g, s) => {
      if (g.phase !== 'Command' || g.currentPlayer !== s) return false;
      if (g.pendingChoice || g.pendingMission || g.pendingCombat) return false;
      const acts = AI.bestCommandAction(g, s);
      if (acts.length === 0) return phases.pass(g, s).ok;
      // Uniform over the enumeration, scores ignored (that's the point).
      const a = acts[Math.floor(rng() * acts.length)];
      if (a.kind === 'pass') return phases.pass(g, s).ok;
      if (AI.tryCommandAction(g, s, a)) return true;
      return phases.pass(g, s).ok;
    };
  }
  throw new Error(`unknown policy: ${name}`);
}

/** Play one full game. Returns { winner, winReason, rounds, durationMs,
 *  actions, snapshots } with compact per-turn actions and one boardFeatures
 *  snapshot pair per round boundary. */
export async function playGame({ seed, rebel = 'heuristic', empire = 'heuristic', maxRounds = 16, collect = true }) {
  const mods = await loadModules();
  const { setup, AI, mcts, feats, data } = mods;
  const t0 = Date.now();
  const G = setup.createGame(data, { seed, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true } });
  AI.seedAI(seed * 13 + 1);
  mcts.seedMCTS(seed * 29 + 3);
  AI.setCommandPolicyOverride('Rebel', makePolicy(mods, rebel, 'Rebel', seed));
  AI.setCommandPolicyOverride('Empire', makePolicy(mods, empire, 'Empire', seed));

  const snapshots = [];
  let lastSnapTurn = 0;
  let guard = 0;
  try {
    while (!G.isGameOver && G.timeMarker <= maxRounds && guard++ < 12000) {
      if (collect && G.timeMarker !== lastSnapTurn) {
        lastSnapTurn = G.timeMarker;
        snapshots.push({
          t: G.timeMarker,
          rebel: feats.boardFeatures(G, 'Rebel').map((x) => +x.toFixed(3)),
          empire: feats.boardFeatures(G, 'Empire').map((x) => +x.toFixed(3)),
        });
      }
      const side = G.currentPlayer;
      if (!AI.stepOnce(G, side)) {
        const o = side === 'Rebel' ? 'Empire' : 'Rebel';
        if (!AI.stepOnce(G, o)) break;
      }
    }
  } finally {
    AI.setCommandPolicyOverride('Rebel', null);
    AI.setCommandPolicyOverride('Empire', null);
  }

  const actions = [];
  if (collect) {
    for (const e of G.turnLog) {
      if (e.kind === 'reveal-mission' && e.side) {
        actions.push({ t: e.turn, side: e.side, kind: 'reveal', id: e.payload?.missionId, target: e.payload?.targetSystemId });
      } else if (e.kind === 'activate-system' && e.side) {
        actions.push({ t: e.turn, side: e.side, kind: 'activate', id: e.payload?.leaderId, target: e.payload?.targetSystemId });
      } else if (e.kind === 'pass' && e.side) {
        actions.push({ t: e.turn, side: e.side, kind: 'pass' });
      }
    }
  }

  return {
    winner: G.winner ?? 'none',
    winReason: G.winReason ?? (G.isGameOver ? 'unknown' : 'stalled-or-maxrounds'),
    rounds: G.timeMarker,
    durationMs: Date.now() - t0,
    actions,
    snapshots,
    turnLog: G.turnLog, // for the dims adapter; NOT serialized into the record
  };
}
