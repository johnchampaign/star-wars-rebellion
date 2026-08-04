// #686 — "Rebels gave 3 base locations from Interrogation but one of them
// (Ryloth) was a previous base location that they had given a probe card for in
// a previous round. No idea why that location was given."
//
// Naming a vacated system is legal RAW (Interrogation Droid only requires that
// ONE of the 3 named systems holds the base — the other 2 are free choices), so
// the engine was not breaking a rule. The bug was in what the Rebel AI knew.
//
// When the base relocates, the OLD base's probe card is given to the Imperial
// player: a definitive "the base is not here". But resetEmpireSearchedForBaseMove
// wipes empireSearchedRuledOut and re-seeds it from loyalty/subjugation only, so
// a vacated NEUTRAL system dropped back to "unknown". The Rebel AI's decoy
// scorer penalises ruled-out systems by -100 — it just never saw this one, and
// picked a decoy the Empire could dismiss on sight.
//
// recordEmpireSearched now folds in the Empire's probe hand, and Rapid
// Mobilization re-records after the hand-off.
// Run: node scripts/test-old-base-probe-ruled-out-686.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

/** A probe card for some NEUTRAL system that isn't the base — the shape the
 *  vacated old base has after a relocation. */
const neutralProbeAwayFromBase = (G) => {
  for (const p of Object.values(G.catalog.probes)) {
    const ss = G.map.systems[p.systemId];
    if (!ss) continue;
    if (p.systemId === G.rebelBaseSystemId) continue;
    if (ss.subjugated || ss.loyalty === 'imperial') continue;
    return p;
  }
  throw new Error('no neutral non-base probe system');
};

console.log('\n[ #686 a probe card in the Empire\'s hand rules its system out ]');
{
  const G = createGame(data, { seed: 21 });
  G.rebelBaseRevealed = false;
  const probe = neutralProbeAwayFromBase(G);

  G.empireSearchedRuledOut = [];
  M.recordEmpireSearched(G);
  check('baseline: the neutral system is NOT ruled out yet',
    !G.empireSearchedRuledOut.includes(probe.systemId), probe.systemId);

  // Hand the card to the Empire, exactly as Rapid Mobilization does.
  (G.empire.probeHand ??= []).push(probe.id);
  M.recordEmpireSearched(G);
  check('once the Empire holds the card, the system IS ruled out',
    G.empireSearchedRuledOut.includes(probe.systemId), JSON.stringify(G.empireSearchedRuledOut));
  check('the actual base is never ruled out',
    !G.empireSearchedRuledOut.includes(G.rebelBaseSystemId), G.rebelBaseSystemId);
}

console.log('\n[ #686 the knowledge SURVIVES a base relocation ]');
{
  const G = createGame(data, { seed: 22 });
  G.rebelBaseRevealed = false;
  const probe = neutralProbeAwayFromBase(G);
  (G.empire.probeHand ??= []).push(probe.id);

  // This is the wipe-and-reseed that used to lose it.
  M.resetEmpireSearchedForBaseMove(G);
  check('vacated system is still ruled out after the base moves',
    G.empireSearchedRuledOut.includes(probe.systemId), JSON.stringify(G.empireSearchedRuledOut));
}

console.log('\n[ #686 guard: holding the CURRENT base\'s card never crosses it off ]');
{
  const G = createGame(data, { seed: 23 });
  G.rebelBaseRevealed = false;
  const baseProbe = Object.values(G.catalog.probes).find((p) => p.systemId === G.rebelBaseSystemId);
  if (baseProbe) {
    (G.empire.probeHand ??= []).push(baseProbe.id);
    M.recordEmpireSearched(G);
    check('the base system is still not ruled out',
      !G.empireSearchedRuledOut.includes(G.rebelBaseSystemId), G.rebelBaseSystemId);
  } else {
    check('no probe card exists for the base system (nothing to guard)', true);
  }
}

console.log('\n[ #686 recordEmpireSearched stays idempotent ]');
{
  const G = createGame(data, { seed: 24 });
  G.rebelBaseRevealed = false;
  const probe = neutralProbeAwayFromBase(G);
  (G.empire.probeHand ??= []).push(probe.id);
  M.recordEmpireSearched(G);
  const first = [...G.empireSearchedRuledOut].sort();
  M.recordEmpireSearched(G);
  M.recordEmpireSearched(G);
  const after = [...G.empireSearchedRuledOut].sort();
  check('repeated calls do not grow or duplicate the set',
    JSON.stringify(first) === JSON.stringify(after)
    && new Set(after).size === after.length, `${first.length} vs ${after.length}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
