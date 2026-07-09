// #522 — the Rebel AI ran Plan the Assault by sending a LONE X-wing (its only
// base ship) into a fight it couldn't win, for no gain. Plan the Assault's legal
// targets are only systems that already hold an Imperial ship, and the
// "pointless" filter only requires ANY Rebel ship at the base — so a lone fighter
// slipped through. The scoring guard now penalizes a trivial committable force
// (reb < 5, ~2 fighters) and a losing/empty matchup, so the AI only reveals it
// with a real fleet that can actually win.
// Run: node scripts/test-plan-the-assault-force-522.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const mt = await import('../src/engine/missionTargets.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Returns the AI's Plan the Assault reveal action (if any) given a base fleet.
function ptaAction(baseFleet, targetDefenders) {
  ai.seedAI(1);
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.phase = 'Command'; G.currentPlayer = 'Rebel'; G.passedThisCommand = [];
  const leader = G.rebel.leaderPool[0];
  // Plan the Assault is intel cost-2 — the assigned leader must meet the cost or
  // the reveal is skipped before scoring. Ensure it does.
  if (G.catalog.leaders[leader]) G.catalog.leaders[leader].skills = { ...(G.catalog.leaders[leader].skills ?? {}), intel: 3 };
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== leader);
  G.rebel.leadersOnMissions = [{ missionId: 'plan-the-assault', leaderIds: [leader] }];
  G.rebel.missionHand = G.rebel.missionHand.filter((m) => m !== 'plan-the-assault');
  const mk = (t, side) => ({ instanceId: t + Math.random(), typeId: t, side, damage: 0 });
  G.map.rebelBaseSpace.units = baseFleet.map((t) => mk(t, 'Rebel'));
  // Put the defenders on the FIRST legal Plan-the-Assault target (a system that
  // holds an Imperial ship — we add one to make it legal + defended).
  // Use a REAL legal Plan-the-Assault target (a system that already holds an
  // Imperial ship), then set its defenders to the test force (still legal since
  // the defenders include ships).
  const targets = mt.missionTargets(G, 'Rebel', 'plan-the-assault');
  const tgt = targets.systemIds[0];
  if (!tgt) return { score: undefined, beatsPass: false, noTarget: true };
  // Make `tgt` the ONLY legal target: strip Imperial ships from every OTHER
  // system, then set tgt's defenders to the test force (so bestCommandAction's
  // single best-target-per-mission pick is deterministically tgt).
  for (const [sid, ss] of Object.entries(G.map.systems)) {
    if (sid === tgt) continue;
    ss.units = ss.units.filter((u) => !(u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'space'));
  }
  G.map.systems[tgt].units = G.map.systems[tgt].units.filter((u) => u.side !== 'Empire');
  for (const d of targetDefenders) G.map.systems[tgt].units.push(mk(d, 'Empire'));
  const acts = ai.bestCommandAction(G, 'Rebel');
  const pta = acts.find((a) => a.kind === 'reveal' && a.missionId === 'plan-the-assault');
  const passScore = acts.find((a) => a.kind === 'pass')?.score ?? 0.5;
  return { score: pta?.score, beatsPass: pta ? pta.score > passScore : false };
}

console.log('[ #522 — Plan the Assault force adequacy ]');
// Lone X-wing vs a defended target → should score below pass (won't be revealed).
const lone = ptaAction(['x-wing'], ['tie-fighter', 'assault-carrier', 'tie-fighter', 'tie-fighter']);
check('lone X-wing → Plan the Assault does NOT beat passing', lone.beatsPass === false, `score=${lone.score}`);
// Real fleet vs a beatable defender → viable (beats pass).
const fleet = ptaAction(['mon-cala-cruiser', 'mon-cala-cruiser', 'mon-cala-cruiser', 'x-wing'], ['tie-fighter']);
check('real fleet vs weak defender → Plan the Assault is a viable action', fleet.beatsPass === true, `score=${fleet.score}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
