// Dev tab: refine circular crops for the unit tokens on a reference sheet.
// Click a unit → click on the sheet to re-position its circle center; mouse
// wheel over the sheet resizes the selected token's radius.
//
// Edits persist in localStorage. Export JSON → drop the coords into the
// matching extraction script (scripts/extract-unit-tokens.py for the base
// game, scripts/extract-rote-unit-tokens.py for Rise of the Empire).
//
// Parameterized by `config` so the same UI drives both the base-game sheet
// (18 tokens, 1536x1024) and the RotE sheet (8 tokens, 900x600). Rendered
// with no prop it defaults to the base-game configuration.

import { useEffect, useRef, useState, useCallback } from 'react';

type Token = { typeId: string; label: string; cx: number; cy: number; r: number };

export type TokensTabConfig = {
  sheetUrl: string;
  nativeW: number;
  nativeH: number;
  defaults: Token[];
  lsKey: string;
  exportName: string;   // downloaded JSON filename
  sheetPath: string;    // human-readable path shown in the notes
  script: string;       // extraction script to paste into
};

// User-refined via the tokens dev tab on 2026-05-21.
const BASE_DEFAULTS: Token[] = [
  { typeId: 'tie-fighter',                   label: 'TIE Fighter',           cx: 289,  cy: 194, r: 88 },
  { typeId: 'assault-carrier',               label: 'Assault Carrier',       cx: 492,  cy: 194, r: 88 },
  { typeId: 'star-destroyer',                label: 'Star Destroyer',        cx: 706,  cy: 194, r: 88 },
  { typeId: 'super-star-destroyer',          label: 'Super Star Destroyer',  cx: 928,  cy: 194, r: 88 },
  { typeId: 'death-star',                    label: 'Death Star',            cx: 1146, cy: 194, r: 88 },
  { typeId: 'death-star-under-construction', label: 'Death Star (UC)',       cx: 1369, cy: 194, r: 88 },
  { typeId: 'stormtrooper',                  label: 'Stormtrooper',          cx: 289,  cy: 417, r: 84 },
  { typeId: 'at-st',                         label: 'AT-ST',                 cx: 503,  cy: 417, r: 88 },
  { typeId: 'at-at',                         label: 'AT-AT',                 cx: 706,  cy: 417, r: 88 },
  { typeId: 'x-wing',                        label: 'X-Wing',                cx: 289,  cy: 698, r: 84 },
  { typeId: 'y-wing',                        label: 'Y-Wing',                cx: 529,  cy: 698, r: 88 },
  { typeId: 'corellian-corvette',            label: 'Corellian Corvette',    cx: 771,  cy: 698, r: 88 },
  { typeId: 'rebel-transport',               label: 'Rebel Transport',       cx: 1038, cy: 698, r: 88 },
  { typeId: 'mon-cala-cruiser',              label: 'Mon Calamari Cruiser',  cx: 1320, cy: 698, r: 88 },
  { typeId: 'rebel-trooper',                 label: 'Rebel Trooper',         cx: 289,  cy: 906, r: 84 },
  { typeId: 'airspeeder',                    label: 'Airspeeder',            cx: 531,  cy: 906, r: 88 },
  { typeId: 'shield-generator',              label: 'Shield Generator',      cx: 771,  cy: 906, r: 88 },
  { typeId: 'ion-cannon',                    label: 'Ion Cannon',            cx: 1000, cy: 906, r: 88 },
];

export const BASE_TOKENS_CONFIG: TokensTabConfig = {
  sheetUrl: '/dev-assets/unit-tokens-sheet.png',
  nativeW: 1536,
  nativeH: 1024,
  defaults: BASE_DEFAULTS,
  lsKey: 'rebellion-dev-token-circles',
  exportName: 'unit-tokens.json',
  sheetPath: 'public/dev-assets/unit-tokens-sheet.png',
  script: 'scripts/extract-unit-tokens.py',
};

