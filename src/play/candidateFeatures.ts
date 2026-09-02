// Feature extraction for the imitation ranker (docs/imitation-plan.md, step 2).
//
// One numeric vector per (position, candidate). Used identically by the
// trainer (scripts/train-ranker.mjs, over the mined human decisions) and by
// the runtime ranker (candidateRanker.ts, inside the MCTS root), so the two
// can never drift apart. Keep it engine-pure: no randomness, no I/O.
//
// Design notes:
//  - Features are cheap board reads plus the heuristic's own score, so the
//    ranker learns a CORRECTION to the heuristic rather than replacing it.
//  - Mission identity is one-hot (the human has strong per-mission
//    preferences the scorer's flat base values don't capture); everything
//    else is a small, interpretable number. ~90 dims.
//  - Standardisation (mean/std) lives in the trained weights, not here.
import type { GameState, Side, SystemId } from '../engine/types';
import type { CommandAction } from './randomAI';

const other = (s: Side): Side => (s === 'Rebel' ? 'Empire' : 'Rebel');

/** Stable feature order. Mission one-hots are appended from the catalog at
 *  runtime in sorted id order, so the vector length depends on the catalog —
 *  the trained weights record the names and are checked against them. */
export const BASE_FEATURES = [
  // position
  'time', 'repGap', 'baseRevealed', 'isRebel', 'nCands', 'poolSize',
  'ownSpaceRatio', 'ownGroundRatio', 'missionsInHand', 'leadersOnMissions',
  // candidate shape
  'kindReveal', 'kindActivate', 'kindPass', 'heurScore', 'rank', 'isTop',
  // reveal
  'skillCost', 'isAttempt', 'skillDiplomacy', 'skillIntel', 'skillSpecOps', 'skillLogistics',
  // target (reveal or activate)
  'tgtLoyalOwn', 'tgtLoyalNeutral', 'tgtLoyalEnemy', 'tgtSubjugated', 'tgtSabotage', 'tgtRemote',
  'tgtResources', 'tgtIsBase', 'tgtBaseRegion', 'tgtDistBase', 'tgtEnemySpace', 'tgtEnemyGround',
  'tgtOwnSpace', 'tgtOwnGround', 'tgtHasEnemy', 'tgtHasOwn', 'tgtEnemyLeader', 'tgtOwnLeader',
  // activate
  'ldrSpace', 'ldrGround', 'adjOwnUnits', 'adjOwnSpace', 'adjOwnGround',
] as const;

function bfs(G: GameState, origin: SystemId): Map<string, number> {
  const dist = new Map<string, number>([[origin, 0]]);
  const q: SystemId[] = [origin];
  while (q.length) {
    const cur = q.shift() as SystemId; const d = dist.get(cur) as number;
    for (const nb of G.catalog.adjacency[cur] ?? []) if (!dist.has(nb)) { dist.set(nb, d + 1); q.push(nb); }
  }
  return dist;
}

function healthAt(G: GameState, side: Side, sid: SystemId): { space: number; ground: number; n: number } {
  let space = 0, ground = 0, n = 0;
  const scan = (units: { side: Side; typeId: string }[] | undefined) => {
    for (const u of units ?? []) {
      if (u.side !== side) continue; const t = G.catalog.unitTypes[u.typeId]; if (!t) continue;
      n++; if (t.theater === 'space') space += t.health.value; else ground += t.health.value;
    }
  };
  scan(G.map.systems[sid]?.units);
  if (sid === G.rebelBaseSystemId) scan(G.map.rebelBaseSpace?.units);
  return { space, ground, n };
}

function totalHealth(G: GameState, side: Side): { space: number; ground: number } {
  let space = 0, ground = 0;
  for (const sid of Object.keys(G.map.systems)) { const h = healthAt(G, side, sid as SystemId); space += h.space; ground += h.ground; }
  return { space, ground };
}

/** Per-position context computed once, shared across the position's candidates. */
export interface PositionContext {
  side: Side; nCands: number; baseDist: Map<string, number> | null; own: { space: number; ground: number }; enemy: { space: number; ground: number };
  baseRegion: number | undefined; missionIds: string[];
}

export function positionContext(G: GameState, side: Side, nCands: number): PositionContext {
  const missionIds = Object.keys(G.catalog.missions).sort();
  const base = G.rebelBaseSystemId;
  return {
    side, nCands,
    baseDist: base && (side === 'Rebel' || G.rebelBaseRevealed) ? bfs(G, base) : null,
    own: totalHealth(G, side), enemy: totalHealth(G, other(side)),
    baseRegion: base ? G.catalog.systems[base]?.region : undefined,
    missionIds,
  };
}

