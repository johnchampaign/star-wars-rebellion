// #527 — a player expected the Empire AI to play Tractor Beam (space cinematic
// tactic) when they attacked with a lone transport into the Empire's Death Star +
// Star Destroyer: killing the transport leaves the Rebel with no ships, and Tractor
// Beam's PRIMARY then captures a Rebel leader. This verifies the AI's cinematic
// picker actually chooses Tractor Beam's primary when the capture is live (Star
// Destroyer present + a Rebel leader to grab), and correctly declines the primary
// when there's no leader to capture (the capture would resolve to nothing).
// The report had no encoded state (canEncodeState:false), so this reproduces the
// described scenario synthetically.
// Run: node scripts/test-tractor-beam-ai-527.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const cin = await import('../src/engine/cinematicTactics.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const TB = 'cin-empire-space-tractor-beam';
function empireSpacePick(rebelLeaderPresent) {
  const G = createGame(data, { seed: 7, expansion: { enabled: true, roeUnits: true, cinematicCombat: true } });
  const SYS = 'corellia';
  const mk = (t, s) => ({ instanceId: t + Math.random(), typeId: t, side: s, damage: 0 });
  G.map.systems[SYS].units = [
    mk('death-star', 'Empire'), mk('star-destroyer', 'Empire'),
    mk('transport', 'Rebel'), mk('rebel-trooper', 'Rebel'), mk('rebel-trooper', 'Rebel'),
  ];
  G.rebel.leadersOnBoard = {};
  if (rebelLeaderPresent) G.rebel.leadersOnBoard[SYS] = ['luke-skywalker-jedi'];
  const c = { systemId: SYS, round: 1, report: { rounds: [] }, attackerSide: 'Rebel' };
  return cin.pickBestCinematicPlay(G, c, 'Empire', 'space');
}

console.log('[ #527 — Empire AI plays Tractor Beam to capture a stranded leader ]');
// DS + SD vs a lone transport, Rebel leader present → play Tractor Beam PRIMARY.
const withLeader = empireSpacePick(true);
check('with a Rebel leader present → picks Tractor Beam primary (capture)',
  withLeader?.cardId === TB && withLeader?.useTop === true, `pick=${JSON.stringify(withLeader)}`);
// No Rebel leader → the capture would grab nothing, so the AI must NOT waste the
// primary on it (it may still play the card's secondary or another card).
const noLeader = empireSpacePick(false);
check('with NO Rebel leader → does NOT play Tractor Beam primary',
  !(noLeader?.cardId === TB && noLeader?.useTop === true), `pick=${JSON.stringify(noLeader)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
