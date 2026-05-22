import { useEffect, useState, useMemo } from 'react';
import { loadSystems } from '../data/loadAssets';
import type { System, SystemsFile } from '../types';

// Shared localStorage key — also read/written by regions and resources tabs.
const LS_KEY = 'rebellion-dev-systems-edits';

type SystemEdits = Record<string, Partial<Pick<System, 'region' | 'resources' | 'buildSlot'>>>;

function applyEdits(systems: System[], edits: SystemEdits): System[] {
  return systems.map((s) => {
    const e = edits[s.id];
    if (!e) return s;
    return { ...s, ...e };
  });
}

export default function SystemsTab() {
  const [data, setData] = useState<SystemsFile | null>(null);
  const [edits, setEdits] = useState<SystemEdits>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSystems()
      .then((d) => {
        setData(d);
        const stored = localStorage.getItem(LS_KEY);
        if (stored) {
          try { setEdits(JSON.parse(stored)); } catch {}
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  const effective = useMemo(() => {
    if (!data) return null;
    return applyEdits(data.systems, edits);
  }, [data, edits]);

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!data || !effective) return <div className="placeholder">Loading…</div>;

  const remoteCount = effective.filter((s) => s.isRemote).length;
  const populousCount = effective.filter((s) => !s.isRemote && !s.isCoruscant).length;
  const editCount = Object.keys(edits).length;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Systems ({effective.length})</h2>
      <div style={{ marginBottom: 12, color: '#aaa', fontSize: 13 }}>
        Remote: {remoteCount} · Populous (non-Coruscant): {populousCount} · Coruscant: 1
        {editCount > 0 && (
          <span style={{ marginLeft: 12, color: '#ffd54a' }}>
            · {editCount} row{editCount === 1 ? '' : 's'} with local edits (see <em>regions</em> and <em>resources</em> tabs)
          </span>
        )}
      </div>

      <div className="meta-notes">
        <strong>Provenance:</strong> {data._meta.provenance}
        <ul>
          {data._meta.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>

      <p style={{ color: '#888', fontSize: 13 }}>
        This tab is read-only. Use the <strong>regions</strong> tab to assign systems to regions
        and the <strong>resources</strong> tab to set each populous system's resource icons.
      </p>

      <table className="systems-table">
        <thead>
          <tr>
            <th>id</th>
            <th>name</th>
            <th>kind</th>
            <th>region</th>
            <th>slot</th>
            <th>resources</th>
            <th>x, y</th>
          </tr>
        </thead>
        <tbody>
          {effective.map((s) => (
            <tr key={s.id}>
              <td><code style={{ color: '#80dc78' }}>{s.id}</code></td>
              <td>{s.name}</td>
              <td>
                {s.isCoruscant
                  ? <span className="badge coruscant">Coruscant</span>
                  : s.isRemote
                    ? <span className="badge remote">remote</span>
                    : <span className="badge populous">populous</span>}
              </td>
              <td>{s.region}</td>
              <td>{s.buildSlot ?? '—'}</td>
              <td style={{ color: s.resources.length === 0 ? '#6a6e78' : '#e8e8ea' }}>
                {s.resources.length === 0
                  ? (s.isRemote ? '—' : '(none set)')
                  : s.resources.map((r) => {
                      const glyph = r.shape === 'triangle' ? '▲' : r.shape === 'circle' ? '●' : '■';
                      const color = r.type === 'space' ? '#4fc3f7' : '#ffb74d';
                      return <span key={r.type + r.shape} style={{ color, marginRight: 4 }}>{glyph}</span>;
                    })}
              </td>
              <td style={{ color: '#888', fontFamily: 'monospace', fontSize: 12 }}>
                {s.boardPos.x}, {s.boardPos.y}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
