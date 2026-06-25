// #390 — With two copies of the SAME mission assigned (different leaders heading
// to different systems), revealing must let the player choose WHICH copy. The
// engine matched by missionId alone and always revealed the first copy, so the
// player's choice of leaders/target was ignored.
// Run: node scripts/test-duplicate-mission-reveal-390.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { missionTargets } = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const MISSION = 'double-our-efforts'; // Empire, diplomacy cost 1, non-attempt

function setup() {
  const G = createGame(data, { seed: 4, autoSetupUnits: true });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.pendingChoice = undefined; G.pendingMission = undefined;
  const f = G.empire;
  for (const list of Object.values(f.leadersOnBoard)) list.length = 0;
  // Two assigned copies of the SAME mission, with DIFFERENT leaders.
  f.leadersOnMissions = [
    { missionId: MISSION, leaderIds: ['darth-vader'] },      // copy A
    { missionId: MISSION, leaderIds: ['emperor-palpatine'] }, // copy B
  ];
  return G;
}

function legalTarget(G) {
  const t = missionTargets(G, 'Empire', MISSION);
  return t.permissive ? Object.keys(G.map.systems).find((s) => !G.map.systems[s].destroyed) : t.systemIds[0];
}

console.log('\n[ #390 revealing the SECOND copy (by its leaders) reveals THAT copy, not the first ]');
{
  const G = setup();
  const target = legalTarget(G);
  const r = phases.revealMission(G, 'Empire', MISSION, target, undefined, ['emperor-palpatine']);
  check('reveal ok', r.ok, r.reason);
  check('Palpatine (the chosen copy) was placed at the target',
    (G.empire.leadersOnBoard[target] ?? []).includes('emperor-palpatine'));
  check('Vader (the OTHER copy) was NOT placed/revealed',
    !(G.empire.leadersOnBoard[target] ?? []).includes('darth-vader'));
  const remaining = G.empire.leadersOnMissions.filter((m) => m.missionId === MISSION);
  check('exactly one copy remains assigned', remaining.length === 1, JSON.stringify(remaining));
  check('the remaining copy is Vader\'s', remaining[0]?.leaderIds.includes('darth-vader'));
}

console.log('\n[ #390 revealing the FIRST copy by its leaders ]');
{
  const G = setup();
  const target = legalTarget(G);
  const r = phases.revealMission(G, 'Empire', MISSION, target, undefined, ['darth-vader']);
  check('reveal ok', r.ok, r.reason);
  check('Vader was placed at the target', (G.empire.leadersOnBoard[target] ?? []).includes('darth-vader'));
  const remaining = G.empire.leadersOnMissions.filter((m) => m.missionId === MISSION);
  check('Palpatine\'s copy remains', remaining.length === 1 && remaining[0].leaderIds.includes('emperor-palpatine'));
}

console.log('\n[ backward compatible: no leader hint → reveals the first copy ]');
{
  const G = setup();
  const target = legalTarget(G);
  const r = phases.revealMission(G, 'Empire', MISSION, target);
  check('reveal ok', r.ok, r.reason);
  check('first copy (Vader) revealed', (G.empire.leadersOnBoard[target] ?? []).includes('darth-vader'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
