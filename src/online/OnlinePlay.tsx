// Minimal online-play screen (Phase 4). Drives a server game via the framework
// useGame() hook: polls the redacted view, shows whose turn it is, and submits
// actions. This is the bare loop that proves async two-player-over-network play
// + per-seat redaction end-to-end. Rendering the full PlayTab board against the
// server view (instead of OWNING a local engine) is the larger follow-on
// (PlayTab currently constructs its own engine state).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useGame } from 'digital-boardgame-framework/client';
import { makeGameClient } from './gameClient';
import PlayTab from '../play/PlayTab';
import type { GameState } from '../engine/types';
import type { RebellionAction } from '../adapter/rebellionAction';
import type { Side } from '../types';

export default function OnlinePlay({ gameId, token }: { gameId: string; token: string }) {
  const client = useMemo(() => makeGameClient(gameId, token), [gameId, token]);
  // Poll every 8s — quick enough to feel live, gentle on the Supabase free tier.
  const { view, yourTurn, turn, gameOver, you, submit, loading, error, refresh } =
    useGame<GameState, RebellionAction>(client, { pollMs: 8000 });
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [oppAbandoned, setOppAbandoned] = useState(false);

  // Re-sync immediately whenever the tab regains focus/visibility. Browsers
  // throttle or suspend background-tab timers (and a sleeping machine pauses
  // them entirely), so the 8s poll can stall for a long time. Without this,
  // returning to a backgrounded tab shows stale state — e.g. it still says
  // "waiting for opponent" while the server has already handed the turn back to
  // you (and the reminder email fired). Forcing a refresh on focus closes that
  // gap. A ref holds the latest refresh so we subscribe the listeners once.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState === 'visible') void refreshRef.current?.();
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('focus', resync);
    return () => {
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('focus', resync);
    };
  }, []);

  // While waiting on the opponent, poll for abandonment (the server returns
  // opponentAbandoned once they've been away past the grace period).
  useEffect(() => {
    if (yourTurn || gameOver) { setOppAbandoned(false); return; }
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch(`/api/games/${encodeURIComponent(gameId)}?t=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (!cancelled) setOppAbandoned(!!j.opponentAbandoned);
      } catch { /* ignore */ }
    };
    void check();
    const iv = setInterval(check, 30000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [yourTurn, gameOver, gameId, token]);

  async function abandonAction(kind: 'takeover' | 'claim') {
    setBusy(true); setActErr(null);
    try {
      const r = await fetch(`/api/games/${encodeURIComponent(gameId)}/${kind}?t=${encodeURIComponent(token)}`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      await refresh();
    } catch (e) { setActErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (loading && !view) return <div style={pad}>Loading game {gameId}…</div>;
  if (error && !view) return <div style={pad}><b>Couldn't load this game.</b><pre style={errBox}>{String(error.message)}</pre></div>;
  if (!view) return <div style={pad}>No game data.</div>;

  return (
    <div style={{ ...pad, maxWidth: 1280, margin: '0 auto', fontFamily: 'system-ui, sans-serif', color: '#e8e6f2' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: '8px 0' }}>Online game <span style={{ color: '#8a7', fontSize: 14 }}>(preview)</span></h2>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <button onClick={() => void refresh()} className="tab-button">Refresh</button>
          {you && <ChatPanel gameId={gameId} token={token} you={you as Side} />}
        </div>
      </div>

      <div style={card}>
        <div>
          <b>You are:</b> {you ?? '—'}
          {(() => {
            const opp = you === 'Rebel' ? 'Empire' : you === 'Empire' ? 'Rebel' : null;
            if (!opp) return null;
            const oppIsAI = view.aiSides?.includes(opp);
            return (
              <span style={{ marginLeft: 14 }}>
                <b>Opponent ({opp}):</b>{' '}
                {oppIsAI
                  ? <span style={{ color: '#e0b84f' }}>AI — its turns play automatically. To hand this seat to a person, have them open the {opp} invite link.</span>
                  : <span style={{ color: '#8a7' }}>human</span>}
              </span>
            );
          })()}
        </div>
        <div><b>Phase:</b> {view.phase} &nbsp; <b>Turn marker:</b> {view.timeMarker}/{view.trackLength} &nbsp; <b>Reputation:</b> {view.reputationMarker}</div>
        <div><b>Move #:</b> {turn} &nbsp; {gameOver ? <span style={{ color: '#f88' }}>Game over{view.winner ? ` — ${view.winner} wins` : ''}</span>
          : <b style={{ color: yourTurn ? '#80dc78' : '#e0b84f' }}>{yourTurn ? 'Your turn' : 'Waiting for opponent…'}</b>}</div>
      </div>

      {oppAbandoned && !gameOver && (
        <div style={{ ...card, borderColor: '#7a5', background: '#1f2a1c' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Your opponent has been away a while.</div>
          <div style={{ color: '#aab', fontSize: 13, marginBottom: 10 }}>
            You can let the AI finish their side, or claim the win. (If they come back, they get their seat back automatically.)
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button disabled={busy} onClick={() => void abandonAction('takeover')}>Let the AI take over</button>
            <button disabled={busy} onClick={() => void abandonAction('claim')}>Claim victory</button>
          </div>
          {actErr && <pre style={errBox}>{actErr}</pre>}
        </div>
      )}

      {/* The board below is the input surface (its own pass/done/assign
          controls submit to the server). The old quick-action panel that lived
          here was redundant and showed duplicate buttons (e.g. two "Pass"). */}
      {actErr && !oppAbandoned && <div style={card}><pre style={errBox}>{actErr}</pre></div>}

      {/* The real board, rendered from the redacted server view. Read-only for
          now (pointer-events disabled); moves go through the action panel above.
          Per-control submit wiring is the next step (#110). */}
      <div style={{ ...card, padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '8px 12px', color: '#aab', fontSize: 12, borderBottom: '1px solid #333' }}>
          {yourTurn ? 'Your turn — play directly on the board below.' : 'Opponent’s turn — board is read-only until they move.'}
        </div>
        {/* Fully interactive at the DOM level so read-only features (probe
            overlays, hover-enlarge, info panels, tooltips) work whether or not
            it's your turn. Turn enforcement lives in the online shim: it only
            SUBMITS an action when it's your turn, so stray board-action clicks on
            the opponent's turn no-op silently instead of being server-rejected. */}
        <div>
          <PlayTab online={{ view, you: you as Side | null, yourTurn, submit }} />
        </div>
      </div>

      <details style={{ ...card, marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', color: '#aab' }}>Redacted game state (debug)</summary>
        <pre style={{ maxHeight: 360, overflow: 'auto', fontSize: 11 }}>{JSON.stringify(view, null, 2)}</pre>
      </details>
    </div>
  );
}


const pad: React.CSSProperties = { padding: 20 };
const card: React.CSSProperties = { background: '#1b1e24', border: '1px solid #333', borderRadius: 8, padding: 14, margin: '12px 0' };
const errBox: React.CSSProperties = { background: '#3a1d1d', color: '#f3b', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap' };

// ----- In-game chat panel (top-right, under Refresh) -----

interface ChatMsg { seat: string; body: string; at: string }

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Async message channel between the two human seats. Self-contained: polls
 *  the same game endpoint (which now returns `chat`) every 12s + on tab focus,
 *  and posts via /chat. Messages render as plain text (React escapes). */
function ChatPanel({ gameId, token, you }: { gameId: string; token: string; you: Side }) {
  const base = `/api/games/${encodeURIComponent(gameId)}`;
  const q = `?t=${encodeURIComponent(token)}`;
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [seenCount, setSeenCount] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const loadRef = useRef<() => void>(() => {});
  loadRef.current = async () => {
    try {
      const r = await fetch(`${base}${q}`);
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.chat)) setMsgs(j.chat as ChatMsg[]);
    } catch { /* best-effort */ }
  };

  useEffect(() => {
    void loadRef.current();
    const iv = setInterval(() => loadRef.current(), 12000);
    const onVis = () => { if (document.visibilityState === 'visible') void loadRef.current(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, []);

  // While open, treat everything as read and keep scrolled to the newest.
  useEffect(() => {
    if (open) {
      setSeenCount(msgs.length);
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [open, msgs.length]);

  const unread = open ? 0 : Math.max(0, msgs.length - seenCount);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await fetch(`${base}/chat${q}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.chat)) setMsgs(j.chat as ChatMsg[]);
      setDraft('');
    } catch { /* surfaced by the next poll if it actually landed */ }
    finally { setSending(false); }
  }

  const seatColor = (s: string) => (s === 'Rebel' ? '#4fc3f7' : '#ff8a80');

  return (
    <div style={{ width: 220, textAlign: 'left' }}>
      <button onClick={() => setOpen((o) => !o)} className="tab-button"
        style={{ width: '100%', fontSize: 12, padding: '3px 8px' }}>
        💬 Messages{unread > 0 ? ` (${unread})` : ''} {open ? '▾' : '▸'}
      </button>
      {/* Collapsed peek: the last few messages (incl. your own), one line each,
          so recent context is glanceable without expanding. */}
      {!open && msgs.length > 0 && (
        <div style={{ marginTop: 4, padding: 6, background: '#15171c', border: '1px solid #2a2d34',
          borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {msgs.slice(-3).map((m, i) => (
            <div key={i} title={`${m.seat === you ? 'You' : m.seat} (${relativeTime(m.at)}): ${m.body}`}
              style={{ fontSize: 11, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <span style={{ color: seatColor(m.seat), fontWeight: 700 }}>{m.seat === you ? 'You' : m.seat}</span>
              <span style={{ color: '#cdd6f4' }}>{' · '}{m.body}</span>
            </div>
          ))}
        </div>
      )}
      {open && (
        <div style={{ border: '1px solid #333', borderTop: 'none', borderRadius: '0 0 6px 6px', background: '#15171c' }}>
          <div ref={listRef} style={{ maxHeight: 150, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {msgs.length === 0 && (
              <div style={{ color: '#667', fontSize: 11, fontStyle: 'italic' }}>No messages yet — say hi.</div>
            )}
            {msgs.map((m, i) => (
              <div key={i} style={{ fontSize: 12, lineHeight: 1.3 }}>
                <span style={{ color: seatColor(m.seat), fontWeight: 700 }}>{m.seat === you ? 'You' : m.seat}</span>
                <span style={{ color: '#667', marginLeft: 5, fontSize: 9.5 }}>{relativeTime(m.at)}</span>
                <span style={{ color: '#e8e6f2', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{' · '}{m.body}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, padding: 6, borderTop: '1px solid #333' }}>
            <input
              value={draft}
              maxLength={500}
              placeholder="Message…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
              style={{ flex: 1, minWidth: 0, background: '#0c0d10', color: '#e8e6f2', border: '1px solid #3a3d44', borderRadius: 4, padding: '3px 6px', fontSize: 12 }}
            />
            <button onClick={() => void send()} disabled={sending || !draft.trim()} className="tab-button" style={{ fontSize: 11, padding: '3px 8px' }}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}
