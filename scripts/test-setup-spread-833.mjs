// Regression #833 — "AI as empire always deploys their star destroyers close
// to Coruscant".
//
// THE BUG: setupAutoFill() dealt the Empire's remaining setup units round-robin
// over the Imperial systems in MAP order, which is alphabetical. The pending
// list leads with the three Star Destroyers, so they always landed on the first
// three Imperial worlds A–Z: one on Coruscant in every game, mean 1.23 jumps
// from it across 345 archived AI-Empire setups (humans: 2.37, 12.7% on
// Coruscant). SWR_SETUP_SPREAD (default ON) draws the round-robin order
// weighted 1 + jumps-from-Coruscant. The child run with the lever off pins the
// old behaviour so this test cannot pass vacuously.
//
// Run: node scripts/test-setup-spread-833.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

/** Star Destroyer placement stats over `seeds` auto-filled Empire setups. */
function measure(rote, seeds) {
  const expansion = rote ? { enabled: true } : undefined;
  let sds = 0, onCor = 0, dist = 0, first3 = 0, games = 0, distinctSets = new Set();
  for (let seed = 1; seed <= seeds; seed++) {
    const G = createGame(data, { seed, autoSetupUnits: false, expansion });
    if (G.currentPlayer !== 'Empire') phases.setupAutoFill(G, G.currentPlayer);
    const r = phases.setupAutoFill(G, 'Empire');
    if (!r.ok) throw new Error(`seed ${seed}: auto-fill failed (${r.reason})`);
    const d = { coruscant: 0 }; let f = ['coruscant'];
    for (let k = 1; f.length; k++) {
      const n = [];
      for (const s of f) for (const a of G.catalog.adjacency[s] ?? []) if (d[a] === undefined) { d[a] = k; n.push(a); }
      f = n;
    }
    const imp = Object.entries(G.map.systems).filter(([, ss]) => ss.loyalty === 'imperial' || ss.subjugated).map(([id]) => id);
    const at = [];
    for (const [id, ss] of Object.entries(G.map.systems)) {
      for (const u of ss.units) {
        if (u.typeId !== 'star-destroyer' || u.side !== 'Empire') continue;
        sds++; dist += d[id]; if (id === 'coruscant') onCor++;
        const i = imp.indexOf(id); if (i >= 0 && i < 3) first3++;
        at.push(id);
      }
    }
    distinctSets.add(at.sort().join(','));
    games++;
  }
  return { sds, games, meanDist: dist / sds, onCor: onCor / sds, first3: first3 / sds, distinct: distinctSets.size };
}

if (process.argv[2] === '--child') {
  console.log(JSON.stringify(measure(process.argv[3] === 'rote', 60)));
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};
const child = (mode, spread) => JSON.parse(execFileSync(process.execPath, [__filename, '--child', mode], {
  env: { ...process.env, SWR_SETUP_SPREAD: spread }, encoding: 'utf8',
}).trim().split('\n').pop());

for (const mode of ['rote', 'base']) {
  console.log(`\n[ #833 ${mode}: Star Destroyers spread away from Coruscant ]`);
  const off = child(mode, '0');
  const on = child(mode, '1');
  const fmt = (m) => `mean ${m.meanDist.toFixed(2)} jumps, ${(100 * m.onCor).toFixed(1)}% on Coruscant, ${(100 * m.first3).toFixed(0)}% on first-3 A–Z`;
  console.log(`    off: ${fmt(off)}`);
  console.log(`    on:  ${fmt(on)}`);
  check('control: lever off reproduces the alphabetical bias', off.first3 === 1, fmt(off));
  check('control: lever off clusters near Coruscant', off.meanDist < 1.6, fmt(off));
  check('three Star Destroyers still placed every game', on.sds === 3 * on.games, `${on.sds}/${on.games}`);
  check('lever on: no longer always the first three worlds A–Z', on.first3 < 0.75, fmt(on));
  check('lever on: mean distance in the human range (>= 2.0 jumps)', on.meanDist >= 2.0, fmt(on));
  check('lever on: Coruscant no longer gets one every game', on.onCor < 0.2, fmt(on));
  check('lever on: placements vary across games', on.distinct > off.distinct, `${on.distinct} vs ${off.distinct} distinct`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
