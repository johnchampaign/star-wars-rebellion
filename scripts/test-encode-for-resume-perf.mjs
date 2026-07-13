// Perf fix: the single-player RESUME save (localStorage, written on every action
// + AI batch) re-encoded the FULL state — including the per-turn full-board
// snapshots the v2 log inlines into turnLog. Late-game that's ~1 MB+, and writing
// it synchronously on every confirm made the UI pause for seconds. encodeForResume
// drops those snapshot entries (kind:'state'); archiveCompletedGame keeps the full
// encode for the upload. This verifies: snapshots are stripped, the codec is
// materially smaller, and it still round-trips through decode with state intact.
// Run: node scripts/test-encode-for-resume-perf.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const { stepOnce, seedAI } = await import('../src/play/randomAI.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Drive a game a few rounds in so the turnLog has snapshots + events.
seedAI(3);
const G = createGame(data, { seed: 3, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true } });
let s = 0;
while (G.phase === 'Setup' && s++ < 200) { if (!stepOnce(G, G.currentPlayer)) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!stepOnce(G, o)) { phases.setupAutoFill(G, 'Rebel'); phases.setupAutoFill(G, 'Empire'); } } }
let steps = 0;
while (!G.isGameOver && steps < 200000 && G.timeMarker < 8) { const side = G.currentPlayer; if (stepOnce(G, side)) { steps++; continue; } const o = side === 'Rebel' ? 'Empire' : 'Rebel'; if (stepOnce(G, o)) { steps++; continue; } break; }

console.log('[ encodeForResume — smaller, snapshot-free, round-trips ]');
{
  const snapsInMemory = (G.turnLog ?? []).filter((e) => e.kind === 'state').length;
  check('the in-memory game has snapshots to strip', snapsInMemory > 0, `snaps=${snapsInMemory}`);
  const full = codec.encode(G);
  const light = codec.encodeForResume(G);
  check('full encode STILL contains snapshots (upload keeps them)', full.includes('"kind":"state"'));
  check('resume encode has NO snapshot entries', !light.includes('"kind":"state"'));
  check('resume encode is materially smaller', light.length < full.length * 0.75, `${(light.length / 1024) | 0}KB vs ${(full.length / 1024) | 0}KB`);

  // Round-trip: decode the resume codec, key state preserved.
  const seed = createGame(data, { seed: 1, autoSetupUnits: true, expansion: G.expansion });
  const G2 = codec.decode(light, seed.catalog);
  check('round-trip: time marker preserved', G2.timeMarker === G.timeMarker);
  check('round-trip: reputation preserved', G2.reputationMarker === G.reputationMarker);
  check('round-trip: base + map preserved', G2.rebelBaseSystemId === G.rebelBaseSystemId && !!G2.map?.systems && Object.keys(G2.map.systems).length === Object.keys(G.map.systems).length);
  check('round-trip: no snapshot entries in the restored turnLog', (G2.turnLog ?? []).filter((e) => e.kind === 'state').length === 0);
  // The non-snapshot event log is preserved (report/seq continuity).
  const fullEvents = (G.turnLog ?? []).filter((e) => e.kind !== 'state').length;
  check('round-trip: non-snapshot event entries preserved', (G2.turnLog ?? []).length === fullEvents, `restored=${(G2.turnLog ?? []).length} events=${fullEvents}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
