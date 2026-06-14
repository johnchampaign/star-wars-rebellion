// Territory editor — overlays the traced territory polygons on the board image
// and lets you drag vertices, insert/delete points, move whole cells, and
// add/remove territories. Edits persist to localStorage (LS_TERRITORIES) so the
// no-art vector fallback in the play tab reflects them live; Export downloads an
// updated src/data/territories.json (with recomputed centroid/area).

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { MAP_IMAGE_URL, loadSystems } from '../data/loadAssets';
import { useArtLoaded, getCachedArtUrlSync } from '../play/vmodArtCache';
import {
  TERRITORIES, cloneRegions, loadTerritoryEdits, saveTerritoryEdits,
  polygonCentroid, polygonArea, territoryFill,
  type TerritoryRegion,
} from '../data/territories';

type SysLite = { id: string; name: string; boardPos: { x: number; y: number } };

/** Ray-cast point-in-polygon (image-native coords). */
function pointInPoly(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > p[1]) !== (yj > p[1])) &&
      (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

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
  const [sysList, setSysList] = useState<SysLite[]>([]);
  // Draw mode: when non-null, clicks on the board add points to a new cell's
  // outline (each click is one edge). Used to trace cells — e.g. splitting the
  // central blob into four by drawing four new cells, then deleting the blob.
  const [draft, setDraft] = useState<[number, number][] | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Initial load: canonical base + any local edits.
  useEffect(() => {
    const b = cloneRegions(TERRITORIES.regions);
    setBase(b);
    setRegions(loadTerritoryEdits() ?? cloneRegions(b));
  }, []);

  // Systems, so each cell can show the planet it contains (1 = clean, >1 = needs
  // splitting, 0 = orphan unless it's a barrier).
  useEffect(() => {
    loadSystems()
      .then((d) => setSysList((d.systems ?? []).map((s) => ({ id: s.id, name: s.name, boardPos: s.boardPos }))))
      .catch(() => {});
  }, []);

  // systemIds contained in each region (by id), recomputed when geometry changes.
  const containedByRegion = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const r of regions) {
      m.set(r.id, sysList.filter((s) => pointInPoly([s.boardPos.x, s.boardPos.y], r.exterior)).map((s) => s.name));
    }
    return m;
  }, [regions, sysList]);

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
      dragPosRef.current = n;
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

  // Distance² snap radius (display px → native) for dropping one vertex onto
  // another to merge them. Generous so a hand-dragged release still snaps.
  const MERGE_THR2 = (22 * INV_SCALE) ** 2;
  // The other vertex of `region` that vertex `i` is currently near enough to
  // merge with, or -1. Used both for the live highlight and the split on drop.
  const mergeTargetFor = useCallback((ext: [number, number][], i: number): number => {
    const vi = ext[i];
    let best = -1, bd = MERGE_THR2;
    for (let k = 0; k < ext.length; k++) {
      if (k === i) continue;
      const dx = ext[k][0] - vi[0], dy = ext[k][1] - vi[1];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }, [MERGE_THR2]);

  // Drag end via a single document mouseup (so a release anywhere finishes it).
  // If a vertex was dropped onto another vertex of the same cell, pinch them:
  // the polygon ring splits into two cells meeting at that point.
  const dragRef = useRef<Drag>(null);
  useEffect(() => { dragRef.current = drag; }, [drag]);
  const regionsRef = useRef<TerritoryRegion[]>([]);
  useEffect(() => { regionsRef.current = regions; }, [regions]);
  // Live position of the vertex being dragged (updated synchronously on every
  // move), so the merge test doesn't depend on React having committed yet.
  const dragPosRef = useRef<[number, number] | null>(null);
  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      const p = dragPosRef.current;
      dragPosRef.current = null;
      setDrag(null);
      if (!d || d.kind !== 'vertex' || !p) return;
      // Did this release drop the vertex onto another vertex of the same cell?
      // Compute from the live drag position vs the other (stationary) vertices,
      // so a plain drag/click keeps the vertex selected (Delete still works) and
      // only a real merge splits the cell.
      const r = regionsRef.current.find((x) => x.id === d.id);
      if (!r) return;
      const ext = r.exterior;
      let j = -1, bd = MERGE_THR2;
      for (let k = 0; k < ext.length; k++) {
        if (k === d.index) continue;
        const dx = ext[k][0] - p[0], dy = ext[k][1] - p[1];
        const dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; j = k; }
      }
      if (j < 0) return; // not a merge — keep selection
      const a = Math.min(d.index, j), b = Math.max(d.index, j);
      const P = ext[j]; // merge point (the dragged vertex is dropped here)
      const poly1: [number, number][] = [P, ...ext.slice(a + 1, b)];
      const poly2: [number, number][] = [P, ...ext.slice(b + 1), ...ext.slice(0, a)];
      if (poly1.length < 3 || poly2.length < 3) return; // too close to split — keep selection
      setRegions((rs) => {
        const others = rs.filter((x) => x.id !== d.id);
        const mk = (id: number, e: [number, number][]): TerritoryRegion =>
          ({ id, area_px: polygonArea(e), centroid: polygonCentroid(e), exterior: e });
        return [...others, mk(r.id, poly1), mk(nextId(rs), poly2)];
      });
      setSelectedVertex(null); // only after an actual split
    };
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, [MERGE_THR2]);

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

  // Keyboard: in draw mode Enter=finish, Esc=cancel, Backspace=undo point.
  // Otherwise Delete removes the selected vertex.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (draft !== null) {
        if (e.key === 'Enter') { e.preventDefault(); finishDraft(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelDraw(); }
        else if (e.key === 'Backspace') { e.preventDefault(); undoDraftPoint(); }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedVertex !== null) {
        e.preventDefault();
        deleteVertex();
      } else if (e.key === 'Escape') {
        setSelectedId(null);
        setSelectedVertex(null);
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

  // ---- draw a new cell (trace mode) ----------------------------------------
  const startDraw = () => { setDraft([]); setSelectedId(null); setSelectedVertex(null); };
  const cancelDraw = () => setDraft(null);
  const undoDraftPoint = () => setDraft((d) => (d && d.length ? d.slice(0, -1) : d));
  const finishDraft = () => {
    if (!draft || draft.length < 3) return;
    const ext = draft.slice();
    const id = nextId(regions);
    setRegions((rs) => [...rs, { id, area_px: polygonArea(ext), centroid: polygonCentroid(ext), exterior: ext }]);
    setDraft(null);
    setSelectedId(id);
  };
  // Add a point, or close the cell when clicking near the first point.
  const addDraftPoint = (p: [number, number]) => {
    setDraft((d) => {
      if (!d) return d;
      if (d.length >= 3) {
        const dx = p[0] - d[0][0], dy = p[1] - d[0][1];
        if (dx * dx + dy * dy < 18 * 18 * INV_SCALE * INV_SCALE) {
          // close: defer creation to finishDraft via a microtask-free path
          const ext = d.slice();
          const id = nextId(regions);
          setRegions((rs) => [...rs, { id, area_px: polygonArea(ext), centroid: polygonCentroid(ext), exterior: ext }]);
          setSelectedId(id);
          return null;
        }
      }
      return [...d, p];
    });
  };

  const toggleBarrier = () => {
    if (selectedId === null) return;
    setRegions((rs) => rs.map((r) => (r.id === selectedId ? { ...r, barrier: !r.barrier } : r)));
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
        id: r.id,
        ...(r.name ? { name: r.name } : {}),
        ...(r.barrier ? { barrier: true } : {}),
        area_px: polygonArea(r.exterior),
        centroid: polygonCentroid(r.exterior),
        exterior: r.exterior,
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
        {draft === null ? (
          <>
            <button className="tab-button" onClick={startDraw} style={{ color: '#80dc78' }}>✏️ Draw cell</button>
            <button className="tab-button" onClick={addTerritory}>+ Add square</button>
          </>
        ) : (
          <>
            <button className="tab-button" onClick={finishDraft} disabled={draft.length < 3}
              style={{ color: '#80dc78' }}>
              Finish cell ({draft.length})
            </button>
            <button className="tab-button" onClick={undoDraftPoint} disabled={draft.length === 0}>Undo point</button>
            <button className="tab-button" onClick={cancelDraw} style={{ color: '#ff8866' }}>Cancel</button>
          </>
        )}
        <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
          {regions.length} territories
        </span>
        {selected && (
          <>
            <button className="tab-button" onClick={toggleBarrier}
              style={{ marginLeft: 'auto', color: selected.barrier ? '#c0392b' : undefined }}>
              {selected.barrier ? 'Unmark barrier' : 'Mark as barrier'}
            </button>
            <button className="tab-button" onClick={deleteVertex}
              disabled={selectedVertex === null || selected.exterior.length <= 3}>
              Delete vertex
            </button>
            <button className="tab-button" onClick={deleteTerritory} style={{ color: '#ff8866' }}>
              Delete #{selectedId}
            </button>
          </>
        )}
      </div>

      <div className="meta-notes" style={{ marginBottom: 10 }}>
        <strong>Goal: one system per cell.</strong> Each cell should contain exactly one planet
        (shown in the list). A cell with <span style={{ color: '#ff6b6b' }}>several</span> needs
        splitting; a cell with <span style={{ color: '#ffd54a' }}>none</span> is an orphan unless
        it's a <span style={{ color: '#c0392b' }}>barrier</span> (impassable border — mark it so).
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
            const contained = containedByRegion.get(r.id) ?? [];
            // status color: barrier red, 1 system green, >1 red, 0 amber
            const statusColor = r.barrier ? '#c0392b'
              : contained.length === 1 ? '#80dc78'
              : contained.length > 1 ? '#ff6b6b' : '#ffd54a';
            const statusText = r.barrier ? 'barrier'
              : contained.length === 1 ? contained[0]
              : contained.length > 1 ? `${contained.length} systems!`
              : 'no system';
            return (
              <div key={r.id}
                onClick={() => { setSelectedId(r.id); setSelectedVertex(null); }}
                style={{
                  marginBottom: 4, padding: '4px 6px',
                  border: '1px solid ' + (sel ? '#ff7ab8' : '#2a2d34'),
                  borderRadius: 3, cursor: 'pointer',
                  background: sel ? '#1f1428' : 'transparent',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                    background: r.barrier ? 'transparent' : territoryFill(r.id),
                    border: '1px solid ' + (r.barrier ? '#c0392b' : '#b5662e'),
                  }} />
                  <span style={{ fontSize: 12, color: '#e8e8ea' }}>
                    #{r.id}{r.name ? ` ${r.name}` : ''}
                  </span>
                  <span style={{ fontSize: 10, color: '#777', marginLeft: 'auto', fontFamily: 'monospace' }}>
                    {r.exterior.length}v
                  </span>
                  <button
                    title={`Delete cell #${r.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!confirm(`Delete cell #${r.id}${r.name ? ' (' + r.name + ')' : ''}?`)) return;
                      setRegions((rs) => rs.filter((x) => x.id !== r.id));
                      if (selectedId === r.id) { setSelectedId(null); setSelectedVertex(null); }
                    }}
                    style={{
                      flexShrink: 0, width: 18, height: 18, lineHeight: '14px', padding: 0,
                      background: 'transparent', color: '#ff8866', border: '1px solid #5a3030',
                      borderRadius: 3, cursor: 'pointer', fontSize: 12,
                    }}>×</button>
                </div>
                <div style={{ fontSize: 10, color: statusColor, marginLeft: 18, marginTop: 1 }}>
                  {statusText}
                </div>
              </div>
            );
          })}
        </div>

        {/* Board */}
        <div className="adjacency-canvas"
          style={{ width: DISPLAY_W, height: DISPLAY_H, flexShrink: 0, userSelect: 'none' }}>
          <img src={mapSrc} width={DISPLAY_W} height={DISPLAY_H} alt="Board" draggable={false} />
          <svg ref={svgRef} width={DISPLAY_W} height={DISPLAY_H}
            onMouseMove={handleMouseMove}
            onDoubleClick={(e) => {
              if (draft !== null) return; // drawing mode handles its own clicks
              const n = toNative(e.clientX, e.clientY);
              if (!n) return;
              // Add a vertex to the SELECTED cell at this location (its nearest
              // edge). If nothing's selected, select the cell under the cursor
              // first. This lets you extend a cell's outline anywhere, even
              // outside its current border.
              let target = selectedId;
              if (target === null) {
                const hit = regions.find((r) => pointInPoly(n, r.exterior));
                if (hit) { setSelectedId(hit.id); target = hit.id; }
              }
              if (target !== null) { setSelectedId(target); insertVertexAt(target, n); }
            }}
            style={{ position: 'absolute', top: 0, left: 0, cursor: 'default', pointerEvents: 'all' }}>
            {/* backstop so empty-space clicks land on the svg (Esc deselects) */}
            <rect x={0} y={0} width={DISPLAY_W} height={DISPLAY_H} fill="transparent" />

            {regions.map((r) => {
              const sel = selectedId === r.id;
              const pts = r.exterior.map(([x, y]) => `${x * SCALE},${y * SCALE}`).join(' ');
              const fill = territoryFill(r.id);
              const contained = containedByRegion.get(r.id) ?? [];
              // Border color flags status while tracing: barrier red, ok green,
              // multi red, orphan amber. Selection overrides to yellow.
              const border = r.barrier ? '#c0392b'
                : contained.length === 1 ? '#5a8f4a'
                : contained.length > 1 ? '#ff6b6b' : '#caa23a';
              return (
                <g key={r.id}>
                  <polygon points={pts}
                    onMouseDown={(e) => { e.stopPropagation(); setSelectedId(r.id); setSelectedVertex(null); }}
                    style={{
                      // Outline-only by default so the board art shows through for
                      // tracing; only the selected cell gets a light fill.
                      fill: sel && !r.barrier ? `${fill}33` : 'none',
                      stroke: sel ? '#ffd54a' : border,
                      strokeWidth: sel ? 2.5 : (r.barrier || contained.length !== 1 ? 2 : 1.2),
                      strokeDasharray: r.barrier ? '6,3' : undefined,
                      strokeLinejoin: 'round', cursor: 'pointer', pointerEvents: 'all',
                    }} />
                  {/* id label at centroid */}
                  <text x={polygonCentroid(r.exterior)[0] * SCALE} y={polygonCentroid(r.exterior)[1] * SCALE}
                    textAnchor="middle" dominantBaseline="middle"
                    style={{ fill: sel ? '#fff' : '#cfcfd4', fontSize: 12, fontWeight: 700, pointerEvents: 'none' }}>
                    {r.barrier ? '⛔' : r.id}
                  </text>
                </g>
              );
            })}

            {/* Vertex + centroid handles for the selected territory (on top) */}
            {selected && (() => {
              const c = polygonCentroid(selected.exterior);
              // While dragging a vertex, which other vertex would it merge with
              // on release (→ split the cell). Highlight it so the split is
              // predictable.
              const mergeTarget = (drag?.kind === 'vertex' && drag.id === selected.id)
                ? mergeTargetFor(selected.exterior, drag.index) : -1;
              return (
                <g>
                  {selected.exterior.map((p, i) => {
                    const vsel = selectedVertex === i;
                    const isMergeTarget = i === mergeTarget;
                    return (
                      <circle key={i} cx={p[0] * SCALE} cy={p[1] * SCALE} r={isMergeTarget ? 9 : vsel ? 7 : 5.5}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setSelectedVertex(i);
                          dragPosRef.current = null; // set only once the vertex actually moves
                          setDrag({ kind: 'vertex', id: selected.id, index: i });
                        }}
                        style={{
                          fill: isMergeTarget ? '#ff5a3a' : vsel ? '#ffd54a' : '#ff7ab8',
                          stroke: isMergeTarget ? '#fff' : '#1a1a1a',
                          strokeWidth: isMergeTarget ? 2 : 1, cursor: 'grab', pointerEvents: 'all',
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

            {/* Draw layer (trace a new cell) — topmost capture rect so every
                click adds a point, plus the in-progress outline. */}
            {draft !== null && (
              <g>
                <rect x={0} y={0} width={DISPLAY_W} height={DISPLAY_H} fill="rgba(0,0,0,0.18)"
                  style={{ cursor: 'crosshair', pointerEvents: 'all' }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    const n = toNative(e.clientX, e.clientY);
                    if (n) addDraftPoint(n);
                  }} />
                {draft.length > 0 && (
                  <polyline
                    points={[...draft, ...(draft.length >= 3 ? [draft[0]] : [])]
                      .map(([x, y]) => `${x * SCALE},${y * SCALE}`).join(' ')}
                    style={{ fill: draft.length >= 3 ? 'rgba(128,220,120,0.18)' : 'none',
                      stroke: '#80dc78', strokeWidth: 2, strokeDasharray: '5,3', pointerEvents: 'none' }} />
                )}
                {draft.map((p, i) => (
                  <circle key={i} cx={p[0] * SCALE} cy={p[1] * SCALE} r={i === 0 ? 6 : 4}
                    style={{ fill: i === 0 ? '#ffd54a' : '#80dc78', stroke: '#1a1a1a', strokeWidth: 1, pointerEvents: 'none' }} />
                ))}
              </g>
            )}
          </svg>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
        <p style={{ margin: '4px 0' }}>
          <strong>Split a cell (e.g. the central blob):</strong> click <strong>✏️ Draw cell</strong>,
          then click around a planet to lay down the outline — each click adds a point/edge.
          <strong> Backspace</strong> removes the last point; click the first (yellow) point again,
          press <strong>Enter</strong>, or hit <strong>Finish cell</strong> to close it. Repeat for
          each planet, then select the old oversized blob and <strong>Delete</strong> it. A cell
          turns <span style={{ color: '#5a8f4a' }}>green</span> once it holds exactly one planet.
        </p>
        <p style={{ margin: '4px 0' }}>
          <strong>Reshape:</strong> click a cell to select it — drag a pink vertex handle to move
          it, <strong>double-click anywhere</strong> to add a vertex to the selected cell at that
          spot (even outside its current border), select a vertex and press <strong>Delete</strong>
          to remove it, or drag the cyan centroid handle to slide the whole cell. <strong>Esc</strong>
          deselects. <strong>Mark as barrier</strong> turns a cell into an impassable border.
        </p>
        <p style={{ margin: '4px 0' }}>
          <strong>Split a cell in two:</strong> drag one vertex onto another vertex of the same cell
          (the target turns <span style={{ color: '#ff5a3a' }}>red</span>) and release — the cell
          pinches apart into two cells meeting at that point. Another way to break the central blob:
          add a vertex on each side where the cut should be, then merge them.
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
