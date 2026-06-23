// #388 — Raid Imperial Factory must only fire when the Rebels win an initiated
//        combat in a system that has a SQUARE (■) resource icon. The card art
//        shows ■ specifically; a triangle/circle resource system (e.g. Cato
//        Neimoidia) must NOT trigger it.
// #387 — Public Support (Janus Greejatus): "Janus does not stop units from
//        moving out of the system this turn." The greejatus free-move flag must
//        exempt that system from the generic "a friendly leader pins your units"
//        rule (RR p.2) during activation.
// Run: node scripts/test-square-resource-and-greejatus-387-388.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { combatObjectivesTriggered } = await import('../src/engine/objectives.ts');
const { gainUnit } = await import('../src/engine/mechanics.ts');

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
const roe = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true } });

// Minimal Rebel-won, Rebel-initiated combat report for the given system.
const rebelWinReport = (systemId) => ({
  systemId,
  attackerSide: 'Rebel',
  winner: 'Rebel',
  addedLeaders: [],
  drawnTactics: { side: 'Rebel', spaceCount: 0, groundCount: 0 },
  rounds: [],
  structureDestructions: [],
  retreatDestructions: [],
});

console.log('\n[ #388 Raid Imperial Factory only fires on a ■ (square) resource system ]');
{
  const G = createGame(data, roe(1));
  G.rebel.objectiveHand = ['raid-imperial-factory-3'];

  // Sanity-check the catalog assumptions the test relies on.
  const hasSquare = (sid) => (G.catalog.systems[sid]?.resources ?? []).some((r) => r.shape === 'square');
  check('corellia has a square resource icon (catalog sanity)', hasSquare('corellia'),
    JSON.stringify(G.catalog.systems['corellia']?.resources));
  check('cato-neimoidia has NO square resource icon (the reporter\'s system)',
    !hasSquare('cato-neimoidia'), JSON.stringify(G.catalog.systems['cato-neimoidia']?.resources));

  const firedSquare = combatObjectivesTriggered(G, rebelWinReport('corellia'));
  check('fires on a square-resource system (corellia)', firedSquare.includes('raid-imperial-factory-3'),
    JSON.stringify(firedSquare));

  const firedTri = combatObjectivesTriggered(G, rebelWinReport('cato-neimoidia'));
  check('does NOT fire on a triangle/circle system (cato-neimoidia) — the bug',
    !firedTri.includes('raid-imperial-factory-3'), JSON.stringify(firedTri));
}

console.log('\n[ #387 Public Support exempts Janus\'s system from the friendly-leader pin ]');
{
  const G = createGame(data, roe(1));
  // Drive to a clean Command phase, Empire to act, no pending resolution.
  G.phase = 'Command';
  G.currentPlayer = 'Empire';
  G.passedThisCommand = [];
  G.pendingMission = undefined;
  G.pendingChoice = undefined;
  G.pendingCombat = undefined;

  // Find an adjacent (source S, target T) pair where T has no units, so the
  // activation is a clean move with no combat.
  const adj = G.catalog.adjacency;
  let S = null, T = null;
  for (const sid of Object.keys(G.map.systems)) {
    for (const t of (adj[sid] ?? [])) {
      if (!G.map.systems[t]) continue;
      if ((G.map.systems[t].units ?? []).length === 0 && t !== 'coruscant') { S = sid; T = t; break; }
    }
    if (S) break;
  }
  check('found a source→target adjacency for the test', !!(S && T), `S=${S} T=${T}`);

  // Place an Empire leader in S (this is what pins units there) and a freely-
  // moving space unit (star destroyer needs no transport) to move out.
  G.empire.leadersOnBoard = { ...G.empire.leadersOnBoard, [S]: ['darth-vader'] };
  G.empire.leaderPool = (G.empire.leaderPool ?? []).filter((id) => id !== 'darth-vader');
  // An activating leader with tactic values, still in the pool.
  const activator = (G.empire.leaderPool ?? []).find((id) => {
    const L = G.catalog.leaders[id];
    return L && (L.tacticValues.space + L.tacticValues.ground) > 0;
  });
  check('have an Empire pool leader to activate with', !!activator, `pool=${JSON.stringify(G.empire.leaderPool)}`);
  gainUnit(G, 'Empire', 'star-destroyer', S);
  const sdId = G.map.systems[S].units.find((u) => u.typeId === 'star-destroyer')?.instanceId;

  const order = [{ fromSystemId: S, unitInstanceIds: [sdId] }];

  // WITHOUT the flag: the generic pin must block the move out of S.
  const blocked = phases.activateSystem(structuredClone(G), 'Empire', activator, T, order);
  check('without the card flag, moving out of the leader\'s system is blocked',
    blocked.reason === `friendly-leader-blocks-source:${S}`, `reason=${blocked.reason}`);

  // WITH the Public Support flag set on S: the pin must NOT fire for that system.
  const G2 = structuredClone(G);
  G2.actionCardFlags = { ...(G2.actionCardFlags ?? {}), greejatusFreeMoveSystemId: S };
  const freed = phases.activateSystem(G2, 'Empire', activator, T, order);
  check('with Public Support flag, units may move out of Janus\'s system (no pin)',
    freed.reason !== `friendly-leader-blocks-source:${S}`, `reason=${freed.reason ?? '(ok)'}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