export function featureNames(G: GameState): string[] {
  return [...BASE_FEATURES, ...Object.keys(G.catalog.missions).sort().map((m) => `mission:${m}`)];
}

export function candidateFeatures(G: GameState, ctx: PositionContext, c: CommandAction, rank: number): number[] {
  const side = ctx.side; const enemy = other(side);
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const v: number[] = [];
  const push = (x: number | boolean) => v.push(typeof x === 'boolean' ? (x ? 1 : 0) : (Number.isFinite(x) ? x : 0));
  // position
  push(G.timeMarker / 16); push(Math.max(0, G.reputationMarker - G.timeMarker) / 14); push(!!G.rebelBaseRevealed); push(side === 'Rebel');
  push(ctx.nCands / 12); push((f.leaderPool?.length ?? 0) / 8);
  push(ctx.own.space / Math.max(1, ctx.own.space + ctx.enemy.space)); push(ctx.own.ground / Math.max(1, ctx.own.ground + ctx.enemy.ground));
  push((f.missionHand?.length ?? 0) / 8); push((f.leadersOnMissions?.length ?? 0) / 6);
  // candidate shape
  push(c.kind === 'reveal'); push(c.kind === 'activate'); push(c.kind === 'pass'); push((c.score ?? 0) / 50); push(rank / 12); push(rank === 0);
  // reveal
  const m = c.kind === 'reveal' ? G.catalog.missions[c.missionId] : undefined;
  push(m ? (m.skillCost ?? 0) / 3 : 0); push(!!m?.isAttempt);
  push(m?.skill === 'diplomacy'); push(m?.skill === 'intel'); push(m?.skill === 'specOps'); push(m?.skill === 'logistics');
  // target
  const tgt = c.kind === 'pass' ? undefined : (c.targetSystemId as SystemId | undefined);
  const ss = tgt ? G.map.systems[tgt] : undefined; const sd = tgt ? G.catalog.systems[tgt] : undefined;
  const ownLoy = side === 'Rebel' ? 'rebel' : 'imperial'; const enemyLoy = side === 'Rebel' ? 'imperial' : 'rebel';
  push(ss?.loyalty === ownLoy); push(ss?.loyalty === 'neutral'); push(ss?.loyalty === enemyLoy); push(!!ss?.subjugated); push(!!ss?.sabotage); push(!!sd?.isRemote);
  push((sd?.resources?.length ?? 0) / 3); push(!!tgt && tgt === G.rebelBaseSystemId); push(!!tgt && sd?.region !== undefined && sd.region === ctx.baseRegion);
  push(tgt && ctx.baseDist ? Math.min(6, ctx.baseDist.get(tgt) ?? 6) / 6 : 0.5);
  const he = tgt ? healthAt(G, enemy, tgt) : { space: 0, ground: 0, n: 0 }; const ho = tgt ? healthAt(G, side, tgt) : { space: 0, ground: 0, n: 0 };
  push(Math.min(30, he.space) / 30); push(Math.min(20, he.ground) / 20); push(Math.min(30, ho.space) / 30); push(Math.min(20, ho.ground) / 20);
  push(he.n > 0); push(ho.n > 0);
  const el = tgt ? ((enemy === 'Rebel' ? G.rebel : G.empire).leadersOnBoard?.[tgt]?.length ?? 0) : 0;
  const ol = tgt ? (f.leadersOnBoard?.[tgt]?.length ?? 0) : 0;
  push(el > 0); push(ol > 0);
  // activate
  const ldr = c.kind === 'activate' ? G.catalog.leaders[c.leaderId] : undefined;
  push(ldr ? (ldr.tacticValues?.space ?? 0) / 3 : 0); push(ldr ? (ldr.tacticValues?.ground ?? 0) / 3 : 0);
  let adjN = 0, adjS = 0, adjG = 0;
  if (c.kind === 'activate' && tgt) for (const nb of G.catalog.adjacency[tgt] ?? []) { const h = healthAt(G, side, nb as SystemId); adjN += h.n; adjS += h.space; adjG += h.ground; }
  push(Math.min(12, adjN) / 12); push(Math.min(30, adjS) / 30); push(Math.min(20, adjG) / 20);
  // mission one-hots
  const mid = c.kind === 'reveal' ? c.missionId : null;
  for (const id of ctx.missionIds) push(mid === id);
  return v;
}
