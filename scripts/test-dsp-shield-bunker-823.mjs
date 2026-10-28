// #823 (eu46ho, playing Empire): "Rebel AI planned the assault on the Death
// Star but it was in a system with a shield bunker." A Shield Bunker makes the
// Death Star in its system immune (Death Star Plans included), but the AI's
// "lone Death Star + plans in hand" bonus (+30 on Plan the Assault, +18 on an
// activation) never checked for one, so it sent a corvette and two X-wings to
// Nal Hutta and lost them for nothing.
//
// Pins: on the reporter's board (scripts/fixtures/plan-the-assault-bunker-823
// .json, the strike force put back in the base) the bonus no longer applies at
// Nal Hutta; remove the bunker and it does again (control).
// Run: node scripts/test-dsp-shield-bunker-823.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const raw = readFileSync(join(ROOT, 'scripts/fixtures/plan-the-assault-bunker-823.json'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** The Assignment-phase board: the corvette and two X-wings that died at Nal
 *  Hutta are back in the Rebel base space. */
function board(mutate) {
  const G = codec.decode(raw, catalog);
  let n = 0;
  for (const typeId of ['corellian-corvette', 'x-wing', 'x-wing'])
    G.map.rebelBaseSpace.units.push({ instanceId: `t823-${n++}`, typeId, side: 'Rebel', damage: 0 });
  mutate?.(G);
  return G;
}
const score = (G) => ai.rebelMissionTargetScore(G, 'plan-the-assault', 'nal-hutta', null);
const noBunker = (G) => { const ss = G.map.systems['nal-hutta']; ss.units = ss.units.filter((u) => u.typeId !== 'shield-bunker'); };

console.log('[ the reporter\'s board ]');
{
  const G = board();
  const nh = G.map.systems['nal-hutta'].units.map((u) => u.typeId);
  check('Nal Hutta holds a lone Death Star over a Shield Bunker', nh.includes('death-star') && nh.includes('shield-bunker')
    && nh.filter((t) => G.catalog.unitTypes[t]?.theater === 'space').length === 1, nh.join(','));
  check('the Rebel holds Death Star Plans', G.rebel.objectiveHand.some((o) => o.startsWith('death-star-plans')));
  check('the AI sees the Death Star as shielded', ai.deathStarShielded(G, 'nal-hutta'));
}

console.log('[ the Death Star bonus skips a shielded Death Star ]');
{
  const withBunker = score(board()), without = score(board(noBunker));
  check('control: without the bunker, Plan the Assault at Nal Hutta gets the +30', without - withBunker >= 30, `${without} vs ${withBunker}`);
  check('with the bunker, the strike is scored as unwinnable', withBunker <= -30, String(withBunker));
  check('control: without the expansion rules there is no bunker protection', !ai.deathStarShielded(board((G) => { G.expansion.enabled = false; }), 'nal-hutta'));
}

console.log('[ the activation bonus has the same guard ]');
{
  const src = readFileSync(join(ROOT, 'src/play/randomAI.ts'), 'utf8');
  const uses = [...src.matchAll(/!deathStarShielded\(G, (\w+)\)/g)].map((m) => m[1]);
  check('both Death Star opportunism bonuses check for a bunker', uses.includes('targetSysId') && uses.includes('sysId'), uses.join(','));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
