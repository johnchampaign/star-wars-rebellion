// #497 — the cinematic card "Deployment" reads "Gain 1 triangle ground unit."
// The Rebel has TWO triangle ground unit types (Trooper and Vanguard), so the
// player should choose which to deploy. The engine was hardcoding a Rebel
// Trooper. Now playing Deployment's primary raises a type-pick (a generic Choice)
// when 2+ triangle ground types exist, and deploys the chosen one.
// Run: node scripts/test-cinematic-deployment-497.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const cin = await import('../src/engine/cinematicTactics.ts');
const choices = await import('../src/engine/choices.ts');
const { stepOnce, seedAI } = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const opts = (seed) => ({ seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true } });

console.log('[ helpers: Deployment is a choose-triangle gain; Reinforcements is a fixed gain ]');
{
  const G = createGame(data, opts(1));
  check('gainTriangleAbilityFor(Deployment, top) is non-null', !!cin.gainTriangleAbilityFor('cin-rebel-space-deployment', true));
  check('gainTriangleAbilityFor(Reinforcements, top) is null (fixed unit)', cin.gainTriangleAbilityFor('cin-empire-space-reinforcements', true) === null);
  const types = cin.cinematicTriangleGroundGainTypes(G, 'Rebel').sort();
  check('Rebel triangle ground types = trooper + vanguard', types.join(',') === 'rebel-trooper,rebel-vanguard', types.join(','));
}

console.log('[ playing Deployment raises a type pick and honours the choice (Vanguard) ]');
{
  seedAI(11);
  const G = createGame(data, opts(11));
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'u-wing', 'felucia'); // Deployment prereq (primaryUnit)
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  // Drive until a Rebel space CinematicTacticSelect appears (both sides get one).
  let guard = 0, reached = false;
  while (G.pendingCombat && !G.isGameOver && guard++ < 60) {
    const pc = G.pendingChoice;
    if (pc?.kind === 'CinematicTacticSelect' && pc.side === 'Rebel' && pc.theater === 'space') { reached = true; break; }
    if (stepOnce(G, G.currentPlayer)) continue;
    const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
    if (!stepOnce(G, o)) break;
  }
  check('reached the Rebel space cinematic tactic select', reached, `pc=${G.pendingChoice?.kind}`);
  if (reached) {
    const before = G.map.systems['felucia'].units.filter((u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground').length;
    check('no Rebel ground unit before Deployment', before === 0);
    const r = combat.resolveCinematicTacticSelect(G, 'cin-rebel-space-deployment', true); // top = gain
    check('playing Deployment raises a cinematic-gain Choice', r.ok && G.pendingChoice?.kind === 'Choice' && G.pendingChoice.tag === 'cinematic-gain', `pc=${G.pendingChoice?.kind}/${G.pendingChoice?.tag}`);
    check('both trooper and vanguard offered', (G.pendingChoice?.candidates ?? []).map((c) => c.id).sort().join(',') === 'rebel-trooper,rebel-vanguard');
    // Choose the VANGUARD (not the old hardcoded trooper).
    const r2 = choices.resolveGenericChoice(G, ['rebel-vanguard']);
    check('choosing resolves ok', r2.ok, r2.reason);
    const vanguards = G.map.systems['felucia'].units.filter((u) => u.side === 'Rebel' && u.typeId === 'rebel-vanguard').length;
    const troopers = G.map.systems['felucia'].units.filter((u) => u.side === 'Rebel' && u.typeId === 'rebel-trooper').length;
    check('a Rebel VANGUARD was deployed (the chosen type)', vanguards === 1, `vanguards=${vanguards}`);
    check('NO trooper was deployed (not the hardcoded default)', troopers === 0, `troopers=${troopers}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
