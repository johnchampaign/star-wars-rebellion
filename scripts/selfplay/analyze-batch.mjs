// Self-play analytics miner (Feature 1.2). Reads a run-batch JSONL, produces:
//   radar-rebel.png / radar-empire.png   winners-vs-losers radars (per side —
//                                        the game is asymmetric; see adapter)
//   heatmap-<side>-<class>.png           per-system activity over board coords
//   cards-<side>.png                     mission-reveal frequency, W vs L
//   report.md                            largest winner-loser deltas, plain
//                                        language, blog-post raw material
// Usage: node scripts/selfplay/analyze-batch.mjs <games.jsonl> [--out <dir>]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { register } = await import('tsx/esm/api');
register();
const { readJsonl } = await import('./lib/schema.mjs');
const { RADARS, heatmapCells, cardFrequencies } = await import('./lib/dims-rebellion.mjs');
const { renderRadar, renderPositionHeatmap, renderPairedBars } = await import('./lib/charts.mjs');

const argv = process.argv.slice(2);
const inFile = argv[0];
if (!inFile) { console.error('usage: analyze-batch.mjs <games.jsonl> [--out dir]'); process.exit(1); }
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 ? argv[outIdx + 1] : join(dirname(inFile), 'analysis');
mkdirSync(outDir, { recursive: true });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const systemsJson = JSON.parse(readFileSync(join(ROOT, 'assets', 'systems.json'), 'utf8'));
const systems = Array.isArray(systemsJson) ? systemsJson : systemsJson.systems;
const posOf = new Map(systems.map((s) => [s.id, { x: s.boardPos?.x ?? 0, y: s.boardPos?.y ?? 0, name: s.name }]));

const { records, skipped } = readJsonl(readFileSync(inFile, 'utf8'));
if (records.length === 0) { console.error('no valid records'); process.exit(1); }
console.log(`loaded ${records.length} games (${skipped} skipped)`);

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

const report = [];
report.push(`# Self-play analysis — ${records.length} games`);
report.push('');
report.push(`Source: \`${inFile}\` · policies: ${JSON.stringify(records[0].policies)} · generated ${new Date().toISOString()}`);
const wins = { Rebel: records.filter((r) => r.winner === 'Rebel').length, Empire: records.filter((r) => r.winner === 'Empire').length };
report.push('');
report.push(`Overall: Rebel ${wins.Rebel} — Empire ${wins.Empire} (${Math.round((100 * wins.Rebel) / records.length)}% / ${Math.round((100 * wins.Empire) / records.length)}%).`);
report.push('');
report.push('> **Caveat:** these are AI-self-play behaviors. This project has repeatedly measured');
report.push('> that self-play differs from human play (e.g. passivity goes unpunished). Read the');
report.push('> deltas as "what separates winning AI games", not as human strategy advice.');
report.push('');

for (const radar of RADARS) {
  const side = radar.id === 'rebel' ? 'Rebel' : 'Empire';
  const winners = records.filter((r) => r.winner === side);
  const losers = records.filter((r) => r.winner !== side && r.winner !== 'none');
  const axes = radar.dims.map((d) => d.label);
  const avg = (set, key) => mean(set.map((r) => r.dims[key] ?? 0));
  // Normalize each axis by the max of the two means so both polygons share scale.
  const wVals = [], lVals = [], deltas = [];
  for (const d of radar.dims) {
    let w = avg(winners, d.key), l = avg(losers, d.key);
    deltas.push({ label: d.label, key: d.key, w, l, invert: !!d.invert });
    if (d.invert) { const m = Math.max(w, l, 1e-9); w = m - w + m * 0.05; l = m - l + m * 0.05; }
    const m = Math.max(w, l, 1e-9);
    wVals.push(w / m); lVals.push(l / m);
  }
  renderRadar(join(outDir, `radar-${radar.id}.png`), {
    title: `${radar.title} (${winners.length}W / ${losers.length}L)`,
    axes,
    series: [
      { label: `${side} winners`, values: wVals },
      { label: `${side} losers`, values: lVals },
    ],
  });
  // Report: largest ratios.
  report.push(`## ${radar.title}`);
  report.push('');
  report.push(`![radar](radar-${radar.id}.png)`);
  report.push('');
  const ranked = deltas
    .map((d) => ({ ...d, ratio: (d.w + 1e-9) / (d.l + 1e-9) }))
    .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
  for (const d of ranked) {
    const dir = d.ratio >= 1 ? 'more' : 'less';
    const factor = d.ratio >= 1 ? d.ratio : 1 / d.ratio;
    const note = d.invert ? ' (lower is better for this side)' : '';
    report.push(`- **${d.label}**: winners ${factor.toFixed(2)}x ${dir} than losers (${d.w.toFixed(2)} vs ${d.l.toFixed(2)})${note}`);
  }
  report.push('');

  // Heatmaps: activation+reveal targets, winners vs losers.
  for (const [cls, set] of [['winners', winners], ['losers', losers]]) {
    const cells = heatmapCells(set, side, ['activate', 'reveal']);
    const points = [...cells.entries()]
      .filter(([sid]) => posOf.has(sid))
      .map(([sid, value]) => ({ ...posOf.get(sid), label: posOf.get(sid).name, value: value / Math.max(1, set.length) }));
    if (points.length > 0) {
      renderPositionHeatmap(join(outDir, `heatmap-${radar.id}-${cls}.png`), {
        title: `${side} ${cls}: activity per system (per game)`,
        points,
        color: cls === 'winners' ? '#e0b430' : '#7a86a8',
      });
    }
  }
  report.push(`![heatmap winners](heatmap-${radar.id}-winners.png) ![heatmap losers](heatmap-${radar.id}-losers.png)`);
  report.push('');

  // Card frequency paired bars (top 14 by combined use).
  const wf = cardFrequencies(winners, side), lf = cardFrequencies(losers, side);
  const allCards = [...new Set([...wf.keys(), ...lf.keys()])];
  const rows = allCards
    .map((id) => ({ label: id, a: (wf.get(id) ?? 0) / Math.max(1, winners.length), b: (lf.get(id) ?? 0) / Math.max(1, losers.length) }))
    .sort((p, q) => q.a + q.b - (p.a + p.b))
    .slice(0, 14);
  if (rows.length > 0) {
    renderPairedBars(join(outDir, `cards-${radar.id}.png`), {
      title: `${side}: mission reveals per game, winners vs losers`,
      rows, aLabel: 'winners', bLabel: 'losers',
    });
    report.push(`![cards](cards-${radar.id}.png)`);
    report.push('');
  }
}

writeFileSync(join(outDir, 'report.md'), report.join('\n'));
console.log(`analysis written to ${outDir} (report.md + PNGs)`);
