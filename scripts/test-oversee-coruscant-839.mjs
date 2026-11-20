// #839 (mrvvfh, playing Rebel): "the empire knows I have the heart of the
// empire card ... but still, the empire deployed its strongest weapon, the
// super star destroyer at bothawui via a mission! it could have saved the day
// by playing this mission as close to coruscant as possible". Replayed from
// the reporter's own board (scripts/fixtures/oversee-coruscant-839.json).
//
// Oversee Project ("Choose 1 Imperial unit on space 1 or 2 of the build queue
// and deploy it in this system") had no target score, so every legal system
// tied. With Rebel units holding Coruscant and Heart of the Empire already
// scored, SWR_CORUSCANT_DEPLOY aims it as close to Coruscant as the card allows.
//
// Pins: on the reporter's board the AI's Oversee Project now targets a system
// two jumps from Coruscant, not Bothawui (four); every legal target tied with
// the lever off (control: the test is not vacuous); no bonus once the Empire
// holds Coruscant again.
// Run: node scripts/test-oversee-coruscant-839.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const raw = readFileSync(join(ROOT, 'scripts/fixtures/oversee-coruscant-839.json'), 'utf8');

/** The capture follows the deploy: put the Super Star Destroyer back on space 2
 *  of the queue and Tarkin (who resolved it, still at Bothawui) back on the
 *  Oversee Project card. */
function board() {
  const G = codec.decode(raw, setup.buildCatalog(data));
  const b = G.map.systems['bothawui'];
  b.units = b.units.filter((u) => u.typeId !== 'super-star-destroyer');
  G.empire.buildQueue[2].push('super-star-destroyer');
  delete G.empire.leadersOnBoard['bothawui'];
  G.empire.leadersOnMissions.push({ missionId: 'oversee-project', leaderIds: ['grand-moff-tarkin'] });
  if (!G.empire.missionHand.includes('oversee-project')) G.empire.missionHand.push('oversee-project');
  G.empire.missionDiscard = G.empire.missionDiscard.filter((m) => m !== 'oversee-project');
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  return G;
}
const pick = (G) => AI.bestCommandAction(G, 'Empire').find((a) => a.kind === 'reveal' && a.missionId === 'oversee-project');
const scores = (G) => Object.fromEntries(['cato-neimoidia', 'mandalore', 'sullust', 'saleucami', 'bothawui']
  .map((s) => [s, AI.empireMissionTargetScore(G, 'oversee-project', s)]));

if (process.env.OVERSEE_839_CONTROL === '1') {
  console.log(JSON.stringify(scores(board())));
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const NEAR = new Set(['cato-neimoidia', 'mandalore', 'sullust']);

console.log('[ the reporter\'s board ]');
{
  const G = board();
  check('rewound: Rebels hold Coruscant, Heart of the Empire already scored',
    G.map.systems['coruscant'].units.some((u) => u.side === 'Rebel')
    && G.rebel.scoredObjectives.some((o) => o.objectiveId === 'heart-of-the-empire-2'));
  const s = scores(G);
  check('a two-jump target outscores Bothawui (four jumps)', s['cato-neimoidia'] > s['bothawui'] + 20, JSON.stringify(s));
  check('two jumps beats three (Saleucami)', s['mandalore'] > s['saleucami'], JSON.stringify(s));
  const a = pick(G);
  check('the AI offers Oversee Project', !!a, 'no oversee-project candidate');
  check('…aimed two jumps from Coruscant', a && NEAR.has(a.targetSystemId), a && a.targetSystemId);
}

console.log('[ inert once the Empire is back on Coruscant ]');
{
  const G = board();
  G.map.systems['coruscant'].units.push({ instanceId: 'x839', typeId: 'stormtrooper', side: 'Empire', damage: 0 });
  const s = scores(G);
  check('no Coruscant bonus anywhere', s['cato-neimoidia'] === s['bothawui'], JSON.stringify(s));
}

console.log('[ control: SWR_CORUSCANT_DEPLOY=0 reproduces the tie ]');
{
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, SWR_CORUSCANT_DEPLOY: '0', OVERSEE_839_CONTROL: '1' }, encoding: 'utf8',
  });
  let s = null;
  try { s = JSON.parse((r.stdout ?? '').trim().split('\n').pop()); } catch { /* reported below */ }
  check('with the lever off, Bothawui ties the near targets', s && s['bothawui'] === s['cato-neimoidia'],
    JSON.stringify(s) + (r.stderr ?? '').slice(0, 300));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('all passed');
