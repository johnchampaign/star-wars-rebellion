import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  loadActions, loadMissions, loadObjectives, loadTactics, loadProbes,
  CARD_IMAGE_BASE,
} from '../data/loadAssets';
import type {
  ActionCard, MissionCard, ObjectiveCard, TacticCard, ProbeCard,
  ActionsFile, MissionsFile, ObjectivesFile, TacticsFile, ProbesFile,
  Skill, ActionTiming, ObjectiveTiming,
} from '../types';

type Kind = 'actions' | 'missions' | 'objectives' | 'tactics' | 'probes';

const LS_KEYS: Record<Exclude<Kind, 'probes'>, string> = {
  actions:    'rebellion-dev-actions-edits',
  missions:   'rebellion-dev-missions-edits',
  objectives: 'rebellion-dev-objectives-edits',
  tactics:    'rebellion-dev-tactics-edits',
};

type EditMap<T> = Record<string, Partial<T>>;

function loadEdits<T>(key: string): EditMap<T> {
  const s = localStorage.getItem(key);
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
function saveEdits<T>(key: string, edits: EditMap<T>) {
  if (Object.keys(edits).length === 0) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(edits));
}

function applyEdits<T extends { id: string }>(items: T[], edits: EditMap<T>): T[] {
  return items.map((it) => {
    const e = edits[it.id];
    if (!e) return it;
    return { ...it, ...e };
  });
}

function download(filename: string, payload: object) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// Tab shell
// ============================================================
export default function CardsTab() {
  const [kind, setKind] = useState<Kind>('actions');

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Cards</h2>

      <div className="meta-notes">
        <strong>What this is:</strong> the five card decks. Each kind has its own schema and is stored in its own JSON file (actions, missions, objectives, tactics, probes). Cards are transcribed from the .vmod card images.
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {(['actions', 'missions', 'objectives', 'tactics', 'probes'] as const).map((k) => (
          <button
            key={k}
            className={`tab-button ${kind === k ? 'active' : ''}`}
            onClick={() => setKind(k)}
          >
            {k}
          </button>
        ))}
      </div>

      {kind === 'actions'    && <ActionsView />}
      {kind === 'missions'   && <MissionsView />}
      {kind === 'objectives' && <ObjectivesView />}
      {kind === 'tactics'    && <TacticsView />}
      {kind === 'probes'     && <ProbesView />}
    </div>
  );
}

// ============================================================
// Shared bits
// ============================================================
function CardImg({ image }: { image: string }) {
  return (
    <a href={`${CARD_IMAGE_BASE}/${image}`} target="_blank" rel="noreferrer" title="Open full size">
      <img
        src={`${CARD_IMAGE_BASE}/${image}`}
        alt=""
        style={{ width: 130, height: 'auto', borderRadius: 4, display: 'block' }}
      />
    </a>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: '#aaa', marginBottom: 2 }}>{children}</div>;
}

const inputStyle: React.CSSProperties = {
  background: '#0c0d10',
  color: '#e8e8ea',
  border: '1px solid #3a3d44',
  borderRadius: 3,
  padding: '3px 6px',
  fontSize: 12,
  width: '100%',
  fontFamily: 'inherit',
};

function ExportRow({ count, isDirty, onExport, onReset, completeLabel }: {
  count: number;
  isDirty: boolean;
  onExport: () => void;
  onReset: () => void;
  completeLabel: string;
}) {
  return (
    <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
      <button className="tab-button" onClick={onExport} disabled={!isDirty}>
        Export {isDirty ? '*' : ''}
      </button>
      <button className="tab-button" onClick={onReset} disabled={!isDirty}>
        Reset
      </button>
      <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
        {count} cards · {completeLabel}
      </span>
    </div>
  );
}

