// #822 (kw9i9b, playing Rebel): "the system correctly shows 'Behind Enemy Lines
// at Mygeeto won't accomplish anything right now — there's nothing here for its
// effect to act on' ... But neither the message nor the card explains why. And
// given that the system still has the 'Beta' vibes I was assuming the message
// was wrong." The reason was a missing transport: the Rebel base held a
// speeder and four troopers and no ship to carry them.
//
// Pins: the wasted-mission warning now says why, in plain words, for every
// mission the check knows about; on the reporter's board (scripts/fixtures/
// behind-enemy-lines-822.json) Behind Enemy Lines names the missing transport.
// Run: node scripts/test-mission-waste-reason-822.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const { missionRevealIsPointless, missionPointlessReason } = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const raw = readFileSync(join(ROOT, 'scripts/fixtures/behind-enemy-lines-822.json'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ the reporter\'s board ]');
{
  const G = codec.decode(raw, catalog);
  const base = G.map.rebelBaseSpace.units.map((u) => u.typeId);
  check('the base holds ground units and no ships', base.length > 0 && base.every((t) => G.catalog.unitTypes[t]?.theater === 'ground'), base.join(','));
  check('Behind Enemy Lines at Mygeeto is flagged as wasted', missionRevealIsPointless(G, 'Rebel', 'behind-enemy-lines', 'mygeeto'));
  const why = missionPointlessReason(G, 'Rebel', 'behind-enemy-lines', 'mygeeto');
  check('…and the warning says the ground units have no ship to carry them', /no ship there to carry them/.test(why), why);
  const hf = missionPointlessReason(G, 'Rebel', 'hidden-fleet', 'mygeeto');
  check('Hidden Fleet gets the same explanation', /no ship there to carry them/.test(hf), hf);
  G.map.rebelBaseSpace.units = [];
  check('with an empty base, it says there is nothing to move', /no units at the Rebel base/.test(missionPointlessReason(G, 'Rebel', 'behind-enemy-lines', 'mygeeto')));
}

console.log('[ every mission the check knows has its own reason ]');
{
  const src = readFileSync(join(ROOT, 'src/engine/missionTargets.ts'), 'utf8');
  const body = (name) => { const i = src.indexOf(`export function ${name}`); return src.slice(i, src.indexOf('\n}\n', i)); };
  const cases = (name) => [...body(name).matchAll(/case '([a-z-]+)'/g)].map((m) => m[1]);
  const missing = cases('missionRevealIsPointless').filter((m) => !cases('missionPointlessReason').includes(m));
  check('no mission falls back to the generic wording', missing.length === 0, missing.join(', '));
  const play = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
  check('the play screen\'s warning includes the reason', /won't accomplish anything right now: `\s*\+ `\$\{missionPointlessReason\(G, side, revealMissionId, target\)\}/.test(play));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
