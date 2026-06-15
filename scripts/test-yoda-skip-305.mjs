// #305 — skipping the Yoda/Luke combat reroll actually skips it (it used to
// re-queue the same prompt forever because the "used this round" flag was only
// set when a die was actually rerolled).
// Run: node scripts/test-yoda-skip-305.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const opts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, roeUnits: true }, // standard combat (simpler to drive)
});

// Try several seeds until one produces a YodaReroll prompt (needs a blank die).
let sawPrompt = false, skipped = false, noReQueue = false;
for (let s = 600; s < 640 && !sawPrompt; s++) {
  const G = createGame(data, opts(s));
  G.map.systems['felucia'].units = [];
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  // Luke with the Master Yoda ring, on the board at the combat system.
  M.placeLeader(G, 'Rebel', 'luke-skywalker', 'felucia');
  M.attachRing(G, 'luke-skywalker', 'yoda');
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);

  let guard = 0;
  while (G.pendingCombat && G.pendingChoice && guard++ < 60) {
    const pc = G.pendingChoice;
    if (pc.kind === 'YodaReroll' && pc.context === 'combat') {
      sawPrompt = true;
      // Skip (null).
      const r = combat.resolveYodaReroll(G, null);
      skipped = r.ok;
      // After skipping, the very next pending choice must NOT be another
      // YodaReroll (that would be the infinite re-queue bug).
      noReQueue = !(G.pendingChoice?.kind === 'YodaReroll');
      break;
    }
    // Auto-resolve other choices crudely to push the combat forward.
    if (pc.kind === 'CombatAddLeaderPick') { combat.resolveCombatAddLeaderPick(G, null); continue; }
    if (pc.kind === 'CombatStartActionCards') { combat.resolveCombatStartActionCards(G, []); continue; }
    if (pc.kind === 'CombatAttackerTactics') { combat.resolveCombatAttackerTactics(G, {}); continue; }
    if (pc.kind === 'CombatDefenderTactics') { combat.resolveCombatDefenderTactics(G, {}); continue; }
    if (pc.kind === 'OneInAMillionOffer') { combat.resolveOneInAMillionCombat(G, []); continue; }
    if (pc.kind === 'CombatAssignDamage') {
      // assign each hit to its first legal target
      const out = pc.targetsByHit.map((t) => t[0] ?? null);
      combat.resolveCombatAssignDamage(G, out); continue;
    }
    if (pc.kind === 'RetreatDecision') { combat.resolveRetreatDecision(G, { retreat: false }); continue; }
    break;
  }
}

console.log('\n[ #305 Yoda/Luke combat-reroll skip ]');
check('reached a Yoda reroll prompt', sawPrompt);
check('skip resolved ok', skipped);
check('skip did NOT re-queue another Yoda reroll', noReQueue);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
