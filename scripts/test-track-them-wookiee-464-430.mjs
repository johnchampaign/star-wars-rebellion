// #464 — "Track Them" has NO recruit icon (verified from the card art), so it's
// a STARTING action card, not a recruit-deck card. It must not be offered during
// the recruit step. Flipped isStarting:true → it leaves the Empire action deck
// and joins the starting pool.
// #430 — "Wookiee Guardian" has NO location requirement (the Chewbacca art is
// just its recruit icon): "Use when your opponent attempts a spec ops mission —
// it automatically fails." It should be offerable for ANY Empire spec-ops
// attempt, regardless of where Chewbacca is. We wrongly required Chewbacca in the
// target system.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

console.log('[ #464: Track Them is a starting card, not in the recruit deck ]');
{
  const G = createGame(data, { seed: 5, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  const inRecruitDeck = (G.empire.actionDeck ?? []).includes('track-them');
  const inStartingPool = (G.empire.actionHand ?? []).includes('track-them')
    || (G.empire.startingActionDeck ?? []).includes('track-them');
  check('track-them is NOT in the Empire recruit/action deck', !inRecruitDeck);
  check('track-them IS in the starting pool (hand or leftover starting deck)', inStartingPool,
    `hand=${JSON.stringify(G.empire.actionHand)} startDeck=${JSON.stringify(G.empire.startingActionDeck)}`);
}

// RAW (Rules Reference, "Action Cards"): "Action cards used during a mission or
// combat can only be used if one of the leaders shown on the card is already in
// the system in which the mission or combat is occurring." Wookiee Guardian shows
// Chewbacca and doesn't move him, so he MUST be in the mission's system.
console.log('[ #430: Wookiee Guardian requires Chewbacca in the mission system ]');
function setupWookie(seed, chewSystem, targetSys) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  if (!G.rebel.actionHand.includes('wookie-guardian')) G.rebel.actionHand.push('wookie-guardian');
  for (const list of Object.values(G.rebel.leadersOnBoard)) { const i = list.indexOf('chewbacca'); if (i >= 0) list.splice(i, 1); }
  if (!G.rebel.leaderPool.includes('chewbacca')) G.rebel.leaderPool.push('chewbacca');
  M.placeLeader(G, 'Rebel', 'chewbacca', chewSystem);
  const MISSION = 'hunt-them-down'; // Empire specOps attempt
  if (!G.empire.missionDeck.includes(MISSION)) G.empire.missionDeck.push(MISSION);
  G.empire.leaderPool.push('darth-vader');
  M.placeLeader(G, 'Empire', 'darth-vader', targetSys);
  G.empire.leadersOnMissions.push({ missionId: MISSION, leaderIds: ['darth-vader'] });
  return { G, MISSION, targetSys };
}
{
  // Chewbacca NOT in the target system → NO offer.
  const { G, MISSION, targetSys } = setupWookie(5, 'kashyyyk', 'tatooine');
  const r = phases.revealMission(G, 'Empire', MISSION, targetSys);
  check('reveal ok', r.ok, r.reason);
  check('NO Wookiee Guardian offer when Chewbacca is elsewhere (RAW: leader must be present)',
    G.pendingChoice?.kind !== 'WookieGuardianOffer', `pc=${G.pendingChoice?.kind}`);
}
{
  // Chewbacca IN the target system → offer, and it auto-fails.
  const { G, MISSION, targetSys } = setupWookie(5, 'tatooine', 'tatooine');
  const r = phases.revealMission(G, 'Empire', MISSION, targetSys);
  check('reveal ok (Chewbacca present)', r.ok, r.reason);
  check('Wookiee Guardian offered when Chewbacca IS in the mission system',
    G.pendingChoice?.kind === 'WookieGuardianOffer', `pc=${G.pendingChoice?.kind}`);
  if (G.pendingChoice?.kind === 'WookieGuardianOffer') {
    const wr = phases.resolveWookieGuardianOffer(G, true);
    check('playing it auto-fails the spec-ops mission', wr.ok, wr.reason);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
