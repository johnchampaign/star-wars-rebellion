// Regression test: R2-D2 (Resourceful Astromech) die-flip during COMBAT must
// post an R2D2Flip choice tagged context:'combat' and resolve cleanly. The bug
// (combat.ts omitted context) left it undefined, so the combat board's R2-D2
// panel — gated on context === 'combat' — never rendered and the game hung on
// the unresolved choice.
//
// No test framework is installed; this follows the project's tsx-script idiom
// (like scripts/tournament.mjs). Exits non-zero on failure.
//
// Usage: node scripts/test-r2d2-flip.mjs

import { readFileSync } from 'node:fs';
const mod = await import('tsx/esm/api'); mod.register();
const { createGame } = await import('../src/engine/setup.ts');
const combat = await import('../src/engine/combat.ts');
const load = (p) => JSON.parse(readFileSync(new URL(`../assets/${p}`, import.meta.url), 'utf-8'));
const data = {
  systems: load('systems.json'), adjacency: load('adjacency.json'), leaders: load('leaders.json'),
  actions: load('actions.json'), missions: load('missions.json'), objectives: load('objectives.json'),
  tactics: load('tactics.json'), probes: load('probes.json'),
};

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }

// Build a clean space combat: Empire attacker + Rebel defender at one system,
// no leaders in either pool (so no add-leader pick), empty hands except the
// Rebel holds Resourceful Astromech. Empire rolls first → R2-D2 window opens.
function setup(seed) {
  const G = createGame(data, { seed, autoSetupUnits: true });
  // Wipe leader pools / boards so no CombatAddLeaderPick is offered.
  G.rebel.leaderPool = []; G.empire.leaderPool = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  // Empty hands except the R2-D2 card for the Rebel.
  G.empire.actionHand = []; G.rebel.actionHand = ['resourceful-astromech'];
  G.spaceTacticDeck = []; G.groundTacticDeck = []; // no tactic draws to wade through
  const sysId = 'corellia';
  const ss = G.map.systems[sysId];
  ss.units = [
    // Empire attacker: several Star Destroyers → many red dice, ~certainly a non-blank.
    ...Array.from({ length: 6 }, (_, i) => ({ instanceId: `e${i}`, typeId: 'star-destroyer', side: 'Empire', damage: 0 })),
    // Rebel defender: a couple corvettes so the battle is contested.
    ...Array.from({ length: 2 }, (_, i) => ({ instanceId: `r${i}`, typeId: 'corellian-corvette', side: 'Rebel', damage: 0 })),
  ];
  return { G, sysId };
}

let posted = 0, asserted = 0;
for (let seed = 1; seed <= 40 && asserted === 0; seed++) {
  const { G, sysId } = setup(seed);
  combat.beginCombat(G, 'Empire', sysId, sysId);
  combat.runCombat(G);
  const pc = G.pendingChoice;
  if (pc?.kind !== 'R2D2Flip') continue; // dice all blank this seed, or another choice surfaced — try next
  posted++;
  // ASSERT 1: the combat-side choice carries context:'combat' (the regression).
  if (pc.context !== 'combat') fail(`R2D2Flip posted with context=${JSON.stringify(pc.context)} (expected 'combat') — the bug is back`);
  // ASSERT 2: resolving it clears the choice (no hang).
  const r = combat.resolveR2D2Flip(G, null); // decline the flip
  if (!r.ok) fail(`resolveR2D2Flip returned !ok: ${r.reason}`);
  if (G.pendingChoice?.kind === 'R2D2Flip') fail('pendingChoice still R2D2Flip after resolve — combat hung');
  asserted++;
  console.log(`OK (seed ${seed}): combat R2D2Flip had context='combat' and resolved; pendingChoice -> ${G.pendingChoice?.kind ?? 'cleared'}`);
}

if (asserted === 0) fail(`R2D2Flip never triggered across 40 seeds (posted=${posted}) — test could not exercise the path`);
console.log('PASS: R2-D2 combat flip regression test');
