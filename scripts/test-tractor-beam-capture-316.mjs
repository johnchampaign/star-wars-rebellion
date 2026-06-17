// #316 audit — Tractor Beam ("capture 1 leader" when the Empire has a Star
// Destroyer and the Rebels have no ships) lets the Empire CHOOSE which Rebel
// leader to capture when 2+ are stranded in the system, instead of grabbing the
// first one.
// Run: node scripts/test-tractor-beam-capture-316.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const ct = await import('../src/engine/cinematicTactics.ts');

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

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true } });

console.log('\n[ #316 the Empire picks which stranded Rebel leader to capture ]');
{
  const G = createGame(data, opts(95));
  const sys = 'felucia';
  G.map.systems[sys].units = [];
  // Empire: a Star Destroyer (space) + a stormtrooper (ground, gives the ground
  // battle). Rebel: a ground unit (no SHIPS) + two leaders stranded here.
  M.deployUnit(G, 'Empire', 'star-destroyer', sys);
  M.deployUnit(G, 'Empire', 'stormtrooper', sys);
  M.deployUnit(G, 'Rebel', 'rebel-trooper', sys);
  M.placeLeader(G, 'Rebel', 'general-rieekan', sys);
  M.placeLeader(G, 'Rebel', 'mon-mothma', sys);
  combat.beginCombat(G, 'Empire', 'malastare', sys);
  const c = G.pendingCombat;
  check('combat started', !!c);
  // Queue the Tractor Beam capture and resolve the cinematic end-of-round step.
  c.cinematicEndOfRound = [{ side: 'Empire', kind: 'capture' }];
  const paused = ct.resolveCinematicEndOfRound(G, c);
  check('capture paused for a pick (2 leaders)', paused === true);
  check('TractorBeamCapturePick posted for the Empire',
    G.pendingChoice?.kind === 'TractorBeamCapturePick' && G.pendingChoice.side === 'Empire',
    G.pendingChoice?.kind);
  check('both leaders are candidates', (G.pendingChoice?.candidates ?? []).length === 2);

  const capturedBefore = (G.empire.capturedLeaders ?? []).map((cl) => cl.leaderId);
  const choiceCands = [...G.pendingChoice.candidates];
  const r = combat.resolveTractorBeamCapturePick(G, 'mon-mothma');
  check('resolve ok', r.ok, r.reason);
  const capturedAfter = (G.empire.capturedLeaders ?? []).map((cl) => cl.leaderId);
  check('Mon Mothma was captured', capturedAfter.includes('mon-mothma'),
    `captured=${JSON.stringify(capturedAfter)}`);
  check('the other leader was NOT captured', !capturedAfter.includes('general-rieekan'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
