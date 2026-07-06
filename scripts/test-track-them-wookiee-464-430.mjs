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

console.log('[ #430: Wookiee Guardian fires for any spec-ops attempt (no Chewbacca-location requirement) ]');
{
  const G = createGame(data, { seed: 5, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  G.phase = 'Command';
  G.currentPlayer = 'Empire';
  G.passedThisCommand = [];
  const SYS = 'tatooine'; // NOT where Chewbacca is
  // Rebel holds Wookiee Guardian; Chewbacca is somewhere ELSE entirely.
  if (!G.rebel.actionHand.includes('wookie-guardian')) G.rebel.actionHand.push('wookie-guardian');
  if (!G.rebel.leaderPool.includes('chewbacca') && !Object.values(G.rebel.leadersOnBoard).some(a => a.includes('chewbacca'))) G.rebel.leaderPool.push('chewbacca');
  M.placeLeader(G, 'Rebel', 'chewbacca', 'kashyyyk'); // far from tatooine
  // Empire attempts a spec-ops mission at tatooine (Chewbacca NOT present).
  const MISSION = 'hunt-them-down'; // Empire specOps attempt
  if (!G.empire.missionDeck.includes(MISSION)) G.empire.missionDeck.push(MISSION);
  G.empire.leaderPool.push('darth-vader');
  M.placeLeader(G, 'Empire', 'darth-vader', SYS);
  G.empire.leadersOnMissions.push({ missionId: MISSION, leaderIds: ['darth-vader'] });

  const r = phases.revealMission(G, 'Empire', MISSION, SYS);
  check('reveal ok', r.ok, r.reason);
  check('WookieGuardianOffer posted even though Chewbacca is NOT in the target system',
    G.pendingChoice?.kind === 'WookieGuardianOffer', `pc=${G.pendingChoice?.kind}`);
  // And playing it auto-fails the mission.
  if (G.pendingChoice?.kind === 'WookieGuardianOffer') {
    const wr = phases.resolveWookieGuardianOffer(G, true);
    check('playing it auto-fails the spec-ops mission', wr.ok, wr.reason);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
