// Territory editor — overlays the traced territory polygons on the board image
// and lets you drag vertices, insert/delete points, move whole cells, and
// add/remove territories. Edits persist to localStorage (LS_TERRITORIES) so the
// no-art vector fallback in the play tab reflects them live; Export downloads an
// updated src/data/territories.json (with recomputed centroid/area).

import { useEffect, useState, useRef, useCallback } from 'react';
import { MAP_IMAGE_URL } from '../data/loadAssets';
import { useArtLoaded, getCachedArtUrlSync } from '../play/vmodArtCache';
import {
  TERRITORIES, cloneRegions, loadTerritoryEdits, saveTerritoryEdits,
  polygonCentroid, polygonArea, territoryFill,
  type TerritoryRegion,
} from '../data/territories';

const NATIVE_W = 3180;
const NATIVE_H = 1590;
const DISPLAY_W = 1590;
const DISPLAY_H = 795;
const SCALE = DISPLAY_W / NATIVE_W;
const INV_SCALE = NATIVE_W / DISPLAY_W;

type Drag =
  | { kind: 'vertex'; id: number; index: number }
  | { kind: 'move'; id: number; last: [number, number] }
  | null;

function nextId(regions: TerritoryRegion[]): number {
  return regions.reduce((m, r) => Math.max(m, r.id), -1) + 1;
}

