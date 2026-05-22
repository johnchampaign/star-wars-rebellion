// Drag system markers to reposition them on the planet artwork.
// Same localStorage key and shape as before — any prior edits are preserved.

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { loadSystems, MAP_IMAGE_URL } from '../data/loadAssets';
import type { System, SystemsFile } from '../types';

const NATIVE_W = 3180;
const NATIVE_H = 1590;
const DISPLAY_W = 1590;
const DISPLAY_H = 795;
const SCALE = DISPLAY_W / NATIVE_W;
const INV_SCALE = NATIVE_W / DISPLAY_W;
const MARKER_R = 22;
const LS_KEY = 'rebellion-dev-systems-edits';

type SystemEdits = Record<string, Partial<Pick<System, 'region' | 'resources' | 'buildSlot' | 'boardPos'>>>;

function applyEdits(systems: System[], edits: SystemEdits): System[] {
  return systems.map((s) => {
    const e = edits[s.id];
    if (!e) return s;
    return { ...s, ...e, boardPos: e.boardPos ?? s.boardPos };
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

export default function PositionsTab() {
  const [data, setData] = useState<SystemsFile | null>(null);
  const [edits, setEdits] = useState<SystemEdits>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

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

  const editedFlag = useCallback((s: System) => {
    if (!data) return false;
    const orig = data.systems.find((o) => o.id === s.id);
    if (!orig) return false;
    return orig.boardPos.x !== s.boardPos.x || orig.boardPos.y !== s.boardPos.y;
  }, [data]);

  const isDirty = useMemo(() => {
    if (!data || !effective) return false;
    return effective.some(editedFlag);
  }, [data, effective, editedFlag]);

  const updateBoardPos = useCallback((id: string, x: number, y: number) => {
    if (!data) return;
    const orig = data.systems.find((s) => s.id === id);
    if (!orig) return;
    const newX = Math.round(x);
    const newY = Math.round(y);
    setEdits((prev) => {
      const next = { ...prev };
      const merged = { ...(next[id] ?? {}) };
      const sameX = newX === orig.boardPos.x;
      const sameY = newY === orig.boardPos.y;
      if (sameX && sameY) {
        delete merged.boardPos;
      } else {
        merged.boardPos = { x: newX, y: newY };
      }
      if (Object.keys(merged).length === 0) delete next[id];
      else next[id] = merged;
      return next;
    });
  }, [data]);

  // SVG mouse move during drag
  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragging || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const nativeX = localX * INV_SCALE;
    const nativeY = localY * INV_SCALE;
    if (nativeX < 0 || nativeY < 0 || nativeX > NATIVE_W || nativeY > NATIVE_H) return;
    updateBoardPos(dragging, nativeX, nativeY);
  }, [dragging, updateBoardPos]);

  useEffect(() => {
    if (!dragging) return;
    const upHandler = () => setDragging(null);
    document.addEventListener('mouseup', upHandler);
    return () => document.removeEventListener('mouseup', upHandler);
  }, [dragging]);

  const handleResetOne = (id: string) => {
    setEdits((prev) => {
      const next = { ...prev };
      if (next[id]?.boardPos) {
        const merged = { ...next[id] };
        delete merged.boardPos;
        if (Object.keys(merged).length === 0) delete next[id];
        else next[id] = merged;
      }
      return next;
    });
  };

  const handleReset = () => {
    if (!data) return;
    if (!confirm('Reset only the position edits? (Region/resources/buildSlot edits will be kept.)')) return;
    setEdits((prev) => {
      const next: SystemEdits = {};
      for (const [id, e] of Object.entries(prev)) {
        const carry: typeof e = {};
        if ('region' in e) carry.region = e.region;
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
        notes: [...data._meta.notes, `Edited via dev positions tab at ${new Date().toISOString()}.`],
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

  const editedCount = effective.filter(editedFlag).length;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Positions</h2>

      <div className="meta-notes">
        <strong>What this is:</strong> the .vmod's <code>boardPos</code> coordinates came from
        drag-target boxes for game pieces, not the centers of planet artwork. Drag each marker
        onto its planet's center to fix it everywhere.
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="tab-button" onClick={handleExport} disabled={!isDirty}>
          Export systems.json {isDirty ? '*' : ''}
        </button>
        <button className="tab-button" onClick={handleReset} disabled={!isDirty}>
          Reset all position edits
        </button>
        <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
          {editedCount} / {effective.length} repositioned
        </span>
        {dragging && (
          <span style={{ marginLeft: 'auto', color: '#ff7ab8', fontWeight: 600, fontSize: 13 }}>
            Dragging: {dragging}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        {/* Sidebar progress list */}
        <div style={{
          flex: '0 0 200px',
          maxHeight: DISPLAY_H,
          overflowY: 'auto',
          background: '#15171c',
          padding: 8,
          borderRadius: 4,
        }}>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>
            Progress · click ✓ to undo one
          </div>
          {effective.map((s) => {
            const isEdited = editedFlag(s);
            const isHovered = hoverId === s.id;
            return (
              <div
                key={s.id}
                onMouseEnter={() => setHoverId(s.id)}
                onMouseLeave={() => setHoverId(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 6px',
                  marginBottom: 1,
                  borderRadius: 2,
                  background: isHovered ? '#1f2228' : 'transparent',
                  color: isEdited ? '#80dc78' : '#aaa',
                  fontSize: 11,
                }}
              >
                {isEdited ? (
                  <button
                    onClick={() => handleResetOne(s.id)}
                    title="Undo this position edit"
                    style={{
                      background: 'transparent', border: 'none', color: '#80dc78',
                      cursor: 'pointer', padding: 0, fontSize: 12, width: 14,
                    }}
                  >
                    ✓
                  </button>
                ) : (
                  <span style={{ width: 14, textAlign: 'center' }}>○</span>
                )}
                {s.name}
              </div>
            );
          })}
        </div>

        {/* Map with draggable markers */}
        <div
          className="adjacency-canvas"
          style={{ width: DISPLAY_W, height: DISPLAY_H, userSelect: 'none', flexShrink: 0 }}
        >
          <img src={MAP_IMAGE_URL} width={DISPLAY_W} height={DISPLAY_H} alt="Board" draggable={false} />
          <svg
            ref={svgRef}
            width={DISPLAY_W}
            height={DISPLAY_H}
            onMouseMove={handleMouseMove}
            style={{ cursor: dragging ? 'grabbing' : 'default' }}
          >
            {effective.map((s) => {
              const x = s.boardPos.x * SCALE;
              const y = s.boardPos.y * SCALE;
              const isHover = hoverId === s.id;
              const isDragging = dragging === s.id;
              const isEdited = editedFlag(s);
              return (
                <g key={s.id}>
                  {(isHover || isDragging) && (
                    <>
                      <line x1={x - 30} y1={y} x2={x + 30} y2={y} stroke="rgba(255,215,80,0.5)" strokeWidth={1} pointerEvents="none" />
                      <line x1={x} y1={y - 30} x2={x} y2={y + 30} stroke="rgba(255,215,80,0.5)" strokeWidth={1} pointerEvents="none" />
                    </>
                  )}
                  <circle
                    cx={x} cy={y} r={MARKER_R}
                    style={{
                      fill: isEdited ? 'rgba(80, 220, 120, 0.45)' : 'rgba(255, 215, 80, 0.35)',
                      stroke: isDragging ? '#ff7ab8' : isHover ? '#ffd54a' : (isEdited ? 'rgba(80, 220, 120, 0.9)' : 'rgba(255, 215, 80, 0.6)'),
                      strokeWidth: isDragging ? 3 : 2,
                      cursor: 'grab',
                      pointerEvents: 'all',
                    }}
                    onMouseEnter={() => setHoverId(s.id)}
                    onMouseLeave={() => setHoverId(null)}
                    onMouseDown={(e) => { e.preventDefault(); setDragging(s.id); }}
                  />
                  <text
                    x={x} y={y + MARKER_R + 12}
                    textAnchor="middle"
                    className="system-label"
                    opacity={isHover || isDragging || isEdited ? 1 : 0.5}
                    style={{ pointerEvents: 'none' }}
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
          <strong>How to use:</strong> click and drag any marker onto the center of its planet's
          image. The crosshair appears while hovering or dragging for precise alignment.
          Repositioned markers turn <span style={{ color: '#80dc78' }}>green</span>. Click the
          ✓ next to a name in the sidebar to undo that one system's edit.
        </p>
      </div>
    </div>
  );
}
