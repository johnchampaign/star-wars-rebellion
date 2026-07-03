// #469 / #413 — Misdirection: "choose 1 of your leaders. Imperial leaders in the
// leader pool cannot be sent to oppose this leader's mission this round."
// The protected-leader flag (G.misdirectionProtected) was set and cleared but
// never consulted when opposition was offered, so the Empire (incl. the AI)
// could still send a pool leader to oppose the protected leader's mission.
// This test reveals a protected leader's attempt mission and asserts the posted
// OpposeMission choice offers an EMPTY pool (existing-at-target leaders may
// still oppose, but nothing may be SENT from the pool).
// Run: node scripts/test-misdirection-oppose-469.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const MISSION = 'hit-and-run'; // Rebel, specOps, "attempt in any system"
const HERO = 'han-solo';       // the Rebel leader running the mission
const TARGET = 'tatooine';

function setup() {
  const G = createGame(data, { seed: 7, autoSetupUnits: true });
  G.phase = 'Command'; G.currentPlayer = 'Rebel';
  G.pendingChoice = undefined; G.pendingMission = undefined;
  // Clear boards + action hands so no Blindside/Wookiee Special offer intercepts
  // the reveal before it reaches the opposition step.
  for (const list of Object.values(G.rebel.leadersOnBoard)) list.length = 0;
  for (const list of Object.values(G.empire.leadersOnBoard)) list.length = 0;
  G.empire.actionHand = [];
  G.rebel.actionHand = [];
  // The hero is out on the hit-and-run mission; Empire has a full pool.
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== HERO);
  G.rebel.leadersOnMissions = [{ missionId: MISSION, leaderIds: [HERO] }];
  return G;
}

console.log('\n[ control: WITHOUT Misdirection, the Empire pool CAN oppose ]');
{
  const G = setup();
  const before = G.empire.leaderPool.length;
  const r = phases.revealMission(G, 'Rebel', MISSION, TARGET, undefined, [HERO]);
  check('reveal ok', r.ok, r.reason);
  check('Empire actually has pool leaders to send', before > 0, `pool=${before}`);
  check('OpposeMission choice was posted', G.pendingChoice?.kind === 'OpposeMission', G.pendingChoice?.kind);
  check('pool is offered (non-empty) when unprotected',
    (G.pendingChoice?.poolLeaders?.length ?? 0) > 0,
    `poolLeaders=${JSON.stringify(G.pendingChoice?.poolLeaders)}`);
}

console.log('\n[ #469: WITH Misdirection protecting the hero, the pool is EMPTY ]');
{
  const G = setup();
  G.misdirectionProtected = [HERO];
  const r = phases.revealMission(G, 'Rebel', MISSION, TARGET, undefined, [HERO]);
  check('reveal ok', r.ok, r.reason);
  check('OpposeMission choice was posted', G.pendingChoice?.kind === 'OpposeMission', G.pendingChoice?.kind);
  check('pool leaders CANNOT be sent (empty pool)',
    (G.pendingChoice?.poolLeaders?.length ?? 99) === 0,
    `poolLeaders=${JSON.stringify(G.pendingChoice?.poolLeaders)}`);
}

console.log('\n[ a DIFFERENT (unprotected) leader\'s mission is unaffected by the flag ]');
{
  const G = setup();
  G.misdirectionProtected = ['mon-mothma']; // protecting someone else
  const r = phases.revealMission(G, 'Rebel', MISSION, TARGET, undefined, [HERO]);
  check('reveal ok', r.ok, r.reason);
  check('OpposeMission choice was posted', G.pendingChoice?.kind === 'OpposeMission', G.pendingChoice?.kind);
  check('pool still offered for the unprotected hero',
    (G.pendingChoice?.poolLeaders?.length ?? 0) > 0,
    `poolLeaders=${JSON.stringify(G.pendingChoice?.poolLeaders)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
