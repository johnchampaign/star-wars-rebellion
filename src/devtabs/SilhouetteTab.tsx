// Silhouette crop tool — for each unit type, drag a bbox on the reference
// sheet that contains its silhouette icon. Live-previews the crop and exports
// JSON that scripts/extract-unit-silhouettes.py reads to (re)generate the
// per-unit PNGs in public/dev-assets/units/silhouette/.

import { useEffect, useRef, useState, useCallback } from 'react';

const EMPIRE_URL = '/dev-assets/ReferenceEmpire2P.png';
const REBEL_URL  = '/dev-assets/ReferenceRebel2P.png';

// Native sheet sizes (from the .vmod).
const EMPIRE_W = 1600, EMPIRE_H = 990;
const REBEL_W  = 1600, REBEL_H  = 965;

// Display scale — fit width to ~1200.
const DISPLAY_W = 1200;
const SCALE_E = DISPLAY_W / EMPIRE_W;
const SCALE_R = DISPLAY_W / REBEL_W;

type BBox = [number, number, number, number]; // (left, top, right, bottom) in native px

type Sheet = 'Empire' | 'Rebel';

type Entry = { typeId: string; label: string; sheet: Sheet; box: BBox };

// Defaults match scripts/extract-unit-silhouettes.py at time of writing.
const DEFAULTS: Entry[] = [
  // Empire
  { typeId: 'tie-fighter',                   label: 'TIE Fighter',         sheet: 'Empire', box: [415,  75,  545, 155] },
  { typeId: 'stormtrooper',                  label: 'Stormtrooper',        sheet: 'Empire', box: [875,  75, 1005, 155] },
  { typeId: 'assault-carrier',               label: 'Assault Carrier',     sheet: 'Empire', box: [415, 235,  545, 315] },
  { typeId: 'at-st',                         label: 'AT-ST',               sheet: 'Empire', box: [875, 235, 1005, 315] },
  { typeId: 'star-destroyer',                label: 'Star Destroyer',      sheet: 'Empire', box: [415, 315,  545, 395] },
  { typeId: 'at-at',                         label: 'AT-AT',               sheet: 'Empire', box: [875, 395, 1005, 475] },
  { typeId: 'super-star-destroyer',          label: 'Super Star Destroyer',sheet: 'Empire', box: [415, 475,  545, 555] },
  { typeId: 'death-star',                    label: 'Death Star',          sheet: 'Empire', box: [415, 555,  545, 635] },
  { typeId: 'death-star-under-construction', label: 'Death Star (UC)',     sheet: 'Empire', box: [875, 555, 1005, 635] },
  // Rebel
  { typeId: 'x-wing',             label: 'X-Wing',            sheet: 'Rebel', box: [445,  85,  575, 185] },
  { typeId: 'rebel-trooper',      label: 'Rebel Trooper',     sheet: 'Rebel', box: [915,  85, 1045, 185] },
  { typeId: 'y-wing',             label: 'Y-Wing',            sheet: 'Rebel', box: [445, 185,  575, 285] },
  { typeId: 'airspeeder',         label: 'Airspeeder',        sheet: 'Rebel', box: [915, 285, 1045, 385] },
  { typeId: 'rebel-transport',    label: 'Rebel Transport',   sheet: 'Rebel', box: [445, 385,  575, 485] },
  { typeId: 'corellian-corvette', label: 'Corellian Corvette',sheet: 'Rebel', box: [445, 485,  575, 585] },
  { typeId: 'shield-generator',   label: 'Shield Generator',  sheet: 'Rebel', box: [915, 485, 1045, 585] },
  { typeId: 'ion-cannon',         label: 'Ion Cannon',        sheet: 'Rebel', box: [915, 585, 1045, 685] },
  { typeId: 'mon-cala-cruiser',   label: 'Mon Cal Cruiser',   sheet: 'Rebel', box: [445, 685,  575, 785] },
];