// Distance² from point p to segment ab, plus the index to insert after.
function distToSeg(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * dx, cy = a[1] + t * dy;
  return (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
}

export default function TerritoriesTab() {
  const [base, setBase] = useState<TerritoryRegion[]>([]);
  const [regions, setRegions] = useState<TerritoryRegion[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Initial load: canonical base + any local edits.
  useEffect(() => {
    const b = cloneRegions(TERRITORIES.regions);
    setBase(b);
    setRegions(loadTerritoryEdits() ?? cloneRegions(b));
  }, []);

  // Persist edits whenever they change.
  useEffect(() => {
    if (base.length) saveTerritoryEdits(regions, base);
  }, [regions, base]);

  const isDirty = base.length > 0 && JSON.stringify(regions) !== JSON.stringify(base);

  const toNative = useCallback((clientX: number, clientY: number): [number, number] | null => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    return [
      Math.round((clientX - rect.left) * INV_SCALE),
      Math.round((clientY - rect.top) * INV_SCALE),
    ];
  }, []);

  // ---- vertex / move dragging ----------------------------------------------
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const n = toNative(e.clientX, e.clientY);
    if (!n) return;
    if (drag.kind === 'vertex') {
      setRegions((rs) => rs.map((r) =>
        r.id === drag.id
          ? { ...r, exterior: r.exterior.map((p, i) => (i === drag.index ? n : p)) }
          : r));
    } else {
      const dx = n[0] - drag.last[0], dy = n[1] - drag.last[1];
      setRegions((rs) => rs.map((r) =>
        r.id === drag.id
          ? { ...r, exterior: r.exterior.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
          : r));
      setDrag({ ...drag, last: n });
    }
  };

  const endDrag = () => setDrag(null);
  useEffect(() => {
    if (!drag) return;
    const up = () => setDrag(null);
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, [drag]);

  // Insert a vertex on the selected polygon's nearest edge at the click point.
  const insertVertexAt = (id: number, p: [number, number]) => {
    setRegions((rs) => rs.map((r) => {
      if (r.id !== id || r.exterior.length < 2) return r;
      let bestI = 0, bestD = Infinity;
      for (let i = 0; i < r.exterior.length; i++) {
        const a = r.exterior[i], b = r.exterior[(i + 1) % r.exterior.length];
        const d = distToSeg(p, a, b);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      const ext = r.exterior.slice();
      ext.splice(bestI + 1, 0, p);
      return { ...r, exterior: ext };
    }));
  };

  const deleteVertex = () => {
    if (selectedId === null || selectedVertex === null) return;
    setRegions((rs) => rs.map((r) => {
      if (r.id !== selectedId || r.exterior.length <= 3) return r;
      return { ...r, exterior: r.exterior.filter((_, i) => i !== selectedVertex) };
    }));
    setSelectedVertex(null);
  };

  // Keyboard: Delete removes the selected vertex.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedVertex !== null) {
        e.preventDefault();
        deleteVertex();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const addTerritory = () => {
    const id = nextId(regions);
    const cx = NATIVE_W / 2, cy = NATIVE_H / 2;
    const s = 120;
    const ext: [number, number][] = [
      [cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s],
    ];
    setRegions((rs) => [...rs, { id, area_px: polygonArea(ext), centroid: polygonCentroid(ext), exterior: ext }]);
    setSelectedId(id);
    setSelectedVertex(null);
  };

  const deleteTerritory = () => {
    if (selectedId === null) return;
    if (!confirm(`Delete territory #${selectedId}?`)) return;
    setRegions((rs) => rs.filter((r) => r.id !== selectedId));
    setSelectedId(null);
    setSelectedVertex(null);
  };

  const handleReset = () => {
    if (!confirm('Discard all local territory edits and revert to the saved file?')) return;
    setRegions(cloneRegions(base));
    setSelectedId(null);
    setSelectedVertex(null);
  };

  const handleExport = () => {
    // Recompute centroid + area from the (possibly edited) polygons.
    const out = {
      _meta: {
        ...(TERRITORIES._meta ?? { schema: 'territories-v1', provenance: 'user-corrected', source: '', notes: [] }),
        provenance: 'user-corrected',
        notes: [
          ...(TERRITORIES._meta?.notes ?? []),
          `Edited via dev territories tab at ${new Date().toISOString()}.`,
        ],
      },
      image: { width: NATIVE_W, height: NATIVE_H },
      count: regions.length,
      regions: regions.map((r) => ({
        area_px: polygonArea(r.exterior),
        centroid: polygonCentroid(r.exterior),
        exterior: r.exterior,
        id: r.id,
      })),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'territories.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  // Resolve the board image the same way the play tab does: prefer the user's
  // uploaded VASSAL art from the IndexedDB cache (handles the Map-Redux alias),
  // falling back to the static dev-asset. useArtLoaded() forces a re-render once
  // the cached blob URLs are ready.
  useArtLoaded();
  const mapSrc = getCachedArtUrlSync('Map.png') ?? MAP_IMAGE_URL;

  const selected = selectedId !== null ? regions.find((r) => r.id === selectedId) : null;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Territories</h2>

      <div className="meta-notes">
        <strong>What this is:</strong> the board's territory cells, traced as polygons from the
        printed map. The no-art vector fallback in the play tab renders these. Drag vertices to
        reshape, double-click an edge to add a point, select a vertex and press Delete to remove
        it, or drag the cyan centroid handle to move a whole cell.
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="tab-button" onClick={handleExport} disabled={!isDirty}>
          Export territories.json {isDirty ? '*' : ''}
        </button>
        <button className="tab-button" onClick={handleReset} disabled={!isDirty}>Reset</button>
        <button className="tab-button" onClick={addTerritory}>+ Add territory</button>
        <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
          {regions.length} territories
        </span>
        {selected && (
          <>
            <button className="tab-button" onClick={deleteVertex}
              disabled={selectedVertex === null || selected.exterior.length <= 3}
              style={{ marginLeft: 'auto' }}>
              Delete vertex
            </button>
            <button className="tab-button" onClick={deleteTerritory} style={{ color: '#ff8866' }}>
              Delete territory #{selectedId}
            </button>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        {/* Sidebar */}
        <div style={{
          flex: '0 0 170px', maxHeight: DISPLAY_H, overflowY: 'auto',
          background: '#15171c', padding: 8, borderRadius: 4,
        }}>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>Territories</div>
          {regions.map((r) => {
            const sel = selectedId === r.id;
            return (
              <div key={r.id}
                onClick={() => { setSelectedId(r.id); setSelectedVertex(null); }}
                style={{
                  marginBottom: 4, padding: '4px 6px',
                  border: '1px solid ' + (sel ? '#ff7ab8' : '#2a2d34'),
                  borderRadius: 3, cursor: 'pointer',
                  background: sel ? '#1f1428' : 'transparent',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                <span style={{
                  width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                  background: territoryFill(r.id), border: '1px solid #b5662e',
                }} />
                <span style={{ fontSize: 12, color: '#e8e8ea' }}>#{r.id}</span>
                <span style={{ fontSize: 10, color: '#777', marginLeft: 'auto', fontFamily: 'monospace' }}>
                  {r.exterior.length}v
                </span>
              </div>
            );
          })}
        </div>

        {/* Board */}
        <div className="adjacency-canvas"
          style={{ width: DISPLAY_W, height: DISPLAY_H, flexShrink: 0, userSelect: 'none' }}>
          <img src={mapSrc} width={DISPLAY_W} height={DISPLAY_H} alt="Board" draggable={false} />
          <svg ref={svgRef} width={DISPLAY_W} height={DISPLAY_H}
            onMouseMove={handleMouseMove} onMouseUp={endDrag}
            style={{ position: 'absolute', top: 0, left: 0, cursor: 'default', pointerEvents: 'all' }}>
            {/* backstop: click empty space to deselect */}
            <rect x={0} y={0} width={DISPLAY_W} height={DISPLAY_H} fill="transparent"
              onMouseDown={() => { setSelectedId(null); setSelectedVertex(null); }} />

            {regions.map((r) => {
              const sel = selectedId === r.id;
              const pts = r.exterior.map(([x, y]) => `${x * SCALE},${y * SCALE}`).join(' ');
              const fill = territoryFill(r.id);
              return (
                <g key={r.id}>
                  <polygon points={pts}
                    onMouseDown={(e) => { e.stopPropagation(); setSelectedId(r.id); setSelectedVertex(null); }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      const n = toNative(e.clientX, e.clientY);
                      if (n) { setSelectedId(r.id); insertVertexAt(r.id, n); }
                    }}
                    style={{
                      fill: sel ? `${fill}66` : `${fill}33`,
                      stroke: sel ? '#ffd54a' : '#b5662e',
                      strokeWidth: sel ? 2 : 1.2,
                      strokeLinejoin: 'round', cursor: 'pointer', pointerEvents: 'all',
                    }} />
                  {/* id label at centroid */}
                  <text x={polygonCentroid(r.exterior)[0] * SCALE} y={polygonCentroid(r.exterior)[1] * SCALE}
                    textAnchor="middle" dominantBaseline="middle"
                    style={{ fill: sel ? '#fff' : '#cfcfd4', fontSize: 12, fontWeight: 700, pointerEvents: 'none' }}>
                    {r.id}
                  </text>
                </g>
              );
            })}

            {/* Vertex + centroid handles for the selected territory (on top) */}
            {selected && (() => {
              const c = polygonCentroid(selected.exterior);
              return (
                <g>
                  {selected.exterior.map((p, i) => {
                    const vsel = selectedVertex === i;
                    return (
                      <circle key={i} cx={p[0] * SCALE} cy={p[1] * SCALE} r={vsel ? 6 : 4.5}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setSelectedVertex(i);
                          setDrag({ kind: 'vertex', id: selected.id, index: i });
                        }}
                        style={{
                          fill: vsel ? '#ffd54a' : '#ff7ab8',
                          stroke: '#1a1a1a', strokeWidth: 1, cursor: 'grab', pointerEvents: 'all',
                        }} />
                    );
                  })}
                  {/* centroid: drag to move whole cell */}
                  <circle cx={c[0] * SCALE} cy={c[1] * SCALE} r={6}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const n = toNative(e.clientX, e.clientY);
                      if (n) setDrag({ kind: 'move', id: selected.id, last: n });
                    }}
                    style={{ fill: '#3ad6e0', stroke: '#0a2a2c', strokeWidth: 1.5, cursor: 'move', pointerEvents: 'all' }} />
                </g>
              );
            })()}
          </svg>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
        <p style={{ margin: '4px 0' }}>
          <strong>How to use:</strong> click a territory (or sidebar entry) to select it — pink
          handles appear at each vertex and a cyan handle at the centroid. Drag a pink handle to
          move that vertex; <strong>double-click an edge</strong> to insert a new vertex there;
          select a vertex and press <strong>Delete</strong> (or the button) to remove it; drag the
          cyan handle to slide the whole cell. <strong>+ Add territory</strong> drops a square in
          the center.
        </p>
        <p style={{ margin: '4px 0' }}>
          Edits auto-save locally and the play-tab vector fallback picks them up on reload. When
          done, <strong>Export territories.json</strong> and replace
          <code style={{ margin: '0 4px' }}>src/data/territories.json</code> (centroid + area are
          recomputed on export).
        </p>
      </div>
    </div>
  );
}
