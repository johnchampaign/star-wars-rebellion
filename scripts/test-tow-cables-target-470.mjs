// #470 — the Rebel AI played Tow Cables (deal 4 to an AT-AT OR AT-ST) and hit the
// weaker AT-ST. Tow Cables' 4 damage kills BOTH (AT-AT health 3, AT-ST health 2),
// but the AI only picked the least-remaining unit. Among targets the burst can
// actually kill, it should now remove the biggest threat (the AT-AT: 3 attack
// dice vs the AT-ST's 2). Falls back to "most-damaged" only when none die.
// Run: node scripts/test-tow-cables-target-470.mjs
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

// Runs the AI's CinematicTargetPick against the given Empire ground units + burst
// amount; returns which unit it targeted (took damage / was destroyed).
function aiTargets(units, amount) {
  ai.seedAI(1);
  const G = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true, cinematicCombat: true } });
  const SYS = 'felucia';
  G.map.systems[SYS].units = [
    ...units.map((u) => ({ instanceId: u.id, typeId: u.typeId, side: 'Empire', damage: u.damage ?? 0 })),
    { instanceId: 'rebel', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 },
  ];
  G.pendingCombat = { systemId: SYS };
  G.pendingChoice = { kind: 'CinematicTargetPick', side: 'Rebel', theater: 'ground', systemId: SYS, amount, candidates: units.map((u) => u.id) };
  try { ai.stepOnce(G, 'Rebel'); } catch { /* resolver applies the deal */ }
  const hit = units.find((u) => {
    const cur = G.map.systems[SYS].units.find((x) => x.instanceId === u.id);
    return !cur || cur.damage > (u.damage ?? 0);
  });
  return hit?.id;
}

console.log('[ #470 — Tow Cables removes the biggest killable threat ]');
// Both killable by 4 → hit the AT-AT (bigger threat), not the AT-ST.
check('AT-AT + AT-ST, 4 dmg → targets the AT-AT', aiTargets([{ id: 'atat', typeId: 'at-at' }, { id: 'atst', typeId: 'at-st' }], 4) === 'atat');
// If the burst can only kill the AT-ST (amount 2 < AT-AT's 3 health), take the kill.
check('4-dmg unavailable (amount 2) → kills the AT-ST (the reachable kill)', aiTargets([{ id: 'atat', typeId: 'at-at' }, { id: 'atst', typeId: 'at-st' }], 2) === 'atst');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
