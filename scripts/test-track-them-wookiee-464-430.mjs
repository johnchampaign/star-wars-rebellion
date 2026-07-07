// #464 — "Track Them" has NO recruit icon (verified from the card art), so it's
// a STARTING action card, not a recruit-deck card. It must not be offered during
// the recruit step. Flipped isStarting:true → it leaves the Empire action deck
// and joins the starting pool.
// #430 — "Wookiee Guardian" requires Chewbacca in the mission's system (RAW:
// action cards used during a mission need a shown leader present). The offer is
// made at the OPPOSITION step, so the Rebel can bring Chewie in to oppose and
// then play it — and it isn't skipped when the Empire plays Blindside.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const { canEncode } = await import('../src/engine/codec.ts');
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
// The offer now comes at the OPPOSITION step (after the Rebel's Send-Leaders-to-
// Oppose choice), so Chewie can be brought in to oppose and then play the card.
console.log('[ #430: Wookiee Guardian at the opposition step — requires Chewie present ]');
const TARGET = 'tatooine';
// chewPlacement: 'target' (pre-positioned), 'pool' (bring in), or a far system.
function setupWookie(seed, chewPlacement) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  if (!G.rebel.actionHand.includes('wookie-guardian')) G.rebel.actionHand.push('wookie-guardian');
  for (const list of Object.values(G.rebel.leadersOnBoard)) { const i = list.indexOf('chewbacca'); if (i >= 0) list.splice(i, 1); }
  const ci = G.rebel.leaderPool.indexOf('chewbacca'); if (ci >= 0) G.rebel.leaderPool.splice(ci, 1);
  if (chewPlacement === 'pool') { G.rebel.leaderPool.push('chewbacca'); }
  else { G.rebel.leaderPool.push('chewbacca'); M.placeLeader(G, 'Rebel', 'chewbacca', chewPlacement === 'target' ? TARGET : 'kashyyyk'); }
  const MISSION = 'hunt-them-down'; // Empire specOps attempt
  if (!G.empire.missionDeck.includes(MISSION)) G.empire.missionDeck.push(MISSION);
  G.empire.leaderPool.push('darth-vader'); // spec-ops-capable attacker
  M.placeLeader(G, 'Empire', 'darth-vader', TARGET);
  G.empire.leadersOnMissions.push({ missionId: MISSION, leaderIds: ['darth-vader'] });
  phases.revealMission(G, 'Empire', MISSION, TARGET);
  return { G, MISSION };
}
{
  // Chewie far away, not in pool → oppose (decline) → NO offer.
  const { G } = setupWookie(5, 'kashyyyk');
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null);
  check('NO offer when Chewie is elsewhere and not brought in', G.pendingChoice?.kind !== 'WookieGuardianOffer', `pc=${G.pendingChoice?.kind}`);
}
{
  // Chewie pre-positioned at target → oppose (decline further) → offer → auto-fail.
  const { G } = setupWookie(5, 'target');
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null);
  check('offer when Chewie is pre-positioned at the target', G.pendingChoice?.kind === 'WookieGuardianOffer', `pc=${G.pendingChoice?.kind}`);
  if (G.pendingChoice?.kind === 'WookieGuardianOffer') check('accepting auto-fails', phases.resolveWookieGuardianOffer(G, true).ok);
}
{
  // #430(a) THE BRING-IN CASE: Chewie in the pool → send him to oppose → offer → auto-fail.
  const { G } = setupWookie(5, 'pool');
  check('reveal → OpposeMission with Chewie available in the pool',
    G.pendingChoice?.kind === 'OpposeMission' && (G.pendingChoice.poolLeaders ?? []).includes('chewbacca'), `pc=${G.pendingChoice?.kind}`);
  phases.resolveOpposition(G, 'chewbacca'); // bring Chewie in to oppose
  check('offer appears AFTER bringing Chewie in to oppose', G.pendingChoice?.kind === 'WookieGuardianOffer', `pc=${G.pendingChoice?.kind}`);
  if (G.pendingChoice?.kind === 'WookieGuardianOffer') {
    check('accepting auto-fails the spec-ops mission', phases.resolveWookieGuardianOffer(G, true).ok);
    check('mission resolved (no stuck pendingMission)', !G.pendingMission);
  }
}
{
  // Decline resumes the opposition roll (no freeze).
  const { G } = setupWookie(5, 'target');
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null);
  if (G.pendingChoice?.kind === 'WookieGuardianOffer') phases.resolveWookieGuardianOffer(G, false); // decline
  let guard = 0;
  while (G.pendingChoice && guard++ < 10) {
    const k = G.pendingChoice.kind;
    if (k === 'YodaReroll') { phases.resolveYodaMissionReroll(G, null); continue; }
    if (k === 'R2D2Flip') { phases.resolveR2D2MissionFlip(G, null); continue; }
    if (k === 'OneInAMillionOffer') { phases.resolveOneInAMillionMission(G, []); continue; }
    break;
  }
  // The point: the mission RESOLVED (pendingMission cleared) — no freeze. Any
  // leftover pendingChoice (e.g. a StartingCardBranch from the turn continuing)
  // is normal game flow, not the stuck-mission bug.
  check('declining resumes the roll and resolves the mission (no stuck pendingMission)', !G.pendingMission, `pm=${!!G.pendingMission} pc=${G.pendingChoice?.kind}`);
  void canEncode;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
