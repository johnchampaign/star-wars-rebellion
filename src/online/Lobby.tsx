// Minimal online lobby (Phase 4). Create a game, get two invite links to share.
// No accounts/login yet — whoever opens a side's link claims that seat (email
// magic-link identity is Phase 5).

import { useState } from 'react';

interface CreateResult {
  gameId: string;
  invites: { Rebel: string; Empire: string };
}

export default function Lobby({ onClose }: { onClose?: () => void }) {
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebelEmail, setRebelEmail] = useState('');
  const [empireEmail, setEmpireEmail] = useState('');

  async function createGame() {
    setCreating(true);
    setError(null);
    try {
      const emails: Record<string, string> = {};
      if (rebelEmail.trim()) emails.Rebel = rebelEmail.trim();
      if (empireEmail.trim()) emails.Empire = empireEmail.trim();
      const r = await fetch('/api/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emails }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setResult(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '40px auto', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#e8e6f2' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ marginTop: 0 }}>Star Wars: Rebellion — Online <span style={{ color: '#8a7' }}>(preview)</span></h2>
        {onClose && <button onClick={onClose} className="tab-button">Back to single-player</button>}
      </div>
      <p style={{ color: '#aab' }}>
        Asynchronous two-player game. Create a game, then send each side's invite link to the
        right player. Whoever opens a link first claims that side. Bookmark the links — with no
        accounts yet, they're the only way back into the game.
      </p>

      {!result && (
        <div style={{ marginBottom: 16, maxWidth: 460 }}>
          <div style={{ color: '#aab', fontSize: 13, marginBottom: 8 }}>
            Optional — add each player's email to get a <b>"your turn"</b> notification when it's
            their move (great for games played over days). Leave blank to just share links.
          </div>
          <label style={emailRow}>
            <span style={{ width: 64, color: '#4fc3f7' }}>Rebel</span>
            <input type="email" placeholder="rebel@example.com" value={rebelEmail}
              onChange={(e) => setRebelEmail(e.target.value)} style={emailInput} />
          </label>
          <label style={emailRow}>
            <span style={{ width: 64, color: '#ff8a80' }}>Empire</span>
            <input type="email" placeholder="empire@example.com" value={empireEmail}
              onChange={(e) => setEmpireEmail(e.target.value)} style={emailInput} />
          </label>
        </div>
      )}

      {!result && (
        <button onClick={createGame} disabled={creating} style={{ padding: '10px 18px', fontSize: 16 }}>
          {creating ? 'Creating…' : 'Create new game'}
        </button>
      )}
      {error && <pre style={{ background: '#3a1d1d', color: '#f3b', padding: 12, borderRadius: 6 }}>{error}</pre>}

      {result && (
        <div style={{ marginTop: 24 }}>
          <h3>Game created</h3>
          <p style={{ color: '#aab' }}>Game ID: <code>{result.gameId}</code></p>
          <Invite label="Rebel invite — send to the Rebel player" url={result.invites.Rebel} />
          <Invite label="Empire invite — send to the Empire player" url={result.invites.Empire} />
          <p style={{ marginTop: 8, color: '#778' }}>
            To try it solo, open one link in this tab and the other in a separate browser/incognito window.
          </p>
        </div>
      )}
    </div>
  );
}

function Invite({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ margin: '14px 0' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()}
          style={{ flex: 1, padding: 8, fontFamily: 'monospace', borderRadius: 4 }} />
        <button onClick={() => { void navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a href={url}><button>Open</button></a>
      </div>
    </div>
  );
}

const emailRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' };
const emailInput: React.CSSProperties = { flex: 1, padding: 7, borderRadius: 4, border: '1px solid #444', background: '#11131a', color: '#e8e6f2' };