// ============================================================
// Actions
// ============================================================
function ActionsView() {
  const [data, setData] = useState<ActionsFile | null>(null);
  const [edits, setEdits] = useState<EditMap<ActionCard>>({});
  const [filterSide, setFilterSide] = useState<'all' | 'Rebel' | 'Empire'>('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadActions().then((d) => {
      setData(d);
      setEdits(loadEdits<ActionCard>(LS_KEYS.actions));
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => { saveEdits(LS_KEYS.actions, edits); }, [edits]);

  const effective = useMemo(() => data ? applyEdits(data.actions, edits) : null, [data, edits]);
  const isDirty = Object.keys(edits).length > 0;

  const update = useCallback((id: string, patch: Partial<ActionCard>) => {
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  }, []);

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!data || !effective) return <div className="placeholder">Loading…</div>;

  const filtered = filterSide === 'all' ? effective : effective.filter((a) => a.side === filterSide);
  const transcribed = effective.filter((a) => a.timing !== '' || a.rulesText !== '').length;

  const handleExport = () => download('actions.json', {
    _meta: { ...data._meta, provenance: 'user-corrected',
      notes: [...data._meta.notes, `Edited via dev cards tab at ${new Date().toISOString()}.`] },
    actions: effective,
  });

  return (
    <>
      <div style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <ExportRow count={effective.length} isDirty={isDirty} onExport={handleExport}
          onReset={() => { if (confirm('Reset all action edits?')) setEdits({}); }}
          completeLabel={`${transcribed}/${effective.length} with timing or rules text entered`}
        />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {(['all', 'Rebel', 'Empire'] as const).map((s) => (
            <button key={s} className={`tab-button ${filterSide === s ? 'active' : ''}`} onClick={() => setFilterSide(s)}>
              {s}
            </button>
          ))}
        </span>
      </div>

      <CardGrid>
        {filtered.map((a) => (
          <CardCard key={a.id} sideColor={a.side === 'Rebel' ? '#aae0ff' : '#ffaaaa'} image={a.image}
            badge={a.isStarting ? 'starting' : null}>
            <CardName>{a.name}</CardName>
            <div style={{ fontSize: 11, color: '#888' }}>{a.side}</div>

            <FieldLabel>Timing</FieldLabel>
            <select value={a.timing} onChange={(e) => update(a.id, { timing: e.target.value as ActionTiming })}
              style={inputStyle}>
              <option value="">— select —</option>
              <option value="Assignment">Assignment</option>
              <option value="StartOfCombat">Start of Combat</option>
              <option value="Immediate">Immediate</option>
              <option value="Special">Special</option>
            </select>

            <FieldLabel>Leader requirement (comma-separated ids, blank = none)</FieldLabel>
            <input value={a.leaderRequirement.join(', ')}
              onChange={(e) => update(a.id, { leaderRequirement: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="e.g. darth-vader, boba-fett"
              style={inputStyle} />

            <FieldLabel>Rules text</FieldLabel>
            <textarea value={a.rulesText}
              onChange={(e) => update(a.id, { rulesText: e.target.value })}
              rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
          </CardCard>
        ))}
      </CardGrid>
    </>
  );
}

// ============================================================
// Missions
// ============================================================
function MissionsView() {
  const [data, setData] = useState<MissionsFile | null>(null);
  const [edits, setEdits] = useState<EditMap<MissionCard>>({});
  const [filterSide, setFilterSide] = useState<'all' | 'Rebel' | 'Empire'>('all');
  const [showProjects, setShowProjects] = useState<'all' | 'projects' | 'regular'>('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadMissions().then((d) => {
      setData(d);
      setEdits(loadEdits<MissionCard>(LS_KEYS.missions));
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => { saveEdits(LS_KEYS.missions, edits); }, [edits]);

  const effective = useMemo(() => data ? applyEdits(data.missions, edits) : null, [data, edits]);
  const isDirty = Object.keys(edits).length > 0;
  const update = useCallback((id: string, patch: Partial<MissionCard>) => {
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  }, []);

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!data || !effective) return <div className="placeholder">Loading…</div>;

  let filtered = effective;
  if (filterSide !== 'all') filtered = filtered.filter((m) => m.side === filterSide);
  if (showProjects === 'projects') filtered = filtered.filter((m) => m.isProject);
  if (showProjects === 'regular') filtered = filtered.filter((m) => !m.isProject);

  const transcribed = effective.filter((m) => m.skill !== '' || m.rulesText !== '').length;

  const handleExport = () => download('missions.json', {
    _meta: { ...data._meta, provenance: 'user-corrected',
      notes: [...data._meta.notes, `Edited via dev cards tab at ${new Date().toISOString()}.`] },
    missions: effective,
  });

  return (
    <>
      <div style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <ExportRow count={effective.length} isDirty={isDirty} onExport={handleExport}
          onReset={() => { if (confirm('Reset all mission edits?')) setEdits({}); }}
          completeLabel={`${transcribed}/${effective.length} with skill or rules text entered`}
        />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {(['all', 'projects', 'regular'] as const).map((p) => (
            <button key={p} className={`tab-button ${showProjects === p ? 'active' : ''}`} onClick={() => setShowProjects(p)}>{p}</button>
          ))}
          {(['all', 'Rebel', 'Empire'] as const).map((s) => (
            <button key={s} className={`tab-button ${filterSide === s ? 'active' : ''}`} onClick={() => setFilterSide(s)}>
              {s}
            </button>
          ))}
        </span>
      </div>

      <CardGrid>
        {filtered.map((m) => (
          <CardCard key={m.id} sideColor={m.side === 'Rebel' ? '#aae0ff' : '#ffaaaa'} image={m.image}
            badge={m.isProject ? 'project' : (m.isStarting ? 'starting' : null)}>
            <CardName>{m.name}</CardName>
            <div style={{ fontSize: 11, color: '#888' }}>{m.side} {m.isProject ? '· project' : ''}</div>

            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <div style={{ flex: 1 }}>
                <FieldLabel>Skill</FieldLabel>
                <select value={m.skill} onChange={(e) => update(m.id, { skill: e.target.value as Skill | '' })}
                  style={inputStyle}>
                  <option value="">—</option>
                  <option value="diplomacy">diplomacy</option>
                  <option value="intel">intel</option>
                  <option value="specOps">spec ops</option>
                  <option value="logistics">logistics</option>
                </select>
              </div>
              <div style={{ width: 70 }}>
                <FieldLabel>Cost</FieldLabel>
                <input type="number" min={0} max={5} value={m.skillCost}
                  onChange={(e) => update(m.id, { skillCost: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 11, color: '#aaa', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={m.isStarting}
                  onChange={(e) => update(m.id, { isStarting: e.target.checked })} />
                starting
              </label>
              <label style={{ fontSize: 11, color: '#aaa', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={m.isAttempt}
                  onChange={(e) => update(m.id, { isAttempt: e.target.checked })} />
                attempt (vs resolve)
              </label>
            </div>

            <FieldLabel>Leader portrait (id, blank = none)</FieldLabel>
            <input value={m.leaderPortrait ?? ''}
              onChange={(e) => update(m.id, { leaderPortrait: e.target.value.trim() || null })}
              placeholder="e.g. mon-mothma"
              style={inputStyle} />

            <FieldLabel>Rules text</FieldLabel>
            <textarea value={m.rulesText}
              onChange={(e) => update(m.id, { rulesText: e.target.value })}
              rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
          </CardCard>
        ))}
      </CardGrid>
    </>
  );
}

// ============================================================
// Objectives
// ============================================================
function ObjectivesView() {
  const [data, setData] = useState<ObjectivesFile | null>(null);
  const [edits, setEdits] = useState<EditMap<ObjectiveCard>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadObjectives().then((d) => {
      setData(d);
      setEdits(loadEdits<ObjectiveCard>(LS_KEYS.objectives));
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => { saveEdits(LS_KEYS.objectives, edits); }, [edits]);

  const effective = useMemo(() => data ? applyEdits(data.objectives, edits) : null, [data, edits]);
  const isDirty = Object.keys(edits).length > 0;
  const update = (id: string, patch: Partial<ObjectiveCard>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!data || !effective) return <div className="placeholder">Loading…</div>;

  const transcribed = effective.filter((o) => o.reputation > 0 || o.rulesText !== '').length;
  const handleExport = () => download('objectives.json', {
    _meta: { ...data._meta, provenance: 'user-corrected',
      notes: [...data._meta.notes, `Edited via dev cards tab at ${new Date().toISOString()}.`] },
    objectives: effective,
  });

  return (
    <>
      <ExportRow count={effective.length} isDirty={isDirty} onExport={handleExport}
        onReset={() => { if (confirm('Reset all objective edits?')) setEdits({}); }}
        completeLabel={`${transcribed}/${effective.length} with rep value or rules text entered`}
      />

      <CardGrid>
        {effective.map((o) => (
          <CardCard key={o.id} sideColor="#aae0ff" image={o.image} badge={`stage ${o.stage}`}>
            <CardName>{o.name}</CardName>

            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <div style={{ width: 70 }}>
                <FieldLabel>Reputation</FieldLabel>
                <input type="number" min={0} max={6} value={o.reputation}
                  onChange={(e) => update(o.id, { reputation: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <FieldLabel>Timing</FieldLabel>
                <select value={o.timing} onChange={(e) => update(o.id, { timing: e.target.value as ObjectiveTiming })}
                  style={inputStyle}>
                  <option value="">—</option>
                  <option value="Combat">Combat</option>
                  <option value="StartOfRefresh">Start of Refresh</option>
                  <option value="Special">Special</option>
                </select>
              </div>
            </div>

            <FieldLabel>Rules text</FieldLabel>
            <textarea value={o.rulesText}
              onChange={(e) => update(o.id, { rulesText: e.target.value })}
              rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
          </CardCard>
        ))}
      </CardGrid>
    </>
  );
}

// ============================================================
// Tactics
// ============================================================
function TacticsView() {
  const [data, setData] = useState<TacticsFile | null>(null);
  const [edits, setEdits] = useState<EditMap<TacticCard>>({});
  const [filterTheater, setFilterTheater] = useState<'all' | 'ground' | 'space'>('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTactics().then((d) => {
      setData(d);
      setEdits(loadEdits<TacticCard>(LS_KEYS.tactics));
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => { saveEdits(LS_KEYS.tactics, edits); }, [edits]);

  const effective = useMemo(() => data ? applyEdits(data.tactics, edits) : null, [data, edits]);
  const isDirty = Object.keys(edits).length > 0;
  const update = (id: string, patch: Partial<TacticCard>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!data || !effective) return <div className="placeholder">Loading…</div>;

  const filtered = filterTheater === 'all' ? effective : effective.filter((t) => t.theater === filterTheater);
  const transcribed = effective.filter((t) => t.rulesText !== '').length;
  const handleExport = () => download('tactics.json', {
    _meta: { ...data._meta, provenance: 'user-corrected',
      notes: [...data._meta.notes, `Edited via dev cards tab at ${new Date().toISOString()}.`] },
    tactics: effective,
  });

  return (
    <>
      <div style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <ExportRow count={effective.length} isDirty={isDirty} onExport={handleExport}
          onReset={() => { if (confirm('Reset all tactic edits?')) setEdits({}); }}
          completeLabel={`${transcribed}/${effective.length} with rules text entered`}
        />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {(['all', 'ground', 'space'] as const).map((t) => (
            <button key={t} className={`tab-button ${filterTheater === t ? 'active' : ''}`} onClick={() => setFilterTheater(t)}>{t}</button>
          ))}
        </span>
      </div>

      <CardGrid>
        {filtered.map((t) => (
          <CardCard key={t.id} sideColor={t.theater === 'space' ? '#4fc3f7' : '#ffb74d'} image={t.image}
            badge={t.theater}>
            <CardName>{t.name}</CardName>

            <label style={{ fontSize: 11, color: '#aaa', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
              <input type="checkbox" checked={t.requiresSpecial}
                onChange={(e) => update(t.id, { requiresSpecial: e.target.checked })} />
              requires special die (⚡)
            </label>

            <FieldLabel>Rules text</FieldLabel>
            <textarea value={t.rulesText}
              onChange={(e) => update(t.id, { rulesText: e.target.value })}
              rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
          </CardCard>
        ))}
      </CardGrid>
    </>
  );
}

// ============================================================
// Probes (read-only — derived from systems.json)
// ============================================================
function ProbesView() {
  const [data, setData] = useState<ProbesFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadProbes().then(setData).catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!data) return <div className="placeholder">Loading…</div>;

  const expectsCoruscant = data.probes.find((p) => p.systemId === 'coruscant');
  const ok = data.probes.length === 31 && !expectsCoruscant;

  return (
    <>
      <div className="meta-notes">
        <strong>Probe cards are derived</strong> from <code>systems.json</code> — one per non-Coruscant system (rr p.10).
        No editing here. To change which systems exist, edit the systems tab and rerun <code>node scripts/extract-cards.mjs</code>.
      </div>

      <div style={{ marginBottom: 10, fontSize: 13 }}>
        Asserts:{' '}
        {data.probes.length === 31 ? <span style={{ color: '#80dc78' }}>✓ 31 cards</span> : <span style={{ color: '#ff8866' }}>✗ {data.probes.length} cards (expected 31)</span>}{' '}·{' '}
        {!expectsCoruscant ? <span style={{ color: '#80dc78' }}>✓ no Coruscant</span> : <span style={{ color: '#ff8866' }}>✗ Coruscant present</span>}{' '}
        {ok ? '' : '(fix systems.json then rerun extract-cards)'}
      </div>

      <table className="systems-table">
        <thead>
          <tr><th>probe id</th><th>system id</th><th>system name</th></tr>
        </thead>
        <tbody>
          {data.probes.map((p) => (
            <tr key={p.id}>
              <td><code style={{ color: '#80dc78' }}>{p.id}</code></td>
              <td><code>{p.systemId}</code></td>
              <td>{p.systemName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ============================================================
// Layout helpers
// ============================================================
function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
      {children}
    </div>
  );
}

function CardCard({
  image, sideColor, badge, children,
}: {
  image: string;
  sideColor: string;
  badge: string | null;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      background: '#15171c',
      border: `1px solid ${sideColor}33`,
      borderRadius: 6,
      padding: 10,
      display: 'flex',
      gap: 10,
    }}>
      <div style={{ flexShrink: 0, position: 'relative' }}>
        <CardImg image={image} />
        {badge && (
          <span style={{
            position: 'absolute',
            top: 4,
            left: 4,
            background: '#000c',
            color: '#ffd54a',
            padding: '1px 6px',
            borderRadius: 3,
            fontSize: 10,
          }}>{badge}</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

function CardName({ children }: { children: React.ReactNode }) {
  return <strong style={{ color: '#ffd54a', fontSize: 14 }}>{children}</strong>;
}
