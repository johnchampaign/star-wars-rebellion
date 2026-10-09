// @timeout 60000
// #800 (o10k30, playing Rebel): "The 'Rebel Cell' marker and other markers are
// showing above/under the system's name tag, and its yellow-ish color blends
// with the name tag's background ... there's no notification to alert the
// Empire player that there's marker placed on the system between turns."
//
// Pins: placing a target marker sends a notice to the side it works AGAINST
// (not when that side placed it itself); single-player notices now respect
// their addressee like online ones; and the map draws markers on the planet
// with a ring, the system panel in high contrast.
// Run: node scripts/test-target-marker-visibility-800.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const game = () => { const G = createGame(data, { seed: 800, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } }); G.pendingNotices = []; return G; };
const notices = (G) => (G.pendingNotices ?? []).map((n) => ({ title: n.title, side: n.side, details: n.details }));

console.log('[ the side a marker works against is told ]');
{
  const G = game();
  M.placeTargetMarker(G, 'kashyyyk', 'rebel-cell-2', 'Rebel');
  const n = notices(G);
  check('a Rebel Cell placed by the Rebels alerts the Empire', n.length === 1 && n[0].side === 'Empire', JSON.stringify(n));
  check('  …naming the card and the system', /Rebel Cell/.test(n[0]?.title ?? '') && /Kashyyyk/.test(n[0]?.title ?? ''), n[0]?.title);
  M.placeTargetMarker(G, 'kashyyyk', 'rebel-cell-2', 'Rebel');
  check('placing the same marker again does not alert twice', notices(G).length === 1);
}
{
  const G = game();
  M.placeTargetMarker(G, 'mygeeto', 'raid-outposts-2', 'Empire');
  check('Raid Outposts markers the Empire places itself raise no notice for the Empire', notices(G).length === 0, JSON.stringify(notices(G)));
}
{
  const G = game();
  M.placeTargetMarker(G, 'corellia', 'secure-the-plans', 'Empire');
  const n = notices(G);
  check('an Empire Secure the Plans marker alerts the Rebels', n.length === 1 && n[0].side === 'Rebel', JSON.stringify(n));
}

console.log('[ the page ]');
{
  const src = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
  check('single-player notices only show when addressed to the human (or to nobody)', /const visible = all\.filter\(\(n\) => !n\.side \|\| n\.side === humanSide\);/.test(src));
  check('map markers sit on the planet, not under the loyalty hex', /const py = s\.boardPos\.y \* BOARD_SCALE;/.test(src) && !/const ty = my \+ markerH \/ 2 \+ tH \* 0\.4;/.test(src));
  check('map markers get a pulsing ring', /<animate attributeName="stroke-opacity"/.test(src));
  check('they move up out of the way of leader pips', /leadersHere > 0 \? py - 14 - tH \/ 2 - 4 : py/.test(src));
  check('the system panel badge is high contrast', /background: '#b3261e', border: '2px solid #ff8a1f'/.test(src));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
