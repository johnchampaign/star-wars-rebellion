// Draw rectangles on the board to mask printed UI elements (time track,
// deck slots, build queue, etc.). Exports to assets/board-mask.json which
// the play tab and other map tabs read for overlaying dark rectangles.

import { useEffect, useState, useRef, useCallback } from 'react';
import { loadBoardMask, MAP_IMAGE_URL } from '../data/loadAssets';
import type { MaskRect, BoardMaskFile, RectKind } from '../types';

const KIND_OPTIONS: { value: RectKind; label: string; color: string }[] = [
  { value: 'hide',            label: 'Hide (mask)',            color: '#0c0d10' },
  { value: 'rebel-base',      label: 'Rebel Base space',       color: '#1a3a4a' },
  { value: 'build-1-rebel',   label: 'Build queue 1 (Rebel)',  color: '#0a2030' },
  { value: 'build-2-rebel',   label: 'Build queue 2 (Rebel)',  color: '#0a2030' },
  { value: 'build-3-rebel',   label: 'Build queue 3 (Rebel)',  color: '#0a2030' },
  { value: 'build-1-empire',  label: 'Build queue 1 (Empire)', color: '#2a0a0a' },
  { value: 'build-2-empire',  label: 'Build queue 2 (Empire)', color: '#2a0a0a' },
  { value: 'build-3-empire',  label: 'Build queue 3 (Empire)', color: '#2a0a0a' },
];

function kindFromLabel(label: string): RectKind {
  const lc = label.toLowerCase();
  if (lc.includes('rebel base')) return 'rebel-base';
  for (const slot of [1, 2, 3] as const) {
    if (lc.includes(`build queue ${slot}`) && lc.includes('rebel'))  return `build-${slot}-rebel`  as RectKind;
    if (lc.includes(`build queue ${slot}`) && lc.includes('empire')) return `build-${slot}-empire` as RectKind;
  }
  return 'hide';
}

function kindColor(kind: RectKind): string {
  return KIND_OPTIONS.find((k) => k.value === kind)?.color ?? '#0c0d10';
}

const NATIVE_W = 3180;
const NATIVE_H = 1590;
const DISPLAY_W = 1590;
const DISPLAY_H = 795;
const SCALE = DISPLAY_W / NATIVE_W;
const INV_SCALE = NATIVE_W / DISPLAY_W;
const LS_KEY = 'rebellion-dev-board-mask-edits';

function loadEdits(): MaskRect[] | null {
  const s = localStorage.getItem(LS_KEY);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function saveEdits(masks: MaskRect[], original: MaskRect[]): void {
  if (rectsEqual(masks, original)) localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, JSON.stringify(masks));
}

function rectsEqual(a: MaskRect[], b: MaskRect[]): boolean {
  if (a.length !== b.length) return false;
  const fields: (keyof MaskRect)[] = ['id', 'label', 'x', 'y', 'width', 'height'];
  for (let i = 0; i < a.length; i++) {
    for (const f of fields) if (a[i][f] !== b[i][f]) return false;
  }
  return true;
}

function freshId(): string {
  return 'm' + Math.random().toString(36).slice(2, 8);
}

