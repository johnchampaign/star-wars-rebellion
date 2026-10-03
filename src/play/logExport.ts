// Readable game-log export (#796: "dump full game logs and messages at game
// end" — a player wanted to hand the whole game to an AI and get the story of
// it back). Plain text, oldest first, with catalog ids turned into names.
//
// It never reveals more than the on-screen log: the caller passes the same
// visibility rules LogPanel uses, so an opponent's secret plays stay
// "(private)" here too. Pure — no DOM — so it can be tested headless.
import type { GameState, LogEntry, Side } from '../engine/types';

export type LogVisibility = {
  /** Entry is shown at all (else omitted). */
  visible: (e: LogEntry) => boolean;
  /** Occurrence is public but the payload is not. */
  redacted: (e: LogEntry) => boolean;
  /** Card draws: only the count is public. */
  countOnly: (e: LogEntry) => boolean;
};

export type ExportChatMessage = { seat: string; body: string; at: string };

export type ReadableLogOpts = {
  humanSide: Side;
  vis: LogVisibility;
  /** Online games: the opponent is a person, and chat is included. */
  online?: boolean;
  chat?: ExportChatMessage[] | null;
  /** Online games whose chat could not be loaded. */
  chatError?: string;
  now?: Date;
};

/** Payload keys that are bookkeeping, not story. */
const SKIP_KEYS = new Set(['codec', 'seq', 'unit', 'units', 'instanceId', 'instanceIds', 'unitInstanceIds']);

function humanizeKey(k: string): string {
  return k.replace(/Ids?$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function nameLookup(G: GameState): (v: string) => string {
  const c = G.catalog as unknown as Record<string, Record<string, { name?: string } | undefined> | undefined>;
  const tables = ['leaders', 'systems', 'missions', 'actions', 'objectives', 'unitTypes', 'tactics', 'projects'];
  return (v: string) => {
    if (v === 'rebel-base-space') return 'the Rebel Base';
    for (const t of tables) {
      const hit = c[t]?.[v];
      if (hit?.name) return hit.name;
    }
    return v;
  };
}

function renderValue(v: unknown, name: (s: string) => string, depth = 0): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return name(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return 'none';
    return v.map((x) => renderValue(x, name, depth + 1)).join(', ');
  }
  if (typeof v === 'object') {
    if (depth > 2) return '…';
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !SKIP_KEYS.has(k))
      .map(([k, x]) => `${humanizeKey(k)} ${renderValue(x, name, depth + 1)}`);
    return parts.length ? `(${parts.join('; ')})` : '';
  }
  return String(v);
}

/** One log entry as a line of text. */
export function readableEntry(G: GameState, e: LogEntry, vis: LogVisibility): string {
  const name = nameLookup(G);
  const who = e.side ? `${e.side} · ` : '';
  const what = e.kind.replace(/-/g, ' ');
  if (vis.countOnly(e)) {
    const n = (e.payload as { count?: number } | undefined)?.count ?? 1;
    return `${who}${what}: drew ${n} (which cards is hidden)`;
  }
  if (vis.redacted(e)) return `${who}${what} (private)`;
  const p = e.payload ?? {};
  const fields = Object.entries(p)
    .filter(([k]) => !SKIP_KEYS.has(k))
    .map(([k, v]) => `${humanizeKey(k)}: ${renderValue(v, name)}`);
  return fields.length ? `${who}${what} — ${fields.join(', ')}` : `${who}${what}`;
}

/** The whole game as a text document: header, then turn by turn, then chat. */
export function buildReadableLog(G: GameState, opts: ReadableLogOpts): string {
  const { humanSide, vis } = opts;
  const opponent: Side = humanSide === 'Rebel' ? 'Empire' : 'Rebel';
  const now = opts.now ?? new Date();
  const out: string[] = [];
  out.push('STAR WARS: REBELLION — GAME LOG');
  out.push(`Exported ${now.toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  out.push(`You played the ${humanSide}. Opponent: the ${opponent} (${opts.online ? 'another player' : 'the computer'}).`);
  if (G.expansion?.enabled) out.push('Rise of the Empire expansion: on.');
  if (G.isGameOver) {
    out.push(`Result: ${G.winner ? `the ${G.winner} won` : 'game over'}${G.winReason ? ` (${G.winReason.replace(/-/g, ' ')})` : ''}.`);
  } else {
    out.push(`Game in progress: round ${G.timeMarker}, ${G.phase} phase. Reputation marker on ${G.reputationMarker}.`);
  }
  out.push('Entries the rules keep secret from you are marked "(private)" or left out.');

  let lastTurn: number | null = null;
  for (const e of G.turnLog ?? []) {
    if (!vis.visible(e)) continue;
    if (e.turn !== lastTurn) {
      out.push('');
      out.push(`=== Round ${e.turn} ===`);
      lastTurn = e.turn;
    }
    out.push(readableEntry(G, e, vis));
  }

  if (opts.online) {
    out.push('');
    out.push('=== Chat ===');
    if (opts.chatError) out.push(`(chat could not be loaded: ${opts.chatError})`);
    else if (!opts.chat || opts.chat.length === 0) out.push('(no messages)');
    else for (const m of opts.chat) out.push(`[${m.at.replace('T', ' ').slice(0, 16)}] ${m.seat}: ${m.body}`);
  }
  out.push('');
  return out.join('\n');
}
