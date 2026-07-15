// #579 / #551 — the Rebel AI must NOT relocate (abandon) a still-HIDDEN base
// just because an Empire ground force is near it. RM's relocate moves only the
// base marker, stranding the starting fleet at the old site forever. So when the
// base is hidden, the AI now takes the move-units branch (reinforce, pull ships
// in) — relocation happens ONLY when the base is REVEALED (capture imminent).
// Run: node scripts/test-rm-branch-no-strand-579.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const setupBranch = (baseRevealed) => {
  const G = createGame(data, { seed: 5, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  const base = G.rebelBaseSystemId;
  // Put an Empire ground force one hop from the base so proximity > 0.
  const adj = data.adjacency[base] ?? [];
  const near = adj[0] ?? base;
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Empire', 'stormtrooper', near);
  G.rebelBaseRevealed = baseRevealed;
  G.pendingChoice = {
    kind: 'RapidMobilizationBranch', side: 'Rebel',
    twoLeaders: false, baseRevealed, moveUnitsAvailable: !baseRevealed,
  };
  return G;
};

console.log('[ #579 — hidden base + Empire ground nearby → reinforce, do NOT relocate ]');
{
  const G = setupBranch(false);
  AI.stepOnce(G, 'Rebel');
  check('hidden base: AI took move-units (reinforce), not relocate',
    G.pendingChoice?.kind === 'RapidMobilizationMovePick',
    `got ${G.pendingChoice?.kind}`);
}

console.log('\n[ REVEALED base → relocate (escape) is still correct ]');
{
  const G = setupBranch(true);
  AI.stepOnce(G, 'Rebel');
  check('revealed base: AI took establish-base (relocate to escape)',
    G.pendingChoice?.kind === 'RapidMobilizationBasePick',
    `got ${G.pendingChoice?.kind}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