export default function MaskTab() {
  const [original, setOriginal] = useState<MaskRect[] | null>(null);
  const [masks, setMasks] = useState<MaskRect[]>([]);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<BoardMaskFile['_meta'] | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    loadBoardMask()
      .then((d) => {
        // Back-fill kind for any rectangle missing it (legacy data).
        const withKind = (rs: MaskRect[]) => rs.map((r) => r.kind ? r : { ...r, kind: kindFromLabel(r.label) });
        setOriginal(withKind(d.masks));
        setMeta(d._meta);
        const stored = loadEdits();
        setMasks(stored ? withKind(stored) : withKind(d.masks));
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (original !== null) saveEdits(masks, original);
  }, [masks, original]);

  const isDirty = original !== null && !rectsEqual(masks, original);

  // Convert client (display) → native pixel
  const toNative = useCallback((clientX: number, clientY: number) => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * INV_SCALE,
      y: (clientY - rect.top) * INV_SCALE,
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    // Ignore if we clicked on an existing rect (selection happens via the rect's own handler)
    if ((e.target as SVGElement).tagName === 'rect' && (e.target as SVGElement).dataset.maskId) {
      return;
    }
    const native = toNative(e.clientX, e.clientY);
    if (!native) return;
    setDrawing({ x0: native.x, y0: native.y, x1: native.x, y1: native.y });
    setSelectedId(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drawing) return;
    const native = toNative(e.clientX, e.clientY);
    if (!native) return;
    setDrawing({ ...drawing, x1: native.x, y1: native.y });
  };

  const handleMouseUp = () => {
    if (!drawing) return;
    const x = Math.round(Math.min(drawing.x0, drawing.x1));
    const y = Math.round(Math.min(drawing.y0, drawing.y1));
    const width = Math.round(Math.abs(drawing.x1 - drawing.x0));
    const height = Math.round(Math.abs(drawing.y1 - drawing.y0));
    if (width >= 8 && height >= 8) {
      const id = freshId();
      const labelGuess = guessLabel(masks.length + 1);
      const newRect: MaskRect = { id, label: labelGuess, x, y, width, height, kind: kindFromLabel(labelGuess) };
      setMasks((m) => [...m, newRect]);
      setSelectedId(id);
    }
    setDrawing(null);
  };

  // End drag if user releases outside the SVG
  useEffect(() => {
    if (!drawing) return;
    const up = () => setDrawing(null);
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, [drawing]);

  const deleteSelected = () => {
    if (!selectedId) return;
    setMasks((m) => m.filter((r) => r.id !== selectedId));
    setSelectedId(null);
  };

  const updateLabel = (id: string, label: string) => {
    setMasks((m) => m.map((r) => (r.id === id ? { ...r, label } : r)));
  };
  const updateKind = (id: string, kind: RectKind) => {
    setMasks((m) => m.map((r) => (r.id === id ? { ...r, kind } : r)));
  };

  const handleReset = () => {
    if (!confirm('Discard all local mask edits and revert to the saved file?')) return;
    if (original) setMasks(original);
    setSelectedId(null);
  };

  const handleExport = () => {
    const out: BoardMaskFile = {
      _meta: {
        ...(meta ?? { schema: 'board-mask-v1', provenance: 'user-corrected', source: '', notes: [] }),
        provenance: 'user-corrected',
        notes: [
          ...(meta?.notes ?? []),
          `Edited via dev mask tab at ${new Date().toISOString()}.`,
        ],
      },
      masks,
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'board-mask.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (original === null) return <div className="placeholder">Loading…</div>;

  const selected = selectedId ? masks.find((r) => r.id === selectedId) : null;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Mask</h2>

      <div className="meta-notes">
        <strong>What this is:</strong> draw rectangles over printed UI elements on the board
        (time track, deck slots, build queue, reputation track, etc.). The play tab and other
        map-using tabs render these as opaque dark overlays so the parallel panels above the
        board are the single source of truth.
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="tab-button" onClick={handleExport} disabled={!isDirty}>
          Export board-mask.json {isDirty ? '*' : ''}
        </button>
        <button className="tab-button" onClick={handleReset} disabled={!isDirty}>
          Reset
        </button>
        <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
          {masks.length} rectangle{masks.length === 1 ? '' : 's'}
        </span>
        {selected && (
          <button className="tab-button" onClick={deleteSelected} style={{ marginLeft: 'auto', color: '#ff8866' }}>
            Delete selected
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        {/* Sidebar list */}
        <div style={{
          flex: '0 0 200px',
          maxHeight: DISPLAY_H,
          overflowY: 'auto',
          background: '#15171c',
          padding: 8,
          borderRadius: 4,
        }}>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>Rectangles</div>
          {masks.length === 0 && (
            <div style={{ fontSize: 11, color: '#666', fontStyle: 'italic' }}>
              (click-drag on the board to add)
            </div>
          )}
          {masks.map((r) => {
            const isSelected = selectedId === r.id;
            return (
              <div
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                style={{
                  marginBottom: 4,
                  padding: 6,
                  border: '1px solid ' + (isSelected ? '#ff7ab8' : '#2a2d34'),
                  borderRadius: 3,
                  cursor: 'pointer',
                  background: isSelected ? '#1f1428' : 'transparent',
                }}
              >
                <input
                  value={r.label}
                  onChange={(e) => updateLabel(r.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    background: '#0c0d10', color: '#e8e8ea',
                    border: '1px solid #3a3d44', borderRadius: 3, padding: '2px 4px',
                    fontSize: 11, width: '100%',
                  }}
                />
                <select
                  value={r.kind}
                  onChange={(e) => updateKind(r.id, e.target.value as RectKind)}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    background: '#0c0d10', color: '#e8e8ea',
                    border: '1px solid #3a3d44', borderRadius: 3, padding: '2px 4px',
                    fontSize: 11, width: '100%', marginTop: 4,
                  }}
                >
                  {KIND_OPTIONS.map((k) => (
                    <option key={k.value} value={k.value}>{k.label}</option>
                  ))}
                </select>
                <div style={{ fontSize: 10, color: '#888', marginTop: 4, fontFamily: 'monospace' }}>
                  ({r.x}, {r.y}) {r.width}×{r.height}
                </div>
              </div>
            );
          })}
        </div>

        {/* Board */}
        <div
          className="adjacency-canvas"
          style={{ width: DISPLAY_W, height: DISPLAY_H, flexShrink: 0, userSelect: 'none' }}
        >
          <img src={MAP_IMAGE_URL} width={DISPLAY_W} height={DISPLAY_H} alt="Board" draggable={false} />
          <svg
            ref={svgRef}
            width={DISPLAY_W}
            height={DISPLAY_H}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            style={{ cursor: 'crosshair', pointerEvents: 'all' }}
          >
            {/* Transparent backstop so mousedown on empty SVG space registers */}
            <rect
              x={0} y={0} width={DISPLAY_W} height={DISPLAY_H}
              fill="transparent"
              style={{ pointerEvents: 'all' }}
            />
            {/* Existing rectangles */}
            {masks.map((r) => {
              const isSelected = selectedId === r.id;
              const isHide = r.kind === 'hide';
              return (
                <g key={r.id}>
                  <rect
                    data-mask-id={r.id}
                    x={r.x * SCALE}
                    y={r.y * SCALE}
                    width={r.width * SCALE}
                    height={r.height * SCALE}
                    style={{
                      fill: isSelected
                        ? 'rgba(255, 122, 184, 0.45)'
                        : isHide ? 'rgba(0, 0, 0, 0.65)' : 'rgba(80, 220, 120, 0.30)',
                      stroke: isSelected ? '#ff7ab8' : isHide ? '#888' : '#80dc78',
                      strokeWidth: isSelected ? 2 : 1,
                      strokeDasharray: '4,2',
                      cursor: 'pointer',
                      pointerEvents: 'all',
                    }}
                    onClick={(e) => { e.stopPropagation(); setSelectedId(r.id); }}
                  />
                  <text
                    x={r.x * SCALE + 4}
                    y={r.y * SCALE + 12}
                    style={{ fill: isSelected ? '#fff' : isHide ? '#ccc' : '#80dc78', fontSize: 10, pointerEvents: 'none' }}
                  >
                    {r.label}
                  </text>
                </g>
              );
            })}

            {/* In-progress drawing */}
            {drawing && (
              <rect
                x={Math.min(drawing.x0, drawing.x1) * SCALE}
                y={Math.min(drawing.y0, drawing.y1) * SCALE}
                width={Math.abs(drawing.x1 - drawing.x0) * SCALE}
                height={Math.abs(drawing.y1 - drawing.y0) * SCALE}
                style={{
                  fill: 'rgba(255, 215, 80, 0.25)',
                  stroke: '#ffd54a',
                  strokeWidth: 2,
                  strokeDasharray: '4,2',
                  pointerEvents: 'none',
                }}
              />
            )}
          </svg>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
        <p style={{ margin: '4px 0' }}>
          <strong>How to use:</strong> click-drag on the board to draw a rectangle. Click an
          existing rectangle (or its sidebar entry) to select it, then rename or delete. Pink
          = selected, gray = unselected. The yellow box during drag shows what you're drawing.
        </p>
        <p style={{ margin: '4px 0' }}>
          When done, click <strong>Export board-mask.json</strong> and paste back. The other
          map tabs will then hide those board regions behind dark overlays.
        </p>
      </div>
    </div>
  );
}

function guessLabel(n: number): string {
  // Common-sense defaults — user can rename freely.
  const presets = [
    'time track',
    'reputation track',
    'build queue (Rebel)',
    'build queue (Empire)',
    'leader pool (Rebel)',
    'leader pool (Empire)',
    'deck slots',
  ];
  return presets[n - 1] ?? `mask ${n}`;
}
