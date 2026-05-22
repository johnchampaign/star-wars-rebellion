import { useEffect, useState, useMemo, useCallback } from 'react';
import { loadLeaders, LEADER_IMAGE_BASE } from '../data/loadAssets';
import type { Leader, LeadersFile, SkillCounts, TacticValues } from '../types';

const LS_KEY = 'rebellion-dev-leaders-edits';

type LeaderEdits = Record<string, Partial<Pick<Leader, 'skills' | 'minorSkills' | 'tacticValues' | 'isStarting'>>>;

function applyEdits(leaders: Leader[], edits: LeaderEdits): Leader[] {
  return leaders.map((l) => {
    const e = edits[l.id];
    if (!e) return l;
    return { ...l, ...e };
  });
}

function leadersEqual(a: Leader, b: Leader): boolean {
  if (a.isStarting !== b.isStarting) return false;
  const sk = (['diplomacy', 'intel', 'specOps', 'logistics'] as const);
  for (const k of sk) {
    if (a.skills[k] !== b.skills[k]) return false;
    if (a.minorSkills[k] !== b.minorSkills[k]) return false;
  }
  if (a.tacticValues.space !== b.tacticValues.space) return false;
  if (a.tacticValues.ground !== b.tacticValues.ground) return false;
  return true;
}

const SKILL_COLOR: Record<keyof SkillCounts, string> = {
  diplomacy: '#ffa726', // orange
  intel:     '#4dd0c0', // teal
  specOps:   '#e53935', // red
  logistics: '#9aa0a6', // grey
};

const SKILL_LABEL: Record<keyof SkillCounts, string> = {
  diplomacy: 'diplomacy',
  intel: 'intel',
  specOps: 'spec ops',
  logistics: 'logistics',
};

function SkillIcon({ skill, size = 14 }: { skill: keyof SkillCounts; size?: number }) {
  return (
    <span
      title={SKILL_LABEL[skill]}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: SKILL_COLOR[skill],
        flexShrink: 0,
        verticalAlign: 'middle',
      }}
    />
  );
}

