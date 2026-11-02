// #763 (rokhm1, playing Rebel): "the imps did not even get a single sd since the
// very beginning! ... the imps have not payed attention to expanding their fleet
// with the big ships." Measured (archive + self-play, 2026-10-29): against the
// same AI Rebel, human Empires hold the three Star Destroyer worlds (Corellia,
// Mon Calamari, Utapau) Imperial-LOYAL in 32% of rounds, the AI in 21%; humans
// gain loyalty there 0.43 times a game, the AI 0.14. Only loyalty builds a Star
// Destroyer there: a subjugated world builds from its left-most icon, and the
// space square is on the right on all three. The AI assigns loyalty missions as
// often as the humans — it aimed them elsewhere, because the target score
// counted icons flat (Mon Calamari tied any two-icon world) and Display of Power
// had no target score at all.
//
// Replayed on the reporter's own board, round 3 (scripts/fixtures/loyalty-yield-
// 763.json, from his uploaded log): the Empire holds Display of Power, Utapau is
// Rebel-loyal, and the old scorer aimed it at Alderaan. SWR_LOYALTY_YIELD prices
// the target by what Imperial loyalty there would build.
// Run: node scripts/test-loyalty-yield-763.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const ai = await import('../src/play/randomAI.ts');
const { missionTargets } = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const raw = readFileSync(join(ROOT, 'scripts/fixtures/loyalty-yield-763.json'), 'utf8');
const board = () => codec.decode(raw, catalog);
const best = (G, m) => {
  let b = null, bs = -Infinity;
  for (const t of missionTargets(G, 'Empire', m).systemIds) { const s = ai.empireMissionTargetScore(G, m, t); if (s > bs) { bs = s; b = t; } }
  return b;
};
const score = (G, m, t) => ai.empireMissionTargetScore(G, m, t);

if (process.argv[2] === '--off') { console.log(`RESULT ${best(board(), 'display-of-power')}`); process.exit(0); }

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ the reporter\'s board, round 3 ]');
{
  const G = board();
  check('the Empire holds Display of Power', G.empire.missionHand.includes('display-of-power'), G.empire.missionHand.join(','));
  check('Utapau (space circle + space SQUARE) is Rebel-loyal', G.map.systems.utapau.loyalty === 'rebel');
  check('Display of Power is aimed at Utapau (two gains: Rebel -> Imperial)', best(G, 'display-of-power') === 'utapau', best(G, 'display-of-power'));
  const off = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--off'], { env: { ...process.env, SWR_LOYALTY_YIELD: '0' }, encoding: 'utf8' });
  const o = (off.stdout.match(/RESULT (\S+)/) ?? [])[1];
  check('control: with SWR_LOYALTY_YIELD=0 it goes to Alderaan (the old pick)', o === 'alderaan', off.stdout + off.stderr.slice(-300));
}

console.log('[ a Star Destroyer world outranks an equal-icon world ]');
{
  const G = board();
  G.map.systems.corellia.loyalty = 'neutral'; G.map.systems.corellia.subjugated = false;
  // Any other neutral, populous, two-icon world with no space square.
  const other = Object.keys(G.map.systems).find((sid) => {
    const d = G.catalog.systems[sid]; const ss = G.map.systems[sid];
    return d?.buildSlot && !d.isCoruscant && (d.resources ?? []).length === 2 && ss.loyalty === 'neutral' && !ss.subjugated
      && !(d.resources ?? []).some((r) => r.type === 'space' && r.shape === 'square');
  });
  check('a comparison world exists', !!other);
  check(`Trade Negotiations: neutral Corellia scores above neutral ${other}`, score(G, 'trade-negotiations', 'corellia') > score(G, 'trade-negotiations', other),
    `${score(G, 'trade-negotiations', 'corellia')} vs ${score(G, 'trade-negotiations', other)}`);
  G.map.systems.mygeeto.loyalty = 'imperial'; G.map.systems.mygeeto.subjugated = false;
  check('an Imperial-loyal world is still worthless for a loyalty gain', score(G, 'trade-negotiations', 'mygeeto') < 0, String(score(G, 'trade-negotiations', 'mygeeto')));
}

console.log('[ a subjugated world is priced by what conversion unlocks ]');
{
  const G = board();
  for (const sid of ['corellia', 'sullust']) { G.map.systems[sid].loyalty = 'neutral'; G.map.systems[sid].subjugated = true; }
  const cor = score(G, 'trade-negotiations', 'corellia');
  check('subjugated Corellia (locked Star Destroyer square) beats subjugated Sullust (locked AT-AT square)', cor > score(G, 'trade-negotiations', 'sullust'),
    `${cor} vs ${score(G, 'trade-negotiations', 'sullust')}`);
  // Use up every Star Destroyer in supply: the locked square would build nothing.
  const cap = G.catalog.unitTypes['star-destroyer'].supplyCount;
  let have = 0; for (const ss of Object.values(G.map.systems)) have += ss.units.filter((u) => u.typeId === 'star-destroyer').length;
  for (let k = have; k < cap; k++) G.empire.buildQueue[1].push('star-destroyer');
  check('with no Star Destroyer left in supply the conversion bonus collapses', score(G, 'trade-negotiations', 'corellia') < cor - 10,
    `${score(G, 'trade-negotiations', 'corellia')} vs ${cor}`);
}

console.log('[ a single gain on a Rebel-loyal world unlocks nothing ]');
{
  const G = board();
  check('Trade Negotiations on Rebel-loyal Utapau earns no Star Destroyer bonus', score(G, 'trade-negotiations', 'utapau') < score(G, 'display-of-power', 'utapau') - 20,
    `${score(G, 'trade-negotiations', 'utapau')} vs ${score(G, 'display-of-power', 'utapau')}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
