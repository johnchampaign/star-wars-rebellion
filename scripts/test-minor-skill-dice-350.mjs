// Minor-skill mission dice (#350): per the RoE rulebook, each minor skill icon
// rolls 1 GREEN die, capped at 3 per mission, and minor skills roll ONLY green —
// they never spill into red/black. So with >3 minor icons of the counted skill,
// the player rolls 3 green plus red/black equal to the MAJOR-icon count (not
// total-minus-3). Regression for the bug where minor-overflow inflated the
// red/black (major) die count.
// Run: node scripts/test-minor-skill-dice-350.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
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

// cassian-andor: intel major 2, intel minor 2. jyn-erso: intel major 1, intel minor 2.
// Together at an intel mission: 3 major intel + 4 minor intel = 7 skill icons,
// minor = 4 (> the 3-green cap).
console.log('\n[ #350: minor skills roll only green (cap 3); overflow does not become red/black ]');
{
  const G = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.phase = 'Assignment';
  G.currentPlayer = 'Rebel';
  G.passedThisCommand = [];
  // Make both minor-skill leaders available in the pool.
  G.rebel.leaderPool ??= [];
  for (const lid of ['cassian-andor', 'jyn-erso']) {
    if (!G.catalog.leaders[lid]) throw new Error(`missing leader ${lid}`);
    if (!G.rebel.leaderPool.includes(lid)) G.rebel.leaderPool.push(lid);
  }
  G.rebel.missionHand = ['covert-operation'];
  const asg = phases.assignLeader(G, 'Rebel', 'covert-operation', ['cassian-andor', 'jyn-erso']);
  check('assigned both leaders to covert-operation', asg.ok, asg.reason);
  G.phase = 'Command';
  // covert-operation must target a system containing an Imperial unit.
  const target = Object.keys(G.map.systems).find(
    (sid) => (G.map.systems[sid].units ?? []).some((u) => u.side === 'Empire'),
  ) ?? Object.keys(G.map.systems)[0];
  // Put an Empire leader at the target so the mission is OPPOSED and dice are
  // actually rolled (an unopposed mission auto-succeeds with no roll).
  const oppLeader = Object.keys(G.catalog.leaders).find(
    (lid) => G.catalog.leaders[lid].side === 'Empire',
  );
  (G.empire.leadersOnBoard[target] ??= []).push(oppLeader);
  const before = (G.missionReports ?? []).length;
  let err = null;
  let rv = null;
  try { rv = phases.revealMission(G, 'Rebel', 'covert-operation', target); }
  catch (e) { err = e; }
  if (rv && !rv.ok) err = new Error(rv.reason);
  // The attacker roll happens once opposition resolves; auto-resolve with no
  // opposing leader so we reach the mission report.
  if (G.pendingChoice?.kind === 'OpposeMission') {
    try { phases.resolveOpposition(G, null, false); } catch (e) { err = err ?? e; }
  }
  const reps = G.missionReports ?? [];
  const rep = reps[reps.length - 1];
  check('a mission report was produced', !!rep, err ? `reveal threw: ${err.message}` : 'no report');
  if (rep) {
    const colors = rep.attackerDice.colors || [];
    const green = colors.filter((c) => c === 'green').length;
    const redblack = colors.filter((c) => c === 'red' || c === 'black').length;
    check('exactly 3 green dice (minor cap)', green === 3, `got ${green} (${JSON.stringify(colors)})`);
    check('red+black equals the 3 MAJOR intel icons (not 4)', redblack === 3,
      `got ${redblack} red/black — overflow minor leaked into major if this is 4`);
    check('no more than 6 dice total (3 major + 3 green, 1 minor dropped)',
      colors.length === 6, `got ${colors.length}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