function CountStepper({
  value,
  onChange,
  max = 4,
  color = '#ffd54a',
}: {
  value: number;
  onChange: (next: number) => void;
  max?: number;
  color?: string;
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
      <button
        onClick={() => onChange(Math.max(0, value - 1))}
        style={{ width: 18, height: 18, background: '#1f2228', border: '1px solid #3a3d44', color: '#aaa', cursor: 'pointer', borderRadius: 3, padding: 0, lineHeight: '14px' }}
      >−</button>
      <span style={{ minWidth: 18, textAlign: 'center', color, fontWeight: 600, fontSize: 13 }}>{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        style={{ width: 18, height: 18, background: '#1f2228', border: '1px solid #3a3d44', color: '#aaa', cursor: 'pointer', borderRadius: 3, padding: 0, lineHeight: '14px' }}
      >+</button>
    </div>
  );
}

export default function LeadersTab() {
  const [data, setData] = useState<LeadersFile | null>(null);
  const [edits, setEdits] = useState<LeaderEdits>({});
  const [error, setError] = useState<string | null>(null);
  const [showSide, setShowSide] = useState<'all' | 'Rebel' | 'Empire'>('all');

  useEffect(() => {
    loadLeaders()
      .then((d) => {
        setData(d);
        const stored = localStorage.getItem(LS_KEY);
        if (stored) {
          try { setEdits(JSON.parse(stored)); } catch {}
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (Object.keys(edits).length === 0) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, JSON.stringify(edits));
  }, [edits]);

  const effective = useMemo(() => data ? applyEdits(data.leaders, edits) : null, [data, edits]);

  const isDirty = useMemo(() => {
    if (!data || !effective) return false;
    return data.leaders.some((l, i) => !leadersEqual(l, effective[i]));
  }, [data, effective]);

  const updateLeader = useCallback((id: string, patch: Partial<Pick<Leader, 'skills' | 'tacticValues' | 'isStarting'>>) => {
    if (!data) return;
    const orig = data.leaders.find((l) => l.id === id);
    if (!orig) return;
    setEdits((prev) => {
      const next = { ...prev };
      const merged = { ...orig, ...(next[id] ?? {}), ...patch };
      // Diff vs orig: keep only changed entries
      if (leadersEqual(orig, merged)) {
        delete next[id];
      } else {
        // Only store fields that differ
        const delta: Partial<Leader> = {};
        if (merged.isStarting !== orig.isStarting) delta.isStarting = merged.isStarting;
        if (
          merged.skills.diplomacy !== orig.skills.diplomacy ||
          merged.skills.intel !== orig.skills.intel ||
          merged.skills.specOps !== orig.skills.specOps ||
          merged.skills.logistics !== orig.skills.logistics
        ) delta.skills = merged.skills;
        if (
          merged.tacticValues.space !== orig.tacticValues.space ||
          merged.tacticValues.ground !== orig.tacticValues.ground
        ) delta.tacticValues = merged.tacticValues;
        next[id] = delta;
      }
      return next;
    });
  }, [data]);

  const handleReset = () => {
    if (!confirm('Discard all local leader edits and revert to the loaded JSON?')) return;
    setEdits({});
  };

  const handleExport = () => {
    if (!data || !effective) return;
    const out: LeadersFile = {
      _meta: {
        ...data._meta,
        provenance: 'user-corrected',
        notes: [
          ...data._meta.notes,
          `Edited via dev leaders tab at ${new Date().toISOString()}.`,
        ],
      },
      leaders: effective,
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'leaders.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!data || !effective) return <div className="placeholder">Loading…</div>;

  const filtered = showSide === 'all' ? effective : effective.filter((l) => l.side === showSide);
  const completedCount = effective.filter((l) => {
    const sk = l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics;
    const tv = l.tacticValues.space + l.tacticValues.ground;
    return sk > 0 || tv > 0; // a leader with all-zero stats hasn't been transcribed yet
  }).length;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Leaders ({effective.length})</h2>

      <div className="meta-notes">
        <strong>What this is:</strong> 25 leader cards (Rebel + Empire). Each card has 1–3 major
        skill icons in the middle row and printed tactic values (space / ground) in the bottom
        corners. Some leaders have 0 in a theater — that means they cannot activate a system or
        draw tactic cards in that theater.
        <ul>
          <li style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <SkillIcon skill="diplomacy" /> diplomacy
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <SkillIcon skill="intel" /> intel
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <SkillIcon skill="specOps" /> spec ops
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <SkillIcon skill="logistics" /> logistics
            </span>
          </li>
          <li>Click the card image to enlarge it for closer inspection.</li>
          <li>Leaders with all-zero stats are unverified (highlighted red).</li>
        </ul>
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="tab-button" onClick={handleExport} disabled={!isDirty}>
          Export leaders.json {isDirty ? '*' : ''}
        </button>
        <button className="tab-button" onClick={handleReset} disabled={!isDirty}>
          Reset
        </button>
        <span style={{ marginLeft: 8, color: '#888', fontSize: 12 }}>
          {completedCount} / {effective.length} leaders have stats entered
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {(['all', 'Rebel', 'Empire'] as const).map((s) => (
            <button
              key={s}
              className={`tab-button ${showSide === s ? 'active' : ''}`}
              onClick={() => setShowSide(s)}
            >
              {s}
            </button>
          ))}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
        {filtered.map((l) => {
          const orig = data.leaders.find((x) => x.id === l.id)!;
          const hasStats =
            l.skills.diplomacy + l.skills.intel + l.skills.specOps + l.skills.logistics > 0 ||
            l.tacticValues.space + l.tacticValues.ground > 0;
          const isEdited = !leadersEqual(orig, l);
          return (
            <div
              key={l.id}
              style={{
                background: '#15171c',
                border: `1px solid ${isEdited ? '#ffd54a' : hasStats ? '#2a2d34' : '#4a2020'}`,
                borderRadius: 6,
                padding: 10,
                display: 'flex',
                gap: 10,
              }}
            >
              <a href={`${LEADER_IMAGE_BASE}/${l.image}`} target="_blank" rel="noreferrer" title="Open full size">
                <img
                  src={`${LEADER_IMAGE_BASE}/${l.image}`}
                  alt={l.name}
                  style={{ width: 110, height: 'auto', borderRadius: 4, display: 'block' }}
                />
              </a>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
                  <strong style={{ color: l.side === 'Rebel' ? '#aae0ff' : '#ffaaaa' }}>{l.name}</strong>
                  <span style={{ fontSize: 11, color: '#888' }}>{l.side}</span>
                </div>

                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 11, color: '#aaa', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={l.isStarting}
                      onChange={(e) => updateLeader(l.id, { isStarting: e.target.checked })}
                    />
                    starting
                  </label>
                </div>

                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Skills:</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 12 }}>
                    {(['diplomacy', 'intel', 'specOps', 'logistics'] as const).map((k) => (
                      <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <SkillIcon skill={k} size={16} />
                        <span style={{ flex: 1, color: '#aaa', fontSize: 11 }}>{SKILL_LABEL[k]}</span>
                        <CountStepper
                          value={l.skills[k]}
                          onChange={(n) => updateLeader(l.id, { skills: { ...l.skills, [k]: n } })}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Tactic values:</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    {(['space', 'ground'] as const).map((k) => (
                      <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 14, color: k === 'space' ? '#4fc3f7' : '#ffb74d' }}>●</span>
                        <span style={{ flex: 1, color: '#aaa', fontSize: 11 }}>{k}</span>
                        <CountStepper
                          value={l.tacticValues[k]}
                          onChange={(n) => updateLeader(l.id, { tacticValues: { ...l.tacticValues, [k]: n } as TacticValues })}
                          color={k === 'space' ? '#4fc3f7' : '#ffb74d'}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