// Rise of the Empire sheet — 8 tokens, 4 per faction row. Starting positions
// are the auto-estimated crops; refine them here and re-export.
const ROTE_DEFAULTS: Token[] = [
  // Hand-marked via this tab and exported 2026-06-09.
  { typeId: 'tie-striker',       label: 'TIE Striker',       cx: 138, cy: 163, r: 80 },
  { typeId: 'assault-tank',      label: 'Assault Tank',      cx: 334, cy: 164, r: 80 },
  { typeId: 'shield-bunker',     label: 'Shield Bunker',     cx: 531, cy: 163, r: 80 },
  { typeId: 'interdictor',       label: 'Interdictor',       cx: 737, cy: 163, r: 80 },
  { typeId: 'u-wing',            label: 'U-Wing',            cx: 128, cy: 449, r: 80 },
  { typeId: 'nebulon-b-frigate', label: 'Nebulon-B Frigate', cx: 331, cy: 449, r: 80 },
  { typeId: 'rebel-vanguard',    label: 'Rebel Vanguard',    cx: 541, cy: 449, r: 80 },
  { typeId: 'golan-arms-turret', label: 'Golan Arms Turret', cx: 754, cy: 445, r: 80 },
];

export const ROTE_TOKENS_CONFIG: TokensTabConfig = {
  sheetUrl: '/dev-assets/unit-tokens-sheet-rote.png',
  nativeW: 900,
  nativeH: 600,
  defaults: ROTE_DEFAULTS,
  lsKey: 'rebellion-dev-token-circles-rote',
  exportName: 'unit-tokens-rote.json',
  sheetPath: 'public/dev-assets/unit-tokens-sheet-rote.png',
  script: 'scripts/extract-rote-unit-tokens.py',
};

