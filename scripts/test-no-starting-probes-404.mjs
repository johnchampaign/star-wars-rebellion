// #404 — RAW: the Imperial player holds NO probe cards at setup. Setup only USES
// the probe deck for loyalty markers (Imperial probes → box) and to hide the base.
// The first 2 probes are drawn in Refresh step 3 ("Launch probe droids"), which
// runs AFTER turn 1's Assignment and Command. (The earlier #189 setup draw was a
// misread of rr p.15.)
// Run: node scripts/test-no-starting-probes-404.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

console.log('\n[ #404 the Empire holds NO probe cards at setup (auto-setup path) ]');
{
  const G = createGame(data, { seed: 11, autoSetupUnits: true });
  check('Empire probeHand is empty at game start', (G.empire.probeHand?.length ?? 0) === 0, JSON.stringify(G.empire.probeHand));
  check('the probe deck still has cards to draw later', (G.probeDeck?.length ?? 0) > 0);
}

console.log('\n[ #404 the first probes arrive during play (Refresh "Launch probe droids") ]');
{
  const G = createGame(data, { seed: 11, autoSetupUnits: true });
  // No starting-probes log event should exist.
  check('no "empire-starting-probes" setup event', !G.turnLog.some((e) => e.kind === 'empire-starting-probes'));
  seedAI(11); let st = 0, sawProbes = false;
  while (!G.isGameOver && st < 5000) {
    if ((G.empire.probeHand?.length ?? 0) > 0) { sawProbes = true; break; }
    const sd = G.currentPlayer; if (aiStep(G, sd)) { st++; continue; }
    const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (aiStep(G, o)) { st++; continue; } break;
  }
  check('probes do enter the Empire hand once play begins (not stuck at 0 forever)', sawProbes);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
