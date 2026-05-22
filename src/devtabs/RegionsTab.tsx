import { useEffect, useState, useMemo, useCallback } from 'react';
import { loadSystems, MAP_IMAGE_URL } from '../data/loadAssets';
import type { System, SystemsFile } from '../types';

const NATIVE_W = 3180;
const DISPLAY_W = 1590;
const DISPLAY_H = 795;
const SCALE = DISPLAY_W / NATIVE_W;
const MARKER_R = 22;
const LS_KEY = 'rebellion-dev-systems-edits';

const REGION_COLORS = [
  '#e57373', // red
  '#ffb74d', // orange
  '#fff176', // yellow
  '#aed581', // green
  '#4fc3f7', // light blue
  '#7986cb', // indigo
  '#ba68c8', // purple
  '#a1887f', // brown
];

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

export default function RegionsTab() {
  const [data, setData] = useState<SystemsFile | null>(null);
  const [edits, setEdits] = useState<SystemEdits>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
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

  const regionDist = useMemo(() => {
    const m = new Map<number, number>();
    for (let i = 1; i <= 8; i++) m.set(i, 0);
    if (effective) for (const s of effective) m.set(s.region, (m.get(s.region) ?? 0) + 1);
    return m;
  }, [effective]);

  const isDirty = useMemo(() => {
    if (!data || !effective) return false;
    return data.systems.some((s, i) => s.region !== effective[i].region);
  }, [data, effective]);

  const assignRegion = useCallback((systemId: string, region: number) => {
    if (!data) return;
    const orig = data.systems.find((s) => s.id === systemId);
    if (!orig) return;
    setEdits((prev) => {
      const next = { ...prev };
      const merged = { ...(next[systemId] ?? {}), region };
      const sameRegion = merged.region === orig.region;
      const sameSlot = !('buildSlot' in merged) || merged.buildSlot === orig.buildSlot;
      const sameRes = !('resources' in merged) || (
        merged.resources!.length === orig.resources.length &&
        merged.resources!.every((r, i) => r.type === orig.resources[i].type && r.shape === orig.resources[i].shape)
      );
      if (sameRegion && sameSlot && sameRes) {
        delete next[systemId];
      } else {
        next[systemId] = merged;
      }
      return next;
    });
  }, [data]);

  const handleReset = () => {
    if (!data) return;
    if (!confirm('Reset only the region edits? (Resource + buildSlot edits will be kept.)')) return;
    setEdits((prev) => {
      const next: SystemEdits = {};
      for (const [id, e] of Object.entries(prev)) {
        const carry: Partial<Pick<System, 'resources' | 'buildSlot'>> = {};
        if ('resources' in e) carry.resources = e.resources;
        if ('buildSlot' in e) carry.buildSlot = e.buildSlot;
        if (Object.keys(carry).length > 0) next[id] = carry;
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
          `Edited via dev regions tab at ${new Date().toISOString()}.`,
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

  const all4 = [...regionDist.values()].every((v) => v === 4);
  const selected = selectedId ? effective.find((s) => s.id === selectedId) ?? null : null;
  const hoverSys = hoverId ? effective.find((s) => s.id === hoverId) : null;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Regions</h2>

      <div className="meta-notes">
        <strong>What this is:</strong> the 8 thick-orange-bordered wedges on the board (rr p.12). Region IDs are internal — players never see them — but the engine uses them for the few card effects that say "this system's region." Rules require <strong>exactly 4 systems per region</strong>.
      </div>

      {/* Step 1: select a system */}
      <div style={{ marginBottom: 12, padding: '10px 12px', background: '#15171c', borderRadius: 4 }}>
        <div style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>
          <strong style={{ color: '#ffd54a' }}>Step 1:</strong> click a system on the map to select it.
        </div>
        <div style={{ fontSize: 13 }}>
          {selected ? (
            <span>
              <strong style={{ color: 'white' }}>{selected.name}</strong>
              <span style={{ marginLeft: 8, color: '#888' }}>currently in</span>
              <span style={{
                marginLeft: 6,
                background: REGION_COLORS[selected.region - 1],
                color: '#000',
                padding: '1px 8px',
                borderRadius: 3,
                fontWeight: 600,
              }}>Region {selected.region}</span>
              <button
                onClick={() => setSelectedId(null)}
                style={{ marginLeft: 12, background: 'transparent', border: '1px solid #3a3d44', color: '#aaa', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
              >clear</button>
            </span>
          ) : (
            <span style={{ color: '#888' }}>No system selected yet.</span>
          )}
        </div>
      </div>

      {/* Step 2: pick the destination region */}
      <div style={{ marginBottom: 12, padding: '10px 12px', background: '#15171c', borderRadius: 4 }}>
        <div style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>
          <strong style={{ color: '#ffd54a' }}>Step 2:</strong> click a region to {selected ? <span>move <strong style={{ color: 'white' }}>{selected.name}</strong> to it</span> : 'assign the selected system'}.
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((r) => {
            const count = regionDist.get(r) ?? 0;
            const isCurrent = selected && selected.region === r;
            return (
              <button
                key={r}
                disabled={!selected || (isCurrent ?? false)}
                onClick={() => { if (selected) assignRegion(selected.id, r); }}
                style={{
                  padding: '6px 12px',
                  borderRadius: 4,
                  border: '2px solid transparent',
                  background: REGION_COLORS[r - 1],
                  color: '#000',
                  cursor: selected && !isCurrent ? 'pointer' : 'not-allowed',
                  fontWeight: 600,
                  fontSize: 13,
                  minWidth: 70,
                  opacity: !selected ? 0.4 : isCurrent ? 0.6 : 1,
                  outline: isCurrent ? '2px solid white' : 'none',
                  outlineOffset: 2,
                }}
                title={isCurrent ? `${selected!.name} is already in Region ${r}` : `Move ${selected?.name ?? '(no selection)'} to Region ${r}`}
              >
                Region {r}{' '}
                <span style={{ opacity: 0.7, fontSize: 11 }}>({count}/4)</span>
              </button>
            );
          })}
          <span style={{ marginLeft: 8, color: all4 ? '#80dc78' : '#ff8866', fontSize: 13 }}>
            {all4 ? '✓ 4 per region' : 'rules require 4 per region'}
          </span>
        </div>
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8 }}>
        <button className="tab-button" onClick={handleExport} disabled={!isDirty}>
          Export systems.json {isDirty ? '*' : ''}
        </button>
        <button className="tab-button" onClick={handleReset} disabled={!isDirty}>
          Reset region edits
        </button>
      </div>

      <div className="adjacency-info">
        {hoverSys ? (
          <>
            <span className="label">{hoverSys.name}</span>
            <span style={{ marginLeft: 8, color: '#aaa' }}>
              in{' '}
              <span style={{
                background: REGION_COLORS[hoverSys.region - 1],
                color: '#000',
                padding: '1px 6px',
                borderRadius: 3,
                fontWeight: 600,
              }}>Region {hoverSys.region}</span>
            </span>
          </>
        ) : selected ? (
          <span style={{ color: '#aaa' }}>Click a region button above to move <strong>{selected.name}</strong>, or click a different system to switch selection.</span>
        ) : (
          <span style={{ color: '#888' }}>Hover a system to see its region. Click to select it.</span>
        )}
      </div>

      <div className="adjacency-canvas" style={{ width: DISPLAY_W, height: DISPLAY_H }}>
        <img src={MAP_IMAGE_URL} width={DISPLAY_W} height={DISPLAY_H} alt="Board" />
        <svg width={DISPLAY_W} height={DISPLAY_H}>
          {effective.map((s) => {
            const x = s.boardPos.x * SCALE;
            const y = s.boardPos.y * SCALE;
            const color = REGION_COLORS[s.region - 1];
            const isSelected = selectedId === s.id;
            const isHover = hoverId === s.id;
            return (
              <g key={s.id}>
                <circle
                  cx={x} cy={y} r={MARKER_R}
                  style={{
                    fill: color,
                    fillOpacity: 0.7,
                    stroke: isSelected ? 'white' : isHover ? '#ffd54a' : color,
                    strokeWidth: isSelected ? 4 : isHover ? 3 : 2,
                    cursor: 'pointer',
                    pointerEvents: 'all',
                  }}
                  onMouseEnter={() => setHoverId(s.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onClick={() => setSelectedId(s.id)}
                />
                <text
                  x={x} y={y + MARKER_R + 12}
                  textAnchor="middle"
                  className="system-label"
                  opacity={isSelected || isHover ? 1 : 0.6}
                  style={{ fill: isSelected ? 'white' : color }}
                >
                  {s.name}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
        <p style={{ margin: '4px 0' }}>
          <strong>How to use:</strong> (1) click a system on the map to select it (it gets a white border). (2) click one of the eight Region buttons above to move that system to that region. The system marker color updates to match its new region.
        </p>
        <p style={{ margin: '4px 0' }}>
          Each system's marker is colored by its current region. Click any other system at any time to switch selection. The region button matching a selected system's current region is disabled (you can't move it to where it already is).
        </p>
      </div>
    </div>
  );
}