function loadEdits(lsKey: string): Record<string, { cx: number; cy: number; r: number }> | null {
  const s = localStorage.getItem(lsKey);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function saveEdits(lsKey: string, defaults: Token[], tokens: Token[]): void {
  const out: Record<string, { cx: number; cy: number; r: number }> = {};
  let dirty = false;
  for (const t of tokens) {
    const def = defaults.find((d) => d.typeId === t.typeId)!;
    if (t.cx !== def.cx || t.cy !== def.cy || t.r !== def.r) {
      out[t.typeId] = { cx: t.cx, cy: t.cy, r: t.r };
      dirty = true;
    }
  }
  if (dirty) localStorage.setItem(lsKey, JSON.stringify(out));
  else localStorage.removeItem(lsKey);
}

export default function TokensTab({ config = BASE_TOKENS_CONFIG }: { config?: TokensTabConfig }) {
  const { sheetUrl, nativeW, nativeH, defaults, lsKey, exportName, sheetPath, script } = config;
  const DISPLAY_W = Math.min(1200, nativeW);
  const SCALE = DISPLAY_W / nativeW;
  const INV_SCALE = nativeW / DISPLAY_W;
  const DISPLAY_H = nativeH * SCALE;

  const [tokens, setTokens] = useState<Token[]>(() => {
    const edits = loadEdits(lsKey);
    return defaults.map((d) => {
      const e = edits?.[d.typeId];
      return e ? { ...d, cx: e.cx, cy: e.cy, r: e.r } : { ...d };
    });
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Reset state when the config (sheet) changes.
  useEffect(() => {
    const edits = loadEdits(lsKey);
    setTokens(defaults.map((d) => {
      const e = edits?.[d.typeId];
      return e ? { ...d, cx: e.cx, cy: e.cy, r: e.r } : { ...d };
    }));
    setSelectedId(null);
  }, [lsKey, defaults]);

  useEffect(() => { saveEdits(lsKey, defaults, tokens); }, [lsKey, defaults, tokens]);

  const toNative = useCallback((cx: number, cy: number) => {
    if (!svgRef.current) return null;
    const r = svgRef.current.getBoundingClientRect();
    return { x: Math.round((cx - r.left) * INV_SCALE), y: Math.round((cy - r.top) * INV_SCALE) };
  }, [INV_SCALE]);

  const handleClick = (e: React.MouseEvent) => {
    if (!selectedId) return;
    const n = toNative(e.clientX, e.clientY);
    if (!n) return;
    setTokens((ts) => ts.map((t) => t.typeId === selectedId ? { ...t, cx: n.x, cy: n.y } : t));
  };

  const adjustRadius = (delta: number) => {
    if (!selectedId) return;
    setTokens((ts) => ts.map((t) =>
      t.typeId === selectedId ? { ...t, r: Math.max(20, Math.min(200, t.r + delta)) } : t
    ));
  };

  // Wheel-resize when a token is selected and the cursor is over the SVG.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !selectedId) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      adjustRadius(ev.deltaY > 0 ? -2 : 2);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [selectedId]);

  const resetSelected = () => {
    if (!selectedId) return;
    const def = defaults.find((d) => d.typeId === selectedId);
    if (!def) return;
    setTokens((ts) => ts.map((t) => t.typeId === selectedId ? { ...def } : t));
  };
  const resetAll = () => {
    if (!confirm('Reset all token circles to script defaults?')) return;
    setTokens(defaults.map((d) => ({ ...d })));
    setSelectedId(null);
  };
  const applyRadiusToAll = () => {
    if (!selectedId) return;
    const sel = tokens.find((t) => t.typeId === selectedId);
    if (!sel) return;
    setTokens((ts) => ts.map((t) => ({ ...t, r: sel.r })));
  };
  const applyXColumn = () => {
    if (!selectedId) return;
    const sel = tokens.find((t) => t.typeId === selectedId);
    if (!sel) return;
    // Find every token currently within ±60px of selected.cx → align them all to selected.cx
    setTokens((ts) => ts.map((t) => Math.abs(t.cx - sel.cx) <= 60 ? { ...t, cx: sel.cx } : t));
  };
  const applyYRow = () => {
    if (!selectedId) return;
    const sel = tokens.find((t) => t.typeId === selectedId);
    if (!sel) return;
    setTokens((ts) => ts.map((t) => Math.abs(t.cy - sel.cy) <= 60 ? { ...t, cy: sel.cy } : t));
  };

  const exportJson = () => {
    const out = {
      _meta: {
        schema: 'unit-tokens-v1',
        editedAt: new Date().toISOString(),
        note: `Centers + radii for circular unit-token crops. Apply via ${script}.`,
        sheet: sheetPath,
        sheetSize: [nativeW, nativeH],
      },
      tokens: Object.fromEntries(tokens.map((t) => [t.typeId, { cx: t.cx, cy: t.cy, r: t.r }])),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Tokens</h2>
      <div className="meta-notes">
        <strong>What this is:</strong> the {tokens.length} circular unit portraits cropped from
        <code> {sheetPath}</code>. Click a unit on the left, then click
        on the sheet to set its center. Mouse-wheel over the sheet resizes the radius of the
        selected token. When done, <strong>Export JSON</strong> and paste the coords into
        <code> {script}</code>, re-run it.
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="tab-button" onClick={exportJson}>Export JSON</button>
        {selectedId && (
          <>
            <button className="tab-button" onClick={applyRadiusToAll}>Apply this radius to all</button>
            <button className="tab-button" onClick={applyXColumn}>Snap column to this X</button>
            <button className="tab-button" onClick={applyYRow}>Snap row to this Y</button>
            <button className="tab-button" onClick={resetSelected}>Reset selected</button>
          </>
        )}
        <button className="tab-button" onClick={resetAll} style={{ marginLeft: 'auto', color: '#ff8866' }}>
          Reset all
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        {/* Sidebar */}
        <div style={{ flex: '0 0 300px', maxHeight: DISPLAY_H, overflowY: 'auto', background: '#15171c', padding: 8, borderRadius: 4 }}>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>Tokens ({tokens.length})</div>
          {tokens.map((t) => {
            const isSel = selectedId === t.typeId;
            const def = defaults.find((d) => d.typeId === t.typeId)!;
            const dirty = t.cx !== def.cx || t.cy !== def.cy || t.r !== def.r;
            return (
              <div
                key={t.typeId}
                onClick={() => setSelectedId(t.typeId)}
                style={{
                  marginBottom: 4, padding: 6, cursor: 'pointer',
                  border: '1px solid ' + (isSel ? '#ffd54a' : '#2a2d34'),
                  borderRadius: 3, background: isSel ? '#2a230a' : 'transparent',
                  display: 'flex', gap: 8, alignItems: 'center',
                }}
              >
                <TokenPreview sheetUrl={sheetUrl} cx={t.cx} cy={t.cy} r={t.r} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#e8e8ea', fontWeight: 600 }}>
                    {t.label} {dirty && <span style={{ color: '#ffd54a' }}>•</span>}
                  </div>
                  <div style={{ fontSize: 10, color: '#888', fontFamily: 'monospace' }}>
                    ({t.cx},{t.cy}) r={t.r}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Sheet */}
        <div style={{ position: 'relative', width: DISPLAY_W, height: DISPLAY_H, flexShrink: 0, userSelect: 'none' }}>
          <img src={sheetUrl} width={DISPLAY_W} height={DISPLAY_H} draggable={false} alt="Token sheet" />
          <svg
            ref={svgRef}
            width={DISPLAY_W} height={DISPLAY_H}
            style={{ position: 'absolute', top: 0, left: 0, cursor: selectedId ? 'crosshair' : 'default', pointerEvents: 'all' }}
            onClick={handleClick}
          >
            <rect x={0} y={0} width={DISPLAY_W} height={DISPLAY_H} fill="transparent" style={{ pointerEvents: 'all' }} />
            {tokens.map((t) => {
              const isSel = selectedId === t.typeId;
              // Circles are visual only — pointerEvents:none so clicks pass
              // through to the SVG handler, which repositions the active
              // selection. (Selection is done via the sidebar.)
              return (
                <g key={t.typeId} style={{ pointerEvents: 'none' }}>
                  <circle
                    cx={t.cx * SCALE} cy={t.cy * SCALE} r={t.r * SCALE}
                    style={{
                      fill: 'transparent',
                      stroke: isSel ? '#ffd54a' : '#80dc78',
                      strokeWidth: isSel ? 3 : 1.5,
                      strokeDasharray: '4,2',
                    }}
                  />
                  <text
                    x={t.cx * SCALE} y={(t.cy - t.r) * SCALE - 4}
                    textAnchor="middle"
                    style={{ fill: isSel ? '#ffd54a' : '#80dc78', fontSize: 10, textShadow: '0 0 3px #000' }}
                  >
                    {t.typeId}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
        <p style={{ margin: '4px 0' }}>
          <strong>Tips:</strong> Pick a token in the list, then click on the sheet to drop the
          circle center. Mouse-wheel resizes the selected circle's radius. "Snap column/row"
          aligns nearby tokens to the selected one — quick way to fix a whole grid.
        </p>
      </div>
    </div>
  );
}

// Tiny canvas thumbnail of the current circle crop.
function TokenPreview({ sheetUrl, cx, cy, r }: { sheetUrl: string; cx: number; cy: number; r: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.beginPath();
      ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2 - 1, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      const d = r * 2;
      ctx.drawImage(img, cx - r, cy - r, d, d, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    };
    img.src = sheetUrl;
  }, [sheetUrl, cx, cy, r]);
  return (
    <canvas ref={ref} width={48} height={48} style={{ background: '#0c0d10', borderRadius: 24, border: '1px solid #2a2d34', flexShrink: 0 }} />
  );
}
