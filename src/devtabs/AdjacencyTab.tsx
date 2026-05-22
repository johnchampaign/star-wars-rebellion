import { useEffect, useState, useMemo, useCallback } from 'react';
import { loadSystems, loadAdjacency, MAP_IMAGE_URL } from '../data/loadAssets';
import type { System, SystemsFile, AdjacencyFile } from '../types';

// Map.png is 3180x1590. We render it at half size by default so it fits.
const NATIVE_W = 3180;
const NATIVE_H = 1590;
const DISPLAY_W = 1590;
const DISPLAY_H = 795;
const SCALE = DISPLAY_W / NATIVE_W;
const MARKER_R = 22; // in display pixels
const LS_KEY = 'rebellion-dev-adjacency-edits';

type Neighbors = Record<string, string[]>;

function sortedNeighbors(n: Neighbors): Neighbors {
  const out: Neighbors = {};
  for (const k of Object.keys(n).sort()) {
    out[k] = [...n[k]].sort();
  }
  return out;
}

function toggleEdge(n: Neighbors, a: string, b: string): Neighbors {
  if (a === b) return n;
  const aList = new Set(n[a] ?? []);
  const bList = new Set(n[b] ?? []);
  if (aList.has(b)) {
    aList.delete(b);
    bList.delete(a);
  } else {
    aList.add(b);
    bList.add(a);
  }
  return { ...n, [a]: [...aList], [b]: [...bList] };
}

function neighborsEqual(a: Neighbors, b: Neighbors): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const sa = new Set(a[k] ?? []);
    const sb = new Set(b[k] ?? []);
    if (sa.size !== sb.size) return false;
    for (const v of sa) if (!sb.has(v)) return false;
  }
  return true;
}

