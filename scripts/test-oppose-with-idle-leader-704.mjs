// #704 — jocke01: "The empire passed with tagge still ready in the leader pool
// to move units and Jabba that could have opposed my build alliance mission.
// Both remained passive in the pool. Jabba had nothing to do this round except
// opposing since he can't move ships. If the rebel does their last mission he
// should auto oppose if nothing else since otherwise he is a complete waste."
//
// This is a correction to a rule HIS OWN earlier feedback produced. The Empire
// opposes only high-impact missions, priced on "every leader spent opposing is
// an activation foregone" — reporters kept watching it burn its pool on
// sabotage/infiltration while its fleets idled (#516), so the skip was added
// and A/B'd.
//
// But RAW gates activating a system on having tactic values. Boba Fett, Jabba
// and Greejatus have none: they cannot activate anything, ever. For them the
// price the rule is charging is exactly zero, and holding them back is not
// saving them for something better — it is wasting them outright.
//
// Measured over 60 expansion games: Empire passes while holding an idle
// no-tactic leader 27/477 (5.7%) -> 3/475 (0.6%). Win rate over 1200 games
// 40.2% -> 40.0%, i.e. free.
//
// Run: node scripts/test-oppose-with-idle-leader-704.mjs
//   Counterfactual: SWR_OPPOSE_IDLE=0 node scripts/test-oppose-with-idle-leader-704.mjs
//   must FAIL — that flag restores the blanket skip.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const ai = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const NO_TACTIC = ['boba-fett', 'jabba', 'janus-greejatus'];

console.log('\n[ the premise: these leaders genuinely cannot activate anything ]');
{
  const G = createGame(data, { seed: 704, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  for (const lid of NO_TACTIC) {
    const l = G.catalog.leaders[lid];
    check(`${lid} has zero tactic values`,
      !!l && (l.tacticValues.space + l.tacticValues.ground) === 0,
      l ? `${l.tacticValues.space}/${l.tacticValues.ground}` : 'missing');
  }
  const tagge = G.catalog.leaders['general-tagge'];
  check('a normal leader (Tagge) does have them — the rule still applies to him',
    (tagge.tacticValues.space + tagge.tacticValues.ground) > 0);
}

/** Post an OpposeMission window to the Empire with `poolLeaders` available for
 *  a LOW-impact Rebel mission (build-alliance — the one from the report), and
 *  report which leader, if any, the AI sends. */
function opposeWith(poolLeaders, seed = 704) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.empire.leaderPool = [...poolLeaders];
  const target = Object.keys(G.map.systems)[0];
  // resolveOpposition reads G.pendingMission, not just the choice — without it
  // every arm returns 'no-pending-mission' and the test asserts nothing.
  G.pendingMission = {
    missionId: 'build-alliance',
    resolverSide: 'Rebel',
    targetSystemId: target,
    leaderIds: ['mon-mothma'],
    stage: 'oppose',
  };
  G.pendingChoice = {
    kind: 'OpposeMission',
    opposerSide: 'Empire',
    missionId: 'build-alliance',
    targetSystemId: target,
    skill: 'diplomacy',
    attackerDice: 3,
    attackerPortrait: 0,
    existingAtTarget: [],
    poolLeaders: [...poolLeaders],
  };
  const before = G.turnLog.length;
  const acted = ai.stepOnce(G, 'Empire');
  // The most reliable signal is where the leader ended up: resolveOpposition
  // places a sent opposer at the mission's target system.
  const placed = new Set();
  for (const list of Object.values(G.empire.leadersOnBoard ?? {})) for (const l of list) placed.add(l);
  const sent = [...placed].filter((l) => poolLeaders.includes(l));
  return { acted, sent, G };
}

console.log('\n[ #704 an idle no-tactic leader opposes a low-impact mission ]');
{
  // Jabba has diplomacy, so he is a real candidate against Build Alliance.
  const { acted, sent } = opposeWith(['jabba']);
  check('the choice resolved', acted === true);
  check('the bug: Jabba is sent rather than left in the pool',
    sent.includes('jabba'), `sent=${JSON.stringify(sent)}`);
}

console.log('\n[ the original rule still holds for a leader who CAN activate ]');
{
  // Tarkin can activate systems, so spending him on a low-impact mission is a
  // real cost — the skip must still apply to him. This is the half of the rule
  // that was A/B'd and must not be undone.
  const { acted, sent } = opposeWith(['grand-moff-tarkin']);
  check('the choice resolved', acted === true);
  check('a tactics-capable leader is NOT spent on a low-impact mission',
    !sent.includes('grand-moff-tarkin'), `sent=${JSON.stringify(sent)}`);
}

console.log('\n[ given both, it spends the one that cannot activate ]');
{
  const { acted, sent } = opposeWith(['jabba', 'grand-moff-tarkin']);
  check('the choice resolved', acted === true);
  check('Jabba goes, Tarkin stays',
    sent.includes('jabba') && !sent.includes('grand-moff-tarkin'),
    `sent=${JSON.stringify(sent)}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
