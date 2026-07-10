// Driven companion to fixture-empire-finish.mjs (#539).
//
// The base fixture harness is a STATIC snapshot (it decodes and measures). This
// one DECODES each stuck state and then PLAYS THE AI FORWARD (both sides) under
// the current heuristic — so with SWR_EMPIRE_PLANNER=1 it exercises the strike-
// fleet plan layer from the exact positions the AI failed at. It reports the
// peak Empire ground delivered to the base and whether the base was captured,
// which is the behavioral gate: post-planner the force must mobilize (delivered
// rises, leaders-wasted → 0, capture more likely).
//
// Run BOTH arms to A/B:
//   node scripts/fixture-empire-finish-run.mjs            # planner OFF
//   SWR_EMPIRE_PLANNER=1 node scripts/fixture-empire-finish-run.mjs   # planner ON
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FX = join(ROOT, 'scripts', 'fixtures');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const isMobileGround = (G, u) => {
  const t = G.catalog.unitTypes[u.typeId];
  return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile;
};
const isMobile = (G, u) => { const t = G.catalog.unitTypes[u.typeId]; return !!t && !t.transport.immobile; };

function run(name, rounds) {
  const raw = JSON.parse(readFileSync(join(FX, `empire-finish-${name}.json`), 'utf8'));
  const seed = createGame(data, { seed: 1, autoSetupUnits: true, expansion: raw.state.expansion });
  const G = codec.decode(JSON.stringify(raw), seed.catalog);
  seedAI(4242);
  const base = G.rebelBaseSystemId;
  const startT = G.timeMarker;
  const groundAtBase = () => (G.map.systems[base]?.units ?? []).filter((u) => u.side === 'Empire' && isMobileGround(G, u)).length;
  const leadersWastedAtBase = () => {
    const force = (G.map.systems[base]?.units ?? []).filter((u) => u.side === 'Empire' && isMobile(G, u)).length;
    return force === 0 ? (G.empire.leadersOnBoard[base] ?? []).length : 0;
  };
  let peakGround = groundAtBase();
  let captured = false;
  let steps = 0;
  while (!G.isGameOver && G.timeMarker < startT + rounds && steps < 100000) {
    const before = G.rebelBaseSystemId;
    const sd = G.currentPlayer;
    if (!aiStep(G, sd)) { const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (!aiStep(G, o)) break; }
    steps++;
    peakGround = Math.max(peakGround, groundAtBase());
    // Base captured = the win, or the base system flips to Empire control / base id clears.
    if (G.winner === 'Empire') { captured = true; break; }
    if (before && G.rebelBaseSystemId !== before && G.rebelBaseRevealed === false) { /* relocated */ }
  }
  const finalWasted = leadersWastedAtBase();
  console.log(`[ ${name} ] planner=${process.env.SWR_EMPIRE_PLANNER === '1' ? 'ON ' : 'off'}  startT=${startT} ranTo=${G.timeMarker}  peakDeliveredGround=${peakGround}  leadersWastedAtBase(final)=${finalWasted}  captured=${captured}  winner=${G.winner ?? '-'}`);
  return { name, peakGround, finalWasted, captured };
}

const rounds = Number(process.argv[3] ?? 4);
const which = process.argv[2] ?? 'all';
const names = which === 'all' ? ['538', '516'] : [which];
console.log(`=== Empire-finish DRIVEN fixtures (play ${rounds} rounds forward) ===`);
for (const n of names) run(n, rounds);
