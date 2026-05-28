// Minimal online-play UI for Phase 2 (Option A).
//
// Goal: validate the framework integration end-to-end with two real human
// players over the network. This is deliberately the bare minimum — no map
// render, no token art, no tactic-card visuals. It shows:
//   - the redacted GameState as JSON in a collapsible block (for debugging),
//   - a summary header (phase / time / reputation / whose turn / pending),
//   - a list of legal RebellionActions as buttons (click → submit),
//   - a "Report a problem" textbox.
//
// Phase 3 will replace this with the real PlayTab once that's refactored to
// accept (view, legalActions, submit) instead of owning a local engine state.

import { useCallback, useMemo, useState } from 'react';
import { useGame, type GameClientApi } from 'digital-boardgame-framework/client';
import type { GameState } from '../engine/types';
import type { RebellionAction } from '../adapter/rebellionAction';

interface Props { gameId: string; token: string }

function makeClient(gameId: string, token: string): GameClientApi<GameState, RebellionAction> {
  const base = `/api/games/${encodeURIComponent(gameId)}`;
  const q = `?as=${encodeURIComponent(token)}`;
  return {
    fetch: async () => {
      const r = await fetch(`${base}${q}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    },
    legalActions: async () => {
      const r = await fetch(`${base}/legal${q}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j.actions;
    },
    submit: async (action) => {
      const r = await fetch(`${base}/submit${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    },
    report: async (body) => {
      const r = await fetch(`${base}/report${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    },
  };
}

export default function OnlinePlay({ gameId, token }: Props) {
  const client = useMemo(() => makeClient(gameId, token), [gameId, token]);
  // Poll every 8s — short enough that the opponent's moves land quickly,
  // long enough that two players + the framework's no-rate-limit don't
  // hammer Supabase free-tier.
  const game = useGame(client, { pollMs: 8000 });
  const { view, yourTurn, turn, gameOver, legalActions, submit, loading, error, refresh, reportBug } = game;

  if (loading && !view) return <div style={{ padding: 24 }}>Loading game {gameId}…</div>;
  if (error && !view) {
    return (
      <div style={{ padding: 24, color: '#900' }}>
        <h3>Couldn't load game</h3>
        <pre>{error.message}</pre>
        <p>Check that the invite URL is correct and the game hasn't been deleted server-side.</p>
      </div>
    );
  }
  if (!view) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 16, fontFamily: 'sans-serif' }}>
      <div>
        <Header view={view} turn={turn} yourTurn={yourTurn} gameOver={gameOver} onRefresh={refresh} />
        <Actions yourTurn={yourTurn} gameOver={gameOver} legal={legalActions} onSubmit={submit} />
        <Reporter onReport={reportBug} />
        {error && <pre style={{ background: '#fee', padding: 8, color: '#900' }}>{error.message}</pre>}
      </div>
      <StateInspector view={view} />
    </div>
  );
}

function Header(p: { view: GameState; turn: number; yourTurn: boolean; gameOver: boolean; onRefresh: () => void }) {
  const { view } = p;
  return (
    <div style={{ background: '#eef', padding: 12, marginBottom: 12, borderRadius: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>Turn {p.turn}</strong>
        <button onClick={p.onRefresh}>Refresh</button>
      </div>
      <div>Phase: <code>{view.phase}</code></div>
      <div>Time marker: {view.timeMarker} / {view.trackLength}</div>
      <div>Reputation: {view.reputationMarker}</div>
      <div>Current player (engine): <code>{view.currentPlayer}</code></div>
      {view.pendingChoice && (
        <div style={{ color: '#a00' }}>Pending choice: <code>{view.pendingChoice.kind}</code></div>
      )}
      {view.pendingCombat && <div style={{ color: '#a00' }}>Pending combat at {view.pendingCombat.systemId}</div>}
      {view.pendingMission && <div style={{ color: '#a00' }}>Pending mission: <code>{view.pendingMission.missionId}</code></div>}
      <div style={{ marginTop: 8 }}>
        {p.gameOver
          ? <strong style={{ color: '#070' }}>Game over — winner: {view.winner ?? 'draw'} ({view.winReason})</strong>
          : p.yourTurn
            ? <strong style={{ color: '#070' }}>Your turn.</strong>
            : <em style={{ color: '#666' }}>Waiting for opponent…</em>}
      </div>
    </div>
  );
}

function Actions(p: { yourTurn: boolean; gameOver: boolean; legal: RebellionAction[]; onSubmit: (a: RebellionAction) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (p.gameOver) return null;
  if (!p.yourTurn) return <em style={{ color: '#666' }}>(your action buttons will appear here when it's your turn)</em>;
  if (p.legal.length === 0) return <em style={{ color: '#900' }}>No legal actions — stuck. File a bug.</em>;
  return (
    <div>
      <h4>Legal actions ({p.legal.length})</h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {p.legal.map((a, i) => (
          <button
            key={i}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await p.onSubmit(a); } finally { setBusy(false); }
            }}
            style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: 11, textAlign: 'left' }}
            title={JSON.stringify(a, null, 2)}
          >
            {summarizeAction(a)}
          </button>
        ))}
      </div>
    </div>
  );
}

function summarizeAction(a: RebellionAction): string {
  // Compact one-line label. Full payload is in the tooltip.
  const { kind, ...rest } = a as { kind: string } & Record<string, unknown>;
  const payload = JSON.stringify(rest);
  return payload.length > 60 ? `${kind} …` : `${kind} ${payload === '{}' ? '' : payload}`;
}

function Reporter(p: { onReport: (msg: string) => Promise<string> }) {
  const [msg, setMsg] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const send = useCallback(async () => {
    if (!msg.trim()) return;
    setStatus('Sending…');
    try {
      const id = await p.onReport(msg.trim());
      setStatus(`Reported (id ${id.slice(0, 8)}…) — thanks!`);
      setMsg('');
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [msg, p]);
  return (
    <div style={{ marginTop: 24, borderTop: '1px solid #ccc', paddingTop: 12 }}>
      <h4>Report a problem</h4>
      <textarea
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        placeholder="What went wrong?"
        rows={3}
        style={{ width: '100%', fontFamily: 'sans-serif' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <button onClick={send} disabled={!msg.trim()}>Send report</button>
        {status && <span style={{ color: '#444' }}>{status}</span>}
      </div>
    </div>
  );
}

function StateInspector({ view }: { view: GameState }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <h4 style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} Raw state ({view.phase})
      </h4>
      {open && (
        <pre style={{ background: '#f6f6f6', padding: 8, fontSize: 11, maxHeight: '70vh', overflow: 'auto' }}>
          {JSON.stringify(view, null, 2)}
        </pre>
      )}
    </div>
  );
}
