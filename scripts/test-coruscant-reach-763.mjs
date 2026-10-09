// @timeout 120000
// #763 (rokhm1, playing Rebel): "last round, I captured Coruscant, but instead
// of moving in, the imperials just moved their only fleet in the area from
// kashyyyk to malastare". Kashyyyk is TWO jumps from Coruscant; the existing
// drain guard only stopped units leaving Coruscant itself.
//
// SWR_CORUSCANT_REACH: while Rebel units are on or next to Coruscant, an
// Imperial stack within two jumps of the capital is not used as the source of a
// move that takes it further away. Moving toward the capital is untouched. A
// child process runs the same boards with the lever OFF as the control.
// (The lever also adds a staging bonus for activating a neighbour of the
// capital; that is a scoring nudge measured by the self-play screen.)
// Run: node scripts/test-coruscant-reach-763.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = process.env.CR_CHILD === '1';
process.env.SWR_CORUSCANT_REACH = CHILD ? '0' : '1';
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let k = 0; const unit = (t, side) => ({ instanceId: `cr${k++}`, typeId: t, side, damage: 0 });

/** Rebels on Alderaan (next to Coruscant); an Imperial Star Destroyer group at
 *  Kashyyyk (two jumps out, next to both Alderaan and Malastare). */
function board({ rebelsNear = true } = {}) {
  const G = createGame(data, { seed: 763, autoSetupUnits: true });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.empire.leadersOnBoard = {}; G.rebel.leadersOnBoard = {};
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  for (const t of ['star-destroyer', 'stormtrooper', 'stormtrooper', 'tie-fighter']) G.map.systems.kashyyyk.units.push(unit(t, 'Empire'));
  if (rebelsNear) for (const t of ['rebel-transport', 'rebel-trooper', 'rebel-trooper']) G.map.systems.alderaan.units.push(unit(t, 'Rebel'));
  return G;
}
const draws = (G, target) => AI.__testPlannedMoveOrders(G, 'Empire', target).map((o) => o.fromSystemId);
function run() {
  return {
    awayThreat: draws(board(), 'malastare'),
    towardThreat: draws(board(), 'alderaan'),
    awayQuiet: draws(board({ rebelsNear: false }), 'malastare'),
  };
}
if (CHILD) { console.log(JSON.stringify(run())); process.exit(0); }

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const G0 = board();
console.log('[ premise: the reporter\'s geography ]');
check('Kashyyyk is next to Alderaan and Malastare, not Coruscant', G0.catalog.adjacency.kashyyyk.includes('alderaan') && G0.catalog.adjacency.kashyyyk.includes('malastare') && !G0.catalog.adjacency.coruscant.includes('kashyyyk'));
check('Alderaan is next to Coruscant; Malastare is not', G0.catalog.adjacency.coruscant.includes('alderaan') && !G0.catalog.adjacency.coruscant.includes('malastare'));
const on = run();
const off = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, CR_CHILD: '1' }, encoding: 'utf8' }).trim().split('\n').pop());
console.log('[ capital threatened ]');
check('control (lever OFF): a move to Malastare pulls the Kashyyyk fleet away', off.awayThreat.includes('kashyyyk'), JSON.stringify(off.awayThreat));
check('lever ON: the Kashyyyk fleet keeps its reach', !on.awayThreat.includes('kashyyyk'), JSON.stringify(on.awayThreat));
check('lever ON: moving TOWARD the capital (Alderaan) still uses it', on.towardThreat.includes('kashyyyk'), JSON.stringify(on.towardThreat));
console.log('[ capital quiet ]');
check('with no Rebels near Coruscant the fleet moves freely', on.awayQuiet.includes('kashyyyk'), JSON.stringify(on.awayQuiet));
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
