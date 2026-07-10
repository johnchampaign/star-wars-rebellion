// Minimal online lobby (Phase 4). Create a game, get two invite links to share.
// No accounts/login yet — whoever opens a side's link claims that seat (email
// magic-link identity is Phase 5).

import { useState } from 'react';
import type { ExpansionConfig } from '../types';
import { resolveExpansion } from '../engine/setup';

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
  // 'pvp' = two humans; otherwise the AI plays the opposite side to the human.
  const [mode, setMode] = useState<'pvp' | 'human-rebel' | 'human-empire'>('pvp');
  const [expansion, setExpansion] = useState<ExpansionConfig>(() => resolveExpansion({}));
  const patchExpansion = (patch: Partial<ExpansionConfig>) =>
    setExpansion((c) => {
      // Disabled→enabled re-seeds the on-defaults; otherwise merge in place.
      // See same fix in PlayTab.updateExpansionPref.
      const base: Partial<ExpansionConfig> = (!c.enabled && patch.enabled)
        ? { enabled: true }
        : { ...c, ...patch };
      return resolveExpansion({ ...base, ...patch });
    });

  async function createGame() {
    setCreating(true);
    setError(null);
    try {
      const emails: Record<string, string> = {};
      if (rebelEmail.trim()) emails.Rebel = rebelEmail.trim();
      if (empireEmail.trim()) emails.Empire = empireEmail.trim();
      const aiSide = mode === 'human-rebel' ? 'Empire' : mode === 'human-empire' ? 'Rebel' : undefined;
      const r = await fetch('/api/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emails, aiSide, expansion }),
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

  // Which sides a HUMAN plays — the AI seat needs no email and no invite link.
  const aiSide: 'Rebel' | 'Empire' | null =
    mode === 'human-rebel' ? 'Empire' : mode === 'human-empire' ? 'Rebel' : null;
  const humanSides: ('Rebel' | 'Empire')[] = aiSide
    ? [aiSide === 'Rebel' ? 'Empire' : 'Rebel']
    : ['Rebel', 'Empire'];

  return (
    <div style={{ maxWidth: 760, margin: '40px auto', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#e8e6f2' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ marginTop: 0 }}>Star Wars: Rebellion — Online <span style={{ color: '#8a7' }}>(preview)</span></h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <a
            href="https://games-hub-5vo.pages.dev/leaderboard?game=rebellion"
            target="_blank"
            rel="noopener noreferrer"
            className="tab-button"
          >
            Leaderboard
          </a>
          {onClose && <button onClick={onClose} className="tab-button">Back to single-player</button>}
        </div>
      </div>
      <p style={{ color: '#aab' }}>
        Asynchronous two-player game. Create a game, then send each side's invite link to the
        right player. Whoever opens a link first claims that side. Bookmark the links — with no
        accounts yet, they're the only way back into the game.
      </p>

      {!result && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: '#aab', fontSize: 13, marginBottom: 8 }}>Opponent</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {([
              ['pvp', 'Two players'],
              ['human-rebel', 'vs AI — I play Rebel'],
              ['human-empire', 'vs AI — I play Empire'],
            ] as const).map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)}
                className={`tab-button ${mode === m ? 'active' : ''}`}
                style={{ fontSize: 13 }}>{label}</button>
            ))}
          </div>
          {mode !== 'pvp' && (
            <div style={{ color: '#778', fontSize: 12, marginTop: 6 }}>
              The AI plays the other side automatically on the server — open your own seat link and play.
            </div>
          )}
        </div>
      )}

      {!result && (
        <div style={{ marginBottom: 16, maxWidth: 460 }}>
          <div style={{ color: '#aab', fontSize: 13, marginBottom: 8 }}>
            Optional — add {aiSide ? 'your' : "a player's"} email and we'll <b>email the invite link</b> right
            away, plus a <b>"your turn"</b> nudge when it's that player's move (great for games played over
            days). Leave blank to just copy and share the link{aiSide ? '' : 's'} yourself.
            {aiSide && <> The {aiSide} side is the computer — no email needed.</>}
          </div>
          {humanSides.includes('Rebel') && (
            <label style={emailRow}>
              <span style={{ width: 64, color: '#4fc3f7' }}>Rebel</span>
              <input type="email" placeholder="rebel@example.com" value={rebelEmail}
                onChange={(e) => setRebelEmail(e.target.value)} style={emailInput} />
            </label>
          )}
          {humanSides.includes('Empire') && (
            <label style={emailRow}>
              <span style={{ width: 64, color: '#ff8a80' }}>Empire</span>
              <input type="email" placeholder="empire@example.com" value={empireEmail}
                onChange={(e) => setEmpireEmail(e.target.value)} style={emailInput} />
            </label>
          )}
        </div>
      )}

      {!result && (
        <div style={{ marginBottom: 16, maxWidth: 460 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#e8e6f2', fontSize: 14 }}>
            <input type="checkbox" checked={expansion.enabled}
              onChange={(e) => patchExpansion({ enabled: e.target.checked })} />
            Rise of the Empire expansion
          </label>
          {expansion.enabled && (
            <>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
                {([
                  ['roeUnits', 'RoE units'],
                  ['cinematicCombat', 'Cinematic Combat'],
                ] as const).map(([k, label]) => (
                  <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#cbc4b0', fontSize: 12 }}>
                    <input type="checkbox" checked={expansion[k]}
                      onChange={(e) => patchExpansion({ [k]: e.target.checked } as Partial<ExpansionConfig>)} />
                    {label}
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 6, color: '#778', fontSize: 12, lineHeight: 1.4 }}>
                Mission set isn’t chosen here — each player picks their own (base or Rise of the
                Empire) the first time they open the game, and the two sides may differ (RoE p.2).
              </div>
            </>
          )}
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
          {humanSides.includes('Rebel') && (
            <Invite label={aiSide ? 'Your link — open to play as the Rebels (the AI plays the Empire)' : 'Rebel invite — send to the Rebel player'} url={result.invites.Rebel} />
          )}
          {humanSides.includes('Empire') && (
            <Invite label={aiSide ? 'Your link — open to play as the Empire (the AI plays the Rebels)' : 'Empire invite — send to the Empire player'} url={result.invites.Empire} />
          )}
          <p style={{ marginTop: 8, color: '#778' }}>
            {aiSide
              ? 'Open your link above to start playing — the computer takes its turns automatically.'
              : 'To try it solo, open one link in this tab and the other in a separate browser/incognito window.'}
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
