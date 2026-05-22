import { useEffect, useState, useMemo, useCallback } from 'react';
import { loadSystems, MAP_IMAGE_URL } from '../data/loadAssets';
import type { System, SystemsFile, ResourceIcon } from '../types';

const NATIVE_W = 3180;
const DISPLAY_W = 1590;
const DISPLAY_H = 795;
const SCALE = DISPLAY_W / NATIVE_W;
const MARKER_R = 22;
const LS_KEY = 'rebellion-dev-systems-edits';

type SystemEdits = Record<string, Partial<Pick<System, 'region' | 'resources' | 'buildSlot'>>>;

function applyEdits(systems: System[], edits: SystemEdits): System[] {
  return systems.map((s) => {
    const e = edits[s.id];
    if (!e) return s;
    return { ...s, ...e };
  });
}

function loadEdits(): SystemEdits {
  const stored = localStorage.getItem(LS_KEY);
  if (!stored) return {};
  try { return JSON.parse(stored); } catch { return {}; }
}

function saveEdits(edits: SystemEdits) {
  if (Object.keys(edits).length === 0) localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, JSON.stringify(edits));
}

// Compare a system to its original to decide whether the edit-entry is empty.
function isPristine(orig: System, merged: Partial<System>): boolean {
  const eRegion = 'region' in merged ? merged.region : orig.region;
  const eSlot = 'buildSlot' in merged ? merged.buildSlot : orig.buildSlot;
  const eRes = 'resources' in merged ? merged.resources! : orig.resources;
  if (eRegion !== orig.region) return false;
  if (eSlot !== orig.buildSlot) return false;
  if (eRes.length !== orig.resources.length) return false;
  for (let i = 0; i < eRes.length; i++) {
    if (eRes[i].type !== orig.resources[i].type) return false;
    if (eRes[i].shape !== orig.resources[i].shape) return false;
  }
  return true;
}

const SHAPE_GLYPH: Record<ResourceIcon['shape'], string> = {
  triangle: '▲',
  circle: '●',
  square: '■',
};

function ShapeColor({ type, shape, size = 14 }: { type: ResourceIcon['type']; shape: ResourceIcon['shape']; size?: number }) {
  const color = type === 'space' ? '#4fc3f7' : '#ffb74d';
  return (
    <span style={{ color, fontSize: size, lineHeight: 1 }}>{SHAPE_GLYPH[shape]}</span>
  );
}