const LS_KEY = 'rebellion-dev-silhouette-bboxes';

function loadEdits(): Record<string, BBox> | null {
  const s = localStorage.getItem(LS_KEY);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function saveEdits(entries: Entry[]): void {
  const out: Record<string, BBox> = {};
  let dirty = false;
  for (const e of entries) {
    const def = DEFAULTS.find((d) => d.typeId === e.typeId)!;
    if (boxesEqual(e.box, def.box)) continue;
    out[e.typeId] = e.box;
    dirty = true;
  }
  if (dirty) localStorage.setItem(LS_KEY, JSON.stringify(out));
  else localStorage.removeItem(LS_KEY);
}
function boxesEqual(a: BBox, b: BBox): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export default function SilhouetteTab() {
  const [entries, setEntries] = useState<Entry[]>(() => {
    const edits = loadEdits();
    return DEFAULTS.map((d) => edits?.[d.typeId] ? { ...d, box: edits[d.typeId] } : { ...d });
  });
  const [sheet, setSheet] = useState<Sheet>('Empire');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => { saveEdits(entries); }, [entries]);

  const visible = entries.filter((e) => e.sheet === sheet);
  const scale = sheet === 'Empire' ? SCALE_E : SCALE_R;
  const invScale = 1 / scale;
  const nativeW = sheet === 'Empire' ? EMPIRE_W : REBEL_W;
  const nativeH = sheet === 'Empire' ? EMPIRE_H : REBEL_H;
  const displayH = nativeH * scale;
  const url = sheet === 'Empire' ? EMPIRE_URL : REBEL_URL;

  const toNative = useCallback((cx: number, cy: number) => {
    if (!svgRef.current) return null;
    const r = svgRef.current.getBoundingClientRect();
    return { x: (cx - r.left) * invScale, y: (cy - r.top) * invScale };
  }, [invScale]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!selectedId) return; // must select a unit first
    const n = toNative(e.clientX, e.clientY);
    if (!n) return;
    setDrawing({ x0: n.x, y0: n.y, x1: n.x, y1: n.y });
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drawing) return;
    const n = toNative(e.clientX, e.clientY);
    if (!n) return;
    setDrawing({ ...drawing, x1: n.x, y1: n.y });
  };
  const handleMouseUp = () => {
    if (!drawing || !selectedId) { setDrawing(null); return; }
    const left   = Math.round(Math.min(drawing.x0, drawing.x1));
    const top    = Math.round(Math.min(drawing.y0, drawing.y1));
    const right  = Math.round(Math.max(drawing.x0, drawing.x1));
    const bottom = Math.round(Math.max(drawing.y0, drawing.y1));
    if (right - left >= 8 && bottom - top >= 8) {
      const box: BBox = [left, top, right, bottom];
      setEntries((es) => es.map((e) => e.typeId === selectedId ? { ...e, box } : e));
    }
    setDrawing(null);
  };
  useEffect(() => {
    if (!drawing) return;
    const up = () => setDrawing(null);
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, [drawing]);

  const resetSelected = () => {
    if (!selectedId) return;
    const def = DEFAULTS.find((d) => d.typeId === selectedId);
    if (!def) return;
    setEntries((es) => es.map((e) => e.typeId === selectedId ? { ...e, box: [...def.box] as BBox } : e));
  };
  const resetAll = () => {
    if (!confirm('Reset all bboxes to defaults from extract-unit-silhouettes.py?')) return;
    setEntries(DEFAULTS.map((d) => ({ ...d, box: [...d.box] as BBox })));
    setSelectedId(null);
  };

  const exportJson = () => {
    const out = {
      _meta: {
        schema: 'silhouette-bboxes-v1',
        editedAt: new Date().toISOString(),
        note: 'Paste into scripts/extract-unit-silhouettes.py — EMPIRE_CROPS / REBEL_CROPS dicts.',
      },
      empire: Object.fromEntries(entries.filter((e) => e.sheet === 'Empire').map((e) => [e.typeId, e.box])),
      rebel:  Object.fromEntries(entries.filter((e) => e.sheet === 'Rebel') .map((e) => [e.typeId, e.box])),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'silhouette-bboxes.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPython = async () => {
    const fmt = (es: Entry[]) =>
      es.map((e) => `    '${e.typeId}':${' '.repeat(Math.max(1, 32 - e.typeId.length - 5))}(${e.box[0]}, ${e.box[1]}, ${e.box[2]}, ${e.box[3]}),`).join('\n');
    const text =
      `EMPIRE_CROPS: dict[str, tuple[int, int, int, int]] = {\n` +
      fmt(entries.filter((e) => e.sheet === 'Empire')) +
      `\n}\n\nREBEL_CROPS: dict[str, tuple[int, int, int, int]] = {\n` +
      fmt(entries.filter((e) => e.sheet === 'Rebel')) +
      `\n}\n`;
    try {
      await navigator.clipboard.writeText(text);
      alert('Python dict literals copied to clipboard.\nPaste into scripts/extract-unit-silhouettes.py.');
    } catch {
      // Fallback: download a .py snippet
      const blob = new Blob([text], { type: 'text/plain' });
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = 'silhouette-bboxes.py'; a.click();
      URL.revokeObjectURL(u);
    }
  };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Silhouette bboxes</h2>
      <div className="meta-notes">
        <strong>What this is:</strong> the unit-silhouette icons (alternate unit style) are cropped
        from the printed faction reference sheets. Many crops are wrong. Select a unit on the right,
        then click-drag on the sheet to set its bounding box. Live preview updates immediately.
        When you're happy, click <strong>Copy Python dicts</strong> and paste into
        <code> scripts/extract-unit-silhouettes.py</code>, then re-run it to write the PNGs.
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="tab-button" onClick={() => setSheet('Empire')} disabled={sheet === 'Empire'}>Empire sheet</button>
        <button className="tab-button" onClick={() => setSheet('Rebel')}  disabled={sheet === 'Rebel'}>Rebel sheet</button>
        <span style={{ width: 20 }} />
        <button className="tab-button" onClick={exportPython}>Copy Python dicts</button>
        <button className="tab-button" onClick={exportJson}>Export JSON</button>
        <button className="tab-button" onClick={resetAll} style={{ marginLeft: 'auto', color: '#ff8866' }}>Reset all</button>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        {/* Sidebar: unit list + crop previews */}
        <div style={{ flex: '0 0 280px', maxHeight: displayH, overflowY: 'auto', background: '#15171c', padding: 8, borderRadius: 4 }}>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>{sheet} units</div>
          {visible.map((e) => {
            const isSel = selectedId === e.typeId;
            const [l, t, r, b] = e.box;
            const def = DEFAULTS.find((d) => d.typeId === e.typeId)!;
            const dirty = !boxesEqual(e.box, def.box);
            return (
              <div
                key={e.typeId}
                onClick={() => setSelectedId(e.typeId)}
                style={{
                  marginBottom: 4, padding: 6, cursor: 'pointer',
                  border: '1px solid ' + (isSel ? '#ffd54a' : '#2a2d34'),
                  borderRadius: 3, background: isSel ? '#2a230a' : 'transparent',
                  display: 'flex', gap: 8, alignItems: 'center',
                }}
                title={e.typeId}
              >
                <CropPreview url={url} box={e.box} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#e8e8ea', fontWeight: 600 }}>
                    {e.label} {dirty && <span style={{ color: '#ffd54a' }}>•</span>}
                  </div>
                  <div style={{ fontSize: 10, color: '#888', fontFamily: 'monospace' }}>
                    ({l},{t},{r},{b}) {r - l}×{b - t}
                  </div>
                </div>
              </div>
            );
          })}
          {selectedId && (
            <button className="tab-button" onClick={resetSelected} style={{ width: '100%', marginTop: 6 }}>
              Reset selected to default
            </button>
          )}
        </div>

        {/* Sheet */}
        <div style={{ position: 'relative', width: DISPLAY_W, height: displayH, flexShrink: 0, userSelect: 'none' }}>
          <img src={url} width={DISPLAY_W} height={displayH} draggable={false} alt={sheet} />
          <svg
            ref={svgRef}
            width={DISPLAY_W} height={displayH}
            style={{ position: 'absolute', top: 0, left: 0, cursor: selectedId ? 'crosshair' : 'default', pointerEvents: 'all' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            <rect x={0} y={0} width={DISPLAY_W} height={displayH} fill="transparent" style={{ pointerEvents: 'all' }} />
            {visible.map((e) => {
              const isSel = selectedId === e.typeId;
              const [l, t, r, b] = e.box;
              return (
                <g key={e.typeId} onClick={(ev) => { ev.stopPropagation(); setSelectedId(e.typeId); }}>
                  <rect
                    x={l * scale} y={t * scale}
                    width={(r - l) * scale} height={(b - t) * scale}
                    style={{
                      fill: isSel ? 'rgba(255,213,74,0.18)' : 'rgba(80,220,120,0.10)',
                      stroke: isSel ? '#ffd54a' : '#80dc78',
                      strokeWidth: isSel ? 2 : 1,
                      strokeDasharray: '4,2',
                      cursor: 'pointer', pointerEvents: 'all',
                    }}
                  />
                  <text
                    x={l * scale + 3} y={t * scale + 11}
                    style={{ fill: isSel ? '#ffd54a' : '#80dc78', fontSize: 10, pointerEvents: 'none', textShadow: '0 0 3px #000' }}
                  >
                    {e.typeId}
                  </text>
                </g>
              );
            })}
            {drawing && (
              <rect
                x={Math.min(drawing.x0, drawing.x1) * scale}
                y={Math.min(drawing.y0, drawing.y1) * scale}
                width={Math.abs(drawing.x1 - drawing.x0) * scale}
                height={Math.abs(drawing.y1 - drawing.y0) * scale}
                style={{ fill: 'rgba(255,122,184,0.25)', stroke: '#ff7ab8', strokeWidth: 2, strokeDasharray: '4,2', pointerEvents: 'none' }}
              />
            )}
          </svg>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
        <p style={{ margin: '4px 0' }}>
          <strong>Workflow:</strong> click a unit in the left list → click-drag on the sheet to set its bbox.
          Re-drag any time to refine. The preview thumbnail next to each name updates live.
        </p>
        <p style={{ margin: '4px 0' }}>
          When done: <strong>Copy Python dicts</strong>, paste over EMPIRE_CROPS / REBEL_CROPS in
          <code> scripts/extract-unit-silhouettes.py</code>, run the script, refresh the play tab.
        </p>
      </div>
    </div>
  );
}

// Small canvas-backed thumbnail showing what the crop will look like.
function CropPreview({ url, box }: { url: string; box: BBox }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [l, t, r, b] = box;
  const w = Math.max(1, r - l);
  const h = Math.max(1, b - t);
  // Render the crop into a 48x48 canvas (preserve aspect).
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      const aspect = w / h;
      let dw = canvas.width, dh = canvas.height;
      if (aspect > 1) dh = canvas.width / aspect;
      else dw = canvas.height * aspect;
      const dx = (canvas.width - dw) / 2;
      const dy = (canvas.height - dh) / 2;
      ctx.drawImage(img, l, t, w, h, dx, dy, dw, dh);
    };
    img.src = url;
  }, [url, l, t, w, h]);
  return (
    <canvas ref={ref} width={48} height={48} style={{ background: '#0c0d10', borderRadius: 3, border: '1px solid #2a2d34', flexShrink: 0 }} />
  );
}
