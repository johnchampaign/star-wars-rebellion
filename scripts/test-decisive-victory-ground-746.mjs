// #746 — "I received the reputation for the objective saying I won a space and
// a ground battle, but there was no ground battle as the imperials had no
// troops there."
//
// RR p.4 gates each battle step on BOTH factions having units in that theater
// ("Players only resolve this step if both factions have ships in the system").
// So no Imperial ground units = no ground battle = Decisive Victory must not
// score. The old `foughtIn` inferred a battle from ANY unit destroyed in the
// theater, which a cinematic tactic card can do during the SPACE step — hence
// the phantom ground battle. The engine now records which battle steps actually
// ran (CombatReport.theatersFought) and the objective reads that.
//
// Also pins the legacy fallback: reports saved before the field existed still
// use the old destroyed-unit heuristic rather than silently scoring nothing.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();
const { createGame } = await import('../src/engine/setup.ts');
const Obj = await import('../src/engine/objectives.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let fail = 0;
const check = (n, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : `  — ${extra}`)); if (!ok) fail++; };
const newG = () => {
  const G = createGame(data, { seed: 7, expansion: { enabled: true } });
  G.rebel.objectiveHand = ['decisive-victory-1'];
  return G;
};

const atk = (theater, dmg, destroyed = []) => ({ theater, damageApplied: dmg, destroyed, side: 'Rebel' });
const report = (over) => ({
  attackerSide: 'Rebel', winner: 'Rebel', systemId: 'tatooine',
  rounds: [{ attacks: [] }], retreatDestructions: [], ...over,
});
const fires = (G, r) => Obj.combatObjectivesTriggered(G, r).includes('decisive-victory-1');

console.log('[ #746: theatersFought is authoritative ]');
{
  // The reported board: a space battle at Utapau, no Imperial ground units, and
  // a stray ground kill from a cinematic tactic card played in the space step.
  const G = newG();
  const rebelGround = Object.values(G.catalog.unitTypes).find((u) => u.side === 'Rebel' && u.theater === 'ground');
  const phantom = report({
    theatersFought: ['space'],
    rounds: [{ attacks: [atk('space', 3, [{ typeId: rebelGround.id, instanceId: 'x1' }])] }],
  });
  check('space battle only, ground unit killed by a card → NOT fired', !fires(G, phantom));
  // Proof this test isn't vacuous: the SAME report minus the new field takes the
  // legacy path and reproduces the bug the player hit. If someone deletes
  // theatersFought, the assertion above starts failing rather than passing for
  // the wrong reason.
  const { theatersFought: _dropped, ...legacyPhantom } = phantom;
  check('...and the same report on the legacy path DOES misfire (old bug)', fires(G, legacyPhantom));
}
{
  const G = newG();
  const both = report({
    theatersFought: ['space', 'ground'],
    rounds: [{ attacks: [atk('space', 2), atk('ground', 1)] }],
  });
  check('both battle steps ran → fired', fires(G, both));
}
{
  // A theater genuinely won with tactic cards and no dice damage (#383) still
  // scores, because the battle step itself is what's recorded.
  const G = newG();
  const cardsOnly = report({
    theatersFought: ['space', 'ground'],
    rounds: [{ attacks: [atk('space', 0), atk('ground', 0)] }],
  });
  check('both steps ran, zero dice damage (cinematic win) → fired', fires(G, cardsOnly));
}
{
  const G = newG();
  const groundOnly = report({ theatersFought: ['ground'], rounds: [{ attacks: [atk('ground', 2)] }] });
  check('ground battle only → NOT fired', !fires(G, groundOnly));
}

console.log('[ #746: legacy reports (no theatersFought) keep the old heuristic ]');
{
  const G = newG();
  const legacyBoth = report({ rounds: [{ attacks: [atk('space', 2), atk('ground', 1)] }] });
  check('legacy space + ground damage → fired', fires(G, legacyBoth));
  const legacySpace = report({ rounds: [{ attacks: [atk('space', 2)] }] });
  check('legacy space only → NOT fired', !fires(G, legacySpace));
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
