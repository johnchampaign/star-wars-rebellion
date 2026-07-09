// #439/#445/#453 — the Rebel AI mobilized almost every turn / turn 1 / just to
// stack ships on a safe hidden base. Root cause: the "threatened" flag fired on
// ANY Empire ground unit within 2 hops, so Rapid Mobilization got +20 nearly
// every game. Now: escape only when the base is REVEALED (imminent capture) or a
// real force is MASSING near a hidden base; a safe hidden base deprioritizes RM
// so the slot goes to economy. Self-play: Rebel win rate rose sharply (the RM
// over-play was self-harm), confirming the fix.
// Run: node scripts/test-rapid-mobilization-discipline-439-445-453.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Returns whether the Rebel AI assigns a leader to Rapid Mobilization, in a
// state controlled to be `mode`: 'safe' (no Empire near a hidden base),
// 'massing' (2 Empire ground at the hidden base), or 'revealed'.
function rmAssigned(mode) {
  ai.seedAI(1);
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeMissions: true } });
  if (!G.rebel.missionHand.includes('rapid-mobilization')) G.rebel.missionHand.push('rapid-mobilization');
  const base = G.rebelBaseSystemId;
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.side !== 'Empire');
  G.rebelBaseRevealed = mode === 'revealed';
  if (mode === 'massing') {
    G.map.systems[base].units.push({ instanceId: 'e1', typeId: 'stormtrooper', side: 'Empire', damage: 0 });
    G.map.systems[base].units.push({ instanceId: 'e2', typeId: 'stormtrooper', side: 'Empire', damage: 0 });
  }
  let guard = 0;
  while (G.phase === 'Assignment' && G.currentPlayer === 'Rebel' && guard++ < 40) { if (!ai.stepOnce(G, 'Rebel')) break; }
  return (G.rebel.leadersOnMissions ?? []).some((a) => a.missionId === 'rapid-mobilization');
}

console.log('[ #439/#445/#453 — Rapid Mobilization discipline ]');
check('SAFE hidden base → RM NOT assigned (no more constant mobilizing)', rmAssigned('safe') === false);
check('MASSING force at a hidden base → RM assigned (reasonable relocation)', rmAssigned('massing') === true);
check('REVEALED base → RM assigned (escape imminent capture)', rmAssigned('revealed') === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
