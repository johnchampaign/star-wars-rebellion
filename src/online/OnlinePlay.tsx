// Minimal online-play screen (Phase 4). Drives a server game via the framework
// useGame() hook: polls the redacted view, shows whose turn it is, and submits
// actions. This is the bare loop that proves async two-player-over-network play
// + per-seat redaction end-to-end. Rendering the full PlayTab board against the
// server view (instead of OWNING a local engine) is the larger follow-on
// (PlayTab currently constructs its own engine state).

import { useEffect, useMemo, useState } from 'react';
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
        <button onClick={() => void refresh()} className="tab-button">Refresh</button>
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
