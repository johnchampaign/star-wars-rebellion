// Undo stack for the Refresh deploy step (units coming off the build queue).
//
// Added for #670 ("deployment is one-click-and-done, prone to misclicks"), but
// the first version was a bare array that nothing ever cleared. Snapshots from
// an earlier turn's deploy step stayed on it, so once you had exhausted the
// current step's own entries, "Undo last placement" happily popped a snapshot
// from a PREVIOUS turn and rewound the whole game (#684).
//
// The fix is to stamp every snapshot with the deploy step it belongs to and
// refuse to pop across a step boundary. Kept as a standalone pure module so the
// behaviour is testable without mounting PlayTab (see
// scripts/test-deploy-undo-turn-boundary-684.mjs).

/** The pieces of game state that identify one deploy step. */
export type DeployStepIdentity = {
  timeMarker?: number;
  phase?: string;
  // `unknown` because ChoiceRequest is a union and several of its variants
  // carry no `side` at all — narrowing happens below.
  pendingChoice?: unknown;
};

/** Identity of the deploy step a snapshot belongs to. A deploy step is scoped
 *  to one turn, one phase, and one side — undo must never reach past any of
 *  those boundaries. */
export function deployStepKey(g: DeployStepIdentity): string {
  const side = (g.pendingChoice as { side?: string } | undefined)?.side;
  return `${g.timeMarker ?? '?'}:${g.phase ?? '?'}:${side ?? '?'}`;
}

type Entry<T> = { key: string; snap: T };

/** A step-scoped undo stack. Entries belonging to an older deploy step are
 *  dropped rather than returned, so undo can only ever walk back through
 *  placements made in the step you are currently in. */
export class DeployUndoStack<T> {
  private entries: Entry<T>[] = [];

  /** Snapshot for the step `key`. Starting a new step discards anything left
   *  over from the previous one — that leftover is exactly the #684 rewind. */
  push(key: string, snap: T): void {
    this.dropStale(key);
    this.entries.push({ key, snap });
  }

  /** Most recent snapshot for `key`, or null if this step has none. */
  pop(key: string): T | null {
    this.dropStale(key);
    return this.entries.pop()?.snap ?? null;
  }

  /** How many undos are available in the step `key` — what the button's
   *  disabled state should read. Never counts another step's leftovers. */
  depth(key: string): number {
    return this.entries.reduce((n, e) => n + (e.key === key ? 1 : 0), 0);
  }

  /** Forget everything (new game, load, etc.). */
  clear(): void {
    this.entries.length = 0;
  }

  private dropStale(key: string): void {
    if (this.entries.length > 0 && this.entries[this.entries.length - 1].key !== key) {
      this.entries.length = 0;
    }
  }
}
