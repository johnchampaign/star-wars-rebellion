// #324 — Misdirection: "choose 1 of your leaders" must include leaders that are
//        currently out on missions (the reporter couldn't pick Jan Dodonna, who
//        was on a mission).
// #316 — Baze's Loyalty: "Destroy 2 health-worth of units" now posts a player
//        target pick instead of auto-destroying, and respects the 2-health budget.
// Run: node scripts/test-damage-target-choice-316-324.mjs
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
const { stepOnce } = await import('../src/play/randomAI.ts');
const handlers = await import('../src/engine/handlers/index.ts'); // populates the registry
const registry = await import('../src/engine/handlers/registry.ts');

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

const baseOpts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

console.log('\n[ #324 Misdirection candidates include a leader out on a mission ]');
{
  const G = createGame(data, baseOpts(50));
  // Put a known Rebel leader onto a mission and out of pool/board.
  const onMission = G.rebel.leaderPool[0];
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== onMission);
  G.rebel.leadersOnMissions = [{ missionId: 'misdirection', leaderIds: [onMission] }];
  registry.invokeByKey(G, 'misdirection', { side: 'Rebel' });
  check('MisdirectionPick posted', G.pendingChoice?.kind === 'MisdirectionPick');
  check('on-mission leader is a candidate', !!G.pendingChoice?.candidates?.includes(onMission),
    `candidates=${JSON.stringify(G.pendingChoice?.candidates)}`);
}

console.log('\n[ #316 Baze\'s Loyalty posts a player pick and respects the 2-health budget ]');
{
  const G = createGame(data, baseOpts(51));
  // Give the Rebel Chirrut + the card, and a combat with affordable Empire units.
  G.rebel.actionHand = ['baze-s-loyalty'];
  const sys = 'felucia';
  G.map.systems[sys].units = [];
  M.placeLeader(G, 'Rebel', 'chirrut-imwe', sys);
  M.deployUnit(G, 'Empire', 'stormtrooper', sys); // 1-health ground
  M.deployUnit(G, 'Empire', 'stormtrooper', sys); // 1-health ground
  M.deployUnit(G, 'Empire', 'at-st', sys);        // 2-health ground
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys); // attacker
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
  combat.beginCombat(G, 'Rebel', 'kashyyyk', sys);
  combat.runCombat(G);

  // Find the StartOfCombat action-card window and play Baze's Loyalty.
  let guard = 0, played = false;
  while (G.pendingCombat && guard++ < 50) {
    const pc = G.pendingChoice;
    if (pc?.kind === 'CombatStartActionCards' && pc.side === 'Rebel'
        && (pc.playable ?? []).includes('baze-s-loyalty')) {
      combat.resolveCombatStartActionCards(G, ['baze-s-loyalty']);
      played = true;
      break;
    }
    if (pc && stepOnce(G, pc.side)) continue;
    break;
  }
  check('Baze\'s Loyalty was offered + played at start of combat', played,
    `last pc=${G.pendingChoice?.kind}`);
  check('BazesLoyaltyTarget pick posted (not auto-resolved)',
    G.pendingChoice?.kind === 'BazesLoyaltyTarget', G.pendingChoice?.kind);
  check('budget starts at 2', G.pendingChoice?.budget === 2, `budget=${G.pendingChoice?.budget}`);

  // Pick the 2-health AT-ST → spends the whole budget in one pick → done.
  const atst = G.map.systems[sys].units.find((u) => u.typeId === 'at-st');
  const before = G.map.systems[sys].units.length;
  const r = combat.resolveBazesLoyaltyTarget(G, atst.instanceId);
  check('resolve ok', r.ok, r.reason);
  check('AT-ST destroyed', !G.map.systems[sys].units.some((u) => u.instanceId === atst.instanceId));
  check('exactly one unit destroyed (2-health spent the budget)',
    G.map.systems[sys].units.length === before - 1, `before=${before} after=${G.map.systems[sys].units.length}`);
  check('no further Baze pick pending', G.pendingChoice?.kind !== 'BazesLoyaltyTarget', G.pendingChoice?.kind);
}

console.log('\n[ #316 picking a 1-health unit re-posts for the remaining budget ]');
{
  const G = createGame(data, baseOpts(52));
  G.rebel.actionHand = ['baze-s-loyalty'];
  const sys = 'felucia';
  G.map.systems[sys].units = [];
  M.placeLeader(G, 'Rebel', 'chirrut-imwe', sys);
  M.deployUnit(G, 'Empire', 'stormtrooper', sys);
  M.deployUnit(G, 'Empire', 'stormtrooper', sys);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
  combat.beginCombat(G, 'Rebel', 'kashyyyk', sys);
  combat.runCombat(G);
  let guard = 0;
  while (G.pendingCombat && guard++ < 50) {
    const pc = G.pendingChoice;
    if (pc?.kind === 'CombatStartActionCards' && pc.side === 'Rebel'
        && (pc.playable ?? []).includes('baze-s-loyalty')) {
      combat.resolveCombatStartActionCards(G, ['baze-s-loyalty']); break;
    }
    if (pc && stepOnce(G, pc.side)) continue;
    break;
  }
  check('first Baze pick posted', G.pendingChoice?.kind === 'BazesLoyaltyTarget');
  const first = G.map.systems[sys].units.find((u) => u.typeId === 'stormtrooper');
  combat.resolveBazesLoyaltyTarget(G, first.instanceId);
  check('re-posts for the 2nd 1-health unit (budget 1 left)',
    G.pendingChoice?.kind === 'BazesLoyaltyTarget' && G.pendingChoice.budget === 1,
    `pc=${G.pendingChoice?.kind} budget=${G.pendingChoice?.budget}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
