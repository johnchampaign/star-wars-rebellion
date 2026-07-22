// #627 — the 2 bonus mission draws are the LAST setup step (RAW: RR p.15 /
// RoE Advanced step 26 of 27), AFTER deployment and the base pick, so the
// drawn cards can't inform placement. Also guards: resume-compat (an old
// mid-setup save that already drew must not draw again) and determinism
// (moving the draw consumes no RNG — the same cards arrive, just later).
// Run: node scripts/test-setup-mission-draw-627.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const startingCount = (G, side) => Object.values(G.catalog.missions)
  .filter((m) => m.side === side && m.isStarting && !m.isProject && G[side === 'Rebel' ? 'rebel' : 'empire'].missionHand.includes(m.id)).length;

console.log('[ interactive setup: hands hold ONLY starting missions until setup completes ]');
{
  const G = createGame(data, { seed: 4, autoSetupUnits: false });
  check('phase is Setup', G.phase === 'Setup', G.phase);
  check('Rebel hand = starting only', G.rebel.missionHand.length === startingCount(G, 'Rebel'),
    `${G.rebel.missionHand.length} vs ${startingCount(G, 'Rebel')}`);
  check('Empire hand = starting only', G.empire.missionHand.length === startingCount(G, 'Empire'));
  // Drive both AIs through setup to completion.
  let guard = 0;
  while (G.phase === 'Setup' && guard++ < 400) {
    if (!AI.stepOnce(G, G.currentPlayer)) {
      const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
      if (!AI.stepOnce(G, o)) break;
    }
  }
  check('setup completed', G.phase !== 'Setup', G.phase);
  check('Rebel drew +2 at completion', G.rebel.missionHand.length === startingCount(G, 'Rebel') + 2,
    String(G.rebel.missionHand.length));
  check('Empire drew +2 at completion', G.empire.missionHand.length === startingCount(G, 'Empire') + 2);
  // The draws must come AFTER every setup-deploy in the log.
  const lastDeploy = G.turnLog.map((e, i) => (e.kind === 'setup-deploy' || e.kind === 'setup-auto-fill' || e.kind === 'pick-rebel-base') ? i : -1).reduce((a, b) => Math.max(a, b), -1);
  const firstDraw = G.turnLog.findIndex((e) => e.kind === 'draw-mission');
  check('draw-mission logged AFTER all deployment + base pick', firstDraw > lastDeploy,
    `firstDraw=${firstDraw} lastDeploy=${lastDeploy}`);
}

console.log('\n[ auto-setup path still gets its +2 (draw runs inside createGame) ]');
{
  const G = createGame(data, { seed: 4, autoSetupUnits: true });
  check('phase is Assignment', G.phase === 'Assignment', G.phase);
  check('Rebel hand = starting + 2', G.rebel.missionHand.length === startingCount(G, 'Rebel') + 2);
  check('Empire hand = starting + 2', G.empire.missionHand.length === startingCount(G, 'Empire') + 2);
}

console.log('\n[ determinism: the draw is a pure shift from the pre-shuffled deck ]');
{
  // Moving the draw to setup completion must consume no RNG: the 2 cards each
  // side receives are exactly the deck's head as it stood before the draw.
  // (Auto vs interactive configs are NOT comparable at one seed — auto's
  // random base pick consumes an extra RNG call before the deck shuffles.)
  const G = createGame(data, { seed: 8, autoSetupUnits: false });
  const expectRebel = G.rebel.missionDeck.slice(0, 2);
  const expectEmpire = G.empire.missionDeck.slice(0, 2);
  let guard = 0;
  while (G.phase === 'Setup' && guard++ < 400) {
    if (!AI.stepOnce(G, G.currentPlayer)) {
      const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel';
      if (!AI.stepOnce(G, o)) break;
    }
  }
  check('Rebel received exactly the deck head', JSON.stringify(G.rebel.missionHand.slice(-2)) === JSON.stringify(expectRebel),
    `${G.rebel.missionHand.slice(-2)} vs ${expectRebel}`);
  check('Empire received exactly the deck head', JSON.stringify(G.empire.missionHand.slice(-2)) === JSON.stringify(expectEmpire));
}

console.log('\n[ resume-compat: an old save that already drew must not draw again ]');
{
  const G = createGame(data, { seed: 4, autoSetupUnits: true });
  const before = G.rebel.missionHand.length; // starting + 2 already
  M.drawSetupBonusMissions(G); // simulate the transition firing on a resumed old save
  check('idempotent: no double draw', G.rebel.missionHand.length === before,
    `${before} -> ${G.rebel.missionHand.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
