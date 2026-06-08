// Effect handler registry. Cards reference handlers by their `effectKey` slug.
// A card with an effectKey that isn't registered is a "data-only" card — its
// rules text is shown, but no automatic effect runs.

import type { GameState, ChoiceRequest, Side, SystemId, LeaderId } from '../types';

export type EffectKind = 'mission' | 'action' | 'objective' | 'tactic';

export type EffectCard = { kind: EffectKind; id: string };

export type EffectContext = {
  actorSide: Side;
  card: EffectCard;
  // Resolution target — for missions, the chosen system. For tactic cards in
  // combat, the system where combat is taking place.
  targetSystemId?: SystemId;
  // For leader-target missions (Collect Bounty, Detained, etc.) — the
  // specific Rebel leader the Empire chose to go after. Undefined otherwise.
  targetLeaderId?: LeaderId;
  // Leaders attached to the originating mission/action (for "leaders assigned
  // to this mission" rules).
  leaderIds: LeaderId[];
  // RoE: the resolver's winning margin (resolver successes − opposer
  // successes, >= 0) for missions that resolved via a roll. Used by
  // "destroy up to the difference in successes" effects (Plant Explosives,
  // Assault). Undefined for auto-success missions.
  successMargin?: number;
  // Pause/resume state.
  pendingChoice: ChoiceRequest | null;
  handlerState: unknown;
  paused: boolean;
};

export type EffectHandler = (G: GameState, ctx: EffectContext) => boolean;

const registry = new Map<string, EffectHandler>();

export function register(effectKey: string, handler: EffectHandler): void {
  registry.set(effectKey, handler);
}

export function get(effectKey: string): EffectHandler | undefined {
  return registry.get(effectKey);
}

export function has(effectKey: string): boolean {
  return registry.has(effectKey);
}

export function listKeys(): string[] {
  return [...registry.keys()].sort();
}

/** Convenience: run a handler. Returns true if done, false if paused. */
export function invoke(G: GameState, ctx: EffectContext): boolean {
  const h = registry.get(/* effectKey lookup */ '');
  if (!h) return true;
  return h(G, ctx);
}

export function invokeByKey(G: GameState, key: string, ctx: EffectContext): boolean {
  const h = registry.get(key);
  if (!h) return true; // unregistered handlers no-op
  return h(G, ctx);
}

/** Build a fresh EffectContext. */
export function makeContext(
  actorSide: Side, card: EffectCard, opts: {
    targetSystemId?: SystemId; targetLeaderId?: LeaderId; leaderIds?: LeaderId[];
    successMargin?: number;
  } = {}
): EffectContext {
  return {
    actorSide, card,
    targetSystemId: opts.targetSystemId,
    targetLeaderId: opts.targetLeaderId,
    leaderIds: opts.leaderIds ?? [],
    successMargin: opts.successMargin,
    pendingChoice: null,
    handlerState: null,
    paused: false,
  };
}
