// Drag system markers to reposition them on the planet artwork.
// Same localStorage key and shape as before — any prior edits are preserved.

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { loadSystems, MAP_IMAGE_URL, mapImageUrl } from '../data/loadAssets';
import { getVmodMeta, preloadAllBlobUrls } from '../play/vmodArtCache';
import type { System, SystemsFile } from '../types';

const NATIVE_W = 3180;
const NATIVE_H = 1590;
const DISPLAY_W = 1590;
const DISPLAY_H = 795;
const SCALE = DISPLAY_W / NATIVE_W;
const INV_SCALE = NATIVE_W / DISPLAY_W;
const MARKER_R = 22;
const LS_KEY = 'rebellion-dev-systems-edits';

type SystemEdits = Record<string, Partial<Pick<System, 'region' | 'resources' | 'buildSlot' | 'boardPos' | 'loyaltyMarkerPos' | 'sabotageMarkerPos'>>>;
type MarkerKind = 'planet' | 'loyalty' | 'sabotage';

function applyEdits(systems: System[], edits: SystemEdits): System[] {
  return systems.map((s) => {
    const e = edits[s.id];
    if (!e) return s;
    return {
      ...s, ...e,
      boardPos: e.boardPos ?? s.boardPos,
      loyaltyMarkerPos: e.loyaltyMarkerPos ?? s.loyaltyMarkerPos,
      sabotageMarkerPos: e.sabotageMarkerPos ?? s.sabotageMarkerPos,
    };
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
  const [dragging, setDragging] = useState<{ id: string; kind: MarkerKind } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Prefer the loaded .vmod board (the real art the player sees, e.g. v1.2e
  // Map-Redux) over the static stripped placeholder so this calibration tool
  // works in production. Falls back to MAP_IMAGE_URL when no .vmod is loaded.
  const [mapUrl, setMapUrl] = useState<string>(MAP_IMAGE_URL);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    loadSystems()
      .then((d) => {
        setData(d);
        setEdits(loadEdits());
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Load the cached .vmod art so the background is the player's real board.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const meta = await getVmodMeta();
      if (cancelled || !meta) return;
      await preloadAllBlobUrls();
      if (!cancelled) setMapUrl(mapImageUrl());
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { saveEdits(edits); }, [edits]);

  const effective = useMemo(() => data ? applyEdits(data.systems, edits) : null, [data, edits]);

  const planetEdited = useCallback((s: System) => {
    if (!data) return false;
    const orig = data.systems.find((o) => o.id === s.id);
    if (!orig) return false;
    return orig.boardPos.x !== s.boardPos.x || orig.boardPos.y !== s.boardPos.y;
  }, [data]);
  const loyaltyEdited = useCallback((s: System) => {
    if (!data) return false;
    const orig = data.systems.find((o) => o.id === s.id);
    if (!orig || !orig.loyaltyMarkerPos || !s.loyaltyMarkerPos) return false;
    return orig.loyaltyMarkerPos.x !== s.loyaltyMarkerPos.x || orig.loyaltyMarkerPos.y !== s.loyaltyMarkerPos.y;
  }, [data]);
  const sabotageEdited = useCallback((s: System) => {
    if (!data) return false;
    const orig = data.systems.find((o) => o.id === s.id);
    if (!orig || !s.sabotageMarkerPos) return false;
    // No original position recorded → any placed value is an edit.
    if (!orig.sabotageMarkerPos) return true;
    return orig.sabotageMarkerPos.x !== s.sabotageMarkerPos.x || orig.sabotageMarkerPos.y !== s.sabotageMarkerPos.y;
  }, [data]);
  const editedFlag = useCallback((s: System) => planetEdited(s) || loyaltyEdited(s) || sabotageEdited(s), [planetEdited, loyaltyEdited, sabotageEdited]);

  const isDirty = useMemo(() => {
    if (!data || !effective) return false;
    return effective.some(editedFlag);
  }, [data, effective, editedFlag]);

  const updatePos = useCallback((id: string, kind: MarkerKind, x: number, y: number) => {
    if (!data) return;
    const orig = data.systems.find((s) => s.id === id);
    if (!orig) return;
    const newX = Math.round(x);
    const newY = Math.round(y);
    const origPos = kind === 'planet' ? orig.boardPos
      : kind === 'loyalty' ? orig.loyaltyMarkerPos
      : orig.sabotageMarkerPos;
    const field: 'boardPos' | 'loyaltyMarkerPos' | 'sabotageMarkerPos' =
      kind === 'planet' ? 'boardPos' : kind === 'loyalty' ? 'loyaltyMarkerPos' : 'sabotageMarkerPos';
    setEdits((prev) => {
      const next = { ...prev };
      const merged = { ...(next[id] ?? {}) };
      if (origPos && newX === origPos.x && newY === origPos.y) {
        delete merged[field];
      } else {
        merged[field] = { x: newX, y: newY };
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
    updatePos(dragging.id, dragging.kind, nativeX, nativeY);
  }, [dragging, updatePos]);

  useEffect(() => {
    if (!dragging) return;
    const upHandler = () => setDragging(null);
    document.addEventListener('mouseup', upHandler);
    return () => document.removeEventListener('mouseup', upHandler);
  }, [dragging]);

  const handleResetOne = (id: string) => {
    setEdits((prev) => {
      const next = { ...prev };
      if (next[id]?.boardPos || next[id]?.loyaltyMarkerPos || next[id]?.sabotageMarkerPos) {
        const merged = { ...next[id] };
        delete merged.boardPos;
        delete merged.loyaltyMarkerPos;
        delete merged.sabotageMarkerPos;
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
        <strong>What this is:</strong> drag each marker onto the real board to calibrate it.
        The big <span style={{ color: '#ffd54a' }}>yellow</span> marker is the planet center
        (<code>boardPos</code> — drives leader pips &amp; unit stacks); the smaller{' '}
        <span style={{ color: '#5aaaff' }}>blue</span> marker is the printed loyalty hex
        (<code>loyaltyMarkerPos</code> — where the loyalty/subjugation disc sits); the{' '}
        <span style={{ color: '#ff9a3c' }}>orange rectangle</span> is the sabotage token&apos;s
        actual footprint (<code>sabotageMarkerPos</code> — drag it to cover the system&apos;s two
        RESOURCE icons; remote systems have none and get no rectangle; #174).
        Drop each on the matching spot, then Export. Repositioned markers turn green.
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
            Dragging: {dragging.id} ({dragging.kind === 'planet' ? 'planet' : dragging.kind === 'loyalty' ? 'loyalty marker' : 'sabotage marker'})
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
          <img src={mapUrl} width={DISPLAY_W} height={DISPLAY_H} alt="Board" draggable={false} />
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
              const draggingPlanet = dragging?.id === s.id && dragging.kind === 'planet';
              const draggingLoyalty = dragging?.id === s.id && dragging.kind === 'loyalty';
              const draggingSabotage = dragging?.id === s.id && dragging.kind === 'sabotage';
              const planetIsEdited = planetEdited(s);
              const loyaltyIsEdited = loyaltyEdited(s);
              const sabotageIsEdited = sabotageEdited(s);
              // Loyalty hex marker (smaller, blue) — only for systems that have one.
              const lp = s.loyaltyMarkerPos;
              const lx = lp ? lp.x * SCALE : 0;
              const ly = lp ? lp.y * SCALE : 0;
              // Sabotage / resource-icons marker (orange) — only for systems with
              // resource icons. Starts at the saved sabotageMarkerPos, else just
              // right of the loyalty hex (or planet) so it's visible to grab.
              const hasResources = (s.resources?.length ?? 0) > 0;
              const sp = s.sabotageMarkerPos
                ?? (lp ? { x: lp.x + 60, y: lp.y } : { x: s.boardPos.x + 60, y: s.boardPos.y });
              const sx = sp.x * SCALE;
              const sy = sp.y * SCALE;
              return (
                <g key={s.id}>
                  {(isHover || draggingPlanet) && (
                    <>
                      <line x1={x - 30} y1={y} x2={x + 30} y2={y} stroke="rgba(255,215,80,0.5)" strokeWidth={1} pointerEvents="none" />
                      <line x1={x} y1={y - 30} x2={x} y2={y + 30} stroke="rgba(255,215,80,0.5)" strokeWidth={1} pointerEvents="none" />
                    </>
                  )}
                  {/* Planet center (boardPos) — yellow/green */}
                  <circle
                    cx={x} cy={y} r={MARKER_R}
                    style={{
                      fill: planetIsEdited ? 'rgba(80, 220, 120, 0.45)' : 'rgba(255, 215, 80, 0.35)',
                      stroke: draggingPlanet ? '#ff7ab8' : isHover ? '#ffd54a' : (planetIsEdited ? 'rgba(80, 220, 120, 0.9)' : 'rgba(255, 215, 80, 0.6)'),
                      strokeWidth: draggingPlanet ? 3 : 2,
                      cursor: 'grab',
                      pointerEvents: 'all',
                    }}
                    onMouseEnter={() => setHoverId(s.id)}
                    onMouseLeave={() => setHoverId(null)}
                    onMouseDown={(e) => { e.preventDefault(); setDragging({ id: s.id, kind: 'planet' }); }}
                  />
                  {/* Loyalty hex marker (loyaltyMarkerPos) — blue, draggable */}
                  {lp && (
                    <>
                      {draggingLoyalty && (
                        <>
                          <line x1={lx - 30} y1={ly} x2={lx + 30} y2={ly} stroke="rgba(90,170,255,0.6)" strokeWidth={1} pointerEvents="none" />
                          <line x1={lx} y1={ly - 30} x2={lx} y2={ly + 30} stroke="rgba(90,170,255,0.6)" strokeWidth={1} pointerEvents="none" />
                        </>
                      )}
                      <circle
                        cx={lx} cy={ly} r={MARKER_R * 0.7}
                        style={{
                          fill: loyaltyIsEdited ? 'rgba(80, 220, 120, 0.5)' : 'rgba(90, 170, 255, 0.4)',
                          stroke: draggingLoyalty ? '#ff7ab8' : (loyaltyIsEdited ? 'rgba(80,220,120,0.95)' : 'rgba(90,170,255,0.95)'),
                          strokeWidth: draggingLoyalty ? 3 : 2,
                          cursor: 'grab',
                          pointerEvents: 'all',
                        }}
                        onMouseDown={(e) => { e.preventDefault(); setDragging({ id: s.id, kind: 'loyalty' }); }}
                      >
                        <title>{s.name} — loyalty marker</title>
                      </circle>
                    </>
                  )}
                  {/* Sabotage / resource-icons marker — orange RECTANGLE matching
                      the real token footprint (89x52 native, covers both
                      resource icons), draggable by its center (#174). Remote
                      systems have no resource icons → no marker. */}
                  {hasResources && (() => {
                    const SAB_W = 89 * SCALE;
                    const SAB_H = 52 * SCALE;
                    return (
                      <>
                        {draggingSabotage && (
                          <>
                            <line x1={sx - 60} y1={sy} x2={sx + 60} y2={sy} stroke="rgba(255,150,60,0.6)" strokeWidth={1} pointerEvents="none" />
                            <line x1={sx} y1={sy - 40} x2={sx} y2={sy + 40} stroke="rgba(255,150,60,0.6)" strokeWidth={1} pointerEvents="none" />
                          </>
                        )}
                        <rect
                          x={sx - SAB_W / 2} y={sy - SAB_H / 2}
                          width={SAB_W} height={SAB_H} rx={2}
                          style={{
                            fill: sabotageIsEdited ? 'rgba(80, 220, 120, 0.35)' : 'rgba(255, 150, 60, 0.3)',
                            stroke: draggingSabotage ? '#ff7ab8' : (sabotageIsEdited ? 'rgba(80,220,120,0.95)' : 'rgba(255,150,60,0.95)'),
                            strokeWidth: draggingSabotage ? 3 : 2,
                            cursor: 'grab',
                            pointerEvents: 'all',
                          }}
                          onMouseDown={(e) => { e.preventDefault(); setDragging({ id: s.id, kind: 'sabotage' }); }}
                        >
                          <title>{s.name} — sabotage token footprint (drop over the two resource icons)</title>
                        </rect>
                      </>
                    );
                  })()}
                  <text
                    x={x} y={y + MARKER_R + 12}
                    textAnchor="middle"
                    className="system-label"
                    opacity={isHover || draggingPlanet || draggingLoyalty || draggingSabotage || planetIsEdited || loyaltyIsEdited || sabotageIsEdited ? 1 : 0.5}
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
