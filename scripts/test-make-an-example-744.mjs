// @timeout 60000
// #744 — "I did the special mission of Jabba (eliminating a rebel leader) and
// actually all skill items count, but this was done wrong by the game (just
// diplomacy counted)". The reporter was right. Make an Example's card text is
// "Count all skill icons; the captured leader is eliminated" — but the engine's
// count-all check matched the LONGER phrase Interrogation Droid and Lure of the
// Dark Side use ("count all skill icons during this attempt"), so Jabba (2
// diplomacy + 2 intel) rolled 2 dice instead of 4. Fixed by matching the common
// prefix; the AI's leader-fit uses the same rule now.
// Run: node scripts/test-make-an-example-744.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ which missions count every skill icon ]');
{
  const G = createGame(data, { seed: 3, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  check('Make an Example counts all icons (its text has no "during this attempt" tail)', phases.missionCountsAllSkills(G, 'make-an-example'));
  check('Interrogation Droid still does', phases.missionCountsAllSkills(G, 'interrogation-droid'));
  check('Lure of the Dark Side still does', phases.missionCountsAllSkills(G, 'lure-of-the-dark-side'));
  check('an ordinary mission does not', !phases.missionCountsAllSkills(G, 'gather-intel') && !phases.missionCountsAllSkills(G, 'rule-by-fear'));
}

console.log('[ Jabba rolls diplomacy + intel on Make an Example ]');
{
  const G = createGame(data, { seed: 3, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  const SYS = 'tatooine'; // remote
  const jabba = G.catalog.leaders['jabba'];
  check('Jabba has icons outside diplomacy', !!jabba && (jabba.skills.intel ?? 0) > 0, JSON.stringify(jabba?.skills));
  // a captured Rebel leader held in a remote system, Jabba assigned to the mission
  G.empire.capturedLeaders = [{ leaderId: 'mon-mothma', ring: 'captured', systemId: SYS }];
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== 'mon-mothma');
  if (!G.empire.leaderPool.includes('jabba')) G.empire.leaderPool.push('jabba');
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== 'jabba');
  if (!G.empire.missionHand.includes('make-an-example')) G.empire.missionHand.push('make-an-example');
  G.empire.leadersOnMissions.push({ missionId: 'make-an-example', leaderIds: ['jabba'] });
  G.phase = 'Command'; G.currentPlayer = 'Empire';
  const r = phases.revealMission(G, 'Empire', 'make-an-example', SYS);
  check('the reveal is accepted', r.ok, r.reason ?? JSON.stringify(r));
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null);
  const roll = [...G.turnLog].reverse().find((e) => e.kind === 'mission-roll' && e.payload?.missionId === 'make-an-example');
  const expected = (jabba.skills.diplomacy ?? 0) + (jabba.skills.intel ?? 0) + (jabba.skills.specOps ?? 0) + (jabba.skills.logistics ?? 0);
  // Jabba is the card's portrait leader, so the portrait bonus dice ride on top
  // of the icon count; the icon count itself is what #744 was about.
  const portrait = roll?.payload?.attacker?.portrait ?? 0;
  check(`the attempt rolled ${expected} icon dice + ${portrait} portrait (all of Jabba's icons), not ${jabba.skills.diplomacy} + ${portrait}`, roll?.payload?.attacker?.dice === expected + portrait, `roll=${JSON.stringify(roll?.payload?.attacker)} pending=${G.pendingChoice?.kind}`);
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
