// Which queued event-report modal shows next.
//
// Reports of five kinds pile up while the opponent takes their turn (combat,
// mission, objective, refresh, system-activation). Only ONE modal shows at a
// time, and it must be the chronologically earliest — by the `seq` stamp each
// report carries (the turnLog length when it was queued), NOT by kind.
//
// Lives here, out of the PlayTab JSX, so the ordering rule is pinned by
// scripts/test-report-order-732-733.mjs instead of by eyeballing the component.

export type ReportKind = 'combat' | 'mission' | 'objective' | 'refresh' | 'activation';

/** The queue heads the UI currently holds. Only `seq` (and `startedCombat` on
 *  the activation report) matter for ordering, so this takes the minimum shape
 *  rather than the five full report types. */
export type ReportQueueHeads = {
  combat?: { seq?: number };
  mission?: { seq?: number };
  objective?: { seq?: number };
  refresh?: { seq?: number };
  /** Only pass this when the activation report is ELIGIBLE — i.e. nothing is
   *  mid-resolution (no pending mission/combat/choice). An activation modal on
   *  top of a live combat would cover that combat's prompts. */
  activation?: { seq?: number; startedCombat?: boolean };
};

/** Stable per-kind tiebreak for reports queued at the same seq.
 *
 *  An activation that STARTED a combat is the one deliberate exception. Its
 *  report and the combat report it spawns are stamped from the same turnLog
 *  length — activateSystem queues its report, then beginCombat stamps the
 *  combat report before it logs `combat-begin` — so the two always tie and the
 *  priority alone decided. That put the battle result on screen before the
 *  "who moved in" screen that caused it (#733). The move is the cause, so it
 *  wins the tie; an activation that started no combat keeps the ordinary low
 *  priority. */
function priority(kind: ReportKind, heads: ReportQueueHeads): number {
  switch (kind) {
    case 'combat': return 0;
    case 'mission': return 1;
    case 'objective': return 2;
    case 'refresh': return 3;
    case 'activation': return heads.activation?.startedCombat ? -1 : 4;
  }
}

const KINDS: ReportKind[] = ['combat', 'mission', 'objective', 'refresh', 'activation'];

/** The kind of report whose modal should show now, or null if none is queued. */
export function nextReportKind(heads: ReportQueueHeads): ReportKind | null {
  const candidates = KINDS
    .filter((k) => !!heads[k])
    .map((k) => ({ kind: k, seq: heads[k]!.seq ?? 0, prio: priority(k, heads) }));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.seq - b.seq) || (a.prio - b.prio));
  return candidates[0].kind;
}
