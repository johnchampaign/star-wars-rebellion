// #468 — the Empire AI ran Construct Factory on an arbitrary Imperial system,
// ignoring one with a sabotage marker. Construct Factory "removes the marker
// before resolving" — so a sabotaged Imperial target is doubly valuable (build +
// clear the sabotage choking that system). The AI now strongly prefers a
// sabotaged Imperial system.
// Run: node scripts/test-construct-factory-sabotage-468.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ #468 — Construct Factory prefers a sabotaged Imperial system ]');
{
  ai.seedAI(1);
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  const leader = G.empire.leaderPool[0];
  if (G.catalog.leaders[leader]) G.catalog.leaders[leader].skills = { ...(G.catalog.leaders[leader].skills ?? {}), logistics: 3 };
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== leader);
  G.empire.leadersOnMissions = [{ missionId: 'construct-factory', leaderIds: [leader] }];
  G.empire.missionHand = G.empire.missionHand.filter((m) => m !== 'construct-factory');

  const imp = Object.keys(G.map.systems).filter((s) => G.map.systems[s].loyalty === 'imperial' || G.map.systems[s].subjugated);
  check('two+ Imperial systems available', imp.length >= 2, `n=${imp.length}`);
  const [A, B] = imp;
  // Equalize resources so the SABOTAGE marker (not resource count) is the
  // deciding factor. Give the CLEAN system (B) at least as many resources.
  const richer = (G.catalog.systems[B].resources?.length ?? 0) >= (G.catalog.systems[A].resources?.length ?? 0) ? B : A;
  const other = richer === A ? B : A;
  G.map.systems[other].sabotage = true;   // sabotage the (equal-or-poorer) system
  G.map.systems[richer].sabotage = false;

  const acts = ai.bestCommandAction(G, 'Empire');
  const cf = acts.find((a) => a.kind === 'reveal' && a.missionId === 'construct-factory');
  check('Construct Factory reveal is generated', !!cf, 'no reveal');
  check('targets the SABOTAGED system (even the equal/poorer one)', cf?.targetSystemId === other, `target=${cf?.targetSystemId} sabotaged=${other} richerClean=${richer}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