export default function ResourcesTab() {
  const [data, setData] = useState<SystemsFile | null>(null);
  const [edits, setEdits] = useState<SystemEdits>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSystems()
      .then((d) => {
        setData(d);
        setEdits(loadEdits());
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => { saveEdits(edits); }, [edits]);

  const effective = useMemo(() => data ? applyEdits(data.systems, edits) : null, [data, edits]);

  const isDirty = useMemo(() => {
    if (!data || !effective) return false;
    return data.systems.some((s, i) => !isPristine(s, effective[i]));
  }, [data, effective]);

  const updateSystem = useCallback((id: string, patch: Partial<Pick<System, 'resources' | 'buildSlot'>>) => {
    if (!data) return;
    const orig = data.systems.find((s) => s.id === id);
    if (!orig) return;
    setEdits((prev) => {
      const next = { ...prev };
      const merged = { ...(next[id] ?? {}), ...patch };
      if (isPristine(orig, merged)) {
        delete next[id];
      } else {
        next[id] = merged;
      }
      return next;
    });
  }, [data]);

  const handleReset = () => {
    if (!data) return;
    if (!confirm('Reset only the resource + buildSlot edits? (Region edits will be kept.)')) return;
    setEdits((prev) => {
      const next: SystemEdits = {};
      for (const [id, e] of Object.entries(prev)) {
        if ('region' in e) next[id] = { region: e.region };
      }
      return next;
    });
  };

  const handleExport = () => {
    if (!data || !effective) return;
    const out: SystemsFile = {
      _meta: {
        ...data._meta,
        provenance: 'user-corrected',
        notes: [
          ...data._meta.notes,
          `Edited via dev resources tab at ${new Date().toISOString()}.`,
        ],
      },
      systems: effective,
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'systems.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!data || !effective) return <div className="placeholder">Loading…</div>;

  const selected = selectedId ? effective.find((s) => s.id === selectedId) ?? null : null;
  const populousWithResources = effective.filter((s) => !s.isRemote && s.resources.length > 0).length;
  const totalPopulous = effective.filter((s) => !s.isRemote).length;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Resources</h2>

      <div className="meta-notes">
        <strong>What this is:</strong> each populous system has 1–2 hex icons on the board (rr p.12).
        Color: <span style={{ color: '#4fc3f7' }}>blue = space</span>{' '}/{' '}
        <span style={{ color: '#ffb74d' }}>orange = ground</span>.
        Shape: ▲ triangle (smallest units only) ⊂ ● circle (small + medium) ⊂ ■ square (any).
        Each system has a <strong>buildSlot</strong> (1, 2, or 3) — the build-queue position units land on
        when built here (the number printed next to the icons on the board). Subjugated systems use only
        the <em>left</em> icon (resources[0]).
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="tab-button" onClick={handleExport} disabled={!isDirty}>
          Export systems.json {isDirty ? '*' : ''}
        </button>
        <button className="tab-button" onClick={handleReset} disabled={!isDirty}>
          Reset resource edits
        </button>
        <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
          {populousWithResources} / {totalPopulous} populous systems have resources
        </span>
      </div>

      {/* Editor panel above the map, like the regions tab */}
      <div style={{ marginBottom: 12, padding: '10px 14px', background: '#15171c', borderRadius: 4, minHeight: 80 }}>
        {selected ? (
          <ResourceEditorPanel
            system={selected}
            onChange={(patch) => updateSystem(selected.id, patch)}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <div style={{ color: '#888', fontSize: 13 }}>
            <p style={{ margin: '4px 0' }}>Click a populous system on the map to edit its resources.</p>
            <p style={{ margin: '4px 0', fontSize: 12 }}>
              <strong>Marker colors:</strong>{' '}
              <span style={{ color: '#4fc3f7' }}>● blue</span> = mostly space ·{' '}
              <span style={{ color: '#ffb74d' }}>● orange</span> = mostly ground ·{' '}
              <span style={{ color: '#ff7777' }}>● red</span> = populous but no resources set ·{' '}
              <span style={{ color: '#888' }}>● grey</span> = remote (no resources possible)
            </p>
          </div>
        )}
      </div>

      <div>
        {/* Map */}
        <div className="adjacency-canvas" style={{ width: DISPLAY_W, height: DISPLAY_H }}>
          <img src={MAP_IMAGE_URL} width={DISPLAY_W} height={DISPLAY_H} alt="Board" />
          <svg width={DISPLAY_W} height={DISPLAY_H}>
            {effective.map((s) => {
              const x = s.boardPos.x * SCALE;
              const y = s.boardPos.y * SCALE;
              const isSelected = selectedId === s.id;
              const canHaveResources = !s.isRemote;
              const hasResources = s.resources.length > 0;
              let fill = 'rgba(120, 120, 120, 0.35)';
              let stroke = 'rgba(120, 120, 120, 0.6)';
              if (canHaveResources && hasResources) {
                const space = s.resources.filter((r) => r.type === 'space').length;
                const ground = s.resources.filter((r) => r.type === 'ground').length;
                if (space >= ground) { fill = 'rgba(80, 180, 230, 0.6)'; stroke = '#4fc3f7'; }
                else { fill = 'rgba(255, 160, 80, 0.6)'; stroke = '#ffb74d'; }
              } else if (canHaveResources && !hasResources) {
                fill = 'rgba(255, 80, 80, 0.4)';
                stroke = '#ff7777';
              }
              if (isSelected) stroke = 'white';
              return (
                <g key={s.id}>
                  <circle
                    cx={x} cy={y} r={MARKER_R}
                    style={{
                      fill, stroke,
                      strokeWidth: isSelected ? 4 : 2,
                      cursor: canHaveResources ? 'pointer' : 'default',
                      pointerEvents: 'all',
                    }}
                    onClick={() => { if (canHaveResources) setSelectedId(s.id); }}
                  />
                  {hasResources && (
                    <text
                      x={x} y={y + 4}
                      textAnchor="middle"
                      style={{ fontSize: 14, fontWeight: 700, pointerEvents: 'none' }}
                    >
                      {s.resources.map((r, i) => (
                        <tspan key={i} fill={r.type === 'space' ? '#003a5a' : '#5a2a00'}>
                          {SHAPE_GLYPH[r.shape]}
                        </tspan>
                      ))}
                      {s.buildSlot !== null && (
                        <tspan dx={2} fontSize={10} fill="#000">
                          [{s.buildSlot}]
                        </tspan>
                      )}
                    </text>
                  )}
                  <text
                    x={x} y={y + MARKER_R + 12}
                    textAnchor="middle"
                    className="system-label"
                    opacity={isSelected ? 1 : 0.5}
                  >
                    {s.name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
        <p style={{ margin: '4px 0' }}>
          <strong>How to use:</strong> click a populous system on the map. Set its build slot (1–3) and
          add up to 2 resource icons in the panel on the right. Order matters: <strong>resources[0] is the LEFT icon</strong>,
          the only one used when the system is subjugated.
        </p>
      </div>
    </div>
  );
}

function ResourceEditorPanel({
  system,
  onChange,
  onClose,
}: {
  system: System;
  onChange: (patch: Partial<Pick<System, 'resources' | 'buildSlot'>>) => void;
  onClose: () => void;
}) {
  const setResources = (next: ResourceIcon[]) => {
    if (next.length > 2) next = next.slice(0, 2);
    onChange({ resources: next });
  };

  const updateAt = (i: number, patch: Partial<ResourceIcon>) => {
    const next = [...system.resources];
    next[i] = { ...next[i], ...patch };
    setResources(next);
  };

  const removeAt = (i: number) => setResources(system.resources.filter((_, j) => j !== i));

  const addResource = () => {
    if (system.resources.length >= 2) return;
    setResources([...system.resources, { type: 'ground', shape: 'triangle' }]);
  };

  const moveLeft = () => {
    if (system.resources.length < 2) return;
    setResources([system.resources[1], system.resources[0]]);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: '#ffd54a' }}>{system.name}</h3>
        <button
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16 }}
        >×</button>
      </div>

      <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
        {system.isCoruscant ? 'Coruscant (always Imperial)' : 'Populous system'}
      </div>

      {/* Build slot */}
      <div style={{ marginBottom: 16, padding: '10px 12px', background: '#0c0d10', border: '1px solid #2a2d34', borderRadius: 4 }}>
        <div style={{ fontSize: 13, color: '#ffd54a', marginBottom: 8, fontWeight: 600 }}>
          Build queue slot
          <span style={{ marginLeft: 8, color: '#888', fontWeight: 400, fontSize: 11 }}>
            (the number printed next to the resource icons on the board — 1, 2, or 3)
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {([1, 2, 3] as const).map((n) => (
            <button
              key={n}
              onClick={() => onChange({ buildSlot: n })}
              style={{
                padding: '8px 20px',
                background: system.buildSlot === n ? '#ffd54a' : '#1f2228',
                color: system.buildSlot === n ? '#000' : '#aaa',
                border: '1px solid #3a3d44',
                borderRadius: 3,
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: 16,
                minWidth: 50,
              }}
            >{n}</button>
          ))}
        </div>
      </div>

      {/* Resources list */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>
          Resources ({system.resources.length}/2)
          {system.resources.length === 2 && (
            <button
              onClick={moveLeft}
              style={{ marginLeft: 12, fontSize: 11, background: 'transparent', border: '1px solid #3a3d44', color: '#aaa', borderRadius: 3, padding: '2px 6px', cursor: 'pointer' }}
              title="Swap left/right order"
            >
              ⇄ swap
            </button>
          )}
        </div>

        {system.resources.length === 0 && (
          <div style={{ color: '#6a6e78', fontStyle: 'italic', fontSize: 13, marginBottom: 8 }}>none — add one below</div>
        )}

        {system.resources.map((r, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 8px',
              background: '#0c0d10',
              border: '1px solid #2a2d34',
              borderRadius: 4,
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 11, color: '#888', minWidth: 36 }}>
              {i === 0 ? 'LEFT' : 'RIGHT'}
            </span>
            <ShapeColor type={r.type} shape={r.shape} size={18} />
            <select
              value={r.type}
              onChange={(e) => updateAt(i, { type: e.target.value as ResourceIcon['type'] })}
              style={{ background: '#1f2228', color: '#e8e8ea', border: '1px solid #3a3d44', borderRadius: 3, padding: '2px 4px' }}
            >
              <option value="space">space (blue)</option>
              <option value="ground">ground (orange)</option>
            </select>
            <select
              value={r.shape}
              onChange={(e) => updateAt(i, { shape: e.target.value as ResourceIcon['shape'] })}
              style={{ background: '#1f2228', color: '#e8e8ea', border: '1px solid #3a3d44', borderRadius: 3, padding: '2px 4px' }}
            >
              <option value="triangle">▲ triangle</option>
              <option value="circle">● circle</option>
              <option value="square">■ square</option>
            </select>
            <button
              onClick={() => removeAt(i)}
              style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14, marginLeft: 'auto' }}
              title="Remove"
            >×</button>
          </div>
        ))}

        {system.resources.length < 2 && (
          <button
            onClick={addResource}
            style={{
              width: '100%',
              padding: '6px 10px',
              background: 'transparent',
              border: '1px dashed #3a3d44',
              borderRadius: 3,
              color: '#aaa',
              cursor: 'pointer',
              fontSize: 12,
              marginTop: 4,
            }}
          >
            + add resource ({2 - system.resources.length} remaining)
          </button>
        )}
      </div>
    </div>
  );
}
