// #465/#466: Rapid Mobilization must return the NON-CHOSEN drawn probe cards to
// the deck when a new base is established — otherwise they leak into the Empire's
// base-search "ruled out" list. (#541 correction: the vacated OLD-base card is
// instead GIVEN TO THE EMPIRE per LTP p.12, not returned to the deck.)
// #458/#467: My Only Hope (leaderRecruitable) must not re-offer plain Luke once
// he has become a Jedi, nor a leader lured to the dark side.
// Run: node scripts/test-rm-probe-return-and-recruit-465-467.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const M = await import('../src/engine/mechanics.ts');

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
const newGame = (seed) => createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

console.log('\n[ #465/#466 Rapid Mobilization returns non-chosen + old-base probes ]');
let verifiedEstablish = false;
for (let seed = 1; seed <= 40 && !verifiedEstablish; seed++) {
  const G = newGame(seed);
  const oldBase = G.rebelBaseSystemId;
  G.pendingRapidMobilizations = [{ twoLeaders: false }];
  G.pendingChoice = {
    kind: 'RapidMobilizationBranch', side: 'Rebel',
    twoLeaders: false, baseRevealed: false, moveUnitsAvailable: true,
  };
  const r1 = phases.resolveRapidMobilizationBranch(G, 'establish-base');
  if (!r1.ok) continue;
  if (G.pendingChoice?.kind !== 'RapidMobilizationBasePick') continue; // no legal candidate this seed
  const drawn = [...(G.pendingChoice.drawnProbeIds ?? [])];
  const candidate = G.pendingChoice.probeSystemIds[0];
  const chosenProbeId = drawn.find((pid) => G.catalog.probes[pid]?.systemId === candidate);
  const nonChosen = drawn.filter((pid) => pid !== chosenProbeId);
  const oldBaseProbeId = Object.values(G.catalog.probes).find((p) => p.systemId === oldBase)?.id;

  const r2 = phases.resolveRapidMobilizationBasePick(G, candidate);
  check(`(seed ${seed}) base established`, r2.ok && G.rebelBaseSystemId === candidate);
  check('  chosen base probe stays OUT of the deck', !G.probeDeck.includes(chosenProbeId));
  check('  every non-chosen drawn probe is back in the deck',
    nonChosen.every((pid) => G.probeDeck.includes(pid)),
    `missing: ${nonChosen.filter((pid) => !G.probeDeck.includes(pid)).join(',')}`);
  if (oldBaseProbeId) {
    // RAW correction (#541, LTP p.12): the vacated old-base probe is GIVEN TO THE
    // EMPIRE, not returned to the deck. (The earlier "return to deck" was a
    // misread — ruling out the old location for the Empire's search of the NEW
    // base is correct, not a leak.)
    check('  vacated old-base probe given to the Empire (not the deck)',
      !G.probeDeck.includes(oldBaseProbeId) && (G.empire.probeHand ?? []).includes(oldBaseProbeId));
  }
  verifiedEstablish = true;
}
check('found a seed that establishes a new base', verifiedEstablish);

console.log('\n[ #458/#467 leaderRecruitable blocks Jedi-Luke re-offer + dark-side flips ]');
{
  const G = newGame(7);
  // Baseline: plain Luke is recruitable when nothing about Luke is in play.
  // (Remove any Luke forms that setup may have placed, to isolate the check.)
  const stripLeader = (lid) => {
    for (const f of [G.rebel, G.empire]) {
      let i = f.leaderPool.indexOf(lid); if (i >= 0) f.leaderPool.splice(i, 1);
      for (const arr of Object.values(f.leadersOnBoard)) { const j = arr.indexOf(lid); if (j >= 0) arr.splice(j, 1); }
    }
  };
  stripLeader('luke-skywalker'); stripLeader('luke-skywalker-jedi');
  check('plain Luke recruitable when no Luke form is in play',
    phases.leaderRecruitable(G, 'Rebel', 'luke-skywalker') === true);

  // Now Luke has become a Jedi (Luke-Jedi is on the board): plain Luke blocked.
  (G.rebel.leadersOnBoard['yavin'] ??= []).push('luke-skywalker-jedi');
  check('plain Luke NOT recruitable once Luke-Jedi is in play',
    phases.leaderRecruitable(G, 'Rebel', 'luke-skywalker') === false);
  check('Luke-Jedi itself NOT recruitable while in play',
    phases.leaderRecruitable(G, 'Rebel', 'luke-skywalker-jedi') === false);
}
{
  const G = newGame(9);
  // Jyn lured to the dark side: now an Imperial leader with the dark-side ring.
  M.attachRing(G, 'jyn-erso', 'dark-side');
  if (!G.empire.leaderPool.includes('jyn-erso')) G.empire.leaderPool.push('jyn-erso');
  // strip Jyn from Rebel state so ONLY the dark-side marker blocks her
  { const i = G.rebel.leaderPool.indexOf('jyn-erso'); if (i >= 0) G.rebel.leaderPool.splice(i, 1);
    for (const arr of Object.values(G.rebel.leadersOnBoard)) { const j = arr.indexOf('jyn-erso'); if (j >= 0) arr.splice(j, 1); } }
  check('Jyn NOT Rebel-recruitable after being lured to the dark side',
    phases.leaderRecruitable(G, 'Rebel', 'jyn-erso') === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
