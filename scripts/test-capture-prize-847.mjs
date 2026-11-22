// "it should have captured mon mothma instead of jan dodonna" — player report #847.
//
// Capture Rebel Operative was played at Mygeeto (Jan Dodonna) while Mon Mothma
// stood at Ord Mantell, also beside Imperial units. Neither has a spec-ops
// icon, so the attempt had the same odds at both; the target scorer had no
// term for WHO would be captured, so the two tied and the tie-break chose.
// leaderValue would not have helped either: it counts tactic values in full,
// which makes Mon Mothma (3 diplomacy, no tactics) the least valuable Rebel.
//
// Run: node scripts/test-capture-prize-847.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const MID = 'capture-rebel-operative';
function board(leadersOnBoard) {
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  G.rebel.leadersOnBoard = leadersOnBoard;
  return G;
}
const score = (mod, G, sys) => mod.empireMissionTargetScore(G, MID, sys);

console.log('\n[ the reported board: Dodonna at Mygeeto, Mon Mothma at Ord Mantell ]');
{
  const G = board({ mygeeto: ['jan-dodonna'], 'ord-mantell': ['mon-mothma'] });
  const dod = score(ai, G, 'mygeeto'), mon = score(ai, G, 'ord-mantell');
  console.log(`    Mygeeto (Dodonna) ${dod.toFixed(2)}   Ord Mantell (Mon Mothma) ${mon.toFixed(2)}`);
  check('Mon Mothma is the better capture', mon > dod, `${mon} vs ${dod}`);
}

console.log('\n[ it orders equal-odds targets; it does not buy worse odds ]');
{
  // Leia (prize 8, 1 spec ops) opposes with a die; Dodonna (5.5, 0) does not.
  const G = board({ mygeeto: ['jan-dodonna'], 'ord-mantell': ['princess-leia'] });
  const dod = score(ai, G, 'mygeeto'), leia = score(ai, G, 'ord-mantell');
  check('an opposing spec-ops icon still outweighs the bigger prize', dod > leia, `${dod} vs ${leia}`);
  // No leader at all: the term must not fire.
  const G2 = board({});
  check('a system with no Rebel leader gets no prize term',
    score(ai, G2, 'mygeeto') === score(ai, G2, 'ord-mantell'));
}

console.log('\n[ the lever restores the old tie ]');
{
  process.env.SWR_CAPTURE_PRIZE = '0';
  const mod = await import(`../src/play/randomAI.ts?nocache=${Date.now()}`);
  delete process.env.SWR_CAPTURE_PRIZE;
  const G = board({ mygeeto: ['jan-dodonna'], 'ord-mantell': ['mon-mothma'] });
  check('with SWR_CAPTURE_PRIZE=0 the two targets tie again',
    score(mod, G, 'mygeeto') === score(mod, G, 'ord-mantell'),
    `${score(mod, G, 'mygeeto')} vs ${score(mod, G, 'ord-mantell')}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