export default function AdjacencyTab() {
  const [systemsFile, setSystemsFile] = useState<SystemsFile | null>(null);
  const [originalAdj, setOriginalAdj] = useState<AdjacencyFile | null>(null);
  const [neighbors, setNeighbors] = useState<Neighbors | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Load JSON, then layer any localStorage edits on top
  useEffect(() => {
    Promise.all([loadSystems(), loadAdjacency()])
      .then(([s, a]) => {
        setSystemsFile(s);
        setOriginalAdj(a);
        const stored = localStorage.getItem(LS_KEY);
        if (stored) {
          try { setNeighbors(JSON.parse(stored)); return; } catch {}
        }
        setNeighbors(a.neighbors);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Persist edits to localStorage whenever they change
  useEffect(() => {
    if (!neighbors || !originalAdj) return;
    if (neighborsEqual(neighbors, originalAdj.neighbors)) {
      localStorage.removeItem(LS_KEY);
    } else {
      localStorage.setItem(LS_KEY, JSON.stringify(neighbors));
    }
  }, [neighbors, originalAdj]);

  const systemById = useMemo(() => {
    if (!systemsFile) return new Map<string, System>();
    return new Map(systemsFile.systems.map((s) => [s.id, s] as const));
  }, [systemsFile]);

  const isDirty = useMemo(() => {
    if (!neighbors || !originalAdj) return false;
    return !neighborsEqual(neighbors, originalAdj.neighbors);
  }, [neighbors, originalAdj]);

  const handleClick = useCallback(
    (id: string) => {
      if (!neighbors) return;
      if (editingId === null) {
        setEditingId(id);
      } else if (editingId === id) {
        setEditingId(null);
      } else {
        setNeighbors(toggleEdge(neighbors, editingId, id));
      }
    },
    [editingId, neighbors]
  );

  const handleReset = () => {
    if (!originalAdj) return;
    if (!confirm('Discard all local adjacency edits and revert to the loaded JSON?')) return;
    setNeighbors(originalAdj.neighbors);
    setEditingId(null);
  };

  const handleExport = () => {
    if (!neighbors || !originalAdj) return;
    const out: AdjacencyFile = {
      _meta: {
        ...originalAdj._meta,
        provenance: 'user-corrected',
        notes: [
          ...originalAdj._meta.notes,
          `Edited via dev adjacency tab at ${new Date().toISOString()}.`,
        ],
      },
      neighbors: sortedNeighbors(neighbors),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'adjacency.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!systemsFile || !originalAdj || !neighbors) return <div className="placeholder">Loading…</div>;

  const editingSystem = editingId ? systemById.get(editingId) : null;
  const editingNeighbors = editingId ? new Set(neighbors[editingId] ?? []) : new Set<string>();

  // Display set: when editing, show edits-in-progress; when hovering (no edit), show hover's neighbors.
  const highlightSourceId = editingId ?? hoverId;
  const highlightSystem = highlightSourceId ? systemById.get(highlightSourceId) : null;
  const highlightNeighbors = highlightSourceId
    ? new Set(neighbors[highlightSourceId] ?? [])
    : new Set<string>();

  // Edge count for status display
  const edgeCount = Object.values(neighbors).reduce((sum, list) => sum + list.length, 0) / 2;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Adjacency</h2>

      <div className="meta-notes">
        <strong>Provenance:</strong> {originalAdj._meta.provenance}
        {isDirty && (
          <span style={{ marginLeft: 12, color: '#ffd54a' }}>
            · <strong>Unsaved local edits</strong> (in localStorage)
          </span>
        )}
        <ul>
          {originalAdj._meta.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>

      <div className="adjacency-info">
        {editingSystem ? (
          <>
            <span style={{ color: '#ff7ab8', fontWeight: 600 }}>EDITING: {editingSystem.name}</span>
            <span style={{ marginLeft: 12, color: '#aaa' }}>
              Click any system to toggle its edge. Click {editingSystem.name} again or press Esc to exit edit mode.
            </span>
            <span className="neighbors" style={{ marginLeft: 12 }}>
              · {editingNeighbors.size} neighbor{editingNeighbors.size === 1 ? '' : 's'}:
              {' '}
              {[...editingNeighbors].map((n) => systemById.get(n)?.name ?? n).join(', ') || '(none)'}
            </span>
          </>
        ) : highlightSystem ? (
          <>
            <span className="label">{highlightSystem.name}</span>
            <span className="neighbors">
              → {highlightNeighbors.size} neighbor{highlightNeighbors.size === 1 ? '' : 's'}:
              {' '}
              {[...highlightNeighbors].map((n) => systemById.get(n)?.name ?? n).join(', ')}
            </span>
          </>
        ) : (
          <span style={{ color: '#888' }}>
            Hover a system to highlight its neighbors. Click a system to edit its edges.
          </span>
        )}
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="tab-button" onClick={handleExport} disabled={!isDirty}>
          Export adjacency.json {isDirty ? '*' : ''}
        </button>
        <button className="tab-button" onClick={handleReset} disabled={!isDirty}>
          Reset to file
        </button>
        <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
          {Object.keys(neighbors).length} systems · {edgeCount} edges
        </span>
      </div>

      <div
        className="adjacency-canvas"
        style={{ width: DISPLAY_W, height: DISPLAY_H }}
        onKeyDown={(e) => { if (e.key === 'Escape') setEditingId(null); }}
        tabIndex={0}
      >
        <img src={MAP_IMAGE_URL} width={DISPLAY_W} height={DISPLAY_H} alt="Board" />
        <svg width={DISPLAY_W} height={DISPLAY_H}>
          {/* Edges */}
          {Object.entries(neighbors).flatMap(([a, nbrs]) =>
            nbrs.filter((b) => a < b).map((b) => {
              const sa = systemById.get(a);
              const sb = systemById.get(b);
              if (!sa || !sb) return null;
              const x1 = sa.boardPos.x * SCALE;
              const y1 = sa.boardPos.y * SCALE;
              const x2 = sb.boardPos.x * SCALE;
              const y2 = sb.boardPos.y * SCALE;
              const isHighlighted = highlightSourceId === a || highlightSourceId === b;
              return (
                <line
                  key={`${a}-${b}`}
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={isHighlighted ? 'rgba(80, 220, 120, 0.95)' : 'rgba(255, 215, 80, 0.35)'}
                  strokeWidth={isHighlighted ? 2 : 1}
                />
              );
            })
          )}
          {/* System markers */}
          {systemsFile.systems.map((s) => {
            const x = s.boardPos.x * SCALE;
            const y = s.boardPos.y * SCALE;
            const isEditing = editingId === s.id;
            const isHighlightSource = highlightSourceId === s.id && !isEditing;
            const isNeighbor = highlightNeighbors.has(s.id);
            const isDimmed = highlightSourceId !== null && !isEditing && !isHighlightSource && !isNeighbor;

            let cls = 'system-marker';
            let fill = 'rgba(255, 215, 80, 0.3)';
            let stroke = 'rgba(255, 215, 80, 0.6)';
            if (isEditing) {
              fill = 'rgba(255, 122, 184, 0.55)'; // pink for edit-selected
              stroke = '#ff7ab8';
            } else if (isHighlightSource) {
              fill = 'rgba(255, 215, 80, 0.7)';
              stroke = '#ffd54a';
            } else if (isNeighbor) {
              fill = 'rgba(80, 220, 120, 0.55)';
              stroke = 'rgba(80, 220, 120, 0.95)';
            }
            if (isDimmed) cls += ' dimmed';

            return (
              <g key={s.id}>
                <circle
                  cx={x} cy={y} r={MARKER_R}
                  className={cls}
                  style={{ fill, stroke, strokeWidth: isEditing ? 3 : 2 }}
                  onMouseEnter={() => setHoverId(s.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onClick={() => handleClick(s.id)}
                />
                <text
                  x={x} y={y + MARKER_R + 12}
                  textAnchor="middle"
                  className="system-label"
                  opacity={isEditing || isHighlightSource || isNeighbor ? 1 : 0.35}
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
          <strong>How to use:</strong> Click a system to enter edit mode (it turns pink).
          Click another system to add or remove the edge between them.
          Click the pink system again, or press Esc, to exit edit mode.
        </p>
        <p style={{ margin: '4px 0' }}>
          Edits persist in localStorage. When done, click <strong>Export adjacency.json</strong> to download the corrected file —
          replace <code>assets/adjacency.json</code> in the repo with the downloaded file, then re-run <code>npm run copy-assets</code>.
        </p>
      </div>
    </div>
  );
}
