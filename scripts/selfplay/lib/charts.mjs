// Game-agnostic PNG chart primitives on @napi-rs/canvas (already a
// devDependency — no new packages). Deliberately small: radar, positional
// heatmap, horizontal bars. Dark theme to match the game's aesthetic.
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';

const BG = '#15171c', FG = '#e8e2d0', GRID = '#3a3f4a';
const SERIES = ['#e0b430', '#7a86a8']; // winners gold, losers slate

function save(canvas, path) { writeFileSync(path, canvas.toBuffer('image/png')); }

/** Radar chart. series = [{ label, values }] with values already NORMALIZED
 *  to [0,1] per axis (the analyzer normalizes so both series share scale). */
export function renderRadar(path, { title, axes, series, size = 640 }) {
  const canvas = createCanvas(size, size + 60);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, size, size + 60);
  const cx = size / 2, cy = size / 2 + 30, R = size * 0.34;
  const N = axes.length;
  const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / N;
  ctx.strokeStyle = GRID; ctx.fillStyle = FG; ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, cx, 24);
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = angle(i % N);
      const x = cx + Math.cos(a) * R * ring, y = cy + Math.sin(a) * R * ring;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.font = '13px sans-serif';
  for (let i = 0; i < N; i++) {
    const a = angle(i);
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    ctx.fillStyle = FG;
    ctx.fillText(axes[i], cx + Math.cos(a) * (R + 34), cy + Math.sin(a) * (R + 22) + 4);
  }
  series.forEach((s, si) => {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = angle(i % N);
      const v = Math.max(0, Math.min(1, s.values[i % N]));
      const x = cx + Math.cos(a) * R * v, y = cy + Math.sin(a) * R * v;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = SERIES[si % SERIES.length];
    ctx.lineWidth = 2.5; ctx.stroke();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = SERIES[si % SERIES.length]; ctx.fill();
    ctx.globalAlpha = 1;
    // Legend.
    ctx.fillStyle = SERIES[si % SERIES.length];
    ctx.fillRect(20, size + 14 + si * 20, 14, 14);
    ctx.fillStyle = FG; ctx.textAlign = 'left';
    ctx.fillText(s.label, 40, size + 26 + si * 20);
    ctx.textAlign = 'center';
  });
  ctx.lineWidth = 1;
  save(canvas, path);
}

/** Positional heatmap: dots at given {x,y,label,value} positions, radius and
 *  color-intensity by value. positions come from the game's board coords. */
export function renderPositionHeatmap(path, { title, points, width = 900, color = '#e0b430' }) {
  const maxX = Math.max(...points.map((p) => p.x)), maxY = Math.max(...points.map((p) => p.y));
  const minX = Math.min(...points.map((p) => p.x)), minY = Math.min(...points.map((p) => p.y));
  const scale = (width - 120) / Math.max(1, maxX - minX);
  const height = Math.round((maxY - minY) * scale) + 120;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = FG; ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 26);
  const maxV = Math.max(1, ...points.map((p) => p.value));
  for (const p of points) {
    const x = 60 + (p.x - minX) * scale, y = 70 + (p.y - minY) * scale;
    const t = p.value / maxV;
    ctx.beginPath();
    ctx.arc(x, y, 4 + t * 18, 0, 2 * Math.PI);
    ctx.fillStyle = color; ctx.globalAlpha = 0.15 + t * 0.75; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = FG; ctx.font = '10px sans-serif';
    ctx.fillText(p.label, x, y + 26);
  }
  save(canvas, path);
}

/** Horizontal paired bars (winners vs losers frequency comparisons). rows =
 *  [{ label, a, b }] — a=winners, b=losers, raw counts (normalized here). */
export function renderPairedBars(path, { title, rows, aLabel, bLabel, width = 760 }) {
  const rowH = 26, height = 90 + rows.length * rowH;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = FG; ctx.font = '15px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 24);
  ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
  ctx.fillStyle = SERIES[0]; ctx.fillRect(20, 36, 12, 12);
  ctx.fillStyle = FG; ctx.fillText(aLabel, 38, 46);
  ctx.fillStyle = SERIES[1]; ctx.fillRect(150, 36, 12, 12);
  ctx.fillStyle = FG; ctx.fillText(bLabel, 168, 46);
  const maxV = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  const barW = width - 260;
  rows.forEach((r, i) => {
    const y = 70 + i * rowH;
    ctx.fillStyle = FG; ctx.textAlign = 'right'; ctx.fillText(r.label, 190, y + 12);
    ctx.textAlign = 'left';
    ctx.fillStyle = SERIES[0]; ctx.fillRect(200, y, (r.a / maxV) * barW, 9);
    ctx.fillStyle = SERIES[1]; ctx.fillRect(200, y + 11, (r.b / maxV) * barW, 9);
  });
  save(canvas, path);
}
