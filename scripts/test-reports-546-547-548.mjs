// Three 2026-07-11 reports:
// #546 — Superlaser Online must NOT resolve on a Death Star Under Construction:
//        the card says "contains a Death Star", and the card set names the DSUC
//        explicitly whenever it's included. (A blanket parser auto-include let
//        the Empire fire the superlaser of an unfinished station.)
// #547 — Entrapment's primary is "Cancel the Rebel tactic card. You may play
//        another card." — the extra-card grant was missing (only the cancel ran).
// #548 — Catch Them by Surprise moves units "from adjacent systemS" (card scan)
//        — plural sources; the resolver only accepted ONE source system.
// Run: node scripts/test-reports-546-547-548.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const mt = await import('../src/engine/missionTargets.ts');
const cin = await import('../src/engine/cinematicTactics.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const mk = (t, s, id) => ({ instanceId: id ?? t + Math.random(), typeId: t, side: s, damage: 0 });

console.log('[ #546 — Superlaser Online cannot target a DSUC ]');
{
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissionsEmpire: true } });
  const DSUC_SYS = 'dagobah', DS_SYS = 'sullust';
  G.map.systems[DSUC_SYS].units = [mk('death-star-under-construction', 'Empire')];
  G.map.systems[DS_SYS].units = [mk('death-star', 'Empire')];
  const t = mt.missionTargets(G, 'Empire', 'superlaser-online');
  check('completed Death Star system IS a legal target', t.systemIds.includes(DS_SYS), JSON.stringify(t.systemIds));
  check('DSUC-only system is NOT a legal target', !t.systemIds.includes(DSUC_SYS), JSON.stringify(t.systemIds));
  // The explicit-DSUC card keeps covering it: Imperial Might says "Death Star,
  // DSUC, or Shield Bunker".
  const im = mt.missionTargets(G, 'Empire', 'imperial-might');
  check('Imperial Might (names DSUC explicitly) still targets the DSUC system', im.systemIds.includes(DSUC_SYS), JSON.stringify(im.systemIds));
}

console.log('\n[ #547 — Entrapment primary grants the extra card ]');
{
  const G = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true, cinematicCombat: true } });
  const SYS = 'corellia';
  G.map.systems[SYS].units = [mk('star-destroyer', 'Empire'), mk('x-wing', 'Rebel')];
  const c = { systemId: SYS, round: 1, report: { rounds: [] }, attackerSide: 'Rebel' };
  cin.applyCinematicAbility(G, c, 'Empire', 'space', 'cin-empire-space-entrapment', true);
  const key = 'Rebel:space:1';
  check('cancel is applied to the Rebel play', c.cinematicCancel?.[key] === true, JSON.stringify(c.cinematicCancel));
  check('the Empire is granted an EXTRA tactic play this round', (c.cinematicExtraPlays?.['Empire:space:1'] ?? 0) >= 1, JSON.stringify(c.cinematicExtraPlays));
  // The secondary (deck lock) must NOT grant an extra.
  const G2 = createGame(data, { seed: 8, expansion: { enabled: true, roeUnits: true, cinematicCombat: true } });
  G2.map.systems[SYS].units = [mk('star-destroyer', 'Empire'), mk('x-wing', 'Rebel')];
  const c2 = { systemId: SYS, round: 1, report: { rounds: [] }, attackerSide: 'Rebel' };
  cin.applyCinematicAbility(G2, c2, 'Empire', 'space', 'cin-empire-space-entrapment', false);
  check('secondary (deck lock) grants NO extra play', (c2.cinematicExtraPlays?.['Empire:space:1'] ?? 0) === 0);
}

console.log('\n[ #548 — Catch Them by Surprise pulls from MULTIPLE adjacent systems ]');
{
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  const TARGET = 'mustafar';
  const [A, B] = (G.catalog.adjacency[TARGET] ?? []);
  G.map.systems[TARGET].units = [mk('rebel-trooper', 'Rebel', 'reb1')];
  G.map.systems[A].units = [mk('star-destroyer', 'Empire', 'sdA'), mk('stormtrooper', 'Empire', 'stA')];
  G.map.systems[B].units = [mk('assault-carrier', 'Empire', 'acB'), mk('tie-fighter', 'Empire', 'tfB')];
  G.pendingChoice = {
    kind: 'CatchThemBySurpriseMovePick', side: 'Empire',
    targetSystemId: TARGET, candidateSourceSystemIds: [A, B],
  };
  const r = phases.resolveCatchThemBySurpriseMovePick(G, [
    { fromSystemId: A, unitInstanceIds: ['sdA', 'stA'] },
    { fromSystemId: B, unitInstanceIds: ['acB', 'tfB'] },
  ]);
  check('two-source move resolves ok', r.ok, r.reason);
  const at = (id) => G.map.systems[TARGET].units.some((u) => u.instanceId === id);
  check('units from BOTH sources arrived at the target', at('sdA') && at('stA') && at('acB') && at('tfB'));
  check('surprise combat fired (Rebels present)', !!G.pendingCombat && G.pendingCombat.systemId === TARGET, `pc=${G.pendingCombat?.systemId}`);
  // Illegal shapes still rejected: bad source + duplicate source.
  const G2 = createGame(data, { seed: 9, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  G2.map.systems[A].units = [mk('star-destroyer', 'Empire', 'sdX')];
  G2.pendingChoice = { kind: 'CatchThemBySurpriseMovePick', side: 'Empire', targetSystemId: TARGET, candidateSourceSystemIds: [A] };
  check('non-candidate source rejected', !phases.resolveCatchThemBySurpriseMovePick(G2, [{ fromSystemId: 'coruscant', unitInstanceIds: [] }]).ok);
  check('duplicate source rejected', !phases.resolveCatchThemBySurpriseMovePick(G2, [
    { fromSystemId: A, unitInstanceIds: ['sdX'] }, { fromSystemId: A, unitInstanceIds: [] },
  ]).ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
