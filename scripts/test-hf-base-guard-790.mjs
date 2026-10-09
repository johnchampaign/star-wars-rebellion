// @timeout 120000
// #790 (a0pzgi, playing Empire): "Near the end of the game, the AI used Hidden
// Fleet to move away from the base when staying to defend would have been more
// effective." Hidden Fleet moves units out of the HIDDEN Rebel Base space —
// every ship plus the ground units they can carry — and its target scorer never
// looked at the base, so a threatened base could be emptied in one card.
//
// SWR_HF_BASE_GUARD (the #760 base-strip guard, applied to Hidden Fleet): while
// the hidden base is threatened (Imperial ground nearby outnumbers the base's
// own, min 2), Hidden Fleet targets take -45, and if it is played anyway the
// picker leaves the ground and half the ships (min 1) home. Pins the mechanism
// with a child process running the same boards with the guard OFF.
// Run: node scripts/test-hf-base-guard-790.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = process.env.HF_CHILD === '1';
process.env.SWR_HF_BASE_GUARD = CHILD ? '0' : '1';
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let k = 0; const unit = (t, side) => ({ instanceId: `hf${k++}`, typeId: t, side, damage: 0 });

/** Hidden base with 2 troopers, a corvette, a transport and an X-wing; `imperialNext`
 *  stormtroopers on a neighbour of the base. Returns a far, empty target too. */
function board(imperialNext) {
  const G = createGame(data, { seed: 790, autoSetupUnits: true });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.map.rebelBaseSpace.units = [];
  G.rebelBaseRevealed = false; G.empireSearchedRuledOut = [];
  G.phase = 'Command'; G.currentPlayer = 'Rebel'; G.passedThisCommand = [];
  const base = G.rebelBaseSystemId;
  for (const t of ['rebel-trooper', 'rebel-trooper', 'corellian-corvette', 'rebel-transport', 'x-wing']) G.map.rebelBaseSpace.units.push(unit(t, 'Rebel'));
  const nb = (G.catalog.adjacency[base] ?? []).find((s) => !G.catalog.systems[s]?.isRemote) ?? G.catalog.adjacency[base][0];
  for (let i = 0; i < imperialNext; i++) G.map.systems[nb].units.push(unit('stormtrooper', 'Empire'));
  const near = new Set([base, nb, ...(G.catalog.adjacency[base] ?? []), ...(G.catalog.adjacency[nb] ?? [])]);
  const target = Object.keys(G.map.systems).find((s) => !near.has(s) && !G.catalog.systems[s]?.isRemote && !G.catalog.systems[s]?.isCoruscant && G.map.systems[s].loyalty !== 'imperial');
  return { G, base, target };
}
function run() {
  const out = {};
  const t = board(4);
  out.threatened = AI.rebelBaseThreatened(t.G);
  out.scoreThreat = AI.rebelMissionTargetScore(t.G, 'hidden-fleet', t.target, null);
  const q = board(0);
  out.quiet = AI.rebelBaseThreatened(q.G);
  out.scoreQuiet = AI.rebelMissionTargetScore(q.G, 'hidden-fleet', q.target, null);
  // The picker: post the choice the engine would, and let the AI answer it.
  const p = board(4);
  p.G.pendingChoice = { kind: 'HiddenFleetUnitPick', side: 'Rebel', targetSystemId: p.target,
    candidateUnitIds: p.G.map.rebelBaseSpace.units.map((u) => u.instanceId) };
  try { AI.stepOnce(p.G, 'Rebel'); } catch { /* the resume tail needs a mission; the move already happened */ }
  const left = p.G.map.rebelBaseSpace.units.map((u) => u.typeId).sort();
  out.left = left;
  return out;
}
if (CHILD) { console.log(JSON.stringify(run())); process.exit(0); }

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const on = run();
const off = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, HF_CHILD: '1' }, encoding: 'utf8' }).trim().split('\n').pop());

console.log('[ premise ]');
check('4 stormtroopers next to a 2-trooper hidden base reads as threatened', on.threatened === true);
check('with no Imperials nearby it does not', on.quiet === false);
console.log('[ target scoring ]');
check('guard ON: Hidden Fleet out of a threatened base scores 45 lower', on.scoreThreat === off.scoreThreat - 45, `on=${on.scoreThreat} off=${off.scoreThreat}`);
check('a quiet base is unaffected', on.scoreQuiet === off.scoreQuiet, `on=${on.scoreQuiet} off=${off.scoreQuiet}`);
console.log('[ unit picker ]');
check('control (guard OFF): the whole base leaves', off.left.length === 0, JSON.stringify(off.left));
check('guard ON: both troopers stay home', on.left.filter((t) => t === 'rebel-trooper').length === 2, JSON.stringify(on.left));
check('guard ON: at least one ship stays home', on.left.some((t) => t !== 'rebel-trooper'), JSON.stringify(on.left));
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
