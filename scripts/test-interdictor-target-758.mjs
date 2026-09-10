// @timeout 60000
// #758 — "the Empire AI used Construct Interdictor on Mygeeto but the card says
// it must target a planet with a blue square build icon". The reporter was
// right, and it was never an AI bug: assets/missions.json carried the WRONG
// rules text for Interdictor Development —
//   "Resolve in a system that contains an Imperial unit, no Rebel units, and no
//    sabotage marker."
// The printed card (images/Interdictor Deployment_p.png) reads "Resolve in any
// Imperial system that has a blue [square] resource icon", exactly like
// Construct Super Star Destroyer. missionTargets.ts derives legal targets by
// PARSING that text, so the engine offered Mygeeto to either player; the AI
// merely took a target the engine said was legal. Fixed in the card data.
//
// Blue = a SPACE-type resource icon of SQUARE shape: only Corellia, Mon
// Calamari and Utapau have one. Mygeeto has a square GROUND icon, which is why
// it looked plausible and is the perfect negative control.
// Run: node scripts/test-interdictor-target-758.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts');
const MT = await import('../src/engine/missionTargets.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const MISSION = 'interdictor-development';

console.log('[ the card data matches the printed card ]');
{
  const card = data.missions.missions.find((c) => c.id === MISSION);
  check('Interdictor Development requires a blue square resource icon', /blue square resource icon/i.test(card.rulesText), card.rulesText);
  check('and an Imperial system', /any imperial system/i.test(card.rulesText));
  check('the old (wrong) "contains an Imperial unit / no sabotage marker" text is gone', !/contains an imperial unit/i.test(card.rulesText));
  check('the 2-leader clause survives (its handler keys on leader COUNT, not text)', /2 leaders/i.test(card.rulesText));
}

console.log('[ blue = square SPACE icon: three systems on the board ]');
{
  const blue = data.systems.systems.filter((s) => (s.resources ?? []).some((r) => r.type === 'space' && r.shape === 'square')).map((s) => s.id);
  check('exactly Corellia, Mon Calamari, Utapau', blue.sort().join(',') === 'corellia,mon-calamari,utapau', blue.join(','));
  const my = data.systems.systems.find((s) => s.id === 'mygeeto');
  check('Mygeeto has a square GROUND icon but no square SPACE icon (the trap)',
    my.resources.some((r) => r.type === 'ground' && r.shape === 'square') && !my.resources.some((r) => r.type === 'space' && r.shape === 'square'),
    JSON.stringify(my.resources));
}

console.log('[ on the reporter\'s board shape: Mygeeto is not a legal target ]');
{
  // seed 7 puts BOTH Mygeeto and Corellia under Imperial loyalty — the exact
  // situation in the report.
  const G = setup.createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  check('setup: Mygeeto is an Imperial system', G.map.systems['mygeeto'].loyalty === 'imperial');
  check('setup: Corellia is an Imperial system', G.map.systems['corellia'].loyalty === 'imperial');
  const t = MT.missionTargets(G, 'Empire', MISSION);
  check('Mygeeto is NOT offered', !t.systemIds.includes('mygeeto'), t.systemIds.join(','));
  check('Corellia IS offered', t.systemIds.includes('corellia'), t.systemIds.join(','));
  // NON-VACUOUS: the board really does treat Mygeeto as a normal Imperial
  // system — an "any Imperial system" project still targets it. So the
  // exclusion above is the blue-square clause doing the work, not the seed.
  const factory = MT.missionTargets(G, 'Empire', 'construct-factory');
  check('control: "any Imperial system" (Construct Factory) DOES offer Mygeeto', factory.systemIds.includes('mygeeto'));
  // And it now matches its sibling card exactly.
  const ssd = MT.missionTargets(G, 'Empire', 'construct-super-star-destroyer');
  check('target set is identical to Construct Super Star Destroyer', t.systemIds.slice().sort().join(',') === ssd.systemIds.slice().sort().join(','),
    `interdictor=${t.systemIds.join(',')} ssd=${ssd.systemIds.join(',')}`);
}

console.log('[ and the reveal itself is refused ]');
{
  const G = setup.createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  if (!G.empire.missionHand.includes(MISSION)) G.empire.missionHand.push(MISSION);
  G.empire.leadersOnMissions.push({ missionId: MISSION, leaderIds: ['grand-moff-tarkin'] });
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== 'grand-moff-tarkin');
  G.phase = 'Command'; G.currentPlayer = 'Empire';
  const r = phases.revealMission(G, 'Empire', MISSION, 'mygeeto');
  check('revealMission at Mygeeto is rejected as an illegal target', !r.ok && String(r.reason ?? '').startsWith('illegal-target'), JSON.stringify(r));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
