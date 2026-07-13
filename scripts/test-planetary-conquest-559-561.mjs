// #559 — Planetary Conquest says "move UP TO 1 AT-AT, 1 AT-ST and 2
// Stormtroopers" but the game forced ALL eligible units from the chosen source.
// The resolver now accepts a unit SUBSET (the player may bring fewer, or none);
// omitting it moves all (AI / back-compat).
// #561 — the AI had no target score for Planetary Conquest, so it took the first
// legal system alphabetically and just reinforced Alderaan. It now aims the strike
// where the force matters: a Rebel-occupied system over an idle Imperial reinforce.
// Run: node scripts/test-planetary-conquest-559-561.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const mk = (t, s, id) => ({ instanceId: id ?? t + Math.random(), typeId: t, side: s, damage: 0 });

console.log('[ #559 — "up to X units": the resolver moves a chosen SUBSET ]');
{
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  const TARGET = 'coruscant', SRC = 'corellia';
  G.map.systems[SRC].units = [mk('at-at', 'Empire', 'atat'), mk('at-st', 'Empire', 'atst'), mk('stormtrooper', 'Empire', 'st1'), mk('stormtrooper', 'Empire', 'st2')];
  G.map.systems[TARGET].units = [mk('rebel-trooper', 'Rebel', 'reb')];
  const sources = [{ sourceSystemId: SRC, picks: ['atat', 'atst', 'st1', 'st2'] }];
  const setup = () => { G.pendingChoice = { kind: 'PlanetaryConquestSourcePick', side: 'Empire', targetSystemId: TARGET, sources }; };
  const at = (id) => G.map.systems[TARGET].units.some((u) => u.instanceId === id);

  setup();
  // Bring only the AT-AT (a strict subset — the whole point of "up to").
  const r = phases.resolvePlanetaryConquestSourcePick(G, SRC, ['atat']);
  check('subset move resolves ok', r.ok, r.reason);
  check('only the chosen unit (AT-AT) moved', at('atat') && !at('atst') && !at('st1') && !at('st2'));
  check('the un-chosen units stayed at the source', G.map.systems[SRC].units.some((u) => u.instanceId === 'atst'));
}
{
  const G = createGame(data, { seed: 8, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  const TARGET = 'coruscant', SRC = 'corellia';
  G.map.systems[SRC].units = [mk('at-at', 'Empire', 'a'), mk('stormtrooper', 'Empire', 'b')];
  G.map.systems[TARGET].units = [mk('rebel-trooper', 'Rebel', 'reb')];
  G.pendingChoice = { kind: 'PlanetaryConquestSourcePick', side: 'Empire', targetSystemId: TARGET, sources: [{ sourceSystemId: SRC, picks: ['a', 'b'] }] };
  // Omitting the subset (AI path) still moves ALL eligible.
  const r = phases.resolvePlanetaryConquestSourcePick(G, SRC);
  check('omitted subset (AI) moves all eligible', r.ok && G.map.systems[TARGET].units.some((u) => u.instanceId === 'a') && G.map.systems[TARGET].units.some((u) => u.instanceId === 'b'));
  // A unit NOT in the source's eligible set is rejected.
  const G2 = createGame(data, { seed: 9, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  G2.map.systems[SRC].units = [mk('at-at', 'Empire', 'a')];
  G2.pendingChoice = { kind: 'PlanetaryConquestSourcePick', side: 'Empire', targetSystemId: TARGET, sources: [{ sourceSystemId: SRC, picks: ['a'] }] };
  check('an ineligible unit id is rejected', !phases.resolvePlanetaryConquestSourcePick(G2, SRC, ['a', 'ghost']).ok);
}

console.log('\n[ #561 — AI aims Planetary Conquest at Rebels, not an idle Imperial reinforce ]');
{
  ai.seedAI(1);
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissionsEmpire: true } });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  // Alderaan = plain Imperial (a reinforce target, alphabetically first). Bothawui = Rebel ground.
  G.map.systems.alderaan.loyalty = 'imperial'; G.map.systems.alderaan.units = [mk('stormtrooper', 'Empire')];
  G.map.systems.bothawui.units = [mk('rebel-trooper', 'Rebel'), mk('rebel-trooper', 'Rebel')];
  const leader = G.empire.leaderPool[0];
  if (G.catalog.leaders[leader]) G.catalog.leaders[leader].skills = { ...(G.catalog.leaders[leader].skills ?? {}), specOps: 3 };
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== leader);
  G.empire.leadersOnMissions = [{ missionId: 'planetary-conquest', leaderIds: [leader] }];
  G.empire.missionHand = G.empire.missionHand.filter((m) => m !== 'planetary-conquest');
  const acts = ai.bestCommandAction(G, 'Empire');
  const pc = acts.find((a) => a.kind === 'reveal' && a.missionId === 'planetary-conquest');
  check('Planetary Conquest reveal is generated', !!pc, 'no reveal');
  check('targets the Rebel-occupied system, not Alderaan', pc && pc.targetSystemId !== 'alderaan', `target=${pc?.targetSystemId}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
