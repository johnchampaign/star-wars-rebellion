// Expert-vs-AI hunt profile over the v2 log corpus (see memory: expert-hunt-spec).
//
// Splits every v2 log by who hunted (humanSide=Empire → expert; =Rebel → AI
// Empire) and measures, from per-turn snapshots + events:
//   - find rate + find turns
//   - candidate-narrowing trajectory (avg candidates left per turn)
//   - share of Empire activations targeting live candidates
//   - candidate clears by OCCUPATION vs by probe rule-out
//
// Key finding this script exists to track (2026-07-11, 12 expert vs 5 AI
// games): the AI targets candidates MORE (91% vs 64%) but clears HALF as fast
// — expert clears by occupying (force stays: rules out + subjugates + rolls
// the frontier), AI does force-less taps + probe-spam. The future hunt fix is
// occupy-to-clear, and this script measures whether the gap is closing as the
// corpus grows.
//
// Run: node scripts/analyze-hunt-profile.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGameLog, snapshotToCodec } from './lib/log-reader.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const cat = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;

const agg = {
  human: { games: 0, cand: {}, actsOnCand: 0, acts: 0, found: 0, findTurns: [], probeClears: 0, visitClears: 0 },
  ai:    { games: 0, cand: {}, actsOnCand: 0, acts: 0, found: 0, findTurns: [], probeClears: 0, visitClears: 0 },
};

for (const f of readdirSync(join(ROOT, 'logs')).filter((x) => x.endsWith('.json'))) {
  let L; try { L = readGameLog(join(ROOT, 'logs', f)); } catch { continue; }
  if (L.schemaVersion !== 2) continue;
  const who = L.humanSide === 'Empire' ? 'human' : L.humanSide === 'Rebel' ? 'ai' : null;
  if (!who) continue;
  const A = agg[who]; A.games++;

  const candByTurn = {};
  let prevCand = null;
  for (const s of L.snapshots.filter((x) => x.at === 'turn-start' || x.at === 'setup-complete').sort((a, b) => a.turn - b.turn)) {
    const G = codec.decode(snapshotToCodec(s.state), cat);
    const ruled = new Set((G.empire.probeHand || []).map((pid) => cat.probes[pid]?.systemId).filter(Boolean));
    const occ = new Set(); const cand = new Set();
    for (const sid of Object.keys(G.map.systems)) {
      if (G.map.systems[sid].units.some((u) => u.side === 'Empire')) occ.add(sid);
      if (sid === 'coruscant' || ruled.has(sid) || occ.has(sid)) continue;
      cand.add(sid);
    }
    candByTurn[G.timeMarker] = cand;
    (A.cand[G.timeMarker] ??= []).push(cand.size);
    if (prevCand) {
      for (const c of prevCand) {
        if (cand.has(c)) continue;
        if (occ.has(c)) A.visitClears++; else A.probeClears++;
      }
    }
    prevCand = cand;
  }
  for (const e of L.events) {
    if (e.kind !== 'activate-system' || e.side !== 'Empire') continue;
    A.acts++;
    const c = candByTurn[e.turn];
    if (c && c.has(e.payload.targetSystemId)) A.actsOnCand++;
  }
  const rev = L.events.find((e) => e.kind === 'reveal-base');
  if (rev) { A.found++; A.findTurns.push(rev.turn); }
}

for (const who of ['human', 'ai']) {
  const A = agg[who];
  const candLine = Object.keys(A.cand).sort((a, b) => a - b)
    .map((t) => 't' + t + ':' + (A.cand[t].reduce((x, y) => x + y, 0) / A.cand[t].length).toFixed(0)).join(' ');
  console.log(`=== ${who === 'human' ? 'EXPERT (human Empire)' : 'AI EMPIRE'} — ${A.games} games ===`);
  console.log('  found base:', `${A.found}/${A.games}`, ' find turns:', A.findTurns.sort((a, b) => a - b).join(','));
  console.log('  avg candidates by turn:', candLine);
  console.log('  activations onto CANDIDATES:', `${A.actsOnCand}/${A.acts} (${(100 * A.actsOnCand / Math.max(1, A.acts)).toFixed(0)}%)`);
  console.log('  candidate clears — by occupation:', A.visitClears, ' by probe rule-out:', A.probeClears);
}
