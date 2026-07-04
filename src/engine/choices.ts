// Unified player-choice framework.
//
// The engine historically threaded every player prompt through five parallel
// registries (a ChoiceRequest union member, a choiceOwner case, a bespoke
// resolver, a bespoke UI modal + render block, an AI branch, and — on the
// online branch — an adapter action). Adding one meant coordinated edits in all
// of them, and missing any single layer soft-locked the game.
//
// This module collapses that to ONE data-driven `Choice` kind (see
// GenericChoice in types.ts) backed by a tag -> resolver registry. A new prompt
// is now: (1) `requestChoice(...)` with a tag + serializable spec, and (2)
// `registerChoice(tag, fn)` with the follow-up effect. The generic UI modal,
// the generic AI fallback, the single `choiceOwner` case, and (on the branch)
// the single `resolveChoice` adapter action are written once and never touched
// again.
//
// The resolver signature is deliberately identical in spirit to the effect
// handler registry (handlers/registry.ts): plain functions over GameState, with
// all state kept as serializable data on `pendingChoice` so it round-trips
// through codec.encodeFull for online play.

import type { GameState, GenericChoice, ChoiceContext } from './types';

/** A tag resolver: performs the choice's effect given the validated selection
 *  (candidate ids the player picked) and the choice's serialized context. It
 *  OWNS its own resume — after applying the effect it must hand control back to
 *  whatever flow was paused (e.g. resumeMissionAfterChoice, runCombat,
 *  continueRefreshAfterObjectives), or raise a follow-up choice. */
export type ChoiceResolver = (
  G: GameState,
  selection: string[],
  context: ChoiceContext,
) => void;

const choiceRegistry = new Map<string, ChoiceResolver>();

export function registerChoice(tag: string, resolver: ChoiceResolver): void {
  choiceRegistry.set(tag, resolver);
}

export function getChoiceResolver(tag: string): ChoiceResolver | undefined {
  return choiceRegistry.get(tag);
}

/** All registered tags, sorted — used by a coverage tripwire test so a
 *  `requestChoice` tag can't ship without a matching resolver. */
export function listChoiceTags(): string[] {
  return [...choiceRegistry.keys()].sort();
}

/** Raise a generic choice, pausing the calling flow. The caller must then
 *  return up its own call stack so the engine yields until the choice is
 *  answered (same discipline as setting any pendingChoice). Do not call while a
 *  pendingChoice is already set. */
export function requestChoice(G: GameState, spec: Omit<GenericChoice, 'kind'>): void {
  G.pendingChoice = { kind: 'Choice', ...spec };
}

export type ChoiceResult = { ok: boolean; reason?: string };

/** Validate and dispatch the pending generic choice.
 *
 *  `selection` is the list of chosen candidate ids (order preserved for the
 *  resolver, e.g. reorder choices). Validates that every id is a live
 *  (non-disabled) candidate, that there are no duplicates, and that the count
 *  is within [min, max]. On success it clears `pendingChoice` BEFORE invoking
 *  the tag resolver — so the resolver's own resume calls (which bail while a
 *  pendingChoice is set) see a clear slate — then runs the resolver, which
 *  applies the effect and resumes.
 */
export function resolveGenericChoice(G: GameState, selection: string[]): ChoiceResult {
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'Choice') return { ok: false, reason: 'no-generic-choice' };

  const liveIds = new Set(pc.candidates.filter((c) => !c.disabled).map((c) => c.id));
  const seen = new Set<string>();
  for (const id of selection) {
    if (!liveIds.has(id)) return { ok: false, reason: `bad-candidate:${id}` };
    if (seen.has(id)) return { ok: false, reason: `duplicate:${id}` };
    seen.add(id);
  }
  if (selection.length < pc.min) return { ok: false, reason: `too-few:${selection.length}<${pc.min}` };
  if (selection.length > pc.max) return { ok: false, reason: `too-many:${selection.length}>${pc.max}` };

  const resolver = getChoiceResolver(pc.tag);
  if (!resolver) return { ok: false, reason: `no-resolver:${pc.tag}` };

  const context: ChoiceContext = pc.context ?? {};
  const picked = [...selection];
  G.pendingChoice = undefined;
  resolver(G, picked, context);
  return { ok: true };
}
