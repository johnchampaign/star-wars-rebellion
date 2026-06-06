// Minimal online-play screen (Phase 4). Drives a server game via the framework
// useGame() hook: polls the redacted view, shows whose turn it is, and submits
// actions. This is the bare loop that proves async two-player-over-network play
// + per-seat redaction end-to-end. Rendering the full PlayTab board against the
// server view (instead of OWNING a local engine) is the larger follow-on
// (PlayTab currently constructs its own engine state).

import { useMemo, useState } from 'react';
import { useGame } from 'digital-boardgame-framework/client';
import { makeGameClient } from './gameClient';
import PlayTab from '../play/PlayTab';
import type { GameState } from '../engine/types';
import type { RebellionAction } from '../adapter/rebellionAction';
import type { Side } from '../types';

export default function OnlinePlay({ gameId, token }: { gameId: string; token: string }) {
  const client = useMemo(() => makeGameClient(gameId, token), [gameId, token]);
  // Poll every 8s — quick enough to feel live, gentle on the Supabase free tier.
  const { view, yourTurn, turn, gameOver, you, legalActions, submit, loading, error, refresh } =
    useGame<GameState, RebellionAction>(client, { pollMs: 8000 });
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);

  async function send(action: RebellionAction) {
    setBusy(true); setActErr(null);
    try { await submit(action); }
    catch (e) { setActErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (loading && !view) return <div style={pad}>Loading game {gameId}…</div>;
  if (error && !view) return <div style={pad}><b>Couldn't load this game.</b><pre style={errBox}>{String(error.message)}</pre></div>;
  if (!view) return <div style={pad}>No game data.</div>;

  // Phase-appropriate always-available actions, so the loop is playable before
  // the full board lands. The server validates every submit regardless.
  const quick: RebellionAction[] = [];
  if (view.phase === 'Assignment') quick.push({ kind: 'skipAssignment' });
  if (view.phase === 'Command') quick.push({ kind: 'pass' });

  return (
    <div style={{ ...pad, maxWidth: 1280, margin: '0 auto', fontFamily: 'system-ui, sans-serif', color: '#e8e6f2' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: '8px 0' }}>Online game <span style={{ color: '#8a7', fontSize: 14 }}>(preview)</span></h2>
        <button onClick={() => void refresh()} className="tab-button">Refresh</button>
      </div>

      <div style={card}>
        <div><b>You are:</b> {you ?? '—'}</div>
        <div><b>Phase:</b> {view.phase} &nbsp; <b>Turn marker:</b> {view.timeMarker}/{view.trackLength} &nbsp; <b>Reputation:</b> {view.reputationMarker}</div>
        <div><b>Move #:</b> {turn} &nbsp; {gameOver ? <span style={{ color: '#f88' }}>Game over{view.winner ? ` — ${view.winner} wins` : ''}</span>
          : <b style={{ color: yourTurn ? '#80dc78' : '#e0b84f' }}>{yourTurn ? 'Your turn' : 'Waiting for opponent…'}</b>}</div>
      </div>

      {yourTurn && !gameOver && (
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Your move</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {quick.map((a, i) => (
              <button key={`q${i}`} disabled={busy} onClick={() => void send(a)}>{labelFor(a)}</button>
            ))}
            {legalActions.map((a, i) => (
              <button key={`l${i}`} disabled={busy} onClick={() => void send(a)}>{labelFor(a)}</button>
            ))}
            {quick.length === 0 && legalActions.length === 0 && (
              <span style={{ color: '#aab' }}>No quick actions wired for this step yet — full board coming. (The server still accepts any valid move.)</span>
            )}
          </div>
          {actErr && <pre style={errBox}>{actErr}</pre>}
        </div>
      )}

      {/* The real board, rendered from the redacted server view. Read-only for
          now (pointer-events disabled); moves go through the action panel above.
          Per-control submit wiring is the next step (#110). */}
      <div style={{ ...card, padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '8px 12px', color: '#aab', fontSize: 12, borderBottom: '1px solid #333' }}>
          {yourTurn ? 'Your turn — play directly on the board below.' : 'Opponent’s turn — board is read-only until they move.'}
        </div>
        {/* Interactive only on your turn; otherwise read-only so stray clicks
            don't fire server-rejected moves. Each board action submits to the
            server via the online engine shim. */}
        <div style={{ pointerEvents: yourTurn ? 'auto' : 'none' }}>
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

function labelFor(a: RebellionAction): string {
  switch (a.kind) {
    case 'skipAssignment': return 'Done assigning';
    case 'pass': return 'Pass';
    default: return a.kind;
  }
}

const pad: React.CSSProperties = { padding: 20 };
const card: React.CSSProperties = { background: '#1b1e24', border: '1px solid #333', borderRadius: 8, padding: 14, margin: '12px 0' };
const errBox: React.CSSProperties = { background: '#3a1d1d', color: '#f3b', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap' };
