// @timeout 120000
// SWR_ASSAULT_SIZING — mechanism test. (1) When the Empire activates the
// REVEALED base, carrier capacity goes to ground first (fighters rode first
// before, so one stormtrooper arrived with a fleet of TIEs). (2) The assault
// bonus is gated on DELIVERED ground strength vs the Rebel ground at the base,
// not on ground merely present nearby. The legacy child is the control.
// Measured 2026-09-05 on the 43-reveal rig: flat — the assaults were fleet
// strikes with whatever ground fit, and the ground simply wasn't within reach;
// see docs/ab-levers.md. Default OFF.
// Run: node scripts/test-assault-sizing.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = process.env.AS_CHILD === '1';
if (!CHILD) process.env.SWR_ASSAULT_SIZING = '1';
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** Revealed base with 3 Rebel troopers; one adjacent Empire system holding a
 *  Star Destroyer (capacity 4?) + 4 TIEs + 4 stormtroopers, with a leader in pool. */
function board() {
  const G = createGame(data, { seed: 21, autoSetupUnits: true });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.map.rebelBaseSpace.units = [];
  G.rebelBaseRevealed = true;
  const base = G.rebelBaseSystemId;
  const from = (G.catalog.adjacency[base] ?? []).find((s) => !G.catalog.systems[s]?.isRemote) ?? G.catalog.adjacency[base][0];
  let k = 0; const mk = (typeId, side) => ({ instanceId: `u${k++}`, typeId, side, damage: 0 });
  for (let i = 0; i < 3; i++) G.map.systems[base].units.push(mk('rebel-trooper', 'Rebel'));
  G.map.systems[from].units.push(mk('star-destroyer', 'Empire'));
  for (let i = 0; i < 4; i++) G.map.systems[from].units.push(mk('tie-fighter', 'Empire'));
  for (let i = 0; i < 4; i++) G.map.systems[from].units.push(mk('stormtrooper', 'Empire'));
  G.phase = 'Command'; G.currentPlayer = 'Empire';
  return { G, base, from };
}
const activateBase = (G, base) => { AI.seedAI(1); return AI.bestCommandAction(G, 'Empire').find((a) => a.kind === 'activate' && (a.targetSystemId ?? a.systemId) === base); };
// Execute the activation the way the AI would and count the stormtroopers that arrive.
const exec = AI.tryCommandAction ?? AI.executeCommandAction ?? AI.applyCommandAction;
const groundDelivered = (G, act) => { const ok = exec(G, 'Empire', act); if (!ok) return -1; return (G.map.systems[G.rebelBaseSystemId]?.units ?? []).filter((u) => u.side === 'Empire' && u.typeId === 'stormtrooper').length; };

if (CHILD) {
  const { G, base } = board(); const a = activateBase(G, base);
  console.log(JSON.stringify({ ground: a ? groundDelivered(G, a) : null, score: a?.score ?? null, keys: a ? Object.keys(a) : [] }));
  process.exit(0);
}
const legacy = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, AS_CHILD: '1', SWR_ASSAULT_SIZING: '0' }, encoding: 'utf8' }).trim().split('\n').pop());
console.log('[ ground loads first when the target is the revealed base ]');
{
  const { G, base } = board();
  const cap = G.catalog.unitTypes['star-destroyer'].transport.capacity;
  const a = activateBase(G, base);
  check('the base is an activation candidate', !!a, JSON.stringify(AI.bestCommandAction(G, 'Empire').slice(0, 3)));
  const g = a ? groundDelivered(G, a) : 0;
  check(`with the lever: the move carries ${Math.min(4, cap)} stormtroopers (carrier capacity ${cap}) — got ${g}`, g === Math.min(4, cap), `legacy child ${JSON.stringify(legacy)}`);
  check(`legacy loaded fighters first and carried ${legacy.ground} stormtrooper(s)`, legacy.ground != null && legacy.ground < g, JSON.stringify(legacy));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
