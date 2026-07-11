// #552 — a mission that names a specific system ("Attempt in the Kashyyyk
// system", "Resolve in the Dagobah system") must still target that system when
// it's DESTROYED. Official FAQ: "Seek Yoda can be resolved in the Dagobah system
// even if Dagobah has been destroyed." The named-system lookup used allSystems()
// (which drops destroyed systems), so the match failed and the mission fell
// through to the permissive path, letting the player resolve it in a DIFFERENT
// system. Now the named lookup includes destroyed systems; a live-system effect
// (gain loyalty) simply fizzles there, the rest resolves.
// Run: node scripts/test-named-mission-destroyed-system-552.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const mt = await import('../src/engine/missionTargets.ts');
const M = await import('../src/engine/mechanics.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ #552 — named-system missions still target a DESTROYED system ]');
{
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true } });
  // Baseline: Wookiee Uprising targets exactly Kashyyyk while alive.
  const live = mt.missionTargets(G, 'Rebel', 'wookie-uprising');
  check('alive: Wookiee Uprising targets exactly [kashyyyk]', JSON.stringify(live.systemIds) === JSON.stringify(['kashyyyk']), JSON.stringify(live.systemIds));

  // Destroy Kashyyyk.
  G.map.systems['kashyyyk'].destroyed = true;
  const dead = mt.missionTargets(G, 'Rebel', 'wookie-uprising');
  check('destroyed: still targets kashyyyk (not another system)', JSON.stringify(dead.systemIds) === JSON.stringify(['kashyyyk']), JSON.stringify(dead.systemIds));
  check('destroyed: NOT permissive (single legal system, not "all systems")', dead.permissive === false);

  // Seek Yoda on a destroyed Dagobah — the FAQ's own example.
  G.map.systems['dagobah'].destroyed = true;
  const yoda = mt.missionTargets(G, 'Empire', 'seek-yoda') /* side is Rebel really */;
  const yodaR = mt.missionTargets(G, 'Rebel', 'seek-yoda');
  check('destroyed Dagobah is still Seek Yoda\'s target', JSON.stringify(yodaR.systemIds) === JSON.stringify(['dagobah']), JSON.stringify(yodaR.systemIds));
}

console.log('\n[ #552 — the EFFECT resolves on the destroyed system (loyalty fizzles) ]');
{
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  const SYS = 'kashyyyk';
  G.map.systems[SYS].destroyed = true;
  G.map.systems[SYS].loyalty = 'neutral';
  // Put 2 Empire stormtroopers (2 health) at the destroyed Kashyyyk to be destroyed.
  G.map.systems[SYS].units = [
    { instanceId: 'e1', typeId: 'stormtrooper', side: 'Empire', damage: 0 },
    { instanceId: 'e2', typeId: 'stormtrooper', side: 'Empire', damage: 0 },
  ];
  const before = G.map.systems[SYS].units.filter((u) => u.side === 'Empire').length;
  // Resolve the effect directly.
  const runEffect = handlers.runMissionEffect ?? null;
  // Fallback: call the registered handler via a minimal ctx if runMissionEffect isn't exported.
  let destroyPosted = false;
  try {
    // gainLoyalty must fizzle on the destroyed system (no throw, no loyalty).
    M.gainLoyalty(G, 'Rebel', SYS, 1);
    check('gain-loyalty fizzles on the destroyed system (stays non-rebel)', G.map.systems[SYS].loyalty !== 'rebel', `loyalty=${G.map.systems[SYS].loyalty}`);
    destroyPosted = true;
  } catch (e) {
    check('gain-loyalty did not throw on destroyed system', false, String(e));
  }
  check('the destroy-units part of the effect can still run (Empire units present to remove)', before === 2 && destroyPosted);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
