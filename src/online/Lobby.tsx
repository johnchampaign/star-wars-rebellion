// Minimal lobby UI for the Digital Boardgame Framework online port.
//
// Phase 2 deliberate scope (Option A): create a game, get two invite URLs
// to hand out. No login, no email entry, no game list — just the bare
// minimum to bootstrap a two-player session.

import { useState } from 'react';

interface CreateResult {
  gameId: string;
  invites: { Rebel: string; Empire: string };
  seed: number;
}

export default function Lobby() {
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createGame() {
    setCreating(true);
    setError(null);
    try {
      const r = await fetch('/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setResult(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: 24, fontFamily: 'sans-serif' }}>
      <h2>Star Wars: Rebellion — Online (preview)</h2>
      <p style={{ color: '#666' }}>
        Async two-player game. Create a game and share each side's invite link with the
        appropriate player. Whoever opens the URL first claims that side.
      </p>
      {!result && (
        <button
          onClick={createGame}
          disabled={creating}
          style={{ padding: '10px 16px', fontSize: 16 }}
        >
          {creating ? 'Creating…' : 'Create new game'}
        </button>
      )}
      {error && (
        <pre style={{ background: '#fee', padding: 12, color: '#900' }}>{error}</pre>
      )}
      {result && (
        <div style={{ marginTop: 24 }}>
          <h3>Game created</h3>
          <p>Game ID: <code>{result.gameId}</code> &nbsp;(seed {result.seed})</p>
          <p><strong>Rebel invite</strong> — send this URL to whoever's playing Rebel:</p>
          <Invite url={result.invites.Rebel} />
          <p style={{ marginTop: 16 }}><strong>Empire invite</strong> — send this URL to the Empire player:</p>
          <Invite url={result.invites.Empire} />
          <p style={{ marginTop: 24, color: '#666' }}>
            Bookmark these — they're the only way back into this game. We don't store any
            "your games" list per user (no accounts).
          </p>
        </div>
      )}
    </div>
  );
}

function Invite({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        readOnly
        value={url}
        style={{ flex: 1, padding: 8, fontFamily: 'monospace' }}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <a href={url}><button>Open</button></a>
    </div>
  );
}
