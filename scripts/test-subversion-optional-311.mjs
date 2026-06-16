// #311 — Subversion is OPTIONAL ("Reveal this mission after..." = a may): the
// OpposeMission choice surfaces it, and resolveOpposition only fires it when the
// opposer opts in. Also confirms the +1 die DOES apply (claim 2 was a
// misunderstanding — a 0-skill leader rolls exactly 1 die from Subversion).
// Run: node scripts/test-subversion-optional-311.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

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

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

// Set up: Rebel has Subversion assigned with a leader; Empire reveals Rule by
// Fear → Rebel gets the OpposeMission choice. Returns G at that point.
function setupOpposition(seed, rebelSubLeader = 'general-rieekan') {
  const G = createGame(data, opts(seed));
  G.rebel.missionHand = ['subversion-new-rebel'];
  phases.assignLeader(G, 'Rebel', 'subversion-new-rebel', [rebelSubLeader]);
  phases.skipAssignment(G, 'Rebel');
  phases.assignLeader(G, 'Empire', 'rule-by-fear', ['emperor-palpatine']);
  phases.skipAssignment(G, 'Empire');
  let guard = 0;
  while (G.phase === 'Assignment' && guard++ < 10) {
    if (G.pendingChoice?.kind === 'FalseOrdersWindow') { phases.resolveFalseOrders(G, null); continue; }
    break;
  }
  const imperialSys = Object.entries(G.map.systems).find(([_id, s]) =>
    (s.loyalty === 'imperial' || s.subjugated) && s.units.some((u) => u.side === 'Empire'))?.[0];
  G.currentPlayer = 'Empire';
  phases.revealMission(G, 'Empire', 'rule-by-fear', imperialSys);
  return G;
}

console.log('\n[ #311 the OpposeMission choice surfaces Subversion as optional ]');
{
  const G = setupOpposition(40);
  check('OpposeMission posted for Rebel', G.pendingChoice?.kind === 'OpposeMission'
    && G.pendingChoice.opposerSide === 'Rebel', G.pendingChoice?.kind);
  check('choice carries the Subversion option', !!G.pendingChoice?.subversion
    && G.pendingChoice.subversion.missionId === 'subversion-new-rebel',
    JSON.stringify(G.pendingChoice?.subversion));
}

console.log('\n[ #311 opting OUT does not fire Subversion ]');
{
  const G = setupOpposition(41);
  const before = G.turnLog.length;
  phases.resolveOpposition(G, null, false); // decline + DON'T use subversion
  const fired = G.turnLog.slice(before).some((e) => e.kind === 'subversion-trigger');
  check('no subversion-trigger when opted out', !fired);
  check('Subversion leader stayed on its mission',
    G.rebel.leadersOnMissions.some((m) => m.missionId === 'subversion-new-rebel'));
  check('Subversion card NOT discarded', !G.rebel.missionDiscard.includes('subversion-new-rebel'));
}

console.log('\n[ #311 opting IN fires it and adds +1 die (claim 2 confirmation) ]');
{
  const G = setupOpposition(42);
  const before = G.turnLog.length;
  phases.resolveOpposition(G, null, true); // use subversion
  const fired = G.turnLog.slice(before).some((e) => e.kind === 'subversion-trigger');
  check('subversion-trigger fired when opted in', fired);
  // Opposer dice = the moved leader's skill in the mission's skill + 1 (Subversion).
  const roll = [...G.turnLog].reverse().find((e) => e.kind === 'mission-roll');
  const oppDice = roll?.payload?.opposer?.dice;
  const skillName = roll?.payload?.skill;
  const leaderSkill = (G.catalog.leaders['general-rieekan'].skills)[skillName] ?? 0;
  check(`opposer rolled leader skill (${leaderSkill}) + 1 Subversion die`,
    oppDice === leaderSkill + 1, `opposer dice=${oppDice}, expected=${leaderSkill + 1}`);
}

console.log('\n[ #311 default (AI path) still uses Subversion — back-compat ]');
{
  const G = setupOpposition(43);
  const before = G.turnLog.length;
  phases.resolveOpposition(G, null); // no 3rd arg → defaults to useSubversion=true
  check('default-arg call still fires Subversion (AI/back-compat)',
    G.turnLog.slice(before).some((e) => e.kind === 'subversion-trigger'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
