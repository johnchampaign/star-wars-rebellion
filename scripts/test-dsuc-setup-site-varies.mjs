// jocke01: "Every single game I have played the empire deploys the death star
// under construction on dagobah with 4 ties and the single stormtrooper."
//
// The composition he describes is correct — RoE rules p.8 puts the DSUC plus 4
// TIE Fighters and 1 Stormtrooper on one chosen remote system. The site was the
// bug. RAW says the Empire CHOOSES a remote; setupAutoFill fell back to
// `.find(isRemote)`, the first remote in map order, which is Dagobah. A real
// game builds its state with autoSetupUnits:false, so empireDeployTarget is
// always unset by the time the AI's side is auto-filled — meaning the fallback
// ran every single time. Measured before the fix: 200/200 seeds on Dagobah.
//
// That is not a cosmetic complaint. A fixed Death Star site lets the Rebel
// settle on the far side of the map every game knowing exactly where the threat
// will come from, which is precisely the exploit he described using.
//
// Run: node scripts/test-dsuc-setup-site-varies.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const EXP = { enabled: true, roeUnits: true, roeMissions: true };
const N = 120;

/** The path a REAL game takes: interactive setup, with the AI's side auto-filled.
 *  Using autoSetupUnits:true here would test a different function entirely and
 *  would have shown healthy variety even while every real game went to Dagobah. */
function realSetup(seed) {
  const G = createGame(data, { seed, autoSetupUnits: false, expansion: EXP });
  phases.setupAutoFill(G, 'Empire');
  return G;
}
const dsucSystem = (G) => Object.entries(G.map.systems)
  .find(([, ss]) => ss.units.some((u) => u.side === 'Empire'
    && u.typeId === 'death-star-under-construction'))?.[0];

const sites = [];
for (let s = 1; s <= N; s++) sites.push(dsucSystem(realSetup(s)));

console.log('\n[ RAW: the site is a remote system with the prescribed garrison ]');
{
  const G = realSetup(1);
  const site = dsucSystem(G);
  check('a DSUC was placed', !!site, String(site));
  check('the site is a REMOTE system', !!G.catalog.systems[site]?.isRemote, String(site));
  const tally = {};
  for (const u of G.map.systems[site].units.filter((u) => u.side === 'Empire')) {
    tally[u.typeId] = (tally[u.typeId] ?? 0) + 1;
  }
  check('garrison is exactly DSUC + 4 TIE Fighters + 1 Stormtrooper (RoE p.8)',
    tally['death-star-under-construction'] === 1 && tally['tie-fighter'] === 4
    && tally['stormtrooper'] === 1 && Object.keys(tally).length === 3,
    JSON.stringify(tally));
  check('every seed places it on a remote', sites.every((sid) =>
    sid && data.systems.systems.find((x) => x.id === sid)?.isRemote));
}

console.log('\n[ the bug: the site must not be the same system every game ]');
{
  const counts = new Map();
  for (const s of sites) counts.set(s, (counts.get(s) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  check('more than one site is ever used', counts.size > 1,
    `only ${JSON.stringify([...counts])}`);
  check('at least 4 distinct sites across seeds', counts.size >= 4,
    `saw ${counts.size}: ${[...counts.keys()].join(',')}`);
  // 8 remotes, so ~12.5% each. A wide band — this guards against the
  // deterministic failure (100%), not against RNG drift.
  check('no single site dominates', top[1] <= N * 0.4,
    `${top[0]} used ${top[1]}/${N} (${(100 * top[1] / N).toFixed(1)}%)`);
  check('Dagobah specifically is no longer automatic',
    (counts.get('dagobah') ?? 0) <= N * 0.4,
    `dagobah ${counts.get('dagobah') ?? 0}/${N}`);
}

console.log('\n[ still deterministic per seed, so games stay reproducible ]');
{
  const a = dsucSystem(realSetup(42));
  const b = dsucSystem(realSetup(42));
  check('the same seed picks the same site', a === b, `${a} vs ${b}`);
}

console.log('\n[ an explicitly chosen site is still honoured ]');
{
  // A human Imperial player who already placed the DSUC sets empireDeployTarget;
  // auto-fill must not overrule that.
  const G = createGame(data, { seed: 7, autoSetupUnits: false, expansion: EXP });
  const chosen = Object.keys(G.map.systems).find(
    (id) => G.catalog.systems[id]?.isRemote && id !== 'dagobah');
  G.empireDeployTarget = chosen;
  phases.setupAutoFill(G, 'Empire');
  check('the pre-chosen remote is used', dsucSystem(G) === chosen,
    `wanted ${chosen}, got ${dsucSystem(G)}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
