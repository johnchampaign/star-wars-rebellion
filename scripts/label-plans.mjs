// Step 3 of the imitation plan: label every archived round with the PLAN the
// recorded human was executing, derived from what happened next (outcomes),
// not from a model. Writes reports/plan-labels.json keyed by "gameId:turn".
//
// Empire plans (measured 2026-09-02 on 344 base-captured games: nearest
// Imperial ground within 1 hop of the eventual base rises 10% at T-8 to 99%
// at capture, monotone):
//   strike   — base captured/destroyed within 1 round (T-1..T-0)
//   stage    — capture within 2..4 rounds AND Imperial ground is closing on the
//              base (hops non-increasing vs the previous round)
//   search   — base not yet revealed and no capture within 4 rounds
//   consolidate — everything else (revealed but not closing, or no capture)
// Rebel plans:
//   objective-run — reputation marker drops within the next 2 rounds
//   relocate      — the base system changes within the next 2 rounds
//   defend        — base revealed and Imperial ground within 1 hop now
//   develop       — everything else
// Labels are per ROUND (the sample granularity of mine-human-decisions.mjs).
//
// Usage: node scripts/label-plans.mjs [--out reports/plan-labels.json]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(ROOT, 'reports', 'plan-labels.json');
const adj = JSON.parse(readFileSync(join(ROOT, 'assets', 'adjacency.json'), 'utf8')).neighbors;
const bfs = (o) => { const d = new Map([[o, 0]]); const q = [o]; while (q.length) { const c = q.shift(); for (const nb of adj[c] ?? []) if (!d.has(nb)) { d.set(nb, d.get(c) + 1); q.push(nb); } } return d; };
const GROUND = new Set(['stormtrooper', 'at-st', 'at-at']);

const labels = {}; const counts = { Rebel: {}, Empire: {} };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
let games = 0;
for (const f of readdirSync(join(ROOT, 'logs')).filter((x) => x.endsWith('.json'))) {
  let d; try { d = JSON.parse(readFileSync(join(ROOT, 'logs', f), 'utf8')); } catch { continue; }
  if (!('meta' in d)) continue;
  const players = (d.meta || {}).players || {}; const human = Object.keys(players).find((s) => players[s] === 'human');
  const fin = d.final || {}; if (!human || !fin.isGameOver) continue;
  const gid = d.gameId || f; games++;
  const tl = (d.timeline || []).filter((t) => t.snapshot && t.snapshot.map);
  const endT = fin.timeMarker; const capture = fin.winReason === 'base-captured' || fin.winReason === 'base-destroyed';
  const base = fin.rebelBaseSystemId; const dist = base ? bfs(base) : null;
  // per-round facts
  const facts = tl.map((t) => {
    const s = t.snapshot; let hops = 99;
    if (dist) for (const [sid, ss] of Object.entries(s.map.systems)) if ((ss.units || []).some((u) => u.side === 'Empire' && GROUND.has(u.typeId))) hops = Math.min(hops, dist.get(sid) ?? 99);
    return { turn: t.turn, hops, rep: s.reputationMarker, revealed: !!s.rebelBaseRevealed, base: s.rebelBaseSystemId };
  });
  for (let i = 0; i < facts.length; i++) {
    const r = facts[i]; const next = (k) => facts[i + k]; let plan;
    if (human === 'Empire') {
      const toEnd = endT - r.turn;
      if (capture && toEnd <= 1) plan = 'strike';
      else if (capture && toEnd <= 4 && i > 0 && r.hops <= facts[i - 1].hops) plan = 'stage';
      else if (!r.revealed && !(capture && toEnd <= 4)) plan = 'search';
      else plan = 'consolidate';
    } else {
      const repDrop = [1, 2].some((k) => next(k) && next(k).rep < r.rep);
      const moved = [1, 2].some((k) => next(k) && next(k).base && next(k).base !== r.base);
      if (moved) plan = 'relocate';
      else if (r.revealed && r.hops <= 1) plan = 'defend';
      else if (repDrop) plan = 'objective-run';
      else plan = 'develop';
    }
    labels[`${gid}:${r.turn}`] = { side: human, plan };
    bump(counts[human], plan);
  }
}
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), games, labels }));
console.log(`games ${games}, labelled rounds ${Object.keys(labels).length}`);
for (const sd of ['Empire', 'Rebel']) { const t = Object.values(counts[sd]).reduce((a, b) => a + b, 0); console.log(`  ${sd}: ` + Object.entries(counts[sd]).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v} (${(100 * v / t).toFixed(0)}%)`).join(', ')); }
console.log('wrote', OUT);
