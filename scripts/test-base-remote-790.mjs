// @timeout 180000
// #790 (a0pzgi, playing Empire): "Initial base was on Utapau, which is an
// early target for the Empire."
//
// Archive, AI-Rebel games against human Empires, base found by round 4:
// remote systems 16% (n=79) vs 1-icon worlds 45%, 2-icon 62%, square-icon 69%
// (n=200), all ~2 jumps from the Empire's start. Rich worlds get found because
// the Empire goes there anyway. SWR_BASE_REMOTE weights remote systems 3x among
// the distance-eligible opening bases. Weighted, not exclusive: an always-
// remote base would let a human Empire probe the eight remotes first (#718).
//
// Pins, over 200 setups, lever ON vs a lever-OFF child: remote share rises
// clearly but stays below 80%; the base is never 1 jump from the Empire; the
// mean distance is not worse; no single system dominates.
// Run: node scripts/test-base-remote-790.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = process.env.BR_CHILD === '1';
if (!process.env.SWR_BASE_REMOTE) process.env.SWR_BASE_REMOTE = CHILD ? '0' : '1';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
function sample() {
  let n = 0, remote = 0, dsum = 0, d1 = 0; const counts = {};
  for (let seed = 1; seed <= 200; seed++) {
    const G = createGame(data, { seed, autoSetupUnits: false });
    const cands = G.pendingRebelBasePick; if (!cands?.length) continue;
    AI.seedAI?.(seed);
    const b = AI.chooseRebelBaseSystem(G, cands);
    const imp = Object.keys(G.map.systems).filter((s) => G.map.systems[s].loyalty === 'imperial' || G.map.systems[s].units.some((u) => u.side === 'Empire'));
    const dist = new Map(imp.map((s) => [s, 0])); let fr = imp;
    for (let d = 1; d <= 8; d++) { const nx = []; for (const s of fr) for (const a of G.catalog.adjacency[s] ?? []) if (!dist.has(a)) { dist.set(a, d); nx.push(a); } fr = nx; }
    n++; if (G.catalog.systems[b]?.isRemote) remote++;
    const d = dist.get(b) ?? 9; dsum += d; if (d <= 1) d1++;
    counts[b] = (counts[b] ?? 0) + 1;
  }
  return { n, remote: remote / n, meanDist: dsum / n, d1, topShare: Math.max(...Object.values(counts)) / n };
}
if (CHILD) { console.log(JSON.stringify(sample())); process.exit(0); }

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const on = sample();
const off = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, BR_CHILD: '1', SWR_BASE_REMOTE: '0' }, encoding: 'utf8' }).trim().split('\n').pop());
console.log(`  (off: remote ${(100 * off.remote).toFixed(0)}%, dist ${off.meanDist.toFixed(2)} | on: remote ${(100 * on.remote).toFixed(0)}%, dist ${on.meanDist.toFixed(2)}, top system ${(100 * on.topShare).toFixed(0)}%)`);
check('the lever moves the opening base toward remote systems', on.remote >= off.remote + 0.12, `off ${off.remote} on ${on.remote}`);
check('…but not to always-remote (an Empire could probe those first)', on.remote < 0.8, `on ${on.remote}`);
check('never one jump from the Empire\'s start', on.d1 === 0, `d1=${on.d1}`);
check('no further from safety on average', on.meanDist >= off.meanDist - 0.05, `off ${off.meanDist} on ${on.meanDist}`);
check('no single system dominates (#718: Ryloth was 53%)', on.topShare < 0.25, `top ${on.topShare}`);
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
